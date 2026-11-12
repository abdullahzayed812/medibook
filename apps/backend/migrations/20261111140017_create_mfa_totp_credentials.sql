-- Migration: create_mfa_totp_credentials
-- TOTP (RFC 6238) second factor. The shared secret is encrypted (AES-256-GCM) with a key that
-- is not stored in the database. last_used_step blocks code replay.

CREATE TABLE mfa_totp_credentials (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  secret_ciphertext VARBINARY(255) NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  last_used_step    BIGINT UNSIGNED NULL,
  activated_at      DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_mfa_totp_credentials_user (user_id),
  CONSTRAINT fk_mfa_totp_credentials_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_mfa_totp_credentials_status CHECK (status IN ('PENDING', 'ACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
