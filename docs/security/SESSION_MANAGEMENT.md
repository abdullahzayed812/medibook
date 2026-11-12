# Session management

> **Purpose:** session records, refresh-token rotation, revocation and device handling.
>
> Task 02. Code: `apps/backend/src/modules/iam/sessions/sessions.service.ts`.

## Session record

One row in `sessions` per logged-in device/app: user, `device_id` (client-generated stable id,
8–128 chars), `app_type` (`ADMIN_WEB`, `CLINIC_WEB`, `PATIENT_WEB`, `PATIENT_MOBILE`,
`STAFF_MOBILE`), optional device name / OS / OS version / app version, IP, user agent (≤ 512),
`created_at`, `last_activity_at` (written at most once per minute), `expires_at` (absolute),
`revoked_at` + `revoked_reason`, `mfa_verified_at`, `active_clinic_id` (remembered clinic context).

A new login with the same `(user, device_id, app_type)` revokes the previous session
(`REPLACED_BY_NEW_LOGIN`).

## Lifetimes

| Item                         | Default                                                     | Variable                            |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------------- |
| Access token                 | 15 min                                                      | `AUTH_ACCESS_TOKEN_TTL_SECONDS`     |
| Refresh token (idle timeout) | 30 days, renewed on each rotation, capped at session expiry | `AUTH_REFRESH_TOKEN_TTL_SECONDS`    |
| Session (absolute)           | 90 days                                                     | `AUTH_SESSION_MAX_LIFETIME_SECONDS` |

## Refresh token lifecycle

```
login ─▶ RT1 ACTIVE
refresh(RT1) ─▶ RT1 ROTATED (replaced_by = RT2) ; RT2 ACTIVE
refresh(RT2) ─▶ RT2 ROTATED ; RT3 ACTIVE
refresh(RT1) again ─▶ REUSE DETECTED ─▶ session revoked (REFRESH_TOKEN_REUSE),
                                       all ACTIVE tokens → REVOKED, security event
```

- Tokens: 256-bit random, base64url. Stored as **SHA-256 hash only**. Plaintext never touches the
  database or logs.
- Rotation runs in one transaction with row locks (`FOR UPDATE`), so two concurrent refreshes
  with the same token cannot both succeed: the second is treated as reuse.
- Failures (unknown, revoked, expired, reuse, inactive account) all return
  `401 SESSION_INVALID`. The specific reason goes to `security_events`.

## Revocation

| Trigger                           | Scope                    | Reason code                             |
| --------------------------------- | ------------------------ | --------------------------------------- |
| `POST /auth/logout`               | current session          | `LOGOUT`                                |
| `POST /auth/logout-all`           | all sessions of the user | `LOGOUT_ALL`                            |
| `DELETE /sessions/:id`            | one own session          | `USER_REVOKED` (or `LOGOUT` if current) |
| `DELETE /sessions`                | all other sessions       | `USER_REVOKED_OTHERS`                   |
| Refresh token reuse               | that session             | `REFRESH_TOKEN_REUSE`                   |
| Account suspension                | all sessions             | `ACCOUNT_SUSPENDED`                     |
| 2FA enrollment (sensitive change) | all other sessions       | `MFA_ENROLLED`                          |
| Refresh with non-active account   | that session             | `ACCOUNT_NOT_ACTIVE`                    |
| Re-login on same device/app       | previous session         | `REPLACED_BY_NEW_LOGIN`                 |

Revocation is **immediate**: `authenticate` reads the session on every request, so a revoked
session's still-valid access token is rejected at once.

**Clinic membership removal does not revoke sessions.** The account stays valid. Access to that
clinic ends on the next request because memberships are re-read, and a remembered
`active_clinic_id` for that clinic is cleared. Other clinics are unaffected.

Future sensitive account changes (phone change, email change, 2FA reset) must call
`SessionService.revokeAllForUser` in the same transaction.

## Known limitations

- **Strict reuse detection:** a mobile client that sends two parallel refreshes with the same
  token will be logged out. Clients must serialize refreshes. A short grace window is a possible
  future relaxation (OD-08).
- **Web clients** receive refresh tokens in the JSON body. Storing them in `HttpOnly` cookies (with
  CSRF protection) is an open decision (OD-09).
- No scheduled cleanup of expired or revoked rows yet.
- `last_activity_at` granularity is 60 s.
