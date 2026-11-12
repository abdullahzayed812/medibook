-- Migration: create_specialties
-- Specialty catalog managed by Super Admins (no medical data invented in seeds).

CREATE TABLE specialties (
  code       VARCHAR(50)  NOT NULL,
  name       VARCHAR(150) NOT NULL,
  active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code),
  CONSTRAINT ck_specialties_code CHECK (code REGEXP '^[a-z0-9]+(_[a-z0-9]+)*$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE doctor_specialties (
  doctor_profile_id BIGINT UNSIGNED NOT NULL,
  specialty_code    VARCHAR(50) NOT NULL,
  is_primary        TINYINT(1)  NOT NULL DEFAULT 0,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doctor_profile_id, specialty_code),
  KEY ix_doctor_specialties_code (specialty_code),
  CONSTRAINT fk_ds_profile FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles (id) ON DELETE CASCADE,
  CONSTRAINT fk_ds_specialty FOREIGN KEY (specialty_code) REFERENCES specialties (code) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
