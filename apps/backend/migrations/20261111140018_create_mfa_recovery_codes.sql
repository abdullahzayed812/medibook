-- Migration: create_mfa_recovery_codes
-- Single-use recovery codes; only keyed hashes (HMAC-SHA256) are stored.

CREATE TABLE mfa_recovery_codes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  code_hash  CHAR(64)    NOT NULL,
  used_at    DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_mfa_recovery_codes_user_hash (user_id, code_hash),
  CONSTRAINT fk_mfa_recovery_codes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
