-- Migration: create_booking_identity_links
-- Task 05.2. Append-only history of identity associations: one row per person moved from one
-- identity to another, with source, evidence, actor and (if corrected) revocation. Bookings,
-- persons, profiles and audit history are never rewritten by a link or its revocation.

CREATE TABLE booking_identity_links (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  person_id           BIGINT UNSIGNED NOT NULL,
  from_identity_id    BIGINT UNSIGNED NOT NULL,
  to_identity_id      BIGINT UNSIGNED NOT NULL,
  source              VARCHAR(24)     NOT NULL,
  evidence_type       VARCHAR(24)     NOT NULL,
  case_id             BIGINT UNSIGNED NULL,
  actor_user_id       BIGINT UNSIGNED NULL,
  reason              VARCHAR(1000)   NULL,
  status              VARCHAR(16)     NOT NULL DEFAULT 'ACTIVE',
  revoked_at          DATETIME(3)     NULL,
  revoked_by_user_id  BIGINT UNSIGNED NULL,
  revocation_reason   VARCHAR(1000)   NULL,
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_bil_person (person_id, status),
  KEY ix_bil_to (to_identity_id, status),
  CONSTRAINT fk_bil_person FOREIGN KEY (person_id) REFERENCES booking_persons (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bil_from FOREIGN KEY (from_identity_id) REFERENCES booking_identities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bil_to FOREIGN KEY (to_identity_id) REFERENCES booking_identities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bil_case FOREIGN KEY (case_id) REFERENCES identity_support_cases (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bil_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bil_revoker FOREIGN KEY (revoked_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_bil_source CHECK (source IN ('CLAIM_CODE', 'SUPPORT_CASE', 'MIGRATION_CLAIM')),
  CONSTRAINT ck_bil_evidence CHECK (evidence_type IN ('CLAIM_CODE', 'ID_DOCUMENT', 'BOOKING_DETAILS', 'CLINIC_ATTESTATION', 'OTHER')),
  CONSTRAINT ck_bil_status CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL)),
  CONSTRAINT ck_bil_distinct CHECK (from_identity_id <> to_identity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Backfill: Task 05.1 claims (claim code or support case) → link to the owner's SELF identity.
INSERT INTO booking_identity_links (person_id, from_identity_id, to_identity_id, source, evidence_type, actor_user_id, reason)
SELECT g.id, g.identity_id, s.identity_id, 'MIGRATION_CLAIM', 'CLAIM_CODE', g.claimed_by_user_id, 'Task 05.2 backfill of a verified Task 05.1 claim'
  FROM booking_persons g JOIN booking_persons s ON s.user_id = g.claimed_by_user_id AND s.kind = 'SELF'
 WHERE g.kind = 'GUEST' AND g.claimed_by_user_id IS NOT NULL AND g.identity_id <> s.identity_id;

UPDATE booking_persons g JOIN booking_persons s ON s.user_id = g.claimed_by_user_id AND s.kind = 'SELF'
   SET g.identity_id = s.identity_id
 WHERE g.kind = 'GUEST' AND g.claimed_by_user_id IS NOT NULL;
