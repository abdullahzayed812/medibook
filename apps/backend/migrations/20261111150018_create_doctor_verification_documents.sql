-- Migration: create_doctor_verification_documents
-- Private professional verification documents of a doctor profile.
-- Metadata only: file bytes live in private object storage under a random key (never derived
-- from user input). removed_at = withdrawn by the uploader before submission (history kept).

CREATE TABLE doctor_verification_documents (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  doctor_profile_id BIGINT UNSIGNED NOT NULL,
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
  UNIQUE KEY uq_dvd_storage_key (storage_key),
  KEY ix_dvd_parent (doctor_profile_id, id),
  CONSTRAINT fk_dvd_parent FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_dvd_uploader FOREIGN KEY (uploaded_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT ck_dvd_type CHECK (document_type IN ('MEDICAL_LICENSE', 'DEGREE_CERTIFICATE', 'IDENTITY', 'SPECIALTY_CERTIFICATE', 'OTHER')),
  CONSTRAINT ck_dvd_content_type CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
