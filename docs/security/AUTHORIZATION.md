# Authorization

> **Purpose:** the permission model, role mappings and how every authorization decision is made.
>
> Task 02. Code: `apps/backend/src/modules/access/`. Catalog: `authorization/catalog.ts`.

## 1. Model

Three mechanisms, combined in one place, `AuthorizationService`:

| Mechanism            | Meaning                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RBAC**             | Fixed system roles (no user-defined roles). Global roles live in `user_global_roles`; clinic roles in `clinic_memberships` (one row per clinic × user × role). |
| **Permission-based** | Code never asks "is the user a manager?". It asks for a permission (`clinic.bookings.manage`). Roles map to permissions in `role_permissions`.                 |
| **Contextual**       | Clinic permissions are evaluated only inside a verified clinic (and optional branch) context. Ownership checks apply to user-owned resources.                  |

### Permission scopes

| Scope      | Granted by                                                   | Extra requirement                                                                             |
| ---------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `PLATFORM` | Global role `SUPER_ADMIN`                                    | **MFA-verified session**, always (`MFA_REQUIRED` / `MFA_ENROLLMENT_REQUIRED`)                 |
| `CLINIC`   | Active, in-window memberships in **the current clinic only** | Verified `TenantContext` (see [TENANT_ISOLATION.md](TENANT_ISOLATION.md)) + branch rule below |
| `PATIENT`  | Global role `PATIENT`                                        | Ownership check on every target resource (`assertOwner`)                                      |

Scopes are enforced in the database too: `role_permissions` has `CHECK (role_scope = permission_scope)`
with composite foreign keys, so a clinic role can never be given a platform permission, and
`user_global_roles` cannot hold clinic roles.

### Branch rule (CLINIC permissions)

Every clinic permission has a level:

- **CLINIC level** (clinic-wide administration): granted only by a membership with `branch_scope = ALL`.
- **BRANCH level** (day-to-day operations): granted by `branch_scope = ALL`, or, when a branch is
  selected (`X-Branch-Id`), by a membership **assigned to that branch**. Branch-assigned members
  without a selected branch get `BRANCH_CONTEXT_REQUIRED` (fail safe).

Only memberships whose role holds the permission count. A receptionist for all branches who is
also a doctor at branch 5 has clinical permissions only at branch 5. The rule is the pure function
`evaluateClinicPermission` and is unit-tested exhaustively.

## 2. Role → permission mapping (initial, **requires review**)

### Platform

| Role          | Permissions                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPER_ADMIN` | `platform.users.view`, `platform.users.manage_status`, `platform.clinics.view`, `platform.clinics.manage`, `platform.memberships.manage`, `platform.security_events.view`, `platform.audit_events.view` |

Task 03 and later add more `platform.*` permissions to SUPER_ADMIN (registrations, doctor
verification, the specialty catalog, plans, subscriptions, settings, ownership review). See
[PLATFORM_AUTHORIZATION.md](../platform/PLATFORM_AUTHORIZATION.md). The code catalog
(`catalog.ts`) is the complete, test-enforced list.

SUPER_ADMIN gets **no implicit clinic permissions**: no access to clinic data or medical records
through the platform role.

### Clinic

| Permission                      | Level  | Owner | Manager | Doctor | Receptionist |
| ------------------------------- | ------ | :---: | :-----: | :----: | :----------: |
| `clinic.settings.manage`        | CLINIC |  ✅   |    —    |   —    |      —       |
| `clinic.memberships.view`       | CLINIC |  ✅   |   ✅    |   —    |      —       |
| `clinic.memberships.manage`     | CLINIC |  ✅   |   ✅    |   —    |      —       |
| `clinic.branches.manage`        | CLINIC |  ✅   |    —    |   —    |      —       |
| `clinic.doctors.manage`         | CLINIC |  ✅   |   ✅    |   —    |      —       |
| `clinic.services.manage`        | CLINIC |  ✅   |   ✅    |   —    |      —       |
| `clinic.data.export`            | CLINIC |  ✅   |    —    |   —    |      —       |
| `clinic.schedules.manage`       | BRANCH |  ✅   |   ✅    |   —    |      —       |
| `clinic.patients.view`          | BRANCH |  ✅   |   ✅    |   ✅   |      ✅      |
| `clinic.patients.manage`        | BRANCH |  ✅   |   ✅    |   —    |      ✅      |
| `clinic.bookings.view`          | BRANCH |  ✅   |   ✅    |   ✅   |      ✅      |
| `clinic.bookings.manage`        | BRANCH |  ✅   |   ✅    |   —    |      ✅      |
| `clinic.queue.manage`           | BRANCH |  ✅   |   ✅    |   ✅   |      ✅      |
| `clinic.consultations.start`    | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.medical_records.view`   | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.medical_records.create` | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.medical_records.update` | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.prescriptions.manage`   | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.payments.manage`        | BRANCH |  ✅   |   ✅    |   —    |      ✅      |
| `clinic.reports.view`           | BRANCH |  ✅   |   ✅    |   —    |      —       |

