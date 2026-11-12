# Identity architecture

> **Purpose:** how accounts, global roles, clinic memberships and sessions fit together.
>
> Task 02. Related: [AUTHENTICATION](../security/AUTHENTICATION.md) · [AUTHORIZATION](../security/AUTHORIZATION.md) ·
> [TENANT_ISOLATION](../security/TENANT_ISOLATION.md) · [IDENTITY_SCHEMA](../database/IDENTITY_SCHEMA.md) ·
> [SESSION_MANAGEMENT](../security/SESSION_MANAGEMENT.md) · [THREAT_MODEL](../security/THREAT_MODEL.md)

## 1. Identity model

One person has **one user account** and can hold many roles across many clinics.

```
User account (users) ─ global identity + login credential (verified phone) + account status
 ├─ User profile (user_profiles)            general, non-medical info (1:1)
 ├─ Doctor profile (doctor_profiles)        professional identity, independent of clinics (0..1)
 ├─ Global roles (user_global_roles)        SUPER_ADMIN, PATIENT
 ├─ Clinic memberships (clinic_memberships) one row per clinic × role, with status, effective
 │    │                                     dates, branch scope, activation/termination history
 │    └─ Branch assignments (clinic_membership_branches)
 ├─ Patient profiles (patient_profiles)     identity AS A PATIENT OF ONE CLINIC (0..n, one per clinic)
 ├─ Sessions → refresh tokens               one per device/app
 └─ 2FA credentials, recovery codes
```

Key separations:

| Concept                         | Is NOT                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Account status (`users.status`) | membership status, clinic operational status, clinic subscription status                                                 |
| Doctor profile                  | a clinic membership. A doctor works at clinics through `DOCTOR` memberships                                              |
| Patient profile                 | a shared medical record. Each clinic has its own profile row (`clinic_id`), optionally linked to the account (`user_id`) |
| Global roles                    | clinic roles. Database CHECKs make it impossible to store one as the other                                               |

Supported combinations (tested): owner of clinic A + doctor in clinic B; owner + doctor in the same
clinic (two membership rows); doctor in several clinics; any account + `PATIENT` role.

## 2. Account states

| Status                 | Meaning                                                            | Login                                             |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `PENDING_VERIFICATION` | Created by someone else (future invitations); phone not yet proven | OTP success → `ACTIVE`                            |
| `ACTIVE`               | Normal                                                             | allowed                                           |
| `SUSPENDED`            | Blocked by a platform admin; all sessions revoked at suspension    | refused (`ACCOUNT_SUSPENDED`) after a correct OTP |
| `INACTIVE`             | Deactivated (workflow not implemented)                             | refused (`ACCOUNT_INACTIVE`)                      |

Suspension and reactivation: `POST /api/v1/admin/users/:id/suspend|reactivate`
(`platform.users.manage_status`, MFA). They are recorded in `security_events` and `audit_events`.
Reactivation does **not** restore old sessions. Deletion workflows are out of scope.

## 3. Module structure (backend)

| Module             | Responsibility                                                                                                                    | Depends on      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `audit`            | Append-only `security_events` and `audit_events` writers/readers                                                                  | —               |
| `iam`              | Users, profiles, phone normalization, OTP, access tokens, sessions/refresh tokens, 2FA, account status, `authenticate` middleware | `audit`         |
| `access`           | Permission catalog, `AuthorizationService`, memberships, tenant context, `ClinicScope`, `requirePermission`                       | `iam`, `audit`  |
| `patient-profiles` | Tenant-scoped repository (reference pattern)                                                                                      | `access`        |
| `platform-admin`   | Admin endpoints (suspend/reactivate)                                                                                              | `iam`, `access` |

`src/container.ts` is the composition root. `iam` does not import `access` (no cycles); the list
of roles requiring MFA is defined in `iam` (`MFA_REQUIRED_GLOBAL_ROLES`).

## 4. API endpoints (`/api/v1`)

Responses: success `{ data }`, lists with pagination `{ data, page: { limit, nextCursor } }`, errors
`{ error: { code, message, requestId, details? } }`.

| Group    | Method & path                                | Auth                                            | Notes                                                                                              |
| -------- | -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Auth     | `POST /auth/otp/request`                     | public                                          | `{ phone }` → 202 `{ challengeId, expiresAt, resendAvailableAt }` (same for existing/new accounts) |
|          | `POST /auth/otp/verify`                      | public                                          | `{ challengeId, phone, code, device }` → tokens, session id, `account`, `mfaRequired`              |
|          | `POST /auth/refresh`                         | refresh token                                   | `{ refreshToken }` → rotated pair                                                                  |
|          | `POST /auth/logout`                          | bearer                                          | revokes current session (204)                                                                      |
|          | `POST /auth/logout-all`                      | bearer                                          | revokes all sessions (204)                                                                         |
| Account  | `GET /me`                                    | bearer                                          | account, profile, doctor profile, MFA status                                                       |
|          | `GET /me/roles`                              | bearer                                          | `{ global, clinics: [{ clinicId, clinicName, roles }] }` (active memberships)                      |
|          | `GET /me/memberships`                        | bearer                                          | all memberships with status/branches/dates                                                         |
|          | `GET /me/permissions`                        | bearer (+ optional `X-Clinic-Id`/`X-Branch-Id`) | platform (+ `mfaSatisfied`), patient, clinic permissions for the validated context                 |
|          | `GET /me/security-events?limit&cursor`       | bearer                                          | own security events, paginated                                                                     |
| Sessions | `GET /sessions`                              | bearer                                          | active sessions, `current` flag                                                                    |
|          | `DELETE /sessions/:sessionId`                | bearer                                          | revoke one own session (foreign id → 404)                                                          |
|          | `DELETE /sessions`                           | bearer                                          | revoke all **other** sessions                                                                      |
| Context  | `GET /context/clinics`                       | bearer                                          | clinics with an active membership                                                                  |
|          | `POST /context/clinic`                       | bearer                                          | `{ clinicId \| null }` remember (verified) clinic on the session                                   |
|          | `GET /context/branches`                      | bearer + clinic context                         | branches the caller may act in                                                                     |
| 2FA      | `GET /security/mfa`                          | bearer                                          | status                                                                                             |
|          | `POST /security/mfa/totp/enrollment`         | bearer                                          | start: secret + `otpauth://` URI (201)                                                             |
|          | `POST /security/mfa/totp/enrollment/confirm` | bearer                                          | `{ code }` → activates, returns recovery codes once                                                |
|          | `POST /security/mfa/verify`                  | bearer                                          | `{ code }` or `{ recoveryCode }` → session MFA-verified                                            |
|          | `POST /security/mfa/recovery-codes`          | bearer + MFA-verified session                   | regenerate recovery codes                                                                          |
| Admin    | `POST /admin/users/:userId/suspend`          | `platform.users.manage_status` + MFA            | `{ reason }`                                                                                       |
|          | `POST /admin/users/:userId/reactivate`       | same                                            | `{ reason }`                                                                                       |

Membership management (grant / status change / branch change) exists as `MembershipService`
(identity infrastructure). Its HTTP endpoints belong to the clinic-management task.

## 5. Operator tooling

- `npm run secrets:generate`: prints `AUTH_SECRET`, an Ed25519 signing key, a key id and
  `MFA_ENCRYPTION_KEY` for `.env` (development/bootstrap; production uses a secrets manager).
- `npm run role:grant -- <phone> SUPER_ADMIN` / `role:revoke`: bootstrap or remove global roles
  for an existing account (audited with actor = NULL).
