import { describe, expect, it } from 'vitest';
import { MEMBERSHIP_LIFECYCLE } from '../modules/access/index.js';
import {
  APPLICANT_TRANSITIONS,
  isApplicantTransition,
  missingForSubmission,
  REGISTRATION_LIFECYCLE,
  type RegistrationRequest,
} from '../modules/clinic-registration/registration.js';
import { CLOSURE_LIFECYCLE } from '../modules/clinics/lifecycle.service.js';
import { VERIFICATION_LIFECYCLE } from '../modules/doctor-profiles/doctor-profiles.service.js';
import { TRANSFER_LIFECYCLE } from '../modules/ownership-transfer/ownership-transfer.service.js';
import { defineStateMachine } from './state-machine.js';

describe('defineStateMachine', () => {
  it('rejects undefined transitions with 409 INVALID_TRANSITION', () => {
    const m = defineStateMachine<'A' | 'B'>('Thing', { A: ['B'], B: [] });
    expect(m.can('A', 'B')).toBe(true);
    expect(() => {
      m.assert('B', 'A');
    }).toThrow(expect.objectContaining({ statusCode: 409, code: 'INVALID_TRANSITION' }));
  });
});

describe('registration workflow', () => {
  it('implements the required transitions', () => {
    const ok: [
      Parameters<typeof REGISTRATION_LIFECYCLE.can>[0],
      Parameters<typeof REGISTRATION_LIFECYCLE.can>[1],
    ][] = [
      ['DRAFT', 'PENDING_REVIEW'],
      ['PENDING_REVIEW', 'UNDER_REVIEW'],
      ['UNDER_REVIEW', 'NEEDS_INFORMATION'],
      ['NEEDS_INFORMATION', 'PENDING_REVIEW'],
      ['UNDER_REVIEW', 'APPROVED'],
      ['UNDER_REVIEW', 'REJECTED'],
    ];
    for (const [from, to] of ok)
      expect(REGISTRATION_LIFECYCLE.can(from, to), `${from}→${to}`).toBe(true);
  });

  it('forbids shortcuts and makes APPROVED/REJECTED final', () => {
    expect(REGISTRATION_LIFECYCLE.can('DRAFT', 'APPROVED')).toBe(false);
    expect(REGISTRATION_LIFECYCLE.can('PENDING_REVIEW', 'APPROVED')).toBe(false);
    expect(REGISTRATION_LIFECYCLE.can('NEEDS_INFORMATION', 'APPROVED')).toBe(false);
    expect(REGISTRATION_LIFECYCLE.transitions.APPROVED).toEqual([]);
    expect(REGISTRATION_LIFECYCLE.transitions.REJECTED).toEqual([]);
  });

  it('separates applicant transitions from reviewer decisions', () => {
    expect(APPLICANT_TRANSITIONS).toHaveLength(2);
    expect(isApplicantTransition('DRAFT', 'PENDING_REVIEW')).toBe(true);
    expect(isApplicantTransition('UNDER_REVIEW', 'APPROVED')).toBe(false);
  });

  it('lists what is missing before submission', () => {
    const empty = {
      contactPhone: null,
      contactEmail: null,
      addressLine1: null,
      city: null,
      countryCode: null,
      legalName: null,
      businessRegistrationNo: null,
    } as unknown as RegistrationRequest;
    expect(missingForSubmission(empty, 0)).toEqual([
      'contactPhone|contactEmail',
      'addressLine1',
      'city',
      'countryCode',
      'legalName',
      'businessRegistrationNo',
      'documents',
    ]);
  });
});

describe('other lifecycles', () => {
  it('membership: deactivation is reversible, termination allows re-hire only', () => {
    expect(MEMBERSHIP_LIFECYCLE.can('ACTIVE', 'INACTIVE')).toBe(true);
    expect(MEMBERSHIP_LIFECYCLE.can('INACTIVE', 'ACTIVE')).toBe(true);
    expect(MEMBERSHIP_LIFECYCLE.transitions.TERMINATED).toEqual(['ACTIVE']);
    expect(MEMBERSHIP_LIFECYCLE.can('TERMINATED', 'SUSPENDED')).toBe(false);
  });

  it('closure: approval before completion; final states', () => {
    expect(CLOSURE_LIFECYCLE.can('PENDING_REVIEW', 'COMPLETED')).toBe(false);
    expect(CLOSURE_LIFECYCLE.can('APPROVED', 'COMPLETED')).toBe(true);
    expect(CLOSURE_LIFECYCLE.can('APPROVED', 'CANCELLED')).toBe(false);
  });

  it('ownership transfer: acceptance precedes review; completion only from review', () => {
    expect(TRANSFER_LIFECYCLE.can('PENDING_ACCEPTANCE', 'COMPLETED')).toBe(false);
    expect(TRANSFER_LIFECYCLE.can('PENDING_REVIEW', 'COMPLETED')).toBe(true);
    expect(TRANSFER_LIFECYCLE.transitions.COMPLETED).toEqual([]);
  });

  it('doctor verification: decisions only from review; suspension and reinstatement', () => {
    expect(VERIFICATION_LIFECYCLE.can('UNVERIFIED', 'VERIFIED')).toBe(false);
    expect(VERIFICATION_LIFECYCLE.can('PENDING_REVIEW', 'VERIFIED')).toBe(true);
    expect(VERIFICATION_LIFECYCLE.can('VERIFIED', 'SUSPENDED')).toBe(true);
    expect(VERIFICATION_LIFECYCLE.can('SUSPENDED', 'VERIFIED')).toBe(true);
    expect(VERIFICATION_LIFECYCLE.can('REJECTED', 'VERIFIED')).toBe(false);
  });
});
