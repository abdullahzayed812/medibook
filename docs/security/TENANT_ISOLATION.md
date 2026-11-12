# Tenant isolation

> **Purpose:** how clinic data is isolated in the shared database, and how that is enforced and tested.
>
> Task 02. One MySQL database, shared tables, `clinic_id` boundary. Resolves open decision OD-03.

## 1. Principles

1. **Never trust a client-supplied clinic id.** A clinic id from a header or session is only a
   _request_. It becomes context only after an active, in-window membership is verified in MySQL
   for this request.
2. **Context is per request.** `req.tenant` is created per request; there are no globals, no
   AsyncLocalStorage singletons and no caches. Concurrent requests with different clinics cannot
   leak into each other (tested with 40 interleaved parallel requests).
3. **Fail safe.** No context → `CLINIC_CONTEXT_REQUIRED` (400) for clinic-scoped routes. An unknown
   clinic and a clinic without membership give the same `CLINIC_ACCESS_DENIED` (403).
4. **Out-of-scope resources do not exist.** Ids of another clinic's rows return **404**, the same as
   nonexistent ids, so manipulated ids reveal nothing.

## 2. Layers of defence

| Layer              | Mechanism                                                                                                                                                                        | Where                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Database           | Composite FKs carrying `clinic_id` (`(membership_id, clinic_id)`, `(clinic_id, branch_id)`); `UNIQUE (clinic_id, id)` on clinic-scoped tables so future children can do the same | migrations                                   |
| Context resolution | `TenantContextResolver.resolve(userId, clinicId, branchId)`: id format check, active membership, effective dates, branch coverage, branch belongs to clinic                      | `access/tenancy/tenant-context.ts`           |
| Middleware         | `clinicContext(resolver)` reads `X-Clinic-Id`, else the session's remembered clinic (re-validated every request). Body, query and path clinic ids are ignored                    | same                                         |
| Type system        | `ClinicScope`: private constructor, created only by the resolver after verification. Repositories of clinic-scoped tables accept a `ClinicScope`, **never a raw clinic id**      | `access/tenancy/clinic-scope.ts`             |
| Lint               | ESLint `no-restricted-imports` blocks `clinic-scope-factory` outside `access/tenancy` (and tests)                                                                                | `eslint.config.js`                           |
| Runtime guard      | `tenantExecutor(db, scope)` rejects any statement without a `clinic_id = ?` predicate (INSERT: `clinic_id` column) or not binding the scope's clinic id                          | `clinic-scope.ts`                            |
| Repository pattern | Every SELECT/UPDATE/DELETE filters `WHERE id = ? AND clinic_id = ?`; `affectedRows = 0` → 404                                                                                    | `patient-profiles.repository.ts` (reference) |
| Authorization      | Clinic permissions are evaluated only from the memberships in `req.tenant`; nothing carries across clinics                                                                       | `AuthorizationService`                       |

## 3. Checklist for every new clinic-scoped table and endpoint

- [ ] Table has `clinic_id BIGINT UNSIGNED NOT NULL` with FK to `clinics`, plus `UNIQUE (clinic_id, id)`.
- [ ] Children reference `(parent_id, clinic_id)` with a composite FK, never `parent_id` alone.
- [ ] `clinic_id` comes first in composite indexes and unique keys used by queries.
- [ ] Repository methods take `scope: ClinicScope` first and run SQL through `tenantExecutor`.
- [ ] Every statement binds `scope.clinicId`, including UPDATE and DELETE.
- [ ] Routes use `authenticate → clinicContext → requirePermission`.
- [ ] Not-found and cross-clinic return the same 404.
- [ ] Tests: cross-clinic read, update and delete, plus a manipulated id, for the new resource.

## 4. Remembered clinic context

`POST /api/v1/context/clinic { clinicId }` stores the choice on the session after verifying
membership (`null` clears it). It is a convenience default only. It is re-validated on every
request, and it is cleared when the membership is suspended or terminated. The `X-Clinic-Id`
header always takes precedence for a single request.

## 5. Branches

`X-Branch-Id` selects a branch inside the clinic. It is accepted only if the branch exists **in
that clinic** and an active membership covers it (`branch_scope = ALL` or an assignment).
Branch-level permissions then require coverage of that branch (see AUTHORIZATION.md §1).

## 6. Known limitations

- The SQL guard is a pattern check (a safety net), not a SQL parser. Correct WHERE clauses remain
  the primary control, together with code review and tests.
- Cross-clinic platform features (SUPER_ADMIN reporting) will need an explicit, audited "platform
  scope" query path. It does not exist yet.
- Background jobs will need a way to obtain a `ClinicScope` from trusted job data (e.g. a
  system-scope factory restricted to the worker). Decide with the first clinic-scoped job.
