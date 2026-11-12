-- Migration: create_clinic_subscription_history
-- Append-only: every status change, plan change, billing period and grace event.

CREATE TABLE clinic_subscription_history (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subscription_id        BIGINT UNSIGNED NOT NULL,
  clinic_id              BIGINT UNSIGNED NOT NULL,
  event_type             VARCHAR(32) NOT NULL,
  from_status            VARCHAR(16) NULL,
  to_status              VARCHAR(16) NOT NULL,
  from_plan_version_id   BIGINT UNSIGNED NULL,
  to_plan_version_id     BIGINT UNSIGNED NOT NULL,
  billing_cycle          VARCHAR(16) NOT NULL,
  period_start           DATETIME(3) NULL,
  period_end             DATETIME(3) NULL,
  actor_user_id          BIGINT UNSIGNED NULL,
  reason                 VARCHAR(1000) NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_csh_clinic (clinic_id, id),
  CONSTRAINT fk_csh_subscription FOREIGN KEY (subscription_id) REFERENCES clinic_subscriptions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_csh_from_version FOREIGN KEY (from_plan_version_id) REFERENCES subscription_plan_versions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_csh_to_version FOREIGN KEY (to_plan_version_id) REFERENCES subscription_plan_versions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_csh_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
