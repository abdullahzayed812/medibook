import { z } from 'zod';
import { APP_TYPES } from '../sessions/sessions.service.js';

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

export const deviceSchema = z.object({
  deviceId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'must be 8-128 characters of [A-Za-z0-9._:-]'),
  appType: z.enum(APP_TYPES),
  deviceName: optionalText(100),
  osName: optionalText(50),
  osVersion: optionalText(50),
  appVersion: optionalText(50),
});

export const requestOtpSchema = z.object({ phone: z.string().min(1).max(32) });

export const verifyOtpSchema = z.object({
  challengeId: z.string().regex(/^[0-9a-f]{32}$/, 'invalid challenge id'),
  phone: z.string().min(1).max(32),
  code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
  device: deviceSchema,
});

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

export const idParam = z.string().regex(/^[1-9]\d{0,19}$/, 'invalid id');

export const mfaCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const mfaVerifySchema = z.union([
  z.object({ code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ recoveryCode: z.string().min(10).max(20) }).strict(),
]);
