-- Migration: extend_patient_profiles
-- Task 05. Links a clinic patient profile to the global booking person (one profile per person
-- per clinic). Nullable: profiles created by other paths stay valid. Additive only.

ALTER TABLE patient_profiles
  ADD COLUMN person_id BIGINT UNSIGNED NULL,
  ADD UNIQUE KEY uq_patient_profiles_clinic_person (clinic_id, person_id),
  ADD CONSTRAINT fk_patient_profiles_person FOREIGN KEY (person_id) REFERENCES booking_persons (id) ON DELETE RESTRICT;
