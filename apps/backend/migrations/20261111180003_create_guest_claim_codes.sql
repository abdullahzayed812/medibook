-- Migration: create_guest_claim_codes
-- Task 05.1. Independent ownership proof for a GUEST person: a 256-bit secret shown once to the
-- guest; only its SHA-256 is stored. ACTIVE codes re-attach a guest session (with the same
-- verified phone) and let an account claim the person once (→ USED). Rotation → REVOKED.

CREATE TABLE guest_claim_codes (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  person_id        BIGINT UNSIGNED NOT NULL,
  code_hash        CHAR(64)        NOT NULL,
  status           VARCHAR(16)     NOT NULL DEFAULT 'ACTIVE',
  expires_at       DATETIME(3)     NOT NULL,
  used_at          DATETIME(3)     NULL,
  used_by_user_id  BIGINT UNSIGNED NULL,
  revoked_at       DATETIME(3)     NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_guest_claim_codes_hash (code_hash),
  KEY ix_guest_claim_codes_person (person_id, status),
  CONSTRAINT fk_gcc_person FOREIGN KEY (person_id) REFERENCES booking_persons (id) ON DELETE RESTRICT,
  CONSTRAINT fk_gcc_used_by FOREIGN KEY (used_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_gcc_status CHECK (
    (status = 'ACTIVE' AND used_at IS NULL AND revoked_at IS NULL)
    OR (status = 'USED' AND used_at IS NOT NULL AND used_by_user_id IS NOT NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
