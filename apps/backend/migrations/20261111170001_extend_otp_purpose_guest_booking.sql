-- Migration: extend_otp_purpose_guest_booking
-- Task 05. Guest booking verifies a phone with an OTP of its own purpose. A GUEST_BOOKING
-- challenge can never complete a login (and vice versa): verification checks the purpose.

ALTER TABLE otp_challenges
  DROP CHECK ck_otp_challenges_purpose,
  ADD CONSTRAINT ck_otp_challenges_purpose CHECK (purpose IN ('LOGIN', 'GUEST_BOOKING'));
