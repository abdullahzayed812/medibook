-- Migration: create_booking_identities
-- Task 05.2 (ADR-055). Canonical booking-CONFLICT identity: one row per real person as far as
-- appointment overlap is concerned. Booking persons point to one identity; verified links make
-- several persons share it. Not a medical-record identity, not an access grant.

CREATE TABLE booking_identities (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
