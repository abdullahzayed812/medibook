-- Migration: create_clinic_access_exceptions
-- Explicit, scoped, time-limited, audited exceptional access during a FULL suspension
-- (continuity of care). Granted by a Super Admin to one member of the suspended clinic.

CREATE TABLE clinic_access_exceptions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id          BIGINT UNSIGNED NOT NULL,
  suspension_id      BIGINT UNSIGNED NOT NULL,
  user_id            BIGINT UNSIGNED NOT NULL,
  reason             VARCHAR(1000) NOT NULL,
  granted_by_user_id BIGINT UNSIGNED NOT NULL,
  starts_at          DATETIME(3) NOT NULL,
  expires_at         DATETIME(3) NOT NULL,
  revoked_at         DATETIME(3) NULL,
  revoked_by_user_id BIGINT UNSIGNED NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_cae_lookup (clinic_id, user_id, expires_at),
  CONSTRAINT fk_cae_suspension FOREIGN KEY (clinic_id, suspension_id) REFERENCES clinic_suspensions (clinic_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_cae_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cae_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_cae_revoked_by FOREIGN KEY (revoked_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_cae_window CHECK (expires_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
