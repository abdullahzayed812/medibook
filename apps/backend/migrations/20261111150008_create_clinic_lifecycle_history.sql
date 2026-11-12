-- Migration: create_clinic_lifecycle_history
-- Append-only history of operational status changes (ACTIVE / SUSPENDED / CLOSING / CLOSED).

CREATE TABLE clinic_lifecycle_history (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id      BIGINT UNSIGNED NOT NULL,
  from_status    VARCHAR(16)   NULL,
  to_status      VARCHAR(16)   NOT NULL,
  actor_user_id  BIGINT UNSIGNED NULL,
  reason         VARCHAR(1000) NULL,
  reference_type VARCHAR(32)   NULL,
  reference_id   BIGINT UNSIGNED NULL,
  created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_clh_clinic (clinic_id, id),
  CONSTRAINT fk_clh_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT,
  CONSTRAINT fk_clh_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
