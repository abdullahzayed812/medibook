# Threat model: identity, authentication, authorization, tenancy

> **Purpose:** assets, actors, threats, mitigations and residual risks for identity and tenancy.
>
> Task 02 scope. Method: assets → actors → threats (STRIDE-oriented) → mitigations → residual risk.

## Assets

Patient and clinic data (future), account identities, sessions and tokens, authorization state
(memberships, roles, mapping), signing and encryption keys, OTP codes, 2FA secrets, audit trail.

## Actors

Anonymous internet clients; authenticated users of one clinic acting against another
(**cross-tenant**); low-privilege staff seeking escalation; holders of stolen tokens or devices;
compromised or careless insiders (platform admins); infrastructure-level attackers (DB dump, log
access).

## Threats and mitigations

| #   | Threat                                      | Mitigations                                                                                                                                                        | Tests                                                 |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| T1  | Account enumeration via OTP request         | Request step never reads `users`; identical 202 responses; generic errors                                                                                          | `otp.test.ts`                                         |
| T2  | OTP brute force                             | 6-digit CSPRNG code; 5 attempts/challenge under row lock → LOCKED; per-phone cooldown + hourly cap; per-IP request and verification caps; fail closed              | `otp.test.ts`, `security.test.ts`                     |
| T3  | OTP disclosure (DB/logs)                    | Only HMAC (HKDF-derived key) stored; never in responses/logs/events; mock provider impossible in production                                                        | `otp.test.ts`, `env.test.ts`, `otp-provider.test.ts`  |
| T4  | SMS pumping / cost abuse                    | Per-IP and per-phone limits                                                                                                                                        | partial (see residual)                                |
| T5  | Access-token forgery / tampering            | EdDSA signature, alg allow-list (no `none`), `typ`, `iss`, `aud`, `kid` lookup, numeric id checks                                                                  | `access-tokens.test.ts`, `security.test.ts`           |
| T6  | Use of tokens after logout / suspension     | Session + account status checked per request                                                                                                                       | `tokens-sessions.test.ts`, `security.test.ts`         |
| T7  | Refresh-token theft                         | Hash-only storage; rotation; reuse detection revokes whole session; absolute session lifetime                                                                      | `tokens-sessions.test.ts`, `security.test.ts`         |
| T8  | **Cross-tenant read/update/delete**         | Verified tenant context per request; `ClinicScope`; repository `clinic_id` predicates; SQL guard; composite FKs; 404 for foreign ids                               | `tenant-isolation.test.ts`, `identity-schema.test.ts` |
| T9  | Manipulated clinic/branch/resource ids      | Format validation; membership and branch verification; body/query clinic ids ignored                                                                               | `tenant-isolation.test.ts`, `authorization.test.ts`   |
| T10 | Context leakage between concurrent requests | Request-scoped context only, no globals                                                                                                                            | `tenant-isolation.test.ts` (40 parallel requests)     |
| T11 | Privilege escalation (role grants)          | Assignable-role rules; no self-modification; owner grants are platform-only; DB scope CHECKs                                                                       | `authorization.test.ts`, `identity-schema.test.ts`    |
| T12 | Escalation via client-sent roles/claims     | Tokens carry no roles; all authorization from MySQL                                                                                                                | `security.test.ts`                                    |
| T13 | Admin account takeover                      | Mandatory TOTP for all platform permissions; per-session MFA state; replay protection; recovery codes hashed; MFA rate limit; other sessions revoked on enrollment | `security.test.ts`, `authorization.test.ts`           |
| T14 | Stale permissions after changes             | No caching; per-request reads                                                                                                                                      | `authorization.test.ts`                               |
| T15 | Log injection / sensitive data in logs      | Request id allow-list; redaction list; bodies never logged; phone masked; security events hold no secrets                                                          | Task 01 tests, `security.test.ts`                     |
| T16 | Repudiation of admin actions                | `audit_events` written in the same transaction as the change                                                                                                       | `authorization.test.ts`, `security.test.ts`           |
| T17 | IP spoofing to evade rate limits            | `HTTP_TRUST_PROXY` must match the real proxy chain (default `false`)                                                                                               | config                                                |

## Security assumptions

1. TLS terminates at a trusted proxy/load balancer; `HTTP_TRUST_PROXY` is configured to match it.
2. Secrets (`AUTH_SECRET`, signing key, `MFA_ENCRYPTION_KEY`, DB/Redis credentials) are stored in
   a secrets manager in production and never committed.
3. MySQL and Redis are on a private network; Redis requires a password.
4. The application's MySQL user should not be able to UPDATE/DELETE `security_events` and
   `audit_events` in production (grants not yet configured: residual risk).
5. Clients store refresh tokens in OS secure storage (mobile) and serialize refresh calls.

## Residual risks and open items

- No real OTP provider: production cannot start (by design) until OD-06 is decided.
- No device fingerprinting / CAPTCHA / phone-number reputation against SMS pumping (T4).
- No 2FA reset workflow (lost device) and no admin re-verification flow yet.
- Logs are append-only by convention, not yet by database grants.
- No key-rotation tooling for `MFA_ENCRYPTION_KEY`; `AUTH_SECRET` rotation invalidates OTPs and
  recovery codes.
- No retention/purge policy for `otp_challenges`, sessions, tokens and security events.
- Sequential ids are visible to clients (mitigated by authorization and 404 semantics).
