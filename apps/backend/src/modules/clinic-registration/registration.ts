import { z } from 'zod';
import { defineStateMachine } from '../../shared/state-machine.js';
import { CLINIC_TYPES } from '../clinics/clinics.repository.js';
import { addressSchema, contactSchema } from '../clinics/schemas.js';

export const REGISTRATION_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'UNDER_REVIEW',
  'NEEDS_INFORMATION',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/**
 * Registration workflow. SUSPENDED = review frozen by a Super Admin (e.g. suspected fraud);
 * it is NOT the clinic's operational suspension (that lives on the clinic after approval).
 */
export const REGISTRATION_LIFECYCLE = defineStateMachine<RegistrationStatus>('Registration', {
  DRAFT: ['PENDING_REVIEW'],
  PENDING_REVIEW: ['UNDER_REVIEW', 'SUSPENDED'],
  UNDER_REVIEW: ['NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'SUSPENDED'],
  NEEDS_INFORMATION: ['PENDING_REVIEW', 'SUSPENDED'],
  SUSPENDED: ['UNDER_REVIEW', 'REJECTED'],
  APPROVED: [],
  REJECTED: [],
});

/** Transitions only the applicant may perform; every other transition is a Super Admin decision. */
export const APPLICANT_TRANSITIONS: readonly (readonly [RegistrationStatus, RegistrationStatus])[] =
  [
    ['DRAFT', 'PENDING_REVIEW'],
    ['NEEDS_INFORMATION', 'PENDING_REVIEW'],
  ];

export function isApplicantTransition(from: RegistrationStatus, to: RegistrationStatus): boolean {
  return APPLICANT_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export const EDITABLE_STATUSES: readonly RegistrationStatus[] = ['DRAFT', 'NEEDS_INFORMATION'];
export const OPEN_STATUSES: readonly RegistrationStatus[] = [
  'DRAFT',
  'PENDING_REVIEW',
  'UNDER_REVIEW',
  'NEEDS_INFORMATION',
  'SUSPENDED',
];

export const registrationFieldsSchema = addressSchema
  .extend(contactSchema.shape)
  .extend({
    clinicName: z.string().trim().min(2).max(200),
    clinicType: z.enum(CLINIC_TYPES).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    website: z.url().max(255).nullable().optional(),
    legalName: z.string().trim().min(2).max(200).nullable().optional(),
    businessRegistrationNo: z.string().trim().min(2).max(100).nullable().optional(),
    taxId: z.string().trim().min(2).max(100).nullable().optional(),
  })
  .strict();

export const registrationPatchSchema = registrationFieldsSchema.partial().strict();
export type RegistrationFields = z.infer<typeof registrationFieldsSchema>;

export const REGISTRATION_COLUMNS: Readonly<Record<string, string>> = {
  clinicName: 'clinic_name',
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
  legalName: 'legal_name',
  businessRegistrationNo: 'business_registration_no',
  taxId: 'tax_id',
};

export interface RegistrationRequest {
  readonly id: string;
  readonly ownerUserId: string;
  readonly status: RegistrationStatus;
  readonly clinicName: string;
  readonly clinicType: string;
  readonly description: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly website: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly legalName: string | null;
  readonly businessRegistrationNo: string | null;
  readonly taxId: string | null;
  readonly submittedAt: Date | null;
  readonly decidedAt: Date | null;
  readonly decidedByUserId: string | null;
  readonly decisionReason: string | null;
  readonly clinicId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Fields required before submission (validation of completeness, not of format). */
export function missingForSubmission(r: RegistrationRequest, documentCount: number): string[] {
  const missing: string[] = [];
  if (r.contactPhone === null && r.contactEmail === null) missing.push('contactPhone|contactEmail');
  if (r.addressLine1 === null) missing.push('addressLine1');
  if (r.city === null) missing.push('city');
  if (r.countryCode === null) missing.push('countryCode');
  if (r.legalName === null) missing.push('legalName');
  if (r.businessRegistrationNo === null) missing.push('businessRegistrationNo');
  if (documentCount === 0) missing.push('documents');
  return missing;
}
