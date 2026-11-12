# Branch operating hours and doctor schedules

> **Purpose:** how a branch's opening hours and a doctor's working schedule are modelled,
> validated, resolved per date, and converted between local wall-clock time and UTC (including
> daylight-saving transitions). The Booking Engine computes slots from
> this working time ([BOOKINGS.md](BOOKINGS.md)); this document defines **working time, not slots**. Decisions: ADR-041, ADR-043.
> Related: [DOCTOR_ASSIGNMENTS.md](DOCTOR_ASSIGNMENTS.md) ·
> [CLINIC_SETUP_API.md](../api/CLINIC_SETUP_API.md) ·
> [CLINIC_SETUP_SCHEMA.md](../database/CLINIC_SETUP_SCHEMA.md).

## Model

| Concept        | What it is                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Schedule**   | A dated **version** of a weekly pattern: `effectiveFrom` … `effectiveUntil` (inclusive local dates; open-ended allowed). |
| owner `BRANCH` | Branch operating hours: when the branch is open.                                                                         |
| owner `DOCTOR` | A doctor's working schedule at ONE branch, bound to a doctor branch assignment.                                          |
| **Period**     | `{ day: MON…SUN, kind: WORK \| BREAK, start: "HH:MM", end: "HH:MM" }`, local wall-clock time of the branch.              |
| **Exception**  | A dated change for one owner: `CLOSED` (whole days), `UNAVAILABLE` (time range removed), `EXTRA` (time range added).     |

Both owners use the same tables (`schedules`, `schedule_periods`, `schedule_exceptions`) and
the same rules. A branch has its own versions, and each doctor assignment has its own, so the
same doctor has independent schedules at different branches.

**Versions are immutable.** A change creates a **revision**: a new version from a chosen date.
The old version ends the day before, or is deactivated as `SUPERSEDED` when the revision
starts on its first day. Periods are never updated in place, so every past week stays
reconstructable. Deactivation sets `INACTIVE`, and nothing is deleted. Re-activation re-runs
every validation.

## Period rules (both owners)

- `start < end` within one day. `24:00` is allowed as an end.
- **No period crosses midnight.** An overnight shift is two periods, for example
  `MON 22:00–24:00` + `TUE 00:00–02:00`. A single period such as `22:00–02:00` is rejected,
  because its weekday and date would be ambiguous. Touching periods are treated as continuous
  time.
- WORK periods of the same day do not overlap. Each BREAK lies inside one WORK period of the
  same day, and breaks do not overlap. Multiple WORK periods per day are allowed.
- At least one WORK period, and at most 70 periods per version.
- Available time per weekday = WORK − BREAK.
- `effectiveFrom` must be the branch's local **today or later**. History is never rewritten,
  and all validation applies from today onward.
- Active versions of one owner never overlap in dates (`SCHEDULE_OVERLAP`). Back-to-back
  versions (`until = D`, next `from = D+1`) are fine.

## Exceptions

| Kind          | Dates                         | Branch meaning                       | Doctor meaning                                 |
| ------------- | ----------------------------- | ------------------------------------ | ---------------------------------------------- |
| `CLOSED`      | `startDate`…`endDate` (≤ 366) | holiday, temporary closure           | leave / unavailability (whole days)            |
| `UNAVAILABLE` | one date + `start`/`end`      | partial closure (e.g. staff meeting) | partial leave                                  |
| `EXTRA`       | one date + `start`/`end`      | exceptional opening hours            | additional working period (inside branch time) |

**Resolution of one date:** `CLOSED` → nothing, including EXTRA. Otherwise the result is
`(weekly WORK − BREAK − UNAVAILABLE) ∪ EXTRA`. To give a date completely different hours (for
example Ramadan hours), add `UNAVAILABLE 00:00–24:00` plus `EXTRA` periods. Exceptions of the same
kind for the same owner must not overlap (`EXCEPTION_OVERLAP`). Exceptions are cancelled, never
deleted. A start date must be today or later.

## Doctor schedules must fit the branch

When a doctor schedule is created, revised or re-activated:

1. The assignment must be configurable: assignment active, DOCTOR membership active and
   covering the branch, and the global profile VERIFIED and ACTIVE (`ASSIGNMENT_NOT_ELIGIBLE`).
2. Every date of its range (from today) is covered by an active branch version
   (`BRANCH_HOURS_NOT_COVERED`, with the gaps).
3. On every weekday that occurs, the doctor's time is inside the branch's time of each
   overlapping branch version. Working during a branch BREAK counts as outside
   (`OUTSIDE_BRANCH_HOURS`, with the offending day and times).
4. No real-time overlap with the doctor's schedules at the clinic's **other branches**
   (`DOCTOR_SCHEDULE_CONFLICT`, with the other branch and the first conflicting UTC interval).

