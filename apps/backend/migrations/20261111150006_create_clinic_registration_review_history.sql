-- Migration: create_clinic_registration_review_history
-- Append-only status history (who, when, why) of every registration transition.

CREATE TABLE clinic_registration_review_history (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  registration_request_id BIGINT UNSIGNED NOT NULL,
  from_status             VARCHAR(20)   NULL,
  to_status               VARCHAR(20)   NOT NULL,
  actor_user_id           BIGINT UNSIGNED NOT NULL,
  reason                  VARCHAR(1000) NULL,
  created_at              DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_crrh_request (registration_request_id, id),
  CONSTRAINT fk_crrh_request FOREIGN KEY (registration_request_id) REFERENCES clinic_registration_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crrh_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
