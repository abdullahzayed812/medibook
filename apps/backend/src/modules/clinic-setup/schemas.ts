import { z } from 'zod';
import { idSchema, reasonSchema } from '../platform/index.js';
import { DAYS, dayNumber, MAX_PERIODS, parseClock, type Period } from './weekly.js';

const clock = z
  .string()
  .refine((v) => parseClock(v) !== undefined, 'must be HH:MM between 00:00 and 24:00')
  .transform((v) => parseClock(v) ?? 0);
const date = z.iso.date();
const optText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

export const periodSchema = z
  .object({
    day: z.enum(DAYS),
    kind: z.enum(['WORK', 'BREAK']).default('WORK'),
    start: clock,
    end: clock,
  })
  .strict()
  .transform((p): Period => ({ day: dayNumber(p.day), kind: p.kind, start: p.start, end: p.end }));

export const scheduleBody = z
  .object({
    effectiveFrom: date,
    effectiveUntil: date.nullable().optional(),
    note: optText(500),
    periods: z.array(periodSchema).min(1).max(MAX_PERIODS),
  })
  .strict();

export const exceptionBody = z
  .object({
    kind: z.enum(['CLOSED', 'UNAVAILABLE', 'EXTRA']),
    startDate: date,
    endDate: date.optional(),
    start: clock.optional(),
    end: clock.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const rangeQuery = z.object({ from: date, to: date });

export const assignmentBody = z.object({ membershipId: idSchema, notes: optText(1000) }).strict();
export const assignmentPatch = z.object({ notes: z.string().trim().max(1000).nullable() }).strict();
export const deactivateBody = z.object({ reason: reasonSchema }).strict();

const serviceFields = {
  code: z
    .string()
    .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/)
    .max(50)
    .nullable()
    .optional(),
  nameEn: optText(200),
  nameAr: optText(200),
  descriptionEn: optText(4000),
  descriptionAr: optText(4000),
  preparationEn: optText(2000),
  preparationAr: optText(2000),
  specialtyCode: z
    .string()
    .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/)
    .max(50)
    .nullable()
    .optional(),
};

export const serviceCreate = z
  .object(serviceFields)
  .strict()
  .refine((s) => (s.nameEn ?? null) !== null || (s.nameAr ?? null) !== null, {
    message: 'nameEn or nameAr is required',
    path: ['nameEn'],
  });

export const servicePatch = z
  .object({ ...serviceFields, status: z.enum(['ACTIVE', 'INACTIVE']).optional() })
  .strict();

export const offeringBody = z
  .object({
    priceMinor: z.number().int().min(0).max(1_000_000_000),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'ISO 4217 code')
      .optional(),
    durationMinutes: z.number().int().min(5).max(720),
    bufferMinutes: z.number().int().min(0).max(240).optional(),
    instructionsEn: optText(2000),
    instructionsAr: optText(2000),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .strict();

export const doctorServiceBody = z
  .object({
    durationMinutes: z.number().int().min(5).max(720).nullable().optional(),
    priceMinor: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  })
  .strict();