Design choices to review:

- **Owners have no clinical permissions** (medical records, prescriptions, consultations). An owner
  who practises gets them through a separate `DOCTOR` membership in the same clinic.
- **Managers** cannot change settings, branches or export data, and cannot grant OWNER/MANAGER.
- **Receptionists** handle patients, bookings, queue and payments, with no clinical access.
- **Doctors** have clinical permissions plus read access to patients and bookings, and the queue.

### Patient

| Role      | Permissions                                                                            |
| --------- | -------------------------------------------------------------------------------------- |
| `PATIENT` | `patient.profile.view_own`, `patient.bookings.view_own`, `patient.bookings.manage_own` |

`PATIENT` is granted automatically, and audited, on the user's first patient booking use (Task 05, ADR-045; resolves OD-07).

## 3. Membership management rules (privilege escalation)

Enforced by `MembershipService` on every grant, status change and branch change:

1. Nobody can change **their own** memberships.
2. Clinic actors need `clinic.memberships.manage` **in that clinic**, and may only manage roles in
   `ASSIGNABLE_CLINIC_ROLES`:
   - CLINIC_OWNER → CLINIC_MANAGER, DOCTOR, RECEPTIONIST
   - CLINIC_MANAGER → DOCTOR, RECEPTIONIST
   - DOCTOR, RECEPTIONIST → none
3. `CLINIC_OWNER` memberships (and any other role) can be managed with
   `platform.memberships.manage` (MFA-verified SUPER_ADMIN).
4. Membership ids of another clinic behave as "not found".

Status transitions: `PENDING → ACTIVE | TERMINATED`, `ACTIVE → SUSPENDED | TERMINATED`,
`SUSPENDED → ACTIVE | TERMINATED`, `TERMINATED → ACTIVE` (re-activation). Each change writes
`clinic_membership_events` and an `audit_events` row.

## 4. Using it in code

```ts
router.get(
  '/clinic/bookings',
  authenticate, // identity + live session + account status
  clinicContext(resolver), // verified req.tenant (or 400/403)
  requirePermission(authz, 'clinic.bookings.view'),
  controller.list, // uses req.tenant.scope in repositories
);
```

- Never check roles in controllers or services. Ask `authz.check/assert` or use `requirePermission`.
- Clinic permissions without a tenant context are refused (`CLINIC_CONTEXT_REQUIRED`), even if a
  route forgets `clinicContext`.
- Hiding UI elements is never authorization. Every protected endpoint must use the guards.
- Denials: 403 `FORBIDDEN` (no permission), 403 `MFA_REQUIRED` / `MFA_ENROLLMENT_REQUIRED`,
  400 `CLINIC_CONTEXT_REQUIRED` / `BRANCH_CONTEXT_REQUIRED`, 403 `CLINIC_ACCESS_DENIED` /
  `BRANCH_ACCESS_DENIED`. Resources outside the caller's scope or ownership return 404.

## 5. Immediate effect

No roles or permissions are stored in tokens. Every check reads current state: global roles,
memberships (status and effective window), branch assignments and `role_permissions`. Suspending
or terminating a membership, revoking a global role, or changing the mapping affects the **next
request**. Integration tests verify each of these.

## 6. Changing the catalog

1. Edit `catalog.ts` (`PERMISSIONS`, `ROLE_PERMISSIONS`, levels).
2. Add a migration that inserts or deletes the matching `permissions` / `role_permissions` rows
   (never edit the seed migrations).
3. Update the tables above and add a DECISIONS.md entry for any change to role boundaries.
4. The `identity-schema` integration test fails until code and database agree.
