-- Migration: create_platform_settings
-- Super-Admin-managed platform configuration (validated in code; defaults live in code).

CREATE TABLE platform_settings (
  setting_key        VARCHAR(100) NOT NULL,
  value              JSON         NOT NULL,
  updated_by_user_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_platform_settings_user FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
