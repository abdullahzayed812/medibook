-- Migration: create_user_profiles
-- General (non-medical) account information. 1:1 with users.

CREATE TABLE user_profiles (
  user_id          BIGINT UNSIGNED NOT NULL,
  display_name     VARCHAR(150) NULL,
  preferred_locale VARCHAR(16)  NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
