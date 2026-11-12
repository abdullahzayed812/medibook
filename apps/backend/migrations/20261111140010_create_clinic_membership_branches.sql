-- Migration: create_clinic_membership_branches
-- Branch assignments. Both composite FKs carry clinic_id, so the membership and the branch
-- are guaranteed to belong to the same clinic.

CREATE TABLE clinic_membership_branches (
  membership_id BIGINT UNSIGNED NOT NULL,
  clinic_id     BIGINT UNSIGNED NOT NULL,
  branch_id     BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (membership_id, branch_id),
  KEY ix_clinic_membership_branches_branch (clinic_id, branch_id),
  CONSTRAINT fk_cmb_membership FOREIGN KEY (membership_id, clinic_id)
    REFERENCES clinic_memberships (id, clinic_id) ON DELETE CASCADE,
  CONSTRAINT fk_cmb_branch FOREIGN KEY (clinic_id, branch_id)
    REFERENCES clinic_branches (clinic_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
