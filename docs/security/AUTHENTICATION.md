# Authentication

> **Purpose:** phone OTP sign-in, tokens, MFA and the authentication rules.
>
> Task 02. Code: `apps/backend/src/modules/iam/`.

## 1. Phone + OTP ("sign in or sign up")

```
Client                         API                                 MySQL / Redis / OtpProvider
  │ POST /auth/otp/request {phone}
  │──────────────────────────────▶ normalize → E.164 (libphonenumber-js)
  │                                rate limits (Redis): IP/hour, phone cooldown, phone/hour
  │                                supersede pending challenges; insert challenge (HMAC of code)
  │                                provider.send(code)
  │◀────────────── 202 { challengeId, expiresAt, resendAvailableAt }   (identical for any phone)
  │ POST /auth/otp/verify {challengeId, phone, code, device}
  │──────────────────────────────▶ IP verify rate limit
  │                                TX: lock challenge → checks → attempts+1 → compare (constant time)
  │                                    ok → find-or-create user (phone proven) → status checks
  │                                    → create session + refresh token → security events → COMMIT
  │◀────────────── 200 { accessToken, refreshToken, sessionId, account, mfaRequired }
```

| Control                       | Default (env)                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Code                          | 6 digits, CSPRNG (`crypto.randomInt`)                                         |
| Storage                       | `HMAC-SHA256(HKDF(AUTH_SECRET,"otp-code"), challengeId:code)`, never the code |
| Challenge id                  | 128-bit random hex (not sequential)                                           |
| Expiry                        | `OTP_TTL_SECONDS` = 300                                                       |
| Attempts per challenge        | `OTP_MAX_ATTEMPTS` = 5. Then `LOCKED`, even for the right code                |
| Resend cooldown per phone     | `OTP_RESEND_COOLDOWN_SECONDS` = 60                                            |
| Requests per phone / hour     | `OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR` = 5                                     |
| Requests per IP / hour        | `OTP_MAX_REQUESTS_PER_IP_PER_HOUR` = 30                                       |
| Verifications per IP / 15 min | `OTP_MAX_VERIFICATIONS_PER_IP_PER_15_MIN` = 30                                |
| New request                   | supersedes earlier pending challenges of that phone                           |

- Attempt counting happens under a row lock (`SELECT … FOR UPDATE`), so parallel guesses can't
  exceed the limit (tested with 6 concurrent wrong guesses).
- Brute-force bound: about 5 guesses per challenge and 5 challenges per phone per hour, so about
  25 guesses per hour against 10⁶ codes.
- Failure responses are generic: `OTP_INVALID` (wrong, expired, used, unknown or mismatched
  challenge) or `OTP_ATTEMPTS_EXCEEDED`. Rate limits return `429 OTP_RATE_LIMITED` + `Retry-After`.
- **No account enumeration:** the request step never reads `users`. Account state is revealed only
  after the phone is proven (e.g. `ACCOUNT_SUSPENDED`).
- Rate limiting **fails closed**: if Redis is unavailable, OTP requests fail.
- Every outcome is a `security_events` row (phone stored only as a keyed hash, `subject_hash`).

### OTP providers

`OtpProvider` interface (`send({ phoneE164, code, purpose, expiresAt })`). Only the **mock** provider
exists. It writes the code to the dev log (`devOtp`) and keeps an in-memory outbox for tests.
It **cannot run in production**, for two independent reasons:

1. Config validation rejects `OTP_PROVIDER=mock` when `NODE_ENV=production` (the process exits).
2. The `MockOtpProvider` constructor throws in production.

Consequently, **production cannot start until a real provider is approved and implemented**
(OD-06). OTP codes are never logged by anything else. The logger redacts `otpCode`,
`recoveryCode`, tokens and secrets.

### Email

Not implemented. `users.email` / `email_verified_at` exist; a future email OTP provider can
implement `OtpProvider` with a new `purpose`.

## 2. Access tokens

- JWT, **EdDSA (Ed25519)**, header `typ: at+jwt`, `kid`.
- Claims: `iss`, `aud`, `sub` (user id), `sid` (session id), `jti`, `iat`, `exp`. **No roles or
  permissions.** Those are resolved per request.
- TTL `AUTH_ACCESS_TOKEN_TTL_SECONDS` = 900 (60–3600).
- Verification enforces algorithm allow-list, `typ`, issuer, audience, expiry (5 s tolerance),
  required claims and numeric ids. Errors: `401 INVALID_TOKEN` / `401 TOKEN_EXPIRED`.
