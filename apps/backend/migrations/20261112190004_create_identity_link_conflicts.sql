-- Migration: create_identity_link_conflicts
-- Task 05.2. When a verified link joins identities that ALREADY hold overlapping bookings, the
-- link proceeds (future overlaps are prevented) and each overlapping pair is recorded here for
-- resolution. No booking is cancelled or moved automatically. A conflict is resolved once at
-- least one of its bookings no longer holds time (computed on read; resolved_at set by support).

CREATE TABLE identity_link_conflicts (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  link_id            BIGINT UNSIGNED NOT NULL,
  booking_a_id       BIGINT UNSIGNED NOT NULL,
  booking_b_id       BIGINT UNSIGNED NOT NULL,
  resolved_at        DATETIME(3)     NULL,
  resolved_by_user_id BIGINT UNSIGNED NULL,
  resolution_note    VARCHAR(1000)   NULL,
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ilc_pair (link_id, booking_a_id, booking_b_id),
  KEY ix_ilc_open (resolved_at, id),
  CONSTRAINT fk_ilc_link FOREIGN KEY (link_id) REFERENCES booking_identity_links (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ilc_a FOREIGN KEY (booking_a_id) REFERENCES bookings (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ilc_b FOREIGN KEY (booking_b_id) REFERENCES bookings (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ilc_resolver FOREIGN KEY (resolved_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
