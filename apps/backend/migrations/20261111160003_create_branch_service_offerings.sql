-- Migration: create_branch_service_offerings
-- Task 04. A clinic service offered at one branch with branch-specific price, duration and
-- operational settings. One row per (branch, service); deactivation keeps it. Money in integer
-- minor units (ADR-029) with an ISO 4217 currency.

CREATE TABLE branch_service_offerings (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id          BIGINT UNSIGNED NOT NULL,
  branch_id          BIGINT UNSIGNED NOT NULL,
  service_id         BIGINT UNSIGNED NOT NULL,
  status             VARCHAR(16)       NOT NULL DEFAULT 'ACTIVE',
  price_minor        BIGINT UNSIGNED   NOT NULL,
  currency           CHAR(3)           NOT NULL,
  duration_minutes   SMALLINT UNSIGNED NOT NULL,
  buffer_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  instructions_en    VARCHAR(2000)     NULL,
  instructions_ar    VARCHAR(2000)     NULL,
  created_by_user_id BIGINT UNSIGNED   NULL,
  updated_by_user_id BIGINT UNSIGNED   NULL,
  created_at         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_bso_branch_service (clinic_id, branch_id, service_id),
  UNIQUE KEY uq_bso_clinic_branch_id (clinic_id, branch_id, id),
  KEY ix_bso_service (clinic_id, service_id, status),
  CONSTRAINT fk_bso_branch FOREIGN KEY (clinic_id, branch_id) REFERENCES clinic_branches (clinic_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bso_service FOREIGN KEY (clinic_id, service_id) REFERENCES clinic_services (clinic_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_bso_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_bso_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_bso_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_bso_price CHECK (price_minor <= 1000000000),
  CONSTRAINT ck_bso_currency CHECK (currency REGEXP '^[A-Z]{3}$'),
  CONSTRAINT ck_bso_duration CHECK (duration_minutes BETWEEN 5 AND 720),
  CONSTRAINT ck_bso_buffer CHECK (buffer_minutes <= 240)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
