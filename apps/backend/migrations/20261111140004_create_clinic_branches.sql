-- Migration: create_clinic_branches
-- Minimal branch anchor. UNIQUE (clinic_id, id) lets child tables reference (branch, clinic)
-- together, so a row can never link a branch of clinic A to a record of clinic B.

CREATE TABLE clinic_branches (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id BIGINT UNSIGNED NOT NULL,
  name      VARCHAR(200) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_clinic_branches_clinic_id (clinic_id, id),
  CONSTRAINT fk_clinic_branches_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
