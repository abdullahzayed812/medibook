-- Migration: create_schedule_exceptions
-- Task 04. Date-specific exceptions for branch hours (holidays, temporary closures, exceptional
-- hours) and doctor schedules (leave, partial unavailability, additional working periods).
--   CLOSED       whole local days start_date..end_date (no minutes)
--   UNAVAILABLE  one local date, start_minute..end_minute removed
--   EXTRA        one local date, start_minute..end_minute added
-- Cancelled, never deleted.

CREATE TABLE schedule_exceptions (
  id                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  clinic_id            BIGINT UNSIGNED  NOT NULL,
  branch_id            BIGINT UNSIGNED  NOT NULL,
  owner_type           VARCHAR(16)      NOT NULL,
  assignment_id        BIGINT UNSIGNED  NULL,
  kind                 VARCHAR(16)      NOT NULL,
  start_date           DATE             NOT NULL,
  end_date             DATE             NOT NULL,
  start_minute         SMALLINT UNSIGNED NULL,
  end_minute           SMALLINT UNSIGNED NULL,
  reason               VARCHAR(500)     NOT NULL,
  status               VARCHAR(16)      NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id   BIGINT UNSIGNED  NULL,
  cancelled_at         DATETIME(3)      NULL,
  cancelled_by_user_id BIGINT UNSIGNED  NULL,
  created_at           DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_schedule_exceptions_clinic_id (clinic_id, id),
  KEY ix_schedule_exceptions_branch (clinic_id, branch_id, owner_type, status, start_date),
  KEY ix_schedule_exceptions_assignment (clinic_id, assignment_id, status, start_date),
  CONSTRAINT fk_se_branch FOREIGN KEY (clinic_id, branch_id) REFERENCES clinic_branches (clinic_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_se_assignment FOREIGN KEY (clinic_id, branch_id, assignment_id) REFERENCES doctor_branch_assignments (clinic_id, branch_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_se_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_se_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_se_owner CHECK ((owner_type = 'BRANCH' AND assignment_id IS NULL) OR (owner_type = 'DOCTOR' AND assignment_id IS NOT NULL)),
  CONSTRAINT ck_se_kind CHECK (
    (kind = 'CLOSED' AND start_minute IS NULL AND end_minute IS NULL AND end_date >= start_date)
    OR (kind IN ('UNAVAILABLE', 'EXTRA') AND end_date = start_date AND start_minute IS NOT NULL
        AND end_minute IS NOT NULL AND start_minute < end_minute AND end_minute <= 1440)),
  CONSTRAINT ck_se_status CHECK ((status = 'ACTIVE' AND cancelled_at IS NULL) OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
