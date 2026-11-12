-- Migration: create_clinic_membership_events
-- Append-only activation / suspension / termination history of memberships.

CREATE TABLE clinic_membership_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  membership_id BIGINT UNSIGNED NOT NULL,
  clinic_id     BIGINT UNSIGNED NOT NULL,
  from_status   VARCHAR(16)  NULL,
  to_status     VARCHAR(16)  NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  reason        VARCHAR(255) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_cme_membership (membership_id, created_at),
  CONSTRAINT fk_cme_membership FOREIGN KEY (membership_id, clinic_id)
    REFERENCES clinic_memberships (id, clinic_id) ON DELETE CASCADE,
  CONSTRAINT fk_cme_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
