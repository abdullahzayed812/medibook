-- Migration: extend_clinic_branches
-- Branch details and operational status (ACTIVE / INACTIVE). Additive only.

ALTER TABLE clinic_branches
  ADD COLUMN address_line1 VARCHAR(200) NULL,
  ADD COLUMN address_line2 VARCHAR(200) NULL,
  ADD COLUMN city          VARCHAR(100) NULL,
  ADD COLUMN region        VARCHAR(100) NULL,
  ADD COLUMN postal_code   VARCHAR(20)  NULL,
  ADD COLUMN country_code  CHAR(2)      NULL,
  ADD COLUMN latitude      DECIMAL(9,6) NULL,
  ADD COLUMN longitude     DECIMAL(9,6) NULL,
  ADD COLUMN contact_phone VARCHAR(16)  NULL,
  ADD COLUMN contact_email VARCHAR(254) NULL,
  ADD COLUMN time_zone     VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  ADD COLUMN status        VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN settings      JSON         NULL,
  ADD KEY ix_clinic_branches_clinic_status (clinic_id, status),
  ADD CONSTRAINT ck_clinic_branches_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  ADD CONSTRAINT ck_clinic_branches_lat CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT ck_clinic_branches_lng CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
