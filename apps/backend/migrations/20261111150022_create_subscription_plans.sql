-- Migration: create_subscription_plans
-- Plans with immutable versions: pricing/features/limits changes create a new version, so
-- subscriptions keep referencing the exact terms they were sold. Money in minor units.

CREATE TABLE subscription_plans (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(50)  NOT NULL,
  name        VARCHAR(150) NOT NULL,
  description VARCHAR(1000) NULL,
  status      VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  current_version_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_subscription_plans_code (code),
  CONSTRAINT ck_subscription_plans_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_subscription_plans_code CHECK (code REGEXP '^[a-z0-9]+(_[a-z0-9]+)*$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE subscription_plan_versions (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plan_id              BIGINT UNSIGNED NOT NULL,
  version              INT UNSIGNED NOT NULL,
  monthly_price_minor  BIGINT UNSIGNED NOT NULL,
  annual_price_minor   BIGINT UNSIGNED NOT NULL,
  currency             CHAR(3) NOT NULL,
  trial_days           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  features             JSON NOT NULL,
  limits               JSON NOT NULL,
  created_by_user_id   BIGINT UNSIGNED NOT NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_spv_plan_version (plan_id, version),
  UNIQUE KEY uq_spv_plan_id (plan_id, id),
  CONSTRAINT fk_spv_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans (id) ON DELETE RESTRICT,
  CONSTRAINT fk_spv_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_spv_currency CHECK (currency REGEXP '^[A-Z]{3}$'),
  CONSTRAINT ck_spv_trial CHECK (trial_days <= 365)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE subscription_plans
  ADD CONSTRAINT fk_subscription_plans_current_version FOREIGN KEY (id, current_version_id)
    REFERENCES subscription_plan_versions (plan_id, id) ON DELETE RESTRICT;
