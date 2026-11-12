-- Migration: extend_doctor_profiles
-- Global professional profile (not owned by any clinic). Additive only.

ALTER TABLE doctor_profiles
  ADD COLUMN bio                    TEXT          NULL,
  ADD COLUMN qualifications         JSON          NULL,
  ADD COLUMN license_authority      VARCHAR(200)  NULL,
  ADD COLUMN license_country        CHAR(2)       NULL,
  ADD COLUMN license_expires_on     DATE          NULL,
  ADD COLUMN profile_image_key      VARCHAR(255)  NULL,
  ADD COLUMN public_visibility      TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN verification_status    VARCHAR(16)   NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN verification_changed_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN profile_status         VARCHAR(16)   NOT NULL DEFAULT 'ACTIVE',
  ADD KEY ix_doctor_profiles_verification (verification_status, id),
  ADD CONSTRAINT ck_doctor_profiles_verification CHECK (verification_status IN ('UNVERIFIED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED')),
  ADD CONSTRAINT ck_doctor_profiles_status CHECK (profile_status IN ('ACTIVE', 'INACTIVE'));
