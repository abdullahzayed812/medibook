-- Migration: create_patient_profiles
-- A patient's identity WITHIN ONE CLINIC (tenant-scoped). Not a shared cross-clinic record.
-- user_id links the profile to a platform account when the patient has one.
-- UNIQUE (clinic_id, id) allows future clinic-scoped tables to reference (patient, clinic).

CREATE TABLE patient_profiles (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id    BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NULL,
  display_name VARCHAR(150) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_patient_profiles_clinic_id (clinic_id, id),
  UNIQUE KEY uq_patient_profiles_clinic_user (clinic_id, user_id),
  KEY ix_patient_profiles_user (user_id),
  CONSTRAINT fk_patient_profiles_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT,
  CONSTRAINT fk_patient_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
