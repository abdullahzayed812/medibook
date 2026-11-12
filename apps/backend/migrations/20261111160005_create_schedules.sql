-- Migration: create_schedules
-- Task 04. Recurring weekly schedules: branch operating hours (owner_type BRANCH) and doctor
-- working schedules (owner_type DOCTOR, bound to a doctor branch assignment). A schedule is a
-- dated version (effective_from .. effective_until, inclusive local dates); its periods are
-- immutable — a change is a new revision, so history is never rewritten. Times are wall-clock
-- minutes in the branch's IANA time zone, NOT UTC. Non-overlap of active versions is enforced
-- by the service under the clinic row lock (date ranges cannot be a unique key).

CREATE TABLE schedules (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id              BIGINT UNSIGNED NOT NULL,
  branch_id              BIGINT UNSIGNED NOT NULL,
  owner_type             VARCHAR(16)   NOT NULL,
  assignment_id          BIGINT UNSIGNED NULL,
  status                 VARCHAR(16)   NOT NULL DEFAULT 'ACTIVE',
  effective_from         DATE          NOT NULL,
  effective_until        DATE          NULL,
  revision               INT UNSIGNED  NOT NULL DEFAULT 1,
  supersedes_schedule_id BIGINT UNSIGNED NULL,
  note                   VARCHAR(500)  NULL,
  created_by_user_id     BIGINT UNSIGNED NULL,
  deactivated_at         DATETIME(3)   NULL,
  deactivated_by_user_id BIGINT UNSIGNED NULL,
  deactivation_reason    VARCHAR(1000) NULL,
  created_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_schedules_clinic_id (clinic_id, id),
  KEY ix_schedules_branch (clinic_id, branch_id, owner_type, status, effective_from),
  KEY ix_schedules_assignment (clinic_id, assignment_id, status, effective_from),
  KEY ix_schedules_supersedes (supersedes_schedule_id),
  CONSTRAINT fk_schedules_branch FOREIGN KEY (clinic_id, branch_id) REFERENCES clinic_branches (clinic_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_schedules_assignment FOREIGN KEY (clinic_id, branch_id, assignment_id) REFERENCES doctor_branch_assignments (clinic_id, branch_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_schedules_supersedes FOREIGN KEY (supersedes_schedule_id) REFERENCES schedules (id) ON DELETE SET NULL,
  CONSTRAINT fk_schedules_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_schedules_deactivated_by FOREIGN KEY (deactivated_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_schedules_owner CHECK ((owner_type = 'BRANCH' AND assignment_id IS NULL) OR (owner_type = 'DOCTOR' AND assignment_id IS NOT NULL)),
  CONSTRAINT ck_schedules_status CHECK ((status = 'ACTIVE' AND deactivated_at IS NULL) OR (status = 'INACTIVE' AND deactivated_at IS NOT NULL)),
  CONSTRAINT ck_schedules_dates CHECK (effective_until IS NULL OR effective_until >= effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Weekly periods of one schedule version. day_of_week: ISO 1 = Monday … 7 = Sunday.
-- Minutes from local midnight; end_minute 1440 = midnight at the end of the day. A period never
-- crosses midnight (an overnight shift is two periods). BREAK periods lie inside a WORK period.
CREATE TABLE schedule_periods (
  id           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  clinic_id    BIGINT UNSIGNED  NOT NULL,
  schedule_id  BIGINT UNSIGNED  NOT NULL,
  day_of_week  TINYINT UNSIGNED NOT NULL,
  kind         VARCHAR(8)       NOT NULL,
  start_minute SMALLINT UNSIGNED NOT NULL,
  end_minute   SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY ix_schedule_periods_schedule (clinic_id, schedule_id, day_of_week),
  CONSTRAINT fk_schedule_periods_schedule FOREIGN KEY (clinic_id, schedule_id) REFERENCES schedules (clinic_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_schedule_periods_day CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT ck_schedule_periods_kind CHECK (kind IN ('WORK', 'BREAK')),
  CONSTRAINT ck_schedule_periods_range CHECK (start_minute < end_minute AND end_minute <= 1440)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
