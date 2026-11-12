-- Migration: create_otp_challenges
-- One OTP challenge per request. Only an HMAC of the code is stored. id is a random
-- 128-bit hex value (not sequential) handed to the client.

CREATE TABLE otp_challenges (
  id            CHAR(32)    NOT NULL,
  phone_e164    VARCHAR(16) NOT NULL,
  purpose       VARCHAR(16) NOT NULL,
  code_hash     CHAR(64)    NOT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts  TINYINT UNSIGNED NOT NULL,
  expires_at    DATETIME(3) NOT NULL,
  verified_at   DATETIME(3) NULL,
  request_ip    VARCHAR(45) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_otp_challenges_phone_status (phone_e164, status),
  KEY ix_otp_challenges_created_at (created_at),
  CONSTRAINT ck_otp_challenges_purpose CHECK (purpose IN ('LOGIN')),
  CONSTRAINT ck_otp_challenges_status CHECK (status IN ('PENDING', 'VERIFIED', 'EXPIRED', 'LOCKED', 'SUPERSEDED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
