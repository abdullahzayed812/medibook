-- Migration: create_domain_events
-- Transactional outbox for integration events (notifications, billing, marketplace indexing).
-- Written in the same transaction as the change; consumers (worker) are a later task.
-- Payloads never contain secrets, tokens or documents.

CREATE TABLE domain_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type     VARCHAR(100) NOT NULL,
  aggregate_type VARCHAR(50)  NOT NULL,
  aggregate_id   VARCHAR(64)  NOT NULL,
  clinic_id      BIGINT UNSIGNED NULL,
  payload        JSON         NOT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at   DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_domain_events_unpublished (published_at, id),
  KEY ix_domain_events_aggregate (aggregate_type, aggregate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
