-- Migration: create_identity_support_cases
-- Task 05.1. Support-assisted ownership verification for guest bookings without a claim code
-- and other ambiguous ownership. Opened by the account holder; decided by a Super Admin
-- (platform.identity.resolve, MFA, never the requester). Append-only outcome; audited.

CREATE TABLE identity_support_cases (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  requested_by_user_id  BIGINT UNSIGNED NOT NULL,
  phone_hash            CHAR(64)        NOT NULL,
  candidate_person_ids  JSON            NOT NULL,
  booking_reference     BIGINT UNSIGNED NULL,
  statement             VARCHAR(1000)   NOT NULL,
  status                VARCHAR(16)     NOT NULL DEFAULT 'OPEN',
  resolved_person_id    BIGINT UNSIGNED NULL,
  resolved_by_user_id   BIGINT UNSIGNED NULL,
  resolution_reason     VARCHAR(1000)   NULL,
  verification_note     VARCHAR(1000)   NULL,
  resolved_at           DATETIME(3)     NULL,
  created_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_isc_status (status, id),
  KEY ix_isc_requester (requested_by_user_id, id),
  CONSTRAINT fk_isc_requester FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_isc_person FOREIGN KEY (resolved_person_id) REFERENCES booking_persons (id) ON DELETE RESTRICT,
  CONSTRAINT fk_isc_resolver FOREIGN KEY (resolved_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_isc_status CHECK (
    (status = 'OPEN' AND resolved_at IS NULL)
    OR (status = 'LINKED' AND resolved_at IS NOT NULL AND resolved_person_id IS NOT NULL)
    OR (status = 'REJECTED' AND resolved_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
