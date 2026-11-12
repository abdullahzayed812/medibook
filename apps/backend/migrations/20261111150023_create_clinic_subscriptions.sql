-- Migration: create_clinic_subscriptions
-- One current subscription per clinic (state), plus append-only history (next migration).
-- Stored status is advanced by admin/billing events and the lifecycle sweep job; enforcement
-- additionally derives the effective status from dates, so a lagging job never grants access.

CREATE TABLE clinic_subscriptions (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id            BIGINT UNSIGNED NOT NULL,
  plan_id              BIGINT UNSIGNED NOT NULL,
  plan_version_id      BIGINT UNSIGNED NOT NULL,
  status               VARCHAR(16) NOT NULL,
  billing_cycle        VARCHAR(16) NOT NULL DEFAULT 'MONTHLY',
  trial_starts_at      DATETIME(3) NULL,
  trial_ends_at        DATETIME(3) NULL,
  current_period_start DATETIME(3) NULL,
  current_period_end   DATETIME(3) NULL,
  past_due_since       DATETIME(3) NULL,
  grace_period_days    SMALLINT UNSIGNED NULL,
  status_changed_at    DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_clinic_subscriptions_clinic (clinic_id),
  KEY ix_clinic_subscriptions_status (status, current_period_end),
  CONSTRAINT fk_csub_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT,
  CONSTRAINT fk_csub_plan_version FOREIGN KEY (plan_id, plan_version_id) REFERENCES subscription_plan_versions (plan_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_csub_status CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'EXPIRED')),
  CONSTRAINT ck_csub_cycle CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
  CONSTRAINT ck_csub_grace CHECK (grace_period_days IS NULL OR grace_period_days <= 60)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
