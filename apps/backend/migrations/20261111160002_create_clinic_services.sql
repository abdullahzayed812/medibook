-- Migration: create_clinic_services
-- Task 04. Clinic-defined service catalog (bilingual). No platform service catalog exists; a
-- service may optionally reference a platform specialty. Never deleted: deactivation keeps
-- every historical reference valid.

CREATE TABLE clinic_services (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id          BIGINT UNSIGNED NOT NULL,
  code               VARCHAR(50)   NULL,
  name_en            VARCHAR(200)  NULL,
  name_ar            VARCHAR(200)  NULL,
  description_en     VARCHAR(4000) NULL,
  description_ar     VARCHAR(4000) NULL,
  preparation_en     VARCHAR(2000) NULL,
  preparation_ar     VARCHAR(2000) NULL,
  specialty_code     VARCHAR(50)   NULL,
  status             VARCHAR(16)   NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id BIGINT UNSIGNED NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_clinic_services_code (clinic_id, code),
  UNIQUE KEY uq_clinic_services_clinic_id (clinic_id, id),
  KEY ix_clinic_services_status (clinic_id, status, id),
  KEY ix_clinic_services_specialty (specialty_code),
  CONSTRAINT fk_clinic_services_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT,
  CONSTRAINT fk_clinic_services_specialty FOREIGN KEY (specialty_code) REFERENCES specialties (code) ON DELETE RESTRICT,
  CONSTRAINT fk_clinic_services_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_clinic_services_name CHECK (name_en IS NOT NULL OR name_ar IS NOT NULL),
  CONSTRAINT ck_clinic_services_code CHECK (code IS NULL OR code REGEXP '^[a-z0-9]+(_[a-z0-9]+)*$'),
  CONSTRAINT ck_clinic_services_status CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
