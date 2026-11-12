# Doctor professional profiles

> **Purpose:** the global doctor professional profile, the specialty catalog, verification and public exposure.

One user account has **one global DoctorProfile** that no clinic owns, plus any number of
`DOCTOR` clinic memberships.

**Profile fields:** display name, biography, qualifications (title, institution, year), specialties
(from the `specialties` catalog, at most one primary), license number,
authority, country and expiry date, profile image reference (column only; upload belongs to the
future public-media integration), public visibility (the doctor's consent), verification status
and profile status (ACTIVE / INACTIVE).

## Specialty catalog

- The active list is public (`GET /specialties`).
- Creating, renaming and deactivating specialties (`PUT /admin/specialties/:code`, with
  `active: false` as the catalog's soft delete) require **`platform.specialties.manage`**
  (MFA-verified Super Admin), and every change is audited (`SPECIALTY_CHANGED`).
- There is no hard delete. Specialties that doctors reference are protected by
  `ON DELETE RESTRICT`.
- This permission is **separate from `platform.doctors.verify`** (ADR-035). A verify-only
  reviewer cannot change the catalog, and a catalog manager cannot review, verify, reject,
  suspend or reinstate doctors.

## Verification

```
UNVERIFIED ─submit─▶ PENDING_REVIEW ─approve─▶ VERIFIED ─suspend─▶ SUSPENDED ─reinstate─▶ VERIFIED
                          │                                            └─reject─▶ REJECTED
                          └──reject──▶ REJECTED ─resubmit─▶ PENDING_REVIEW
```

- **Submission requires** a license number, a license authority and a MEDICAL_LICENSE document.
- **Only `platform.doctors.verify`** (MFA-verified Super Admin) can decide; a reason is required.
  Clinic owners and managers cannot change global status. Nobody can decide on their own profile.
- **License fields are locked** while the profile is PENDING_REVIEW, VERIFIED or SUSPENDED. Documents can be added only before submission.
- Every decision writes `doctor_verification_history` and an audit event. Reviewer document
  reads are audited.
- **Verification never grants clinic membership or permissions.** A VERIFIED profile is required to
  assign the doctor to a clinic branch; see [DOCTOR_ASSIGNMENTS.md](DOCTOR_ASSIGNMENTS.md).

## Public exposure

A doctor is publicly visible only if **all** of these hold:

- the profile is VERIFIED and ACTIVE;
- the doctor opted in (`public_visibility`);
- a clinic lists the doctor's active DOCTOR membership (`public_listing`, set with `clinic.doctors.manage`);
- that clinic shows doctors (`doctors_public_visibility`);
- that clinic is Marketplace-eligible.

The public projection contains display name, biography, qualifications, specialties and a
verified flag. It never includes license data, documents, user ids or contact data.
