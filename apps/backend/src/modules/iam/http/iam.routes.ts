import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../../config/env.js';
import type { Database } from '../../../infrastructure/database/database.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { paginationQuerySchema } from '../../../shared/http/pagination.js';
import { requestMeta } from '../../../shared/http/request-meta.js';
import { validate } from '../../../shared/http/middleware/validate.js';
import type { SecurityEventLog } from '../../audit/index.js';
import type { AccountService } from '../account.service.js';
import type { AuthService } from '../auth.service.js';
import type { MfaService } from '../mfa/mfa.service.js';
import type { OtpService } from '../otp/otp.service.js';
import type { PhoneChangeService } from '../phone-change.service.js';
import { maskPhone, normalizePhone } from '../phone.js';
import type { SessionService } from '../sessions/sessions.service.js';
import { requireAuth } from './auth-context.js';
import {
  idParam,
  mfaCodeSchema,
  mfaVerifySchema,
  refreshSchema,
  requestOtpSchema,
  verifyOtpSchema,
} from './schemas.js';

export interface IamRouteDeps {
  readonly db: Database;
  readonly authenticate: RequestHandler;
  readonly auth: AuthService;
  readonly otp: OtpService;
  readonly sessions: SessionService;
  readonly accounts: AccountService;
  readonly mfa: MfaService;
  readonly securityEvents: SecurityEventLog;
  readonly otpConfig: AppConfig['otp'];
  readonly phoneChange: PhoneChangeService;
}

