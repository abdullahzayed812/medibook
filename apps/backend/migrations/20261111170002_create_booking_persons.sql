-- Migration: create_booking_persons
-- Task 05. Global, NON-medical identity of the person an appointment is for, used for booking
-- ownership and patient conflict detection across clinics. Clinic-scoped patient_profiles stay
-- the clinic's patient record; no medical data lives here and profiles are never merged.
--   SELF       a person identified by an OTP-verified phone (keyed hash), optionally linked to
--              the account with that phone (user_id) — the same row serves guest and account.
--   DEPENDENT  a person without own login (e.g. a child), managed through booking_delegations.

CREATE TABLE booking_persons (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind               VARCHAR(16)  NOT NULL,
  phone_hash         CHAR(64)     NULL,
  user_id            BIGINT UNSIGNED NULL,
  display_name       VARCHAR(150) NOT NULL,
  birth_date         DATE         NULL,
  created_by_user_id BIGINT UNSIGNED NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_booking_persons_phone (phone_hash),
  UNIQUE KEY uq_booking_persons_user (user_id),
  CONSTRAINT fk_booking_persons_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_booking_persons_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_booking_persons_kind CHECK (
    (kind = 'SELF' AND phone_hash IS NOT NULL)
    OR (kind = 'DEPENDENT' AND phone_hash IS NULL AND user_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
