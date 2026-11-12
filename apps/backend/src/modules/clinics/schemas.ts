import { z } from 'zod';
import { CLINIC_TYPES } from './clinics.repository.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => text(max).nullable().optional();

export const addressSchema = z.object({
  addressLine1: nullableText(200),
  addressLine2: nullableText(200),
  city: nullableText(100),
  region: nullableText(100),
  postalCode: nullableText(20),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

export const contactSchema = z.object({
  contactPhone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'must be E.164')
    .nullable()
    .optional(),
  contactEmail: z.email().max(254).nullable().optional(),
});

/** Fields a clinic may edit itself. Name and legal identity change only through platform review. */
export const clinicProfilePatchSchema = addressSchema
  .extend(contactSchema.shape)
  .extend({
    clinicType: z.enum(CLINIC_TYPES).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    website: z.url().max(255).nullable().optional(),
  })
  .strict();

const TIME_ZONE = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'must be an IANA time zone');

export const branchCreateSchema = addressSchema
  .extend(contactSchema.shape)
  .extend({
    name: text(200),
    timeZone: TIME_ZONE,
    settings: z
      .record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict();

export const branchPatchSchema = branchCreateSchema.partial().strict();

export const suspensionSchema = z
  .object({
    scope: z.enum(['FULL', 'NEW_OPERATIONS']),
    reason: z.string().trim().min(3).max(1000),
    expectedEndAt: z.iso.datetime().optional(),
  })
  .strict();

export const accessExceptionSchema = z
  .object({
    userId: z.string().regex(/^[1-9]\d{0,19}$/),
    reason: z.string().trim().min(3).max(1000),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const closureRequestSchema = z
  .object({
    reason: z.string().trim().min(10).max(2000),
    requestedEffectiveDate: z.iso.date().optional(),
  })
  .strict();

export type ClinicProfilePatch = z.infer<typeof clinicProfilePatchSchema>;
export type BranchInput = z.infer<typeof branchCreateSchema>;

/** camelCase field → column for clinic/branch updates (allow-list). */
export const FIELD_COLUMNS: Readonly<Record<string, string>> = {
  name: 'name',
  clinicType: 'clinic_type',
  description: 'description',
  website: 'website',
  contactPhone: 'contact_phone',
  contactEmail: 'contact_email',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  region: 'region',
  postalCode: 'postal_code',
  countryCode: 'country_code',
  latitude: 'latitude',
  longitude: 'longitude',
  timeZone: 'time_zone',
};

export function toColumns(
  patch: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean | null> {
  const columns: Record<string, string | number | boolean | null> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (field === 'settings') {
      columns.settings = value === null ? null : JSON.stringify(value);
      continue;
    }
    const column = FIELD_COLUMNS[field];
    if (column === undefined) throw new Error(`Unmapped field ${field}`);
    columns[column] = value as string | number | boolean | null;
  }
  return columns;
}