A doctor `EXTRA` must lie inside the branch's resolved time **on that date** (weekly ± branch
exceptions), and must also pass check 4.

The reverse direction is enforced too. A branch-hours revision or deactivation that would leave
an active doctor schedule (of an active assignment) uncovered or outside is refused
(`BRANCH_HOURS_IN_USE`, listing the affected schedules). **Branch date exceptions** (holidays,
closures) are deliberately _not_ blocked by doctor schedules. They are resolved by
intersection: on a branch holiday the doctor's working time that day is simply empty.

## Resolved working time

`GET …/working-time?from&to` (≤ 62 days) returns, per local date:

```
doctor time = (doctor weekly − breaks − doctor UNAVAILABLE) ∪ doctor EXTRA, or ∅ if doctor CLOSED
branch time = (branch weekly − breaks − branch UNAVAILABLE) ∪ branch EXTRA, or ∅ if branch CLOSED
working time = doctor time ∩ branch time        (∅ if the assignment is not effective)
```

Each day lists `local` wall-clock ranges and their `utc` instants. `GET …/opening-time` does the
same for the branch alone. A future Booking Engine derives slots from this; this task does not
generate or reserve slots.

## Time zones and DST

- Every branch has an IANA `timeZone` (validated with the runtime's ICU data). Recurring
  periods and exception times are **local wall-clock minutes in that zone, never UTC**, so
  "09:00" stays 09:00 local all year. All instants (`created_at`, the `utc` output) are UTC.
- Conversion uses `Intl` only (no new dependency); see
  `apps/backend/src/modules/clinic-setup/time-zone.ts`.
- **One rule for DST:** a local time _w_ on date _D_ maps to the **first instant at which the
  local clock on D reads ≥ w**. A period `[s, e)` becomes the single UTC interval
  `[map(s), map(e))`.

| Case                                  | Example (America/New_York)                     | Result                                                                               |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Nonexistent** time (spring forward) | 02:30 on the March change day does not exist   | maps to the transition instant (03:00 EDT). Nothing is shifted to a later wall time. |
| Period across the gap                 | 01:00–04:00                                    | 2 real hours (06:00Z–08:00Z)                                                         |
| Period wholly inside the gap          | 02:00–02:45                                    | empty (no real time exists)                                                          |
| **Ambiguous** time (fall back)        | 01:30 on the November change day happens twice | the **first** occurrence (EDT)                                                       |
| Period across the repeated hour       | 00:00–03:00                                    | 4 real hours (first 00:00 → 03:00 EST)                                               |
| Period inside the repeated hour       | 01:00–01:30                                    | 30 minutes, first occurrence only (never 90)                                         |

Egypt (`Africa/Cairo`) observes DST again since 2023. Its clocks go 00:00 → 01:00 on the last
Friday of April and 24:00 → 23:00 on the last Thursday of October. The same rule applies and
is unit-tested.

- **Cross-branch conflicts** convert each branch's pattern with **its own** zone, date by date,
  over a horizon of 371 days from the later of today and the schedule start. This covers every
  seasonal offset combination, for example a conflict between Cairo and London that exists only
  between London's and Cairo's spring changes (tested). Beyond the horizon, the yearly
  repetition of DST rules is assumed. Touching intervals (one ends when the other starts) are
  not a conflict. Travel time is not modelled (OD-22).
- **Branch time zone lock:** while a branch has active schedules or exceptions, its time zone
  cannot change (`409 BRANCH_TIME_ZONE_LOCKED`), because that would silently move every period
  in real time. Deactivate, change the zone, then re-create.

## Concurrency

Every schedule and exception write is one transaction that **first locks the clinic row**
(ADR-034), then reads current state and validates. Concurrent conflicting writes, for the same
assignment or for the same doctor at two branches, therefore serialize: exactly one commits,
and the others get `409` (tested with parallel requests). Validation is never only a pre-check
outside the transaction.

## Authorization and operating state

| Action                                                   | Permission                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| View hours, schedules, exceptions, working/opening time  | `clinic.schedules.view` (BRANCH level; owner, manager, doctor, receptionist) |
| Create/revise/deactivate/activate, add/cancel exceptions | `clinic.schedules.manage` (BRANCH level; owner, manager)                     |

BRANCH level means branch-assigned members act only on their branches. The branch in the URL
is re-resolved against the caller's memberships, and an uncovered branch is `404`. Writes are
ADMINISTRATION: blocked by a FULL suspension and by CLOSED, but not by a NEW_OPERATIONS
suspension or a restricted subscription (ADR-026). Reads are CLINIC_INFO (always allowed).
Doctors see their own (and their branches') schedules, and cannot change them.
