import { loadDatabaseConfig } from '../config/env.js';
import { loadEnvFile } from '../config/load-env-file.js';
import { Database } from '../infrastructure/database/database.js';
import { AUDIT_ACTION, AuditLog } from '../modules/audit/index.js';
import { normalizePhone } from '../modules/iam/index.js';
import { NO_REQUEST_META } from '../shared/http/request-meta.js';

/**
 * Operator CLI to grant/revoke global roles (bootstraps the first SUPER_ADMIN).
 *   npm run role:grant -- +9647700000000 SUPER_ADMIN
 *   npm run role:revoke -- +9647700000000 SUPER_ADMIN
 * The account must already exist (the person signs in once with OTP). Recorded in audit_events
 * with actor = NULL (system/operator). Revoking does not end sessions: authorization is re-read
 * on every request, so the role stops working immediately.
 */
const GLOBAL_ROLES = { SUPER_ADMIN: 'PLATFORM', PATIENT: 'PATIENT' } as const;

async function main(): Promise<void> {
  const [command, phoneInput, roleInput] = process.argv.slice(2);
  if (
    (command !== 'grant' && command !== 'revoke') ||
    phoneInput === undefined ||
    roleInput === undefined
  ) {
    throw new Error('Usage: global-role.ts grant|revoke <phone E.164> <SUPER_ADMIN|PATIENT>');
  }
  if (!Object.hasOwn(GLOBAL_ROLES, roleInput)) throw new Error(`Unknown global role ${roleInput}`);
  const role = roleInput as keyof typeof GLOBAL_ROLES;

  loadEnvFile();
  const db = Database.fromConfig(loadDatabaseConfig().database);
  try {
    await db.transaction(async (tx) => {
      const users = await tx.query<{ id: string }>(
        'SELECT id FROM users WHERE phone_e164 = ? FOR UPDATE',
        [normalizePhone(phoneInput)],
      );
      const userId = users[0]?.id;
      if (userId === undefined) throw new Error('No account with that phone number');
      const result =
        command === 'grant'
          ? await tx.execute(
              'INSERT IGNORE INTO user_global_roles (user_id, role_code, role_scope) VALUES (?, ?, ?)',
              [userId, role, GLOBAL_ROLES[role]],
            )
          : await tx.execute('DELETE FROM user_global_roles WHERE user_id = ? AND role_code = ?', [
              userId,
              role,
            ]);
      if (result.affectedRows === 0) {
        process.stdout.write('No change.\n');
        return;
      }
      await new AuditLog().record(
        tx,
        {
          action:
            command === 'grant'
              ? AUDIT_ACTION.GLOBAL_ROLE_GRANTED
              : AUDIT_ACTION.GLOBAL_ROLE_REVOKED,
          actorUserId: null,
          targetType: 'USER',
          targetId: userId,
          metadata: { role, via: 'cli' },
        },
        NO_REQUEST_META,
      );
      process.stdout.write(
        `${command === 'grant' ? 'Granted' : 'Revoked'} ${role} for user ${userId}.\n`,
      );
    });
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