/** Routes stay thin: validated input → one service call → response. */
export function createIamRouter(deps: IamRouteDeps): Router {
  const router = Router();
  const { authenticate } = deps;

  // --- Authentication (public) ---
  router.post('/auth/otp/request', validate({ body: requestOtpSchema }), async (req, res) => {
    const { phone } = req.body as z.infer<typeof requestOtpSchema>;
    const issued = await deps.otp.request(
      normalizePhone(phone, deps.otpConfig.phoneDefaultRegion),
      requestMeta(req),
    );
    // Identical response whether or not an account exists for this phone.
    res.status(202).json({ data: issued });
  });

  router.post('/auth/otp/verify', validate({ body: verifyOtpSchema }), async (req, res) => {
    const body = req.body as z.infer<typeof verifyOtpSchema>;
    const result = await deps.auth.loginWithOtp(
      {
        challengeId: body.challengeId,
        phoneE164: normalizePhone(body.phone, deps.otpConfig.phoneDefaultRegion),
        code: body.code,
        device: body.device,
      },
      requestMeta(req),
    );
    res.status(200).json({ data: result });
  });

  router.post('/auth/refresh', validate({ body: refreshSchema }), async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
    res.json({ data: await deps.auth.refresh(refreshToken, requestMeta(req)) });
  });

  router.post('/auth/logout', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    await deps.sessions.logout(auth.userId, auth.sessionId, requestMeta(req));
    res.status(204).end();
  });

  router.post('/auth/logout-all', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    await deps.sessions.logoutAll(auth.userId, auth.sessionId, requestMeta(req));
    res.status(204).end();
  });

  // --- Account ---
  // Verified phone change: codes to the current AND the new phone (Task 05.1).
  router.post(
    '/me/phone/change-requests',
    authenticate,
    validate({ body: z.object({ phone: z.string().max(32) }).strict() }),
    async (req, res) => {
      const { phone } = req.body as { phone: string };
      res.status(202).json({
        data: await deps.phoneChange.request(
          requireAuth(req).userId,
          normalizePhone(phone, deps.otpConfig.phoneDefaultRegion),
          requestMeta(req),
        ),
      });
    },
  );
  router.post(
    '/me/phone/change-requests/verify',
    authenticate,
    validate({
      body: z
        .object({
          phone: z.string().max(32),
          currentChallengeId: z.string().regex(/^[0-9a-f]{32}$/),
          currentCode: z.string().max(12),
          newChallengeId: z.string().regex(/^[0-9a-f]{32}$/),
          newCode: z.string().max(12),
        })
        .strict(),
    }),
    async (req, res) => {
      const b = req.body as {
        phone: string;
        currentChallengeId: string;
        currentCode: string;
        newChallengeId: string;
        newCode: string;
      };
      res.json({
        data: await deps.phoneChange.confirm(
          requireAuth(req).userId,
          { ...b, newPhoneE164: normalizePhone(b.phone, deps.otpConfig.phoneDefaultRegion) },
          requestMeta(req),
        ),
      });
    },
  );

  router.get('/me', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    const account = await deps.accounts.getAccount(auth.userId);
    const mfa = await deps.mfa.status(auth.userId);
    res.json({
      data: {
        id: account.user.id,
        phone: account.user.phoneE164,
        phoneVerifiedAt: account.user.phoneVerifiedAt,
        email: account.user.email,
        status: account.user.status,
        createdAt: account.user.createdAt,
        profile: account.profile,
        doctorProfile: account.doctorProfile,
        mfa: { ...mfa, verifiedForSession: auth.mfaVerified },
      },
    });
  });

  router.get(
    '/me/security-events',
    authenticate,
    validate({ query: paginationQuerySchema }),
    async (req, res) => {
      const auth = requireAuth(req);
      const query = req.query as unknown as z.infer<typeof paginationQuerySchema>;
      res.json(await deps.securityEvents.listForUser(deps.db, auth.userId, query));
    },
  );

  // --- Sessions ---
  router.get('/sessions', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    res.json({ data: await deps.sessions.listActive(auth.userId, auth.sessionId) });
  });

  router.delete(
    '/sessions/:sessionId',
    authenticate,
    validate({ params: z.object({ sessionId: idParam }) }),
    async (req, res) => {
      const auth = requireAuth(req);
      const { sessionId } = req.params as { sessionId: string };
      await deps.sessions.revokeOwn(auth.userId, sessionId, auth.sessionId, requestMeta(req));
      res.status(204).end();
    },
  );

  /** Revoke all OTHER sessions (keeps the current one). */
  router.delete('/sessions', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    const revoked = await deps.sessions.revokeOthers(auth.userId, auth.sessionId, requestMeta(req));
    res.json({ data: { revoked } });
  });

  // --- Two-factor authentication ---
  router.get('/security/mfa', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    res.json({
      data: { ...(await deps.mfa.status(auth.userId)), verifiedForSession: auth.mfaVerified },
    });
  });

  router.post('/security/mfa/totp/enrollment', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    const account = await deps.accounts.getAccount(auth.userId);
    const started = await deps.mfa.startEnrollment(
      auth.userId,
      auth.sessionId,
      maskPhone(account.user.phoneE164),
      requestMeta(req),
    );
    res.status(201).json({ data: started });
  });

  router.post(
    '/security/mfa/totp/enrollment/confirm',
    authenticate,
    validate({ body: mfaCodeSchema }),
    async (req, res) => {
      const auth = requireAuth(req);
      const { code } = req.body as z.infer<typeof mfaCodeSchema>;
      res.json({
        data: await deps.mfa.confirmEnrollment(auth.userId, auth.sessionId, code, requestMeta(req)),
      });
    },
  );

  router.post(
    '/security/mfa/verify',
    authenticate,
    validate({ body: mfaVerifySchema }),
    async (req, res) => {
      const auth = requireAuth(req);
      await deps.mfa.verify(
        auth.userId,
        auth.sessionId,
        req.body as z.infer<typeof mfaVerifySchema>,
        requestMeta(req),
      );
      res.status(204).end();
    },
  );

  router.post('/security/mfa/recovery-codes', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    if (!auth.mfaVerified) {
      throw new AppError(
        403,
        'MFA_REQUIRED',
        'Two-factor verification is required for this action',
      );
    }
    res.json({
      data: await deps.mfa.regenerateRecoveryCodes(auth.userId, auth.sessionId, requestMeta(req)),
    });
  });

  return router;
}
