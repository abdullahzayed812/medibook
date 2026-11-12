-- Migration: create_clinic_ownership_transfer_history
-- Append-only history of every ownership-transfer step.

CREATE TABLE clinic_ownership_transfer_history (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transfer_id   BIGINT UNSIGNED NOT NULL,
  event         VARCHAR(32)   NOT NULL,
  from_status   VARCHAR(24)   NULL,
  to_status     VARCHAR(24)   NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  note          VARCHAR(1000) NULL,
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_coth_transfer (transfer_id, id),
  CONSTRAINT fk_coth_transfer FOREIGN KEY (transfer_id) REFERENCES clinic_ownership_transfers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_coth_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
