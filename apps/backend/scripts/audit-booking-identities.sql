-- Task 05.2: READ-ONLY legacy booking-identity audit.
--
-- Purpose: list historical identity associations that were NOT made by claim code or audited
-- support decision, so that a human can review them. It never modifies data and never unlinks
-- or merges anything. Review procedure: docs/platform/BOOKING_PERSONS.md § Legacy identity audit.
--
-- Run (dev example):
--   docker exec -i medibook-mysql-1 sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --table medibook' \
--     < apps/backend/scripts/audit-booking-identities.sql
--
-- The whole script runs in one READ ONLY transaction: any write statement would fail with
-- ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION. Phone numbers are never printed; only hash prefixes.

SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION READ ONLY;

SELECT 'A. SELF persons of an account that carry GUEST-made bookings (old Task 05 phone auto-link)' AS section;
SELECT p.id AS person_id, p.user_id, p.created_at AS person_created, u.created_at AS account_created,
       COUNT(b.id) AS guest_made_bookings, MIN(b.created_at) AS first_guest_booking
  FROM booking_persons p
  JOIN users u ON u.id = p.user_id
  JOIN bookings b ON b.person_id = p.id AND b.actor_kind = 'GUEST'
 WHERE p.kind = 'SELF'
 GROUP BY p.id, p.user_id, p.created_at, u.created_at
 ORDER BY p.id;

SELECT 'B. SELF persons created before their account (adopted rather than created by it)' AS section;
SELECT p.id AS person_id, p.user_id, p.created_at AS person_created, u.created_at AS account_created
  FROM booking_persons p
  JOIN users u ON u.id = p.user_id
 WHERE p.kind = 'SELF' AND p.created_at < u.created_at
 ORDER BY p.id;

SELECT 'C. Claimed persons without a CLAIM_CODE claim audit or a support case (unexplained ownership)' AS section;
SELECT p.id AS person_id, p.kind, p.claimed_by_user_id, p.claimed_at
  FROM booking_persons p
 WHERE p.claimed_by_user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM audit_events e
                    WHERE e.action = 'BOOKING_PERSON_CLAIMED' AND e.target_id = CAST(p.id AS CHAR)
                      AND JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.via')) IN ('CLAIM_CODE', 'SUPPORT_CASE'))
 ORDER BY p.id;

SELECT 'D. Identity groups with more than one person record, and how each member joined' AS section;
SELECT p.identity_id, p.id AS person_id, p.kind, p.user_id, p.claimed_by_user_id,
       l.source AS link_source, l.evidence_type, l.case_id, l.created_at AS linked_at
  FROM booking_persons p
  LEFT JOIN booking_identity_links l ON l.person_id = p.id AND l.status = 'ACTIVE'
 WHERE p.identity_id IN (SELECT identity_id FROM booking_persons GROUP BY identity_id HAVING COUNT(*) > 1)
 ORDER BY p.identity_id, p.id;

SELECT 'E. Links backfilled by migration (MIGRATION_CLAIM): verify each against its claim audit' AS section;
SELECT l.id AS link_id, l.person_id, l.to_identity_id, l.created_at,
       (SELECT JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.via')) FROM audit_events e
         WHERE e.action = 'BOOKING_PERSON_CLAIMED' AND e.target_id = CAST(l.person_id AS CHAR)
         ORDER BY e.id LIMIT 1) AS claim_audit_via
  FROM booking_identity_links l
 WHERE l.source = 'MIGRATION_CLAIM' AND l.status = 'ACTIVE'
 ORDER BY l.id;

SELECT 'F. Accounts owning more than one person record (own SELF + claimed), with identity count' AS section;
SELECT owner_user_id, COUNT(*) AS persons, COUNT(DISTINCT identity_id) AS identities
  FROM (SELECT COALESCE(user_id, claimed_by_user_id) AS owner_user_id, identity_id
          FROM booking_persons WHERE user_id IS NOT NULL OR claimed_by_user_id IS NOT NULL) x
 GROUP BY owner_user_id
HAVING COUNT(*) > 1
 ORDER BY owner_user_id;

SELECT 'G. Unclaimed GUEST persons sharing a phone hash with an account SELF person (signal only, NEVER link on this)' AS section;
SELECT g.id AS guest_person_id, s.id AS self_person_id, s.user_id, LEFT(g.phone_hash, 8) AS hash_prefix,
       g.created_at AS guest_created
  FROM booking_persons g
  JOIN booking_persons s ON s.kind = 'SELF' AND s.phone_hash = g.phone_hash
                        AND s.phone_hash_key_version = g.phone_hash_key_version
 WHERE g.kind = 'GUEST' AND g.claimed_by_user_id IS NULL AND g.identity_id <> s.identity_id
 ORDER BY g.id;

SELECT 'H. Phone hashes shared by persons of different owners (recycled-number risk)' AS section;
SELECT LEFT(phone_hash, 8) AS hash_prefix, COUNT(*) AS persons,
       COUNT(DISTINCT COALESCE(user_id, claimed_by_user_id, -id)) AS distinct_owners,
       COUNT(DISTINCT identity_id) AS identities
  FROM booking_persons
 WHERE phone_hash IS NOT NULL
 GROUP BY phone_hash
HAVING COUNT(DISTINCT COALESCE(user_id, claimed_by_user_id, -id)) > 1
 ORDER BY persons DESC;

SELECT 'I. Totals' AS section;
SELECT (SELECT COUNT(*) FROM booking_persons) AS persons,
       (SELECT COUNT(*) FROM booking_identities) AS identities,
       (SELECT COUNT(*) FROM booking_identity_links WHERE status = 'ACTIVE') AS active_links,
       (SELECT COUNT(*) FROM identity_link_conflicts WHERE resolved_at IS NULL) AS unresolved_conflicts;

COMMIT;
