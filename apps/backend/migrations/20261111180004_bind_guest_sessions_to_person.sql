-- Migration: bind_guest_sessions_to_person
-- Task 05.1. A guest session acts for exactly ONE guest person: the one it created, or one it
-- attached with that person's claim code. A verified phone alone never selects a person.

ALTER TABLE guest_booking_sessions
  ADD COLUMN person_id BIGINT UNSIGNED NULL,
  ADD COLUMN failed_attach_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN phone_hash_key_version TINYINT UNSIGNED NOT NULL DEFAULT 1,
  ADD KEY ix_gbs_person (person_id),
  ADD CONSTRAINT fk_gbs_person FOREIGN KEY (person_id) REFERENCES booking_persons (id) ON DELETE RESTRICT;
