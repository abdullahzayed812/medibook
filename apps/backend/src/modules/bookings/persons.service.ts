import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import { randomToken, sha256Hex } from '../../shared/security/crypto.js';
import type { RateLimiter } from '../../shared/security/rate-limiter.js';
import type { AuthorizationService, Principal } from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import type { OtpService } from '../iam/index.js';
import {
  linkPersonInto,
  lockIdentitiesOfPersons,
  newIdentity,
  type EvidenceType,
} from './identity-links.js';

/**
 * Booking persons, ownership and delegation (ADR-045, ADR-050). A booking person is the GLOBAL,
 * non-medical identity an appointment is for — the patient conflict key across clinics. It never
 * carries medical data, and clinic patient profiles are never merged.
 *
 *  SELF       an account's own person, keyed by user_id (never by phone).
 *  GUEST      created by a verified-phone guest session. Ownership is proven ONLY by its claim
 *             code (256-bit, shown once, hash stored) — never by controlling the phone, which
 *             can change hands. An account that claims it becomes its owner (claimed_by_user_id).
 *  DEPENDENT  no login of its own; a user books for it through a DECLARED delegation.
 *  CLINIC     recorded by clinic staff for a patient without a verified identity.
 *
 * Persons are never merged and never matched by phone. Ambiguous ownership (guest bookings
 * without a claim code, recycled numbers) goes to an identity support case decided by a Super
 * Admin. A delegation authorizes BOOKING only — never medical-record access or consent.
 */

export const RELATIONSHIPS = ['GUARDIAN', 'SPOUSE', 'RELATIVE', 'CAREGIVER', 'OTHER'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];
/** Legal age below which a person is a minor (guardianship applies). Platform rule. */
export const MINOR_AGE_YEARS = 18;
export const GUEST_SESSION_MINUTES = 60;
/** Claim codes stay valid for re-attachment and claiming for one year unless used or rotated. */
export const CLAIM_CODE_DAYS = 365;
/** Failed claim-code attempts allowed per guest session, and claims per account per hour. */
export const MAX_GUEST_ATTACH_FAILURES = 5;
export const MAX_CLAIMS_PER_HOUR = 10;

export interface PersonRow {
  id: string;
  kind: 'SELF' | 'GUEST' | 'DEPENDENT' | 'CLINIC';
  user_id: string | null;
  claimed_by_user_id: string | null;
  /** Canonical booking-conflict identity (ADR-055); shared by verified-linked persons. */
  identity_id: string;
  display_name: string;
  birth_date: string | null;
}

export type ActingAs =
  | { readonly kind: 'SELF'; readonly person: PersonRow }
  | {
      readonly kind: 'DELEGATE';
      readonly person: PersonRow;
      readonly delegationId: string;
      readonly relationship: Relationship;
    };

export interface GuestSession {
  readonly sessionId: string;
  readonly phoneE164: string;
  readonly phoneHash: string;
  /** The one guest person this session acts for (null until it books or attaches). */
  readonly personId: string | null;
}

const PERSON_SELECT = `SELECT id, kind, user_id, claimed_by_user_id, identity_id, display_name,
    DATE_FORMAT(birth_date, '%Y-%m-%d') AS birth_date FROM booking_persons`;

const claimInvalid = () =>
  new AppError(400, 'CLAIM_INVALID', 'The claim code is invalid, expired or already used');

export interface PersonsDeps {
  readonly db: Database;
  readonly otp: OtpService;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  readonly rateLimiter: RateLimiter;
  readonly authz: AuthorizationService;
}

const RC = { isolation: 'READ COMMITTED' as const };

export class PersonsService {
  constructor(private readonly deps: PersonsDeps) {}

  // ---------- identities ----------

  /**
   * The account holder's SELF person (keyed by user_id), created on first use. It is NEVER
   * linked to another person by phone: a guest person with the same phone stays separate until
   * it is claimed with its claim code or through a support case. The informational phone hash
   * follows verified phone changes, so the identity stays the same.
   */
  async selfPerson(userId: string, meta: RequestMeta): Promise<PersonRow> {
    return this.firstUse(() => this.selfPersonOnce(userId, meta));
  }

