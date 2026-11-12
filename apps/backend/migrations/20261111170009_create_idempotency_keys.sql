-- Migration: create_idempotency_keys
-- Task 05. Replay records for critical state-changing requests. Scoped by actor and operation;
-- the row is written in the SAME transaction as the change, so a failed request leaves no key
-- behind. request_hash detects reuse of a key with a different payload.

CREATE TABLE idempotency_keys (
  id              BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  scope_key       VARCHAR(80)       NOT NULL,
  operation       VARCHAR(64)       NOT NULL,
  idem_key        VARCHAR(128)      NOT NULL,
  request_hash    CHAR(64)          NOT NULL,
  response_status SMALLINT UNSIGNED NULL,
  response_body   JSON              NULL,
  created_at      DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_idempotency (scope_key, operation, idem_key),
  KEY ix_idempotency_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
