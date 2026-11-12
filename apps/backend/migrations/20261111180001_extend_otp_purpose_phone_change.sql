-- Migration: extend_otp_purpose_phone_change
-- Task 05.1. Verified account phone change: codes to the current AND the new phone, each with
-- its own purpose so they can never complete a login or a guest verification.

ALTER TABLE otp_challenges
  DROP CHECK ck_otp_challenges_purpose,
  ADD CONSTRAINT ck_otp_challenges_purpose CHECK (purpose IN ('LOGIN', 'GUEST_BOOKING', 'PHONE_CHANGE'));