  /**
   * Concurrent first uses race to create the same person: READ COMMITTED avoids gap-lock
   * deadlocks, deadlocks are retried, and the loser of a duplicate-key race re-reads.
   */
  private async firstUse<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const errno = (err as { errno?: number }).errno;
        if ((errno !== 1062 && errno !== 1213) || attempt >= 3) throw err;
      }
    }
  }

  private async selfPersonOnce(userId: string, meta: RequestMeta): Promise<PersonRow> {
    const user = (
      await this.deps.db.query<{ phone_e164: string; display_name: string | null }>(
        `SELECT u.phone_e164, p.display_name FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ?`,
        [userId],
      )
    )[0];
    if (user === undefined) throw new UnauthorizedError();
    const hash = this.deps.otp.subjectHash(user.phone_e164);
    const existing = (
      await this.deps.db.query<PersonRow & { phone_hash: string | null }>(
        `SELECT id, kind, user_id, claimed_by_user_id, identity_id, display_name, DATE_FORMAT(birth_date, '%Y-%m-%d') AS birth_date,
                phone_hash FROM booking_persons WHERE user_id = ?`,
        [userId],
      )
    )[0];
    if (existing !== undefined) {
      if (existing.phone_hash !== hash)
        await this.deps.db.execute(
          'UPDATE booking_persons SET phone_hash = ?, phone_hash_key_version = 1 WHERE id = ?',
          [hash, existing.id],
        );
      return {
        id: existing.id,
        kind: existing.kind,
        user_id: existing.user_id,
        claimed_by_user_id: existing.claimed_by_user_id,
        identity_id: existing.identity_id,
        display_name: existing.display_name,
        birth_date: existing.birth_date,
      };
    }
    const displayName = user.display_name ?? 'Patient';
    return this.deps.db.transactionWithRetry(async (tx) => {
      const identity = await newIdentity(tx);
      const id = String(
        (
          await tx.execute(
            `INSERT INTO booking_persons (kind, phone_hash, user_id, display_name, created_by_user_id, identity_id, origin_identity_id)
             VALUES ('SELF', ?, ?, ?, ?, ?, ?)`,
            [hash, userId, displayName, userId, identity, identity],
          )
        ).insertId,
      );
      await this.audit(tx, AUDIT_ACTION.BOOKING_PERSON_CREATED, userId, id, { kind: 'SELF' }, meta);
      const person: PersonRow = {
        id,
        kind: 'SELF',
        user_id: userId,
        claimed_by_user_id: null,
        identity_id: identity,
        display_name: displayName,
        birth_date: null,
      };
      return person;
    }, RC);
  }

  /**
   * The session's guest person: the one it is bound to, or a NEW guest person bound to it now.
   * A verified phone never selects an existing person (it may be a recycled number); returning
   * guests attach their person with its claim code first (attachGuest).
   */
  async guestPerson(
    session: GuestSession,
    displayName: string,
    meta: RequestMeta,
  ): Promise<PersonRow> {
    return this.deps.db.transactionWithRetry(async (tx) => {
      const bound = (
        await tx.query<{ person_id: string | null }>(
          'SELECT person_id FROM guest_booking_sessions WHERE id = ? FOR UPDATE',
          [session.sessionId],
        )
      )[0];
      if (bound !== undefined && bound.person_id !== null) {
        const person = (
          await tx.query<PersonRow>(`${PERSON_SELECT} WHERE id = ?`, [bound.person_id])
        )[0];
        if (person === undefined) throw new Error('bound person vanished');
        return person;
      }
      const identity = await newIdentity(tx);
      const id = String(
        (
          await tx.execute(
            `INSERT INTO booking_persons (kind, phone_hash, display_name, identity_id, origin_identity_id) VALUES ('GUEST', ?, ?, ?, ?)`,
            [session.phoneHash, displayName, identity, identity],
          )
        ).insertId,
      );
      await tx.execute('UPDATE guest_booking_sessions SET person_id = ? WHERE id = ?', [
        id,
        session.sessionId,
      ]);
      await this.audit(tx, AUDIT_ACTION.BOOKING_PERSON_CREATED, null, id, { kind: 'GUEST' }, meta);
      const person: PersonRow = {
        id,
        kind: 'GUEST',
        user_id: null,
        claimed_by_user_id: null,
        identity_id: identity,
        display_name: displayName,
        birth_date: null,
      };
      return person;
    }, RC);
  }

  /** Clinic-recorded person for a patient without a verified identity (staff bookings). */
  async insertClinicPerson(
    tx: SqlExecutor,
    staffUserId: string,
    input: { displayName: string; birthDate?: string | null | undefined },
  ): Promise<PersonRow> {
    const identity = await newIdentity(tx);
    const id = String(
      (
        await tx.execute(
          `INSERT INTO booking_persons (kind, display_name, birth_date, created_by_user_id, identity_id, origin_identity_id)
           VALUES ('CLINIC', ?, ?, ?, ?, ?)`,
          [input.displayName, input.birthDate ?? null, staffUserId, identity, identity],
        )
      ).insertId,
    );
    return {
      id,
      kind: 'CLINIC',
      user_id: null,
      claimed_by_user_id: null,
      identity_id: identity,
      display_name: input.displayName,
      birth_date: input.birthDate ?? null,
    };
  }

  /**
   * How `userId` may act for `personId`: as the person themself (own SELF person, or a guest
   * person they claimed), or through an ACTIVE booking delegation. Anything else is a 404.
   */
  async actingAs(executor: SqlExecutor, userId: string, personId: string): Promise<ActingAs> {
    const person = (
      await executor.query<PersonRow>(`${PERSON_SELECT} WHERE id = ?`, [personId])
    )[0];
    if (person === undefined) throw new NotFoundError('Person not found');
    if (person.user_id === userId || person.claimed_by_user_id === userId)
      return { kind: 'SELF', person };
    const delegation = (
      await executor.query<{ id: string; relationship: Relationship }>(
        `SELECT id, relationship FROM booking_delegations WHERE delegate_user_id = ? AND person_id = ? AND status = 'ACTIVE'`,
        [userId, personId],
      )
    )[0];
    if (delegation === undefined) throw new NotFoundError('Person not found');
    return {
      kind: 'DELEGATE',
      person,
      delegationId: delegation.id,
      relationship: delegation.relationship,
    };
  }

  /** The person `userId` books for: self by default, or one they own or hold a delegation for. */
  async subjectFor(
    userId: string,
    personId: string | undefined,
    meta: RequestMeta,
  ): Promise<PersonRow> {
    const self = await this.selfPerson(userId, meta);
    if (personId === undefined || personId === self.id) return self;
    return (await this.actingAs(this.deps.db, userId, personId)).person;
  }

  /** Persons the user may book for: self, claimed guest persons, active delegations. */
  async bookablePersons(userId: string, meta: RequestMeta) {
    const self = await this.selfPerson(userId, meta);
    const owned = await this.deps.db.query<PersonRow>(
      `${PERSON_SELECT} WHERE claimed_by_user_id = ? ORDER BY id`,
      [userId],
    );
    const delegated = await this.deps.db.query<
      PersonRow & { delegation_id: string; relationship: string; basis: string }
    >(
      `SELECT p.id, p.kind, p.user_id, p.claimed_by_user_id, p.display_name, DATE_FORMAT(p.birth_date, '%Y-%m-%d') AS birth_date,
              d.id AS delegation_id, d.relationship, d.basis
         FROM booking_delegations d JOIN booking_persons p ON p.id = d.person_id
        WHERE d.delegate_user_id = ? AND d.status = 'ACTIVE' ORDER BY d.id`,
      [userId],
    );
    const own = (p: PersonRow, isSelf: boolean) => ({
      personId: p.id,
      kind: p.kind,
      displayName: p.display_name,
      self: isSelf,
      claimed: !isSelf,
      relationship: null,
      basis: null,
      delegationId: null,
    });
    return [
      own(self, true),
      ...owned.map((p) => own(p, false)),
      ...delegated.map((p) => ({
        personId: p.id,
        kind: p.kind,
        displayName: p.display_name,
        self: false,
        claimed: false,
        relationship: p.relationship,
        basis: p.basis,
        delegationId: p.delegation_id,
      })),
    ];
  }

  // ---------- claim codes ----------

  /**
   * Issues the FIRST claim code of a guest person, returned once (only its hash is stored).
   * Returns null when the person already has or had a code: codes are never shown again.
   */
  async issueFirstClaimCode(
    personId: string,
    meta: RequestMeta,
  ): Promise<{ claimCode: string; expiresAt: string } | null> {
    return this.deps.db.transactionWithRetry(async (tx) => {
      await tx.query('SELECT id FROM booking_persons WHERE id = ? FOR UPDATE', [personId]);
      const any = await tx.query('SELECT id FROM guest_claim_codes WHERE person_id = ? LIMIT 1', [
        personId,
      ]);
      if (any.length > 0) return null;
      return this.insertClaimCode(tx, personId, meta);
    }, RC);
  }

  /** Revokes the session person's active codes and issues a new one (returned once). */
  async rotateClaimCode(
    session: GuestSession,
    meta: RequestMeta,
  ): Promise<{ claimCode: string; expiresAt: string }> {
    if (session.personId === null) throw claimInvalid();
    const personId = session.personId;
    return this.deps.db.transactionWithRetry(async (tx) => {
      const person = (
        await tx.query<PersonRow>(`${PERSON_SELECT} WHERE id = ? FOR UPDATE`, [personId])
      )[0];
      if (person?.kind !== 'GUEST' || person.claimed_by_user_id !== null) throw claimInvalid();
      await tx.execute(
        `UPDATE guest_claim_codes SET status = 'REVOKED', revoked_at = ? WHERE person_id = ? AND status = 'ACTIVE'`,
        [this.deps.clock(), personId],
      );
      return this.insertClaimCode(tx, personId, meta);
    }, RC);
  }

  /**
   * A returning guest attaches their person to a new session with the claim code AND the same
   * verified phone (two factors). Failures are counted per session and lock it after 5.
   */
  async attachGuest(
    session: GuestSession,
    code: string,
    meta: RequestMeta,
  ): Promise<{ personId: string }> {
    const outcome = await this.deps.db.transaction(async (tx) => {
      const row = (
        await tx.query<{ person_id: string | null; failed_attach_count: number }>(
          'SELECT person_id, failed_attach_count FROM guest_booking_sessions WHERE id = ? FOR UPDATE',
          [session.sessionId],
        )
      )[0];
      if (row === undefined || row.failed_attach_count >= MAX_GUEST_ATTACH_FAILURES)
        return { kind: 'LOCKED' as const };
      const match = (
        await tx.query<{
          person_id: string;
          status: string;
          expires_at: Date;
          phone_hash: string | null;
          kind: string;
          claimed_by_user_id: string | null;
        }>(
          `SELECT c.person_id, c.status, c.expires_at, p.phone_hash, p.kind, p.claimed_by_user_id
             FROM guest_claim_codes c JOIN booking_persons p ON p.id = c.person_id WHERE c.code_hash = ?`,
          [sha256Hex(code)],
        )
      )[0];
      if (
        match?.status !== 'ACTIVE' ||
        match.expires_at <= this.deps.clock() ||
        match.kind !== 'GUEST' ||
        match.claimed_by_user_id !== null ||
        match.phone_hash !== session.phoneHash ||
        (row.person_id !== null && row.person_id !== match.person_id)
      ) {
        await tx.execute(
          'UPDATE guest_booking_sessions SET failed_attach_count = failed_attach_count + 1 WHERE id = ?',
          [session.sessionId],
        );
        return { kind: 'INVALID' as const };
      }
      await tx.execute('UPDATE guest_booking_sessions SET person_id = ? WHERE id = ?', [
        match.person_id,
        session.sessionId,
      ]);
      await this.audit(
        tx,
        AUDIT_ACTION.GUEST_SESSION_ATTACHED,
        null,
        match.person_id,
        { sessionId: session.sessionId },
        meta,
      );
      return { kind: 'OK' as const, personId: match.person_id };
    });
    if (outcome.kind === 'LOCKED')
      throw new AppError(
        429,
        'GUEST_ATTACH_LOCKED',
        'Too many invalid claim codes. Verify your phone again.',
      );
    if (outcome.kind === 'INVALID') throw claimInvalid();
    return { personId: outcome.personId };
  }

  /**
   * An account claims a guest person with its claim code (atomic, audited, rate limited). The
   * account becomes its owner AND the guest person's identity is linked into the account's own
   * conflict identity (ADR-055) — in the same transaction; a failed claim links nothing. The
   * person records stay separate; profiles and history are untouched. Repeating the claim with
   * the same account is idempotent (no second link); any other account gets CLAIM_INVALID.
   */
  async claimWithCode(userId: string, code: string, meta: RequestMeta) {
    const limit = await this.deps.rateLimiter.consume(
      `booking:claim:user:${userId}`,
      MAX_CLAIMS_PER_HOUR,
      3600,
    );
    if (!limit.allowed)
      throw new AppError(429, 'CLAIM_RATE_LIMITED', 'Too many claim attempts. Please wait.');
    // Safe sequence: the account's own person (and identity) exists before the claim transaction.
    const self = await this.selfPerson(userId, meta);
    return this.deps.db.transactionWithRetry(async (tx) => {
      const c = (
        await tx.query<{
          id: string;
          person_id: string;
          status: string;
          expires_at: Date;
          used_by_user_id: string | null;
        }>(
          'SELECT id, person_id, status, expires_at, used_by_user_id FROM guest_claim_codes WHERE code_hash = ? FOR UPDATE',
          [sha256Hex(code)],
        )
      )[0];
      if (c === undefined) throw claimInvalid();
      // Lock order: identities (ascending, re-checked) → persons.
      const locked = await lockIdentitiesOfPersons(tx, [c.person_id, self.id]);
      const person = (
        await tx.query<PersonRow>(`${PERSON_SELECT} WHERE id = ? FOR UPDATE`, [c.person_id])
      )[0];
      const owner = (
        await tx.query<PersonRow>(`${PERSON_SELECT} WHERE id = ? FOR UPDATE`, [self.id])
      )[0];
      if (person === undefined || owner === undefined) throw claimInvalid();
      if (
        c.status === 'USED' &&
        c.used_by_user_id === userId &&
        person.claimed_by_user_id === userId
      )
        return {
          personId: person.id,
          bookings: await this.countBookings(tx, person.id),
          alreadyClaimed: true,
          identityConflicts: 0,
        };
      if (
        c.status !== 'ACTIVE' ||
        c.expires_at <= this.deps.clock() ||
        person.kind !== 'GUEST' ||
        person.claimed_by_user_id !== null
      )
        throw claimInvalid();
      await this.takeOwnership(tx, person.id, userId);
      await tx.execute(
        `UPDATE guest_claim_codes SET status = 'USED', used_at = ?, used_by_user_id = ? WHERE id = ?`,
        [this.deps.clock(), userId, c.id],
      );
      const link = await linkPersonInto(
        tx,
        this.deps.auditLog,
        this.deps.clock(),
        {
          personId: person.id,
          intoIdentityId: owner.identity_id,
          lockedIdentityIds: locked,
          source: 'CLAIM_CODE',
          evidenceType: 'CLAIM_CODE',
          actorUserId: userId,
          reason: 'Guest bookings claimed with a valid claim code',
        },
        meta,
      );
      await this.audit(
        tx,
        AUDIT_ACTION.BOOKING_PERSON_CLAIMED,
        userId,
        person.id,
        { via: 'CLAIM_CODE' },
        meta,
      );
      return {
        personId: person.id,
        bookings: await this.countBookings(tx, person.id),
        alreadyClaimed: false,
        identityConflicts: link.conflicts,
      };
    }, RC);
  }

  // ---------- identity support cases ----------

  /**
   * Opens a support case.
   *  GUEST_OWNERSHIP  guest bookings the account cannot prove with a claim code; candidates are
   *                   unclaimed guest persons with the account's current phone (a signal only).
   *  IDENTITY_LINK    another booking person — typically a patient recorded by clinic staff —
   *                   is the requester; the booking reference names it (a signal only). LINK
   *                   associates it with the requester's conflict identity WITHOUT ownership.
   * The requester learns nothing about candidates.
   */
  async openIdentityCase(
    userId: string,
    input: {
      statement: string;
      bookingReference?: string | undefined;
      kind?: 'GUEST_OWNERSHIP' | 'IDENTITY_LINK' | undefined;
    },
    meta: RequestMeta,
  ) {
    const kind = input.kind ?? 'GUEST_OWNERSHIP';
    const user = (
      await this.deps.db.query<{ phone_e164: string }>(
        'SELECT phone_e164 FROM users WHERE id = ?',
        [userId],
      )
    )[0];
    if (user === undefined) throw new UnauthorizedError();
    if (kind === 'IDENTITY_LINK' && input.bookingReference === undefined)
      throw new ValidationError([
        { location: 'body', path: 'bookingReference', message: 'required for IDENTITY_LINK' },
      ]);
    const open = await this.deps.db.query(
      `SELECT id FROM identity_support_cases WHERE requested_by_user_id = ? AND status = 'OPEN'`,
      [userId],
    );
    if (open.length >= 3) throw new ConflictError('Too many open identity cases');
    const hash = this.deps.otp.subjectHash(user.phone_e164);
    const candidates =
      kind === 'GUEST_OWNERSHIP'
        ? await this.deps.db.query<{ id: string }>(
            `SELECT id FROM booking_persons WHERE kind = 'GUEST' AND claimed_by_user_id IS NULL AND phone_hash = ? ORDER BY id`,
            [hash],
          )
        : await this.deps.db.query<{ id: string }>(
            `SELECT p.id FROM bookings b JOIN booking_persons p ON p.id = b.person_id
              WHERE b.id = ? AND p.kind IN ('CLINIC', 'GUEST')`,
            [input.bookingReference ?? ''],
          );
    return this.deps.db.transaction(async (tx) => {
      const id = String(
        (
          await tx.execute(
            `INSERT INTO identity_support_cases (requested_by_user_id, phone_hash, candidate_person_ids, booking_reference, statement, case_kind)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              userId,
              hash,
              JSON.stringify(candidates.map((c) => c.id)),
              input.bookingReference ?? null,
              input.statement,
              kind,
            ],
          )
        ).insertId,
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.IDENTITY_CASE_OPENED,
          actorUserId: userId,
          targetType: 'IDENTITY_CASE',
          targetId: id,
          metadata: { kind, candidates: candidates.length },
        },
        meta,
      );
      return { caseId: id, kind, status: 'OPEN' as const };
    });
  }

  async myIdentityCases(userId: string) {
    const rows = await this.deps.db.query<{
      id: string;
      status: string;
      case_kind: string;
      created_at: Date;
      resolved_at: Date | null;
    }>(
      'SELECT id, status, case_kind, created_at, resolved_at FROM identity_support_cases WHERE requested_by_user_id = ? ORDER BY id DESC LIMIT 50',
      [userId],
    );
    return rows.map((r) => ({
      caseId: r.id,
      kind: r.case_kind,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      resolvedAt: r.resolved_at?.toISOString() ?? null,
    }));
  }

  async listIdentityCases(actor: Principal, status: 'OPEN' | 'LINKED' | 'REJECTED' | undefined) {
    await this.deps.authz.assert(actor, 'platform.identity.resolve');
    const rows = await this.deps.db.query<Record<string, unknown>>(
      `SELECT id, case_kind, requested_by_user_id, candidate_person_ids, booking_reference, statement, status, resolved_person_id,
              resolution_reason, evidence_type, link_id, created_at, resolved_at
         FROM identity_support_cases WHERE (? IS NULL OR status = ?) ORDER BY id DESC LIMIT 100`,
      [status ?? null, status ?? null],
    );
    return rows.map((r) => ({
      caseId: String(r.id),
      kind: r.case_kind as string,
      requestedByUserId: String(r.requested_by_user_id),
      candidatePersonIds: r.candidate_person_ids as string[],
      bookingReference: (r.booking_reference as string | null) ?? null,
      statement: r.statement as string,
      status: r.status as string,
      resolvedPersonId: (r.resolved_person_id as string | null) ?? null,
      evidenceType: (r.evidence_type as string | null) ?? null,
      linkId: (r.link_id as string | null) ?? null,
      resolutionReason: (r.resolution_reason as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      resolvedAt: (r.resolved_at as Date | null)?.toISOString() ?? null,
    }));
  }

  /**
   * Super Admin decision after offline verification (MFA; never the requester). Phone equality
   * is never sufficient: LINK requires a recorded evidence type (ID document, booking details,
   * clinic attestation, other — with a note).
   *  GUEST_OWNERSHIP + LINK  requester becomes owner of an unclaimed guest person AND that
   *                          person joins the requester's conflict identity.
   *  IDENTITY_LINK + LINK    the person (clinic-recorded or guest) joins the requester's conflict
   *                          identity only — no ownership, no access to its bookings.
   *  REJECT                  closes the case; no relationship changes.
   * Atomic and audited. Overlapping existing bookings are recorded as link conflicts, never
   * cancelled.
   */
  async resolveIdentityCase(
    actor: Principal,
    caseId: string,
    input: {
      decision: 'LINK' | 'REJECT';
      personId?: string | undefined;
      reason: string;
      verificationNote: string;
      evidenceType?: Exclude<EvidenceType, 'CLAIM_CODE'> | undefined;
    },
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'platform.identity.resolve');
    const pre = (
      await this.deps.db.query<{ requested_by_user_id: string }>(
        'SELECT requested_by_user_id FROM identity_support_cases WHERE id = ?',
        [caseId],
      )
    )[0];
    if (pre === undefined) throw new NotFoundError('Identity case not found');
    if (pre.requested_by_user_id === actor.userId)
      throw new AppError(
        403,
        'SELF_APPROVAL_FORBIDDEN',
        'You cannot resolve your own identity case',
      );
    if (
      input.decision === 'LINK' &&
      (input.personId === undefined || input.evidenceType === undefined)
    )
      throw new ValidationError([
        {
          location: 'body',
          path: 'evidenceType',
          message: 'personId and evidenceType are required for LINK',
        },
      ]);
    // The requester's own person (and identity) exists before the decision transaction.
    const requesterPerson =
      input.decision === 'LINK' ? await this.selfPerson(pre.requested_by_user_id, meta) : null;
    return this.deps.db.transactionWithRetry(async (tx) => {
      const c = (
        await tx.query<{
          id: string;
          requested_by_user_id: string;
          status: string;
          case_kind: string;
        }>(
          'SELECT id, requested_by_user_id, status, case_kind FROM identity_support_cases WHERE id = ? FOR UPDATE',
          [caseId],
        )
      )[0];
      if (c === undefined) throw new NotFoundError('Identity case not found');
      if (c.status !== 'OPEN') throw new ConflictError('The case is already resolved');
      const now = this.deps.clock();
      let linked: string | null = null;
      let linkId: string | null = null;
      if (input.decision === 'LINK' && requesterPerson !== null && input.personId !== undefined) {
        const locked = await lockIdentitiesOfPersons(tx, [input.personId, requesterPerson.id]);
        const person = (
          await tx.query<PersonRow>(`${PERSON_SELECT} WHERE id = ? FOR UPDATE`, [input.personId])
        )[0];
        const owner = (
          await tx.query<PersonRow>(`${PERSON_SELECT} WHERE id = ? FOR UPDATE`, [
            requesterPerson.id,
          ])
        )[0];
        if (person === undefined || owner === undefined)
          throw new NotFoundError('Person not found');
        if (c.case_kind === 'GUEST_OWNERSHIP') {
          if (person.kind !== 'GUEST' || person.claimed_by_user_id !== null)
            throw new ConflictError('Only an unclaimed guest person can be linked');
          await this.takeOwnership(tx, person.id, c.requested_by_user_id);
          await tx.execute(
            `UPDATE guest_claim_codes SET status = 'REVOKED', revoked_at = ? WHERE person_id = ? AND status = 'ACTIVE'`,
            [now, person.id],
          );
          await this.audit(
            tx,
            AUDIT_ACTION.BOOKING_PERSON_CLAIMED,
            c.requested_by_user_id,
            person.id,
            { via: 'SUPPORT_CASE', caseId },
            meta,
          );
        } else if (person.kind !== 'CLINIC' && person.kind !== 'GUEST') {
          // Accounts and dependents are other people (or need their own proofs): never support-linked.
          throw new ConflictError('Only clinic-recorded or guest persons can be identity-linked');
        }
        const link = await linkPersonInto(
          tx,
          this.deps.auditLog,
          now,
          {
            personId: person.id,
            intoIdentityId: owner.identity_id,
            lockedIdentityIds: locked,
            source: 'SUPPORT_CASE',
            evidenceType: input.evidenceType ?? 'OTHER',
            caseId,
            actorUserId: actor.userId,
            reason: input.reason,
          },
          meta,
        );
        linked = person.id;
        linkId = link.linkIds[0] ?? null;
      }
      const status = input.decision === 'LINK' ? 'LINKED' : 'REJECTED';
      await tx.execute(
        `UPDATE identity_support_cases SET status = ?, resolved_person_id = ?, resolved_by_user_id = ?, resolution_reason = ?,
           verification_note = ?, evidence_type = ?, link_id = ?, resolved_at = ? WHERE id = ?`,
        [
          status,
          linked,
          actor.userId,
          input.reason,
          input.verificationNote,
          input.evidenceType ?? null,
          linkId,
          now,
          caseId,
        ],
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.IDENTITY_CASE_RESOLVED,
          actorUserId: actor.userId,
          targetType: 'IDENTITY_CASE',
          targetId: caseId,
          metadata: {
            decision: input.decision,
            kind: c.case_kind,
            personId: linked,
            evidenceType: input.evidenceType ?? null,
            reason: input.reason,
          },
        },
        meta,
      );
      return { caseId, status, linkId };
    }, RC);
  }

  // ---------- delegation ----------

  /**
   * A person without own login, booked for by the creating user under a DECLARED delegation.
   * GUARDIAN requires a birth date showing a minor; every other relationship requires an
   * authority statement (recorded verbatim for audit).
   */
  async createDependent(
    userId: string,
    input: {
      displayName: string;
      birthDate?: string | undefined;
      relationship: Relationship;
      authorityStatement?: string | undefined;
    },
    meta: RequestMeta,
  ) {
    const issues: { location: string; path: string; message: string }[] = [];
    if (input.relationship === 'GUARDIAN') {
      if (input.birthDate === undefined)
        issues.push({ location: 'body', path: 'birthDate', message: 'required for a guardian' });
      else if (!this.isMinor(input.birthDate))
        issues.push({
          location: 'body',
          path: 'relationship',
          message: `GUARDIAN applies to minors (under ${MINOR_AGE_YEARS}); state your authority with another relationship`,
        });
    } else if ((input.authorityStatement ?? '').trim().length < 10) {
      issues.push({
        location: 'body',
        path: 'authorityStatement',
        message: 'describe your authority to book (≥ 10 characters)',
      });
    }
    if (input.birthDate !== undefined && input.birthDate > this.today())
      issues.push({ location: 'body', path: 'birthDate', message: 'must not be in the future' });
    if (issues.length > 0) throw new ValidationError(issues);
    return this.deps.db.transaction(async (tx) => {
      const identity = await newIdentity(tx);
      const personId = String(
        (
          await tx.execute(
            `INSERT INTO booking_persons (kind, display_name, birth_date, created_by_user_id, identity_id, origin_identity_id)
             VALUES ('DEPENDENT', ?, ?, ?, ?, ?)`,
            [input.displayName, input.birthDate ?? null, userId, identity, identity],
          )
        ).insertId,
      );
      const delegationId = String(
        (
          await tx.execute(
            `INSERT INTO booking_delegations (delegate_user_id, person_id, relationship, basis, authority_statement)
             VALUES (?, ?, ?, 'DECLARED', ?)`,
            [userId, personId, input.relationship, input.authorityStatement ?? null],
          )
        ).insertId,
      );
      await this.audit(
        tx,
        AUDIT_ACTION.BOOKING_PERSON_CREATED,
        userId,
        personId,
        { kind: 'DEPENDENT' },
        meta,
      );
      await this.auditDelegation(
        tx,
        userId,
        delegationId,
        { personId, basis: 'DECLARED', relationship: input.relationship, status: 'ACTIVE' },
        meta,
      );
      return {
        personId,
        delegationId,
        kind: 'DEPENDENT' as const,
        displayName: input.displayName,
        relationship: input.relationship,
      };
    });
  }

  /**
   * The account holder consents that another account (by phone) may book for them. The delegate
   * must already have an account; the answer is the same 404 whether or not it exists.
   */
  async grantConsent(
    userId: string,
    input: { phoneE164: string; relationship: Relationship },
    meta: RequestMeta,
  ) {
    const self = await this.selfPerson(userId, meta);
    const delegate = (
      await this.deps.db.query<{ id: string }>(
        `SELECT id FROM users WHERE phone_e164 = ? AND status = 'ACTIVE'`,
        [input.phoneE164],
      )
    )[0];
    if (delegate === undefined || delegate.id === userId)
      throw new NotFoundError('No eligible account for this phone');
    return this.deps.db.transaction(async (tx) => {
      const active = await tx.query(
        `SELECT id FROM booking_delegations WHERE delegate_user_id = ? AND person_id = ? AND status = 'ACTIVE'`,
        [delegate.id, self.id],
      );
      if (active.length > 0) throw new ConflictError('This account may already book for you');
      const id = String(
        (
          await tx.execute(
            `INSERT INTO booking_delegations (delegate_user_id, person_id, relationship, basis, consent_by_user_id)
             VALUES (?, ?, ?, 'CONSENT', ?)`,
            [delegate.id, self.id, input.relationship, userId],
          )
        ).insertId,
      );
      await this.auditDelegation(
        tx,
        userId,
        id,
        { personId: self.id, basis: 'CONSENT', relationship: input.relationship, status: 'ACTIVE' },
        meta,
      );
      return {
        delegationId: id,
        personId: self.id,
        relationship: input.relationship,
        basis: 'CONSENT' as const,
      };
    });
  }

  /** Delegations granted on the caller's own person (who may book for me). */
  async grantedDelegations(userId: string, meta: RequestMeta) {
    const self = await this.selfPerson(userId, meta);
    const rows = await this.deps.db.query<{
      id: string;
      relationship: string;
      basis: string;
      created_at: Date;
    }>(
      `SELECT id, relationship, basis, created_at FROM booking_delegations WHERE person_id = ? AND status = 'ACTIVE' ORDER BY id`,
      [self.id],
    );
    return rows.map((r) => ({
      delegationId: r.id,
      relationship: r.relationship,
      basis: r.basis,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /** Either side may revoke: the delegate, or the person's own account (consent withdrawal). */
  async revoke(userId: string, delegationId: string, meta: RequestMeta): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const row = (
        await tx.query<{
          id: string;
          delegate_user_id: string;
          person_user_id: string | null;
          status: string;
          person_id: string;
        }>(
          `SELECT d.id, d.delegate_user_id, p.user_id AS person_user_id, d.status, d.person_id
             FROM booking_delegations d JOIN booking_persons p ON p.id = d.person_id WHERE d.id = ? FOR UPDATE`,
          [delegationId],
        )
      )[0];
      if (row === undefined || (row.delegate_user_id !== userId && row.person_user_id !== userId))
        throw new NotFoundError('Delegation not found');
      if (row.status !== 'ACTIVE') throw new ConflictError('The delegation is already revoked');
      await tx.execute(
        `UPDATE booking_delegations SET status = 'REVOKED', revoked_at = ?, revoked_by_user_id = ? WHERE id = ?`,
        [this.deps.clock(), userId, delegationId],
      );
      await this.auditDelegation(
        tx,
        userId,
        delegationId,
        { personId: row.person_id, status: 'REVOKED' },
        meta,
      );
    });
  }

  // ---------- guests ----------

  async requestGuestCode(phoneE164: string, meta: RequestMeta) {
    return this.deps.otp.request(phoneE164, meta, 'GUEST_BOOKING');
  }

  /** Verifies a GUEST_BOOKING code and issues a short-lived guest token (no account). */
  async verifyGuest(
    input: { challengeId: string; phoneE164: string; code: string },
    meta: RequestMeta,
  ) {
    await this.deps.otp.assertVerificationRateLimit(meta);
    const result = await this.deps.db.transaction(async (tx) => {
      const verification = await this.deps.otp.verify(tx, { ...input, purpose: 'GUEST_BOOKING' });
      if (!verification.ok) return { ok: false as const, reason: verification.reason };
      const token = randomToken(32);
      const expiresAt = new Date(this.deps.clock().getTime() + GUEST_SESSION_MINUTES * 60_000);
      await tx.execute(
        'INSERT INTO guest_booking_sessions (phone_e164, phone_hash, token_hash, expires_at) VALUES (?, ?, ?, ?)',
        [input.phoneE164, this.deps.otp.subjectHash(input.phoneE164), sha256Hex(token), expiresAt],
      );
      return { ok: true as const, token, expiresAt };
    });
    if (!result.ok)
      throw result.reason === 'LOCKED'
        ? new AppError(
            400,
            'OTP_ATTEMPTS_EXCEEDED',
            'Too many incorrect attempts. Please request a new code.',
          )
        : new AppError(400, 'OTP_INVALID', 'The verification code is invalid or has expired');
    return { guestToken: result.token, expiresAt: result.expiresAt.toISOString() };
  }

  async resolveGuest(token: string | undefined): Promise<GuestSession> {
    if (token === undefined || !/^[A-Za-z0-9_-]{20,128}$/.test(token))
      throw new AppError(401, 'GUEST_SESSION_INVALID', 'Verify your phone to continue');
    const row = (
      await this.deps.db.query<{
        id: string;
        phone_e164: string;
        phone_hash: string;
        person_id: string | null;
      }>(
        `SELECT id, phone_e164, phone_hash, person_id FROM guest_booking_sessions
          WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
        [sha256Hex(token), this.deps.clock()],
      )
    )[0];
    if (row === undefined)
      throw new AppError(401, 'GUEST_SESSION_INVALID', 'Verify your phone to continue');
    return {
      sessionId: row.id,
      phoneE164: row.phone_e164,
      phoneHash: row.phone_hash,
      personId: row.person_id,
    };
  }

  /** The session's own guest person (bound by booking or by claim-code attachment). */
  async guestOwnPerson(session: GuestSession): Promise<PersonRow | undefined> {
    if (session.personId === null) return undefined;
    return (
      await this.deps.db.query<PersonRow>(`${PERSON_SELECT} WHERE id = ?`, [session.personId])
    )[0];
  }

  // ---------- patient role ----------

  /**
   * Grants the global PATIENT role on first patient use (resolves OD-07, ADR-045). Idempotent;
   * audited once. The role carries only `patient.*` self-service permissions.
   */
  async ensurePatientRole(userId: string, meta: RequestMeta): Promise<void> {
    const result = await this.deps.db.execute(
      `INSERT IGNORE INTO user_global_roles (user_id, role_code, role_scope) VALUES (?, 'PATIENT', 'PATIENT')`,
      [userId],
    );
    if (result.affectedRows === 1)
      await this.deps.auditLog.record(
        this.deps.db,
        {
          action: AUDIT_ACTION.GLOBAL_ROLE_GRANTED,
          actorUserId: userId,
          targetType: 'USER',
          targetId: userId,
          metadata: { role: 'PATIENT', reason: 'FIRST_PATIENT_USE' },
        },
        meta,
      );
  }

  // ---------- helpers ----------

  /** Account becomes owner of a guest person; that person's guest sessions end. */
  private async takeOwnership(tx: SqlExecutor, personId: string, userId: string): Promise<void> {
    const now = this.deps.clock();
    await tx.execute(
      'UPDATE booking_persons SET claimed_by_user_id = ?, claimed_at = ? WHERE id = ?',
      [userId, now, personId],
    );
    await tx.execute(
      'UPDATE guest_booking_sessions SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL',
      [now, personId],
    );
  }

  private async insertClaimCode(tx: SqlExecutor, personId: string, meta: RequestMeta) {
    const code = randomToken(32);
    const expiresAt = new Date(this.deps.clock().getTime() + CLAIM_CODE_DAYS * 86_400_000);
    await tx.execute(
      'INSERT INTO guest_claim_codes (person_id, code_hash, expires_at) VALUES (?, ?, ?)',
      [personId, sha256Hex(code), expiresAt],
    );
    await this.audit(tx, AUDIT_ACTION.GUEST_CLAIM_CODE_ISSUED, null, personId, { expiresAt }, meta);
    return { claimCode: code, expiresAt: expiresAt.toISOString() };
  }

  private async countBookings(tx: SqlExecutor, personId: string): Promise<number> {
    const [row] = await tx.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM bookings WHERE person_id = ?',
      [personId],
    );
    return Number(row?.n ?? 0);
  }

  private today(): string {
    return this.deps.clock().toISOString().slice(0, 10);
  }

  private isMinor(birthDate: string): boolean {
    const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
    const adult = new Date(Date.UTC(y + MINOR_AGE_YEARS, m - 1, d));
    return adult.getTime() > this.deps.clock().getTime();
  }

  private async audit(
    tx: SqlExecutor,
    action: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION],
    actor: string | null,
    personId: string,
    metadata: Record<string, unknown>,
    meta: RequestMeta,
  ) {
    await this.deps.auditLog.record(
      tx,
      { action, actorUserId: actor, targetType: 'BOOKING_PERSON', targetId: personId, metadata },
      meta,
    );
  }

  private async auditDelegation(
    tx: SqlExecutor,
    actor: string,
    id: string,
    metadata: Record<string, unknown>,
    meta: RequestMeta,
  ) {
    await this.deps.auditLog.record(
      tx,
      {
        action: AUDIT_ACTION.BOOKING_DELEGATION_CHANGED,
        actorUserId: actor,
        targetType: 'BOOKING_DELEGATION',
        targetId: id,
        metadata,
      },
      meta,
    );
  }
}
