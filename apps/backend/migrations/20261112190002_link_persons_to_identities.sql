-- Migration: link_persons_to_identities
-- Task 05.2. Every booking person gets its own identity (origin_identity_id, immutable) and a
-- current identity_id (moved only by a verified link; reverted on correction). Existing persons
-- get identity id = person id; later identities continue from the auto-increment.
-- Guest persons already claimed under Task 05.1 (claim code / support case — verified proofs)
-- are linked to their owner's SELF identity, with a link row for history.

ALTER TABLE booking_persons
  ADD COLUMN identity_id BIGINT UNSIGNED NULL,
  ADD COLUMN origin_identity_id BIGINT UNSIGNED NULL;

INSERT INTO booking_identities (id) SELECT id FROM booking_persons;
UPDATE booking_persons SET identity_id = id, origin_identity_id = id;

ALTER TABLE booking_persons
  MODIFY identity_id BIGINT UNSIGNED NOT NULL,
  MODIFY origin_identity_id BIGINT UNSIGNED NOT NULL,
  ADD KEY ix_booking_persons_identity (identity_id),
  ADD UNIQUE KEY uq_booking_persons_origin (origin_identity_id),
  ADD CONSTRAINT fk_booking_persons_identity FOREIGN KEY (identity_id) REFERENCES booking_identities (id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_booking_persons_origin FOREIGN KEY (origin_identity_id) REFERENCES booking_identities (id) ON DELETE RESTRICT;
