-- Migration: extend_clinics
-- Operational clinic record. A clinic row exists only once a registration is APPROVED
-- (approved_at). Registration status, operational status, subscription status and marketplace
-- visibility are separate concepts stored in separate places.
-- Additive only: existing rows get operational_status = ACTIVE and no registration.

ALTER TABLE clinics
  ADD COLUMN clinic_type                VARCHAR(32)  NOT NULL DEFAULT 'GENERAL' AFTER name,
  ADD COLUMN description                TEXT         NULL,
  ADD COLUMN contact_phone              VARCHAR(16)  NULL,
  ADD COLUMN contact_email              VARCHAR(254) NULL,
  ADD COLUMN website                    VARCHAR(255) NULL,
  ADD COLUMN address_line1              VARCHAR(200) NULL,
  ADD COLUMN address_line2              VARCHAR(200) NULL,
  ADD COLUMN city                       VARCHAR(100) NULL,
  ADD COLUMN region                     VARCHAR(100) NULL,
  ADD COLUMN postal_code                VARCHAR(20)  NULL,
  ADD COLUMN country_code               CHAR(2)      NULL,
  ADD COLUMN latitude                   DECIMAL(9,6) NULL,
  ADD COLUMN longitude                  DECIMAL(9,6) NULL,
  ADD COLUMN legal_name                 VARCHAR(200) NULL,
  ADD COLUMN business_registration_no   VARCHAR(100) NULL,
  ADD COLUMN tax_id                     VARCHAR(100) NULL,
  ADD COLUMN operational_status         VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN operational_status_changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN approved_at                DATETIME(3)  NULL,
  ADD COLUMN approved_by_user_id        BIGINT UNSIGNED NULL,
  ADD COLUMN public_visibility          TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN doctors_public_visibility  TINYINT(1)   NOT NULL DEFAULT 1,
  ADD COLUMN services_public_visibility TINYINT(1)   NOT NULL DEFAULT 1,
  ADD KEY ix_clinics_operational_status (operational_status),
  ADD KEY ix_clinics_marketplace (public_visibility, operational_status),
  ADD CONSTRAINT fk_clinics_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT ck_clinics_operational_status CHECK (operational_status IN ('ACTIVE', 'SUSPENDED', 'CLOSING', 'CLOSED')),
  ADD CONSTRAINT ck_clinics_type CHECK (clinic_type IN ('GENERAL', 'SPECIALTY', 'DENTAL', 'POLYCLINIC', 'DIAGNOSTIC', 'OTHER')),
  ADD CONSTRAINT ck_clinics_lat CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT ck_clinics_lng CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
