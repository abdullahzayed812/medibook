import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import type { AuthorizationService, Principal } from '../access/index.js';
import {
  AUDIT_ACTION,
  SECURITY_EVENT,
  type AuditLog,
  type SecurityEventLog,
} from '../audit/index.js';
import { HOLDS_TIME_SQL } from './policy.js';

/**
 * Canonical booking-conflict identities (ADR-055). Each booking person keeps its own id, kind,
 * owner and history; `identity_id` says which real person it is FOR CONFLICT PURPOSES. A verified
 * link (claim code, or a Super Admin decision with recorded evidence) moves a person's identity
 * group into another identity; a correction moves a person back to its immutable
 * `origin_identity_id`. Nothing else changes: bookings, actors, profiles, audit history and
 * access rights stay as they were. An identity link never grants access to anyone's data, and
 * phone equality never creates one.
 *
 * Lock order (extends ADR-046): … doctor(s) → IDENTITY rows (ascending) → person rows → bookings.
 * Link and revoke operations take no doctor lock, so they cannot form a cycle with bookings.
 */

export type LinkSource = 'CLAIM_CODE' | 'SUPPORT_CASE';
export type EvidenceType =
  'CLAIM_CODE' | 'ID_DOCUMENT' | 'BOOKING_DETAILS' | 'CLINIC_ATTESTATION' | 'OTHER';

export async function newIdentity(tx: SqlExecutor): Promise<string> {
  return String((await tx.execute('INSERT INTO booking_identities () VALUES ()')).insertId);
}

/** Locks identity rows in ascending id order (deadlock-free with every other identity locker). */
export async function lockIdentities(tx: SqlExecutor, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort((a, b) => Number(a) - Number(b)))
    await tx.query('SELECT id FROM booking_identities WHERE id = ? FOR UPDATE', [id]);
}

/**
 * Locks the identity of `personId` and then the person row, re-checking that a concurrent link did
 * not move the person in between. Returns the locked, current identity id.
 */
export async function lockIdentityOfPerson(tx: SqlExecutor, personId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = (
      await tx.query<{ identity_id: string }>(
        'SELECT identity_id FROM booking_persons WHERE id = ?',
        [personId],
      )
    )[0];
    if (seen === undefined) throw new NotFoundError('Person not found');
    await lockIdentities(tx, [seen.identity_id]);
    const now = (
      await tx.query<{ identity_id: string }>(
        'SELECT identity_id FROM booking_persons WHERE id = ? FOR UPDATE',
        [personId],
      )
    )[0];
    if (now?.identity_id === seen.identity_id) return seen.identity_id;
  }
  throw new ConflictError('The patient identity changed concurrently; retry');
}

async function holdingBookingsOfPerson(tx: SqlExecutor, personId: string, now: Date) {
  return tx.query<{ id: string; starts_at: Date; ends_at: Date }>(
    `SELECT b.id, b.starts_at, b.ends_at FROM bookings b
      WHERE b.person_id = ? AND b.mode = 'SLOT' AND ${HOLDS_TIME_SQL}`,
    [personId, now],
  );
}

/**
 * Locks the current identities of several persons (ascending), then the person rows, and
 * re-checks that no concurrent link or revocation moved a person in between; retries up to 3
 * times. Returns every identity id it holds locked (for `linkPersonInto`).
 */
export async function lockIdentitiesOfPersons(
  tx: SqlExecutor,
  personIds: readonly string[],
): Promise<string[]> {
  const held = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = await tx.query<{ id: string; identity_id: string }>(
      `SELECT id, identity_id FROM booking_persons WHERE id IN (${personIds.map(() => '?').join(', ')})`,
      [...personIds],
    );
    const wanted = seen.map((r) => r.identity_id).filter((id) => !held.has(id));
    await lockIdentities(tx, wanted);
    for (const id of wanted) held.add(id);
    const now = await tx.query<{ id: string; identity_id: string }>(
      `SELECT id, identity_id FROM booking_persons WHERE id IN (${personIds.map(() => '?').join(', ')}) ORDER BY id FOR UPDATE`,
      [...personIds],
    );
    if (now.every((r) => held.has(r.identity_id))) return [...held];
  }
  throw new ConflictError('The patient identity changed concurrently; retry');
}

