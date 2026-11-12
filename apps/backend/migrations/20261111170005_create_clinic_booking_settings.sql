-- Migration: create_clinic_booking_settings
-- Task 05. Per-clinic booking configuration within platform limits (CHECKs mirror
-- BOOKING_LIMITS in src/modules/bookings/policy.ts). A missing row means platform defaults.

CREATE TABLE clinic_booking_settings (
  clinic_id                 BIGINT UNSIGNED   NOT NULL,
  slot_enabled              TINYINT(1)        NOT NULL DEFAULT 1,
  queue_enabled             TINYINT(1)        NOT NULL DEFAULT 0,
  slot_interval_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  min_lead_minutes          INT UNSIGNED      NOT NULL DEFAULT 60,
  max_horizon_days          SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  confirmation_ttl_minutes  INT UNSIGNED      NOT NULL DEFAULT 120,
  cancel_min_notice_minutes INT UNSIGNED      NOT NULL DEFAULT 1440,
  cancel_reason_required    TINYINT(1)        NOT NULL DEFAULT 0,
  updated_by_user_id        BIGINT UNSIGNED   NULL,
  updated_at                DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (clinic_id),
  CONSTRAINT fk_cbs_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cbs_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_cbs_interval CHECK (slot_interval_minutes BETWEEN 5 AND 120),
  CONSTRAINT ck_cbs_lead CHECK (min_lead_minutes <= 10080),
  CONSTRAINT ck_cbs_horizon CHECK (max_horizon_days BETWEEN 1 AND 180),
  CONSTRAINT ck_cbs_ttl CHECK (confirmation_ttl_minutes BETWEEN 5 AND 2880),
  CONSTRAINT ck_cbs_notice CHECK (cancel_min_notice_minutes <= 10080)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
