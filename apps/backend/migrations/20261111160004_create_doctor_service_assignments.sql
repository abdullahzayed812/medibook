-- Migration: create_doctor_service_assignments
-- Task 04. Explicit doctor ↔ service eligibility at one branch. Composite FKs pin the doctor
-- assignment and the offering to the SAME clinic and branch. History kept (ended rows); at most
-- one ACTIVE row per (assignment, offering) via active_key.

CREATE TABLE doctor_service_assignments (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id             BIGINT UNSIGNED NOT NULL,
  branch_id             BIGINT UNSIGNED NOT NULL,
  assignment_id         BIGINT UNSIGNED NOT NULL,
  offering_id           BIGINT UNSIGNED NOT NULL,
  status                VARCHAR(16)       NOT NULL DEFAULT 'ACTIVE',
  duration_minutes      SMALLINT UNSIGNED NULL,
  price_minor           BIGINT UNSIGNED   NULL,
  created_by_user_id    BIGINT UNSIGNED   NULL,
  ended_at              DATETIME(3)       NULL,
  ended_by_user_id      BIGINT UNSIGNED   NULL,
  active_key            TINYINT UNSIGNED AS (IF(status = 'ACTIVE', 1, NULL)) STORED,
  created_at            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_dsa_active (clinic_id, assignment_id, offering_id, active_key),
  KEY ix_dsa_offering (clinic_id, offering_id, status),
  KEY ix_dsa_assignment (clinic_id, branch_id, assignment_id, status),
  CONSTRAINT fk_dsa_assignment FOREIGN KEY (clinic_id, branch_id, assignment_id) REFERENCES doctor_branch_assignments (clinic_id, branch_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_dsa_offering FOREIGN KEY (clinic_id, branch_id, offering_id) REFERENCES branch_service_offerings (clinic_id, branch_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_dsa_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_dsa_ended_by FOREIGN KEY (ended_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_dsa_status CHECK ((status = 'ACTIVE' AND ended_at IS NULL) OR (status = 'ENDED' AND ended_at IS NOT NULL)),
  CONSTRAINT ck_dsa_duration CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 720),
  CONSTRAINT ck_dsa_price CHECK (price_minor IS NULL OR price_minor <= 1000000000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
