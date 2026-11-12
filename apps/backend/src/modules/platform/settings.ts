import { z } from 'zod';
import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import { ValidationError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { AuthorizationService, Principal } from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';

/**
 * Platform settings managed by Super Admins. Every key has a schema and a default here; the
 * database stores only overrides. Unknown keys are rejected.
 */
export const SETTINGS_SCHEMA = {
  'subscription.grace_period_days': z.number().int().min(0).max(60),
  'invitation.ttl_hours': z.number().int().min(1).max(720),
  'ownership_transfer.acceptance_ttl_hours': z.number().int().min(24).max(2160),
  'access_exception.max_duration_hours': z.number().int().min(1).max(720),
  'registration.max_open_requests_per_user': z.number().int().min(1).max(20),
  /** Default ISO 4217 currency for new branch service offerings (Task 04). */
  'clinic.default_currency': z.string().regex(/^[A-Z]{3}$/),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTINGS_SCHEMA)[K]> };

export const SETTING_DEFAULTS: Settings = {
  'subscription.grace_period_days': 3,
  'invitation.ttl_hours': 168,
  'ownership_transfer.acceptance_ttl_hours': 336,
  'access_exception.max_duration_hours': 72,
  'registration.max_open_requests_per_user': 3,
  'clinic.default_currency': 'EGP',
};

export const settingsPatchSchema = z
  .object(Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([k, v]) => [k, v.optional()])))
  .strict();

export class PlatformSettingsService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly auditLog: AuditLog,
  ) {}

  async getAll(executor: SqlExecutor = this.db): Promise<Settings> {
    const rows = await executor.query<{ setting_key: string; value: unknown }>(
      'SELECT setting_key, value FROM platform_settings',
    );
    const settings: Record<string, unknown> = { ...SETTING_DEFAULTS };
    for (const row of rows) {
      const schema = SETTINGS_SCHEMA[row.setting_key as SettingKey] as z.ZodType | undefined;
      // Ignore rows that no longer validate (defensive); defaults apply.
      const parsed = schema?.safeParse(row.value);
      if (parsed?.success === true) settings[row.setting_key] = parsed.data;
    }
    return settings as Settings;
  }

  async get<K extends SettingKey>(key: K, executor: SqlExecutor = this.db): Promise<Settings[K]> {
    return (await this.getAll(executor))[key];
  }

  /** Super Admin view of all settings (with defaults applied). */
  async view(actor: Principal): Promise<Settings> {
    await this.authz.assert(actor, 'platform.settings.manage');
    return this.getAll();
  }

  /** Validated, audited (before/after) partial update. Requires platform.settings.manage. */
  async update(actor: Principal, patch: Partial<Settings>, meta: RequestMeta): Promise<Settings> {
    await this.authz.assert(actor, 'platform.settings.manage');
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new ValidationError(parsed.error.issues);
    return this.db.transaction(async (tx) => {
      const before = await this.getAll(tx);
      for (const [key, value] of Object.entries(parsed.data)) {
        if (value === undefined) continue;
        await tx.execute(
          `INSERT INTO platform_settings (setting_key, value, updated_by_user_id) VALUES (?, ?, ?) AS new
           ON DUPLICATE KEY UPDATE value = new.value, updated_by_user_id = new.updated_by_user_id`,
          [key, JSON.stringify(value), actor.userId],
        );
      }
      const after = await this.getAll(tx);
      await this.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.PLATFORM_SETTINGS_CHANGED,
          actorUserId: actor.userId,
          targetType: 'SETTINGS',
          targetId: 'platform',
          metadata: { before, after },
        },
        meta,
      );
      return after;
    });
  }
}
