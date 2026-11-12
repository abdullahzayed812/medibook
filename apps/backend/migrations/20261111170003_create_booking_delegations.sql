-- Migration: create_booking_delegations
-- Task 05. Authority of a user (delegate) to book for another person. Scope is BOOKING only:
-- a delegation never grants medical-record access or consent authority. Basis:
--   DECLARED  the delegate created the DEPENDENT person and declared the relationship/authority
--   CONSENT   the person's own account granted it (consent_by_user_id)
-- Revoked, never deleted (auditable).

CREATE TABLE booking_delegations (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  delegate_user_id    BIGINT UNSIGNED NOT NULL,
  person_id           BIGINT UNSIGNED NOT NULL,
  relationship        VARCHAR(16)   NOT NULL,
  basis               VARCHAR(16)   NOT NULL,
  authority_statement VARCHAR(500)  NULL,
  consent_by_user_id  BIGINT UNSIGNED NULL,
  scope               VARCHAR(16)   NOT NULL DEFAULT 'BOOKING',
  status              VARCHAR(16)   NOT NULL DEFAULT 'ACTIVE',
  revoked_at          DATETIME(3)   NULL,
  revoked_by_user_id  BIGINT UNSIGNED NULL,
  active_key          TINYINT UNSIGNED AS (IF(status = 'ACTIVE', 1, NULL)) STORED,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_booking_delegations_active (delegate_user_id, person_id, active_key),
  KEY ix_booking_delegations_person (person_id, status),
  CONSTRAINT fk_bd_delegate FOREIGN KEY (delegate_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bd_person FOREIGN KEY (person_id) REFERENCES booking_persons (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bd_consent_by FOREIGN KEY (consent_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_bd_revoked_by FOREIGN KEY (revoked_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_bd_relationship CHECK (relationship IN ('GUARDIAN', 'SPOUSE', 'RELATIVE', 'CAREGIVER', 'OTHER')),
  CONSTRAINT ck_bd_basis CHECK (basis IN ('DECLARED', 'CONSENT')),
  CONSTRAINT ck_bd_scope CHECK (scope = 'BOOKING'),
  CONSTRAINT ck_bd_status CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
