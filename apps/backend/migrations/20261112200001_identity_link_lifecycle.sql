-- Task 05.2.1: identity-link lifecycle hardening (ADR-057).
--
-- New forward-only migration (not an amendment of 190003/190004): amending would require
-- rebuilding the local dev database, deleting its accounts; a new migration is always allowed.
--
-- 1. booking_identity_links gains SUPERSEDED: a newer verified link for the same person replaces
--    the active one, which is kept as history and can no longer be revoked.
-- 2. identity_link_conflicts records HOW a conflict was resolved; a resolved row is final.

ALTER TABLE booking_identity_links DROP CHECK ck_bil_status;

ALTER TABLE booking_identity_links
  ADD COLUMN superseded_by_link_id BIGINT UNSIGNED NULL AFTER revocation_reason,
  ADD COLUMN superseded_at DATETIME(3) NULL AFTER superseded_by_link_id,
  ADD UNIQUE KEY uq_bil_superseded_by (superseded_by_link_id),
  ADD CONSTRAINT fk_bil_superseded_by FOREIGN KEY (superseded_by_link_id) REFERENCES booking_identity_links (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_bil_status CHECK (
    (status = 'ACTIVE'     AND revoked_at IS NULL     AND superseded_by_link_id IS NULL     AND superseded_at IS NULL)
 OR (status = 'REVOKED'    AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND superseded_by_link_id IS NULL)
 OR (status = 'SUPERSEDED' AND revoked_at IS NULL     AND superseded_by_link_id IS NOT NULL AND superseded_at IS NOT NULL)
  );

-- Rows resolved before this migration have no recorded method.
ALTER TABLE identity_link_conflicts
  ADD COLUMN resolution_method VARCHAR(24) NULL AFTER resolution_note;

UPDATE identity_link_conflicts SET resolution_method = 'UNRECORDED' WHERE resolved_at IS NOT NULL;

ALTER TABLE identity_link_conflicts
  ADD CONSTRAINT ck_ilc_method CHECK (resolution_method IS NULL OR resolution_method IN ('BOOKING_RELEASED', 'LINK_REVOKED', 'UNRECORDED')),
  ADD CONSTRAINT ck_ilc_resolved CHECK (
    (resolved_at IS NULL     AND resolved_by_user_id IS NULL     AND resolution_note IS NULL     AND resolution_method IS NULL)
 OR (resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL AND resolution_note IS NOT NULL AND resolution_method IS NOT NULL)
  );
