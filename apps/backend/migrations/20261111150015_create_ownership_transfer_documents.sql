-- Migration: create_ownership_transfer_documents
-- Private documents supporting an ownership transfer.
-- Metadata only: file bytes live in private object storage under a random key (never derived
-- from user input). removed_at = withdrawn by the uploader before submission (history kept).

CREATE TABLE ownership_transfer_documents (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transfer_id BIGINT UNSIGNED NOT NULL,
  document_type       VARCHAR(40)  NOT NULL,
  storage_key         VARCHAR(255) NOT NULL,
  original_filename   VARCHAR(255) NOT NULL,
  content_type        VARCHAR(100) NOT NULL,
  size_bytes          INT UNSIGNED NOT NULL,
  sha256              CHAR(64)     NOT NULL,
  uploaded_by_user_id BIGINT UNSIGNED NOT NULL,
  removed_at          DATETIME(3)  NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_otd_storage_key (storage_key),
  KEY ix_otd_parent (transfer_id, id),
  CONSTRAINT fk_otd_parent FOREIGN KEY (transfer_id) REFERENCES clinic_ownership_transfers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_otd_uploader FOREIGN KEY (uploaded_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_otd_type CHECK (document_type IN ('TRANSFER_AGREEMENT', 'NEW_OWNER_IDENTITY', 'CURRENT_OWNER_IDENTITY', 'OTHER')),
  CONSTRAINT ck_otd_content_type CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
