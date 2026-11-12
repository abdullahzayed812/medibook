-- Migration: create_users
-- Global platform identity (one account per person). Login credential = verified phone.
-- Account status is independent of clinic membership/operational/subscription status.

CREATE TABLE users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_e164        VARCHAR(16)  NOT NULL,
  phone_verified_at DATETIME(3)  NULL,
  email             VARCHAR(254) NULL,
  email_verified_at DATETIME(3)  NULL,
  status            VARCHAR(32)  NOT NULL DEFAULT 'PENDING_VERIFICATION',
  status_changed_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_phone_e164 (phone_e164),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_status (status),
  CONSTRAINT ck_users_status CHECK (status IN ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'INACTIVE')),
  CONSTRAINT ck_users_phone_e164 CHECK (phone_e164 REGEXP '^\\+[1-9][0-9]{6,14}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
