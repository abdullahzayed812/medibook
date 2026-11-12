-- Migration: create_sessions
-- One row per logged-in device/app. Checked on EVERY authenticated request, so revocation
-- is immediate (access-token expiry is not relied upon).

CREATE TABLE sessions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  device_id        VARCHAR(128) NOT NULL,
  app_type         VARCHAR(32)  NOT NULL,
  device_name      VARCHAR(100) NULL,
  os_name          VARCHAR(50)  NULL,
  os_version       VARCHAR(50)  NULL,
  app_version      VARCHAR(50)  NULL,
  ip_address       VARCHAR(45)  NULL,
  user_agent       VARCHAR(512) NULL,
  active_clinic_id BIGINT UNSIGNED NULL,
  mfa_verified_at  DATETIME(3)  NULL,
  last_activity_at DATETIME(3)  NOT NULL,
  expires_at       DATETIME(3)  NOT NULL,
  revoked_at       DATETIME(3)  NULL,
  revoked_reason   VARCHAR(64)  NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_sessions_user_active (user_id, revoked_at, expires_at),
  KEY ix_sessions_user_device (user_id, device_id, app_type),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_active_clinic FOREIGN KEY (active_clinic_id) REFERENCES clinics (id) ON DELETE SET NULL,
  CONSTRAINT ck_sessions_app_type CHECK (
    app_type IN ('ADMIN_WEB', 'CLINIC_WEB', 'PATIENT_WEB', 'PATIENT_MOBILE', 'STAFF_MOBILE')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
