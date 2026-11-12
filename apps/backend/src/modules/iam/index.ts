/** Identity & access-management module public API. */
export { AccountService } from './account.service.js';
export { AuthService, MFA_REQUIRED_GLOBAL_ROLES, type LoginResult } from './auth.service.js';
export { authenticate, requireAuth, type AuthContext } from './http/auth-context.js';
export { createIamRouter } from './http/iam.routes.js';
export { MfaService } from './mfa/mfa.service.js';
export {
  createOtpProvider,
  MockOtpProvider,
  ProductionMockProviderError,
  type OtpProvider,
} from './otp/otp-provider.js';
export { OtpService } from './otp/otp.service.js';
export { maskPhone, normalizePhone } from './phone.js';
export {
  APP_TYPES,
  SessionService,
  type AppType,
  type DeviceInfo,
} from './sessions/sessions.service.js';
export {
  AccessTokenService,
  createEnvKeyStore,
  type AccessTokenKeyStore,
} from './tokens/access-tokens.js';
export { UsersRepository, type AccountStatus } from './users.repository.js';