/** Holding bookings (any clinic) of every person in an identity: id and real interval only. */
async function holdingBookings(tx: SqlExecutor, identityId: string, now: Date) {
  return tx.query<{ id: string; starts_at: Date; ends_at: Date }>(
    `SELECT b.id, b.starts_at, b.ends_at FROM bookings b JOIN booking_persons bp ON bp.id = b.person_id
      WHERE bp.identity_id = ? AND b.mode = 'SLOT' AND ${HOLDS_TIME_SQL}`,
    [identityId, now],
  );
}

/**
 * Links ONE person into `intoIdentityId` (ADR-055, ADR-057). The caller must already hold the
 * locks for the person's current identity and the target identity (`lockedIdentityIds`); if the
 * person moved meanwhile the call fails with 409 instead of touching an unlocked identity.
 *
 * - Only the person moves, never the rest of its current identity: a person already linked to
 *   another account's identity is re-linked alone and its active link becomes SUPERSEDED.
 * - SELF persons are identity anchors and never move. A person owned (claimed) by another account
 *   is never linked into a different account's identity.
 * - Overlapping holding bookings are NOT cancelled: each pair is recorded in
 *   identity_link_conflicts (auditable, to be resolved); from now on no new overlap can be booked.
 * Idempotent when the person is already in the target identity.
 */
