-- Migration: create_booking_status_history
-- Task 05. Append-only transition log of every booking (who, when, why).

CREATE TABLE booking_status_history (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id     BIGINT UNSIGNED NOT NULL,
  booking_id    BIGINT UNSIGNED NOT NULL,
  from_status   VARCHAR(24)     NULL,
  to_status     VARCHAR(24)     NOT NULL,
  actor_kind    VARCHAR(16)     NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  reason        VARCHAR(1000)   NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_bsh_booking (clinic_id, booking_id, id),
  CONSTRAINT fk_bsh_booking FOREIGN KEY (clinic_id, booking_id) REFERENCES bookings (clinic_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_bsh_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_bsh_actor CHECK (actor_kind IN ('SELF', 'DELEGATE', 'GUEST', 'STAFF', 'SYSTEM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
