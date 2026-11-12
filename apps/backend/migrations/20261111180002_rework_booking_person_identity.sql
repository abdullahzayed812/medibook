-- Migration: rework_booking_person_identity
-- Task 05.1 (ADR-050). A phone number no longer identifies a booking person:
--  * phone_hash is informational (support signal, guest re-attach factor) and NOT unique, so a
--    recycled number gets a new person instead of inheriting the old one;
--  * GUEST = created by a verified-phone guest session; ownership is proven only by a claim code;
--    an account that claims it becomes its owner (claimed_by_user_id) — never a merge;
--  * SELF = an account's own person (keyed by user_id);
--  * CLINIC = recorded by clinic staff for a patient without a verified identity.
-- Existing SELF rows without an account were created by guests: they become GUEST (no claim
-- code exists for them → support-assisted ownership verification).
-- No FK referential action on claimed_by_user_id: MySQL forbids it on CHECK columns.

ALTER TABLE booking_persons
  DROP CHECK ck_booking_persons_kind,
  DROP INDEX uq_booking_persons_phone,
  ADD KEY ix_booking_persons_phone (phone_hash),
  ADD COLUMN phone_hash_key_version TINYINT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN claimed_by_user_id BIGINT UNSIGNED NULL,
  ADD COLUMN claimed_at DATETIME(3) NULL,
  ADD KEY ix_booking_persons_claimed_by (claimed_by_user_id),
  ADD CONSTRAINT fk_booking_persons_claimed_by FOREIGN KEY (claimed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT;

UPDATE booking_persons SET kind = 'GUEST' WHERE kind = 'SELF' AND user_id IS NULL;

ALTER TABLE booking_persons
  ADD CONSTRAINT ck_booking_persons_kind CHECK (
    (kind = 'SELF' AND user_id IS NOT NULL AND claimed_by_user_id IS NULL)
    OR (kind = 'GUEST' AND user_id IS NULL AND phone_hash IS NOT NULL)
    OR (kind = 'DEPENDENT' AND user_id IS NULL AND phone_hash IS NULL AND claimed_by_user_id IS NULL)
    OR (kind = 'CLINIC' AND user_id IS NULL AND phone_hash IS NULL AND claimed_by_user_id IS NULL)),
  ADD CONSTRAINT ck_booking_persons_claim CHECK ((claimed_by_user_id IS NULL) = (claimed_at IS NULL));
