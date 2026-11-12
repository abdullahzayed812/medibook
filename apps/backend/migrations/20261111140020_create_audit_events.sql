-- Migration: create_audit_events
-- Append-only record of privileged/administrative changes (who changed what, where).

CREATE TABLE audit_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  action        VARCHAR(64)  NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  target_type   VARCHAR(32)  NOT NULL,
  target_id     VARCHAR(64)  NOT NULL,
  clinic_id     BIGINT UNSIGNED NULL,
  request_id    VARCHAR(128) NULL,
  metadata      JSON         NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_events_target (target_type, target_id, created_at),
  KEY ix_audit_events_actor (actor_user_id, created_at),
  KEY ix_audit_events_clinic (clinic_id, created_at),
  KEY ix_audit_events_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
