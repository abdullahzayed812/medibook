-- Migration: create_doctor_verification_history
-- Append-only history of professional verification decisions.

CREATE TABLE doctor_verification_history (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_profile_id BIGINT UNSIGNED NOT NULL,
  from_status       VARCHAR(16)   NULL,
  to_status         VARCHAR(16)   NOT NULL,
  actor_user_id     BIGINT UNSIGNED NOT NULL,
  reason            VARCHAR(1000) NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_dvh_profile (doctor_profile_id, id),
  CONSTRAINT fk_dvh_profile FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_dvh_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
