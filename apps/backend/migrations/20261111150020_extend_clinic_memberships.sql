-- Migration: extend_clinic_memberships
-- Adds INACTIVE (deactivated, reversible) to membership statuses and a per-membership public
-- listing flag for doctors. Existing statuses and rows are unchanged.

ALTER TABLE clinic_memberships
  DROP CHECK ck_clinic_memberships_status,
  ADD CONSTRAINT ck_clinic_memberships_status CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'INACTIVE', 'TERMINATED')),
  ADD COLUMN public_listing TINYINT(1) NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_clinic_memberships_public_listing CHECK (public_listing = 0 OR role_code = 'DOCTOR');
