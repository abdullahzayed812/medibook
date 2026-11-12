-- Migration: create_doctor_profiles
-- Professional identity of a doctor, independent of any clinic membership (one per user).

CREATE TABLE doctor_profiles (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  display_name   VARCHAR(150) NOT NULL,
  license_number VARCHAR(64)  NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_doctor_profiles_user (user_id),
  CONSTRAINT fk_doctor_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
