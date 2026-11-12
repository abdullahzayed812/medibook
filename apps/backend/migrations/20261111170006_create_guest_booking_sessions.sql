-- Migration: create_guest_booking_sessions
-- Task 05. Short-lived guest access after an OTP-verified phone (no account is created). Only
-- the SHA-256 of the 256-bit token is stored. Booking ids alone never grant guest access.

CREATE TABLE guest_booking_sessions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_e164  VARCHAR(16) NOT NULL,
  phone_hash  CHAR(64)    NOT NULL,
  token_hash  CHAR(64)    NOT NULL,
  expires_at  DATETIME(3) NOT NULL,
  revoked_at  DATETIME(3) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_gbs_token (token_hash),
  KEY ix_gbs_phone (phone_hash, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
