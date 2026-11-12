-- Migration: create_clinic_closure_requests
-- Controlled permanent closure: owner request → Super Admin decision → CLOSING with required
-- actions (blockers) → completion (CLOSED). Records are never deleted.

CREATE TABLE clinic_closure_requests (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id             BIGINT UNSIGNED NOT NULL,
  status                VARCHAR(20)   NOT NULL DEFAULT 'PENDING_REVIEW',
  reason                VARCHAR(2000) NOT NULL,
  requested_effective_date DATE       NULL,
  requested_by_user_id  BIGINT UNSIGNED NOT NULL,
  decided_by_user_id    BIGINT UNSIGNED NULL,
  decided_at            DATETIME(3)   NULL,
  decision_reason       VARCHAR(1000) NULL,
  completed_by_user_id  BIGINT UNSIGNED NULL,
  completed_at          DATETIME(3)   NULL,
  open_key              BIGINT UNSIGNED AS (IF(status IN ('PENDING_REVIEW', 'APPROVED'), clinic_id, NULL)) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ccr_open (open_key),
  UNIQUE KEY uq_ccr_clinic_id (clinic_id, id),
  KEY ix_ccr_status (status, id),
  CONSTRAINT fk_ccr_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ccr_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ccr_decided_by FOREIGN KEY (decided_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ccr_completed_by FOREIGN KEY (completed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_ccr_status CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
