import type { Database } from '../../infrastructure/database/database.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { AuthorizationService, Principal, TenantContext } from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import { loadSettings } from './availability.js';
import type { BookingSettings } from './policy.js';
import { isQueueModeAvailable } from './queue-contract.js';

/**
 * Per-clinic booking settings (ADR-047). Limits are enforced by the request schema and by DB
 * CHECKs. Changes apply to NEW bookings only: every booking snapshots its cancellation policy and
 * booking rules at creation.
 */
export class BookingSettingsService {
  constructor(
    private readonly deps: { db: Database; authz: AuthorizationService; auditLog: AuditLog },
  ) {}

  async get(actor: Principal, tenant: TenantContext): Promise<BookingSettings> {
    await this.deps.authz.assert(actor, 'clinic.profile.view', { tenant });
    return loadSettings(this.deps.db, tenant.clinicId);
  }

  async update(
    actor: Principal,
    tenant: TenantContext,
    patch: Partial<BookingSettings>,
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'clinic.settings.manage', { tenant });
    if (patch.queueEnabled === true && !isQueueModeAvailable())
      throw new AppError(422, 'QUEUE_MODE_NOT_AVAILABLE', 'Queue bookings are not available yet');
    return this.deps.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM clinics WHERE id = ? FOR UPDATE', [tenant.clinicId]);
      const before = await loadSettings(tx, tenant.clinicId);
      const next: BookingSettings = { ...before, ...patch };
      await tx.execute(
        `INSERT INTO clinic_booking_settings (clinic_id, slot_enabled, queue_enabled, slot_interval_minutes, min_lead_minutes,
           max_horizon_days, confirmation_ttl_minutes, cancel_min_notice_minutes, cancel_reason_required, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS n
         ON DUPLICATE KEY UPDATE slot_enabled = n.slot_enabled, queue_enabled = n.queue_enabled,
           slot_interval_minutes = n.slot_interval_minutes, min_lead_minutes = n.min_lead_minutes,
           max_horizon_days = n.max_horizon_days, confirmation_ttl_minutes = n.confirmation_ttl_minutes,
           cancel_min_notice_minutes = n.cancel_min_notice_minutes, cancel_reason_required = n.cancel_reason_required,
           updated_by_user_id = n.updated_by_user_id`,
        [
          tenant.clinicId,
          next.slotEnabled ? 1 : 0,
          next.queueEnabled ? 1 : 0,
          next.slotIntervalMinutes,
          next.minLeadMinutes,
          next.maxHorizonDays,
          next.confirmationTtlMinutes,
          next.cancelMinNoticeMinutes,
          next.cancelReasonRequired ? 1 : 0,
          actor.userId,
        ],
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.BOOKING_SETTINGS_CHANGED,
          actorUserId: actor.userId,
          targetType: 'BOOKING_SETTINGS',
          targetId: tenant.clinicId,
          clinicId: tenant.clinicId,
          metadata: { before, after: next },
        },
        meta,
      );
      return next;
    });
  }
}
