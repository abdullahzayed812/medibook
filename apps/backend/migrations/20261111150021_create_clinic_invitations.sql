-- Migration: create_clinic_invitations
-- Staff invitations: bound to clinic, role, branch scope and the invitee phone; single use;
-- only the SHA-256 of the token is stored. CLINIC_OWNER can never be invited (CHECK).

CREATE TABLE clinic_invitations (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id           BIGINT UNSIGNED NOT NULL,
  role_code           VARCHAR(32) NOT NULL,
  branch_scope        VARCHAR(16) NOT NULL DEFAULT 'ASSIGNED',
  invited_phone_e164  VARCHAR(16) NOT NULL,
  token_hash          CHAR(64)    NOT NULL,
  status              VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  expires_at          DATETIME(3) NOT NULL,
  invited_by_user_id  BIGINT UNSIGNED NOT NULL,
  accepted_by_user_id BIGINT UNSIGNED NULL,
  accepted_at         DATETIME(3) NULL,
  membership_id       BIGINT UNSIGNED NULL,
  revoked_by_user_id  BIGINT UNSIGNED NULL,
  revoked_at          DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ci_token_hash (token_hash),
  UNIQUE KEY uq_ci_clinic_id (clinic_id, id),
  KEY ix_ci_clinic_status (clinic_id, status, id),
  KEY ix_ci_phone_status (invited_phone_e164, status),
  CONSTRAINT fk_ci_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ci_invited_by FOREIGN KEY (invited_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ci_accepted_by FOREIGN KEY (accepted_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ci_revoked_by FOREIGN KEY (revoked_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ci_membership FOREIGN KEY (membership_id, clinic_id) REFERENCES clinic_memberships (id, clinic_id) ON DELETE RESTRICT,
  CONSTRAINT ck_ci_role CHECK (role_code IN ('CLINIC_MANAGER', 'DOCTOR', 'RECEPTIONIST')),
  CONSTRAINT ck_ci_branch_scope CHECK (branch_scope IN ('ALL', 'ASSIGNED')),
  CONSTRAINT ck_ci_status CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE clinic_invitation_branches (
  invitation_id BIGINT UNSIGNED NOT NULL,
  clinic_id     BIGINT UNSIGNED NOT NULL,
  branch_id     BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (invitation_id, branch_id),
  CONSTRAINT fk_cib_invitation FOREIGN KEY (clinic_id, invitation_id) REFERENCES clinic_invitations (clinic_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_cib_branch FOREIGN KEY (clinic_id, branch_id) REFERENCES clinic_branches (clinic_id, id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
