-- Migration: create_doctor_branch_assignments
-- Task 04. Clinic-specific assignment of a doctor (DOCTOR membership + global doctor profile) to
-- a branch. Rows are never deleted: deactivation keeps history. At most one ACTIVE assignment per
-- (clinic, branch, membership) — enforced by active_key (NULL for inactive rows) and serialized
-- by the clinic row lock in the service.

CREATE TABLE doctor_branch_assignments (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id              BIGINT UNSIGNED NOT NULL,
  branch_id              BIGINT UNSIGNED NOT NULL,
  membership_id          BIGINT UNSIGNED NOT NULL,
  doctor_profile_id      BIGINT UNSIGNED NOT NULL,
  status                 VARCHAR(16)   NOT NULL DEFAULT 'ACTIVE',
  notes                  VARCHAR(1000) NULL,
  created_by_user_id     BIGINT UNSIGNED NULL,
  deactivated_at         DATETIME(3)   NULL,
  deactivated_by_user_id BIGINT UNSIGNED NULL,
  deactivation_reason    VARCHAR(1000) NULL,
  active_key             TINYINT UNSIGNED AS (IF(status = 'ACTIVE', 1, NULL)) STORED,
  created_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_dba_active (clinic_id, branch_id, membership_id, active_key),
  UNIQUE KEY uq_dba_clinic_id (clinic_id, id),
  UNIQUE KEY uq_dba_clinic_branch_id (clinic_id, branch_id, id),
  KEY ix_dba_branch_status (clinic_id, branch_id, status, id),
  KEY ix_dba_membership (clinic_id, membership_id, status),
  KEY ix_dba_doctor (doctor_profile_id),
  CONSTRAINT fk_dba_branch FOREIGN KEY (clinic_id, branch_id) REFERENCES clinic_branches (clinic_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_dba_membership FOREIGN KEY (membership_id, clinic_id) REFERENCES clinic_memberships (id, clinic_id) ON DELETE RESTRICT,
  CONSTRAINT fk_dba_doctor FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_dba_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_dba_deactivated_by FOREIGN KEY (deactivated_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_dba_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_dba_deactivation CHECK ((status = 'ACTIVE' AND deactivated_at IS NULL) OR (status = 'INACTIVE' AND deactivated_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
