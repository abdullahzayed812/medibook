-- Migration: extend_identity_support_cases
-- Task 05.2. Cases now have a kind: GUEST_OWNERSHIP (Task 05.1: become owner of an unclaimed guest
-- person) or IDENTITY_LINK (associate another person — e.g. a clinic-recorded patient — with the
-- requester's conflict identity, WITHOUT ownership or access). Decisions record the evidence type.

ALTER TABLE identity_support_cases
  ADD COLUMN case_kind VARCHAR(24) NOT NULL DEFAULT 'GUEST_OWNERSHIP',
  ADD COLUMN evidence_type VARCHAR(24) NULL,
  ADD COLUMN link_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_isc_link FOREIGN KEY (link_id) REFERENCES booking_identity_links (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_isc_kind CHECK (case_kind IN ('GUEST_OWNERSHIP', 'IDENTITY_LINK')),
  ADD CONSTRAINT ck_isc_evidence CHECK (evidence_type IS NULL OR evidence_type IN ('ID_DOCUMENT', 'BOOKING_DETAILS', 'CLINIC_ATTESTATION', 'OTHER'));
