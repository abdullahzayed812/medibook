-- Migration: create_clinic_suspensions
-- Temporary suspensions. scope FULL = normal operations blocked (continuity-of-care only through
-- explicit access exceptions); NEW_OPERATIONS = only new operational transactions blocked.
-- ended_at set on formal reinstatement. At most one open suspension per clinic (service rule,
-- serialized by a clinic row lock; open_key enforces it in the schema too).

CREATE TABLE clinic_suspensions (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id             BIGINT UNSIGNED NOT NULL,
  scope                 VARCHAR(20)   NOT NULL,
  reason                VARCHAR(1000) NOT NULL,
  starts_at             DATETIME(3)   NOT NULL,
  expected_end_at       DATETIME(3)   NULL,
  suspended_by_user_id  BIGINT UNSIGNED NOT NULL,
  ended_at              DATETIME(3)   NULL,
  ended_by_user_id      BIGINT UNSIGNED NULL,
  end_reason            VARCHAR(1000) NULL,
  open_key              BIGINT UNSIGNED AS (IF(ended_at IS NULL, clinic_id, NULL)) STORED,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_clinic_suspensions_open (open_key),
  UNIQUE KEY uq_clinic_suspensions_clinic_id (clinic_id, id),
  CONSTRAINT fk_cs_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cs_by FOREIGN KEY (suspended_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cs_ended_by FOREIGN KEY (ended_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_cs_scope CHECK (scope IN ('FULL', 'NEW_OPERATIONS')),
  CONSTRAINT ck_cs_window CHECK (expected_end_at IS NULL OR expected_end_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
