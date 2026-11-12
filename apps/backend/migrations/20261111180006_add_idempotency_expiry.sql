-- Migration: add_idempotency_expiry
-- Task 05.1 (ADR-053). Retention keeps a TOMBSTONE: after the retention period the stored
-- response is dropped and expired_at set, but the key row stays, so a late retry with the same
-- key is refused (409 IDEMPOTENCY_KEY_EXPIRED) instead of executing the operation again.

ALTER TABLE idempotency_keys
  ADD COLUMN expired_at DATETIME(3) NULL,
  ADD KEY ix_idempotency_expired (expired_at);