export async function linkPersonInto(
  tx: SqlExecutor,
  auditLog: AuditLog,
  now: Date,
  input: {
    personId: string;
    intoIdentityId: string;
    lockedIdentityIds: readonly string[];
    source: LinkSource;
    evidenceType: EvidenceType;
    caseId?: string | null;
    actorUserId: string | null;
    reason: string;
  },
  meta: RequestMeta,
): Promise<{
  linked: boolean;
  linkIds: string[];
  conflicts: number;
  supersededLinkId: string | null;
}> {
  const person = (
    await tx.query<{
      identity_id: string;
      origin_identity_id: string;
      kind: string;
      claimed_by_user_id: string | null;
    }>(
      'SELECT identity_id, origin_identity_id, kind, claimed_by_user_id FROM booking_persons WHERE id = ? FOR UPDATE',
      [input.personId],
    )
  )[0];
  if (person === undefined) throw new NotFoundError('Person not found');
  const from = person.identity_id;
  if (from === input.intoIdentityId)
    return { linked: false, linkIds: [], conflicts: 0, supersededLinkId: null };
  if (
    !input.lockedIdentityIds.includes(from) ||
    !input.lockedIdentityIds.includes(input.intoIdentityId)
  )
    throw new ConflictError('The patient identity changed concurrently; retry');
  if (person.kind === 'SELF')
    throw new AppError(409, 'IDENTITY_LINK_NOT_ALLOWED', 'An account person is never re-linked');
  const targetOwner = (
    await tx.query<{ user_id: string }>(
      `SELECT user_id FROM booking_persons WHERE identity_id = ? AND kind = 'SELF' LIMIT 1`,
      [input.intoIdentityId],
    )
  )[0];
  if (targetOwner === undefined)
    throw new AppError(409, 'IDENTITY_LINK_NOT_ALLOWED', 'Links only join an account identity');
  if (person.claimed_by_user_id !== null && person.claimed_by_user_id !== targetOwner.user_id)
    throw new AppError(
      409,
      'IDENTITY_OWNED_ELSEWHERE',
      'This person is owned by another account; correct the ownership first',
    );
  const mine = await holdingBookingsOfPerson(tx, input.personId, now);
  const theirs = await holdingBookings(tx, input.intoIdentityId, now);
  await tx.execute('UPDATE booking_persons SET identity_id = ? WHERE id = ?', [
    input.intoIdentityId,
    input.personId,
  ]);
  const linkId = String(
    (
      await tx.execute(
        `INSERT INTO booking_identity_links (person_id, from_identity_id, to_identity_id, source, evidence_type, case_id, actor_user_id, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.personId,
          from,
          input.intoIdentityId,
          input.source,
          input.evidenceType,
          input.caseId ?? null,
          input.actorUserId,
          input.reason,
        ],
      )
    ).insertId,
  );
  // A person away from its origin has exactly one ACTIVE link (into `from`): it is superseded.
  let supersededLinkId: string | null = null;
  if (from !== person.origin_identity_id) {
    const prior = (
      await tx.query<{ id: string }>(
        `SELECT id FROM booking_identity_links WHERE person_id = ? AND status = 'ACTIVE' AND id <> ? FOR UPDATE`,
        [input.personId, linkId],
      )
    )[0];
    if (prior !== undefined) {
      await tx.execute(
        `UPDATE booking_identity_links SET status = 'SUPERSEDED', superseded_by_link_id = ?, superseded_at = ? WHERE id = ?`,
        [linkId, now, prior.id],
      );
      supersededLinkId = prior.id;
    }
  }
  let conflicts = 0;
  for (const a of mine)
    for (const b of theirs)
      if (a.starts_at < b.ends_at && b.starts_at < a.ends_at) {
        const [x, y] = Number(a.id) < Number(b.id) ? [a.id, b.id] : [b.id, a.id];
        await tx.execute(
          'INSERT IGNORE INTO identity_link_conflicts (link_id, booking_a_id, booking_b_id) VALUES (?, ?, ?)',
          [linkId, x, y],
        );
        conflicts++;
      }
  await auditLog.record(
    tx,
    {
      action: AUDIT_ACTION.IDENTITY_LINKED,
      actorUserId: input.actorUserId,
      targetType: 'BOOKING_PERSON',
      targetId: input.personId,
      metadata: {
        linkId,
        fromIdentityId: from,
        toIdentityId: input.intoIdentityId,
        source: input.source,
        evidenceType: input.evidenceType,
        caseId: input.caseId ?? null,
        supersededLinkId,
        conflicts,
      },
    },
    meta,
  );
  if (conflicts > 0)
    await auditLog.record(
      tx,
      {
        action: AUDIT_ACTION.IDENTITY_LINK_CONFLICT,
        actorUserId: input.actorUserId,
        targetType: 'BOOKING_PERSON',
        targetId: input.personId,
        metadata: { linkId, conflicts },
      },
      meta,
    );
  return { linked: true, linkIds: [linkId], conflicts, supersededLinkId };
}

/**
 * True when `userId` owns (account or claim) any person currently in, or originating from, one
 * of `identityIds`, or is the actor of one of `bookingIds`. Such a Super Admin is "involved" and
 * must not decide on the identity (SELF_APPROVAL_FORBIDDEN, same rule as identity cases).
 */
async function isInvolved(
  tx: SqlExecutor,
  userId: string,
  identityIds: readonly string[],
  bookingIds: readonly string[] = [],
): Promise<boolean> {
  const ids = [...new Set(identityIds)];
  const persons = await tx.query(
    `SELECT id FROM booking_persons
      WHERE (identity_id IN (${ids.map(() => '?').join(', ')}) OR origin_identity_id IN (${ids.map(() => '?').join(', ')}))
        AND (user_id = ? OR claimed_by_user_id = ?) LIMIT 1`,
    [...ids, ...ids, userId, userId],
  );
  if (persons.length > 0) return true;
  if (bookingIds.length === 0) return false;
  const acted = await tx.query(
    `SELECT id FROM bookings WHERE id IN (${bookingIds.map(() => '?').join(', ')}) AND actor_user_id = ? LIMIT 1`,
    [...bookingIds, userId],
  );
  return acted.length > 0;
}

const selfApproval = (what: string) =>
  new AppError(403, 'SELF_APPROVAL_FORBIDDEN', `You cannot ${what} involving your own identity`);

/** Codes of refused privileged operations that are recorded as security events. */
const RECORDED_REFUSALS = new Set([
  'SELF_APPROVAL_FORBIDDEN',
  'IDENTITY_LINK_SUPERSEDED',
  'IDENTITY_CONFLICT_STILL_OVERLAPPING',
  'IDENTITY_CONFLICT_ALREADY_RESOLVED',
]);

/** Super Admin tools: correction of erroneous links and resolution of link conflicts. */
export class IdentityAdminService {
  constructor(
    private readonly deps: {
      db: Database;
      authz: AuthorizationService;
      auditLog: AuditLog;
      securityEvents: SecurityEventLog;
      clock: Clock;
    },
  ) {}

  /**
   * The refused transaction rolls back (nothing changes), so the refusal is recorded afterwards,
   * in its own statement, as a FAILURE security event (who, what, why; no personal data).
   */
  private async recordingRefusals<T>(
    actor: Principal,
    operation: string,
    targetId: string,
    meta: RequestMeta,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppError && RECORDED_REFUSALS.has(error.code))
        await this.deps.securityEvents.record(
          this.deps.db,
          {
            type: SECURITY_EVENT.IDENTITY_OPERATION_REFUSED,
            outcome: 'FAILURE',
            userId: actor.userId,
            metadata: { operation, targetId, code: error.code },
          },
          meta,
        );
      throw error;
    }
  }

  async listLinks(actor: Principal, personId: string) {
    await this.deps.authz.assert(actor, 'platform.identity.resolve');
    return this.deps.db.query(
      `SELECT id, person_id AS personId, from_identity_id AS fromIdentityId, to_identity_id AS toIdentityId, source, evidence_type AS evidenceType,
              case_id AS caseId, status, reason, revocation_reason AS revocationReason, superseded_by_link_id AS supersededByLinkId,
              created_at AS createdAt, revoked_at AS revokedAt, superseded_at AS supersededAt
         FROM booking_identity_links WHERE person_id = ? ORDER BY id`,
      [personId],
    );
  }

  /**
   * Correction: moves the person back to its origin identity (its own), marks the link REVOKED
   * and keeps it as history. Bookings and history are untouched. Ownership of a claimed guest
   * person is released only when explicitly requested (identity and ownership are separate).
   * Only the ACTIVE link can be revoked: a SUPERSEDED one is refused (the newer link stays).
   */
  async revokeLink(
    actor: Principal,
    linkId: string,
    input: { reason: string; releaseOwnership?: boolean | undefined },
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'platform.identity.resolve');
    return this.recordingRefusals(actor, 'REVOKE_LINK', linkId, meta, () =>
      this.deps.db.transactionWithRetry(
        async (tx) => {
          const link = (
            await tx.query<{
              id: string;
              person_id: string;
              to_identity_id: string;
              status: string;
            }>(
              'SELECT id, person_id, to_identity_id, status FROM booking_identity_links WHERE id = ?',
              [linkId],
            )
          )[0];
          if (link === undefined) throw new NotFoundError('Identity link not found');
          const person = (
            await tx.query<{ identity_id: string; origin_identity_id: string }>(
              'SELECT identity_id, origin_identity_id FROM booking_persons WHERE id = ?',
              [link.person_id],
            )
          )[0];
          if (person === undefined) throw new NotFoundError('Person not found');
          // Lock order: identities (ascending) → person → link.
          await lockIdentities(tx, [
            person.identity_id,
            person.origin_identity_id,
            link.to_identity_id,
          ]);
          const locked = (
            await tx.query<{
              identity_id: string;
              origin_identity_id: string;
              claimed_by_user_id: string | null;
            }>(
              'SELECT identity_id, origin_identity_id, claimed_by_user_id FROM booking_persons WHERE id = ? FOR UPDATE',
              [link.person_id],
            )
          )[0];
          const current = (
            await tx.query<{ status: string }>(
              'SELECT status FROM booking_identity_links WHERE id = ? FOR UPDATE',
              [linkId],
            )
          )[0];
          if (locked === undefined || current === undefined)
            throw new NotFoundError('Identity link not found');
          if (
            await isInvolved(tx, actor.userId, [
              locked.identity_id,
              locked.origin_identity_id,
              link.to_identity_id,
            ])
          )
            throw selfApproval('revoke an identity link');
          if (
            current.status === 'SUPERSEDED' ||
            (current.status === 'ACTIVE' && locked.identity_id !== link.to_identity_id)
          )
            throw new AppError(
              409,
              'IDENTITY_LINK_SUPERSEDED',
              'A newer link replaced this one; revoke the newer link instead',
            );
          if (current.status !== 'ACTIVE') throw new ConflictError('The link is already revoked');
          const now = this.deps.clock();
          await tx.execute(
            'UPDATE booking_persons SET identity_id = origin_identity_id WHERE id = ?',
            [link.person_id],
          );
          await tx.execute(
            `UPDATE booking_identity_links SET status = 'REVOKED', revoked_at = ?, revoked_by_user_id = ?, revocation_reason = ? WHERE id = ?`,
            [now, actor.userId, input.reason, linkId],
          );
          const released = input.releaseOwnership === true && locked.claimed_by_user_id !== null;
          if (released)
            await tx.execute(
              'UPDATE booking_persons SET claimed_by_user_id = NULL, claimed_at = NULL WHERE id = ?',
              [link.person_id],
            );
          await this.deps.auditLog.record(
            tx,
            {
              action: AUDIT_ACTION.IDENTITY_LINK_REVOKED,
              actorUserId: actor.userId,
              targetType: 'BOOKING_PERSON',
              targetId: link.person_id,
              metadata: {
                linkId,
                reason: input.reason,
                fromIdentityId: link.to_identity_id,
                toIdentityId: locked.origin_identity_id,
                ownershipReleased: released,
                previousOwnerUserId: released ? locked.claimed_by_user_id : null,
              },
            },
            meta,
          );
          return { linkId, status: 'REVOKED' as const, ownershipReleased: released };
        },
        { isolation: 'READ COMMITTED' },
      ),
    );
  }

  /**
   * Status: OPEN while both bookings hold time AND their persons still share one identity;
   * CLEARED when that is no longer true but nobody recorded a resolution; RESOLVED once recorded.
   * Ids, times and resolution only (support sees no clinical data).
   */
  async listConflicts(actor: Principal, onlyOpen: boolean) {
    await this.deps.authz.assert(actor, 'platform.identity.resolve');
    const now = this.deps.clock();
    const rows = await this.deps.db.query<Record<string, unknown>>(
      `SELECT c.id, c.link_id, c.booking_a_id, c.booking_b_id, c.resolved_at, c.resolved_by_user_id, c.resolution_note,
              c.resolution_method, c.created_at, ${holds('a')} AS a_holds, ${holds('b')} AS b_holds,
              (pa.identity_id = pb.identity_id) AS same_identity
         FROM identity_link_conflicts c
         JOIN bookings a ON a.id = c.booking_a_id JOIN bookings b ON b.id = c.booking_b_id
         JOIN booking_persons pa ON pa.id = a.person_id JOIN booking_persons pb ON pb.id = b.person_id
        ORDER BY c.id DESC LIMIT 200`,
      [now, now],
    );
    return rows
      .map((r) => {
        const overlapping =
          Number(r.a_holds) === 1 && Number(r.b_holds) === 1 && Number(r.same_identity) === 1;
        const status = r.resolved_at !== null ? 'RESOLVED' : overlapping ? 'OPEN' : 'CLEARED';
        return {
          conflictId: String(r.id),
          linkId: String(r.link_id),
          bookingIds: [String(r.booking_a_id), String(r.booking_b_id)],
          status,
          createdAt: (r.created_at as Date).toISOString(),
          resolution:
            r.resolved_at === null
              ? null
              : {
                  resolvedAt: (r.resolved_at as Date).toISOString(),
                  resolvedByUserId: String(r.resolved_by_user_id),
                  method: r.resolution_method as string,
                  note: r.resolution_note as string,
                },
        };
      })
      .filter((c) => !onlyOpen || c.status === 'OPEN');
  }

  /**
   * Records that support resolved a link conflict. It never changes a booking: the overlap must
   * already be gone (one booking released its time, or the link was revoked), otherwise 409.
   * A resolved conflict is final: the identical request (same actor and note) replays the stored
   * resolution without new effects; any other request is refused (no reopen, no overwrite).
   */
  async resolveConflict(actor: Principal, conflictId: string, note: string, meta: RequestMeta) {
    await this.deps.authz.assert(actor, 'platform.identity.resolve');
    return this.recordingRefusals(actor, 'RESOLVE_CONFLICT', conflictId, meta, () =>
      this.deps.db.transactionWithRetry(
        async (tx) => {
          const pre = (
            await tx.query<{ pa: string; pb: string; ia: string; ib: string }>(
              `SELECT pa.id AS pa, pb.id AS pb, pa.identity_id AS ia, pb.identity_id AS ib
                 FROM identity_link_conflicts c
                 JOIN bookings a ON a.id = c.booking_a_id JOIN bookings b ON b.id = c.booking_b_id
                 JOIN booking_persons pa ON pa.id = a.person_id JOIN booking_persons pb ON pb.id = b.person_id
                WHERE c.id = ?`,
              [conflictId],
            )
          )[0];
          if (pre === undefined) throw new NotFoundError('Identity link conflict not found');
          // Lock order: identities (ascending) → persons → conflict row. A booking of these
          // persons takes the same identity lock, so the overlap cannot change underneath.
          await lockIdentities(tx, [pre.ia, pre.ib]);
          const persons = await tx.query<{
            id: string;
            identity_id: string;
            origin_identity_id: string;
          }>(
            'SELECT id, identity_id, origin_identity_id FROM booking_persons WHERE id IN (?, ?) ORDER BY id FOR UPDATE',
            [pre.pa, pre.pb],
          );
          const c = (
            await tx.query<{
              booking_a_id: string;
              booking_b_id: string;
              resolved_at: Date | null;
              resolved_by_user_id: string | null;
              resolution_note: string | null;
              resolution_method: string | null;
            }>(
              `SELECT booking_a_id, booking_b_id, resolved_at, resolved_by_user_id, resolution_note, resolution_method
                 FROM identity_link_conflicts WHERE id = ? FOR UPDATE`,
              [conflictId],
            )
          )[0];
          if (c === undefined) throw new NotFoundError('Identity link conflict not found');
          const identityOf = (personId: string) =>
            persons.find((p) => p.id === personId)?.identity_id;
          if (identityOf(pre.pa) !== pre.ia || identityOf(pre.pb) !== pre.ib)
            throw new ConflictError('The patient identity changed concurrently; retry');
          const identities = persons.flatMap((p) => [p.identity_id, p.origin_identity_id]);
          if (await isInvolved(tx, actor.userId, identities, [c.booking_a_id, c.booking_b_id]))
            throw selfApproval('resolve an identity conflict');
          if (c.resolved_at !== null) {
            if (c.resolved_by_user_id === actor.userId && c.resolution_note === note)
              return {
                conflictId,
                status: 'RESOLVED' as const,
                method: c.resolution_method ?? 'UNRECORDED',
                resolvedAt: c.resolved_at.toISOString(),
                resolvedByUserId: c.resolved_by_user_id,
                alreadyResolved: true,
              };
            throw new AppError(
              409,
              'IDENTITY_CONFLICT_ALREADY_RESOLVED',
              'This conflict was already resolved; a resolution is final',
            );
          }
          const now = this.deps.clock();
          const holding = await tx.query<{ id: string }>(
            `SELECT b.id FROM bookings b WHERE b.id IN (?, ?) AND ${HOLDS_TIME_SQL}`,
            [c.booking_a_id, c.booking_b_id, now],
          );
          const sameIdentity = pre.ia === pre.ib;
          if (holding.length === 2 && sameIdentity)
            throw new AppError(
              409,
              'IDENTITY_CONFLICT_STILL_OVERLAPPING',
              'Both bookings still hold the same time for one identity; one must be cancelled or the link revoked first',
            );
          const method = sameIdentity ? 'BOOKING_RELEASED' : 'LINK_REVOKED';
          await tx.execute(
            `UPDATE identity_link_conflicts SET resolved_at = ?, resolved_by_user_id = ?, resolution_note = ?, resolution_method = ?
              WHERE id = ? AND resolved_at IS NULL`,
            [now, actor.userId, note, method, conflictId],
          );
          await this.deps.auditLog.record(
            tx,
            {
              action: AUDIT_ACTION.IDENTITY_LINK_CONFLICT_RESOLVED,
              actorUserId: actor.userId,
              targetType: 'IDENTITY_LINK_CONFLICT',
              targetId: conflictId,
              metadata: { method, note, bookingIds: [c.booking_a_id, c.booking_b_id] },
            },
            meta,
          );
          return {
            conflictId,
            status: 'RESOLVED' as const,
            method,
            resolvedAt: now.toISOString(),
            resolvedByUserId: actor.userId,
            alreadyResolved: false,
          };
        },
        { isolation: 'READ COMMITTED' },
      ),
    );
  }
}

function holds(alias: string): string {
  return HOLDS_TIME_SQL.replaceAll('b.', `${alias}.`);
}
