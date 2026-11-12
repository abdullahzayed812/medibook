-- Migration: create_security_events
-- Append-only authentication/session security log. No foreign keys on purpose: the log must
-- survive changes to the rows it describes. Never stores OTPs, tokens or secrets.
-- subject_hash = keyed hash of the phone number, to correlate attempts for unknown accounts.

CREATE TABLE security_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type   VARCHAR(64)  NOT NULL,
  outcome      VARCHAR(16)  NOT NULL,
  user_id      BIGINT UNSIGNED NULL,
  session_id   BIGINT UNSIGNED NULL,
  subject_hash CHAR(64)     NULL,
  ip_address   VARCHAR(45)  NULL,
  user_agent   VARCHAR(512) NULL,
  request_id   VARCHAR(128) NULL,
  metadata     JSON         NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_security_events_user (user_id, id),
  KEY ix_security_events_type (event_type, created_at),
  KEY ix_security_events_subject (subject_hash, created_at),
  CONSTRAINT ck_security_events_outcome CHECK (outcome IN ('SUCCESS', 'FAILURE', 'INFO'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
