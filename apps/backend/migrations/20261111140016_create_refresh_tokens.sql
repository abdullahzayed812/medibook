-- Migration: create_refresh_tokens
-- Only SHA-256 hashes of refresh tokens are stored. Each rotation marks the old token ROTATED
-- and links it to its replacement; presenting a ROTATED token = reuse = session revoked.

CREATE TABLE refresh_tokens (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id     BIGINT UNSIGNED NOT NULL,
  token_hash     CHAR(64)    NOT NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  expires_at     DATETIME(3) NOT NULL,
  used_at        DATETIME(3) NULL,
  replaced_by_id BIGINT UNSIGNED NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_tokens_hash (token_hash),
  KEY ix_refresh_tokens_session_status (session_id, status),
  CONSTRAINT fk_refresh_tokens_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_refresh_tokens_replaced_by FOREIGN KEY (replaced_by_id) REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  CONSTRAINT ck_refresh_tokens_status CHECK (status IN ('ACTIVE', 'ROTATED', 'REVOKED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
