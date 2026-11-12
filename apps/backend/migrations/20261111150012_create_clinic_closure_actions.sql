-- Migration: create_clinic_closure_actions
-- Required actions ("blockers") that must be RESOLVED or WAIVED before a closure can complete:
-- active bookings, open queue, patient notification, record retention, memberships, etc.
-- Future modules contribute automatically detected actions; Task 03 creates the checklist.

CREATE TABLE clinic_closure_actions (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  closure_request_id    BIGINT UNSIGNED NOT NULL,
  clinic_id             BIGINT UNSIGNED NOT NULL,
  action_type           VARCHAR(40)   NOT NULL,
  status                VARCHAR(16)   NOT NULL DEFAULT 'OPEN',
  details               VARCHAR(1000) NULL,
  resolution_note       VARCHAR(1000) NULL,
  resolved_by_user_id   BIGINT UNSIGNED NULL,
  resolved_at           DATETIME(3)   NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cca_request_type (closure_request_id, action_type),
  CONSTRAINT fk_cca_request FOREIGN KEY (clinic_id, closure_request_id) REFERENCES clinic_closure_requests (clinic_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_cca_resolved_by FOREIGN KEY (resolved_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_cca_status CHECK (status IN ('OPEN', 'RESOLVED', 'WAIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