- **Per request**, `authenticate` also loads the session and account from MySQL: revoked or
  expired session → `401 SESSION_INVALID`; non-active account → `403 ACCOUNT_NOT_ACTIVE`.
  Revocation therefore never waits for token expiry.

### Keys

`AccessTokenKeyStore` interface; the default `createEnvKeyStore` reads:

| Variable                                            | Purpose                                                       |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `AUTH_ACCESS_TOKEN_PRIVATE_KEY`                     | base64 of PKCS#8 PEM Ed25519 private key (public key derived) |
| `AUTH_ACCESS_TOKEN_KEY_ID`                          | `kid` of the signing key                                      |
| `AUTH_ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY` / `_KEY_ID` | optional, accepted for verification during rotation           |

Rotation: deploy the new key as current and the old public key as previous. After one access-token
TTL, remove the previous key. A KMS or secrets-manager implementation can replace the env key store
without touching callers.

## 3. Refresh tokens and sessions

See [SESSION_MANAGEMENT.md](SESSION_MANAGEMENT.md).

## 4. Two-factor authentication (TOTP), mandatory for SUPER_ADMIN

| Aspect      | Implementation                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Method      | TOTP RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step), implemented on `node:crypto`, RFC test vectors in unit tests |
| Secret      | 160-bit, **AES-256-GCM encrypted** with `MFA_ENCRYPTION_KEY`, AAD bound to user id                           |
| Replay      | accepted time step must be greater than `last_used_step`                                                     |
| Recovery    | 10 single-use codes (`XXXXX-XXXXX`, 50 bits), stored as HMAC-SHA256                                          |
| Brute force | `MFA_MAX_VERIFICATIONS_PER_15_MIN` = 5 attempts per user                                                     |
| State       | per **session** (`sessions.mfa_verified_at`), not in the token                                               |

**Enforcement:** every `PLATFORM` permission requires an MFA-verified session, checked centrally
in `AuthorizationService`. A SUPER_ADMIN without enrollment gets `MFA_ENROLLMENT_REQUIRED`; with
enrollment but an unverified session, `MFA_REQUIRED`. There is no bypass flag.

**Flows:**

1. _Enrollment:_ `POST /security/mfa/totp/enrollment` (secret + `otpauth://` URI shown once) →
   `POST …/enrollment/confirm { code }` activates the credential, returns recovery codes once, marks
   the session verified and **revokes all other sessions**.
2. _Verification (step-up per session):_ `POST /security/mfa/verify { code }`.
3. _Recovery:_ `POST /security/mfa/verify { recoveryCode }` (single use);
   `POST /security/mfa/recovery-codes` regenerates them (requires a verified session).
4. _Revocation / reset:_ **not implemented.** Requirements for the follow-up:
   - A user must not be able to disable 2FA while holding SUPER_ADMIN.
   - A lost-device reset must be performed by **another** MFA-verified SUPER_ADMIN, with identity
     re-verification, audit event and revocation of all sessions.
   - Re-enrollment over an active credential is refused (409) until such a reset exists.

## 5. Configuration and secrets

All secrets come from the environment and are validated at startup (see ENVIRONMENT_SETUP.md):
`AUTH_SECRET` (≥ 32 chars, HKDF master for OTP, recovery-code and subject hashes),
`AUTH_ACCESS_TOKEN_*`, `MFA_ENCRYPTION_KEY` (32 bytes). Generate with `npm run secrets:generate`.
Rotating `AUTH_SECRET` invalidates pending OTPs and recovery codes. Rotating `MFA_ENCRYPTION_KEY`
requires re-encrypting TOTP secrets (no tooling yet).

## Phone change (Task 05.1)

`POST /me/phone/change-requests { phone }` sends `PHONE_CHANGE` codes to the **current** and the
**new** phone. `POST /me/phone/change-requests/verify` needs both codes, and the new number must
not belong to another account (`409 PHONE_UNAVAILABLE`). `PHONE_CHANGE`, `GUEST_BOOKING` and
`LOGIN` challenges are purpose-bound: none can complete another. The change is audited
(`ACCOUNT_PHONE_CHANGED`, masked numbers). Sessions are kept. A phone number never carries
booking ownership (see [BOOKING_PERSONS.md](../platform/BOOKING_PERSONS.md)).
