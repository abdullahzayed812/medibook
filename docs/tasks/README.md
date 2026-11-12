# Task reports

Every task ends with a report stored here as `TASK_<NN>_REPORT.md` (corrections: `TASK_<NN>_<N>_REPORT.md`). The report records what was
built, the decisions made, the commands actually executed and their real results, known
limitations, and any deviations from the task specification.

| Task   | Title                                                                         | Date       | Status                    | Report                                         |
| ------ | ----------------------------------------------------------------------------- | ---------- | ------------------------- | ---------------------------------------------- |
| 01     | Establish the Clinic SaaS technical foundation                                | 2026-11-11 | Approved (Task 02 issued) | [TASK_01_REPORT.md](TASK_01_REPORT.md)         |
| 02     | Identity, authentication, authorization & tenant isolation                    | 2026-11-11 | Approved (Task 03 issued) | [TASK_02_REPORT.md](TASK_02_REPORT.md)         |
| 03     | Platform & clinic management                                                  | 2026-11-11 | Correction 03.1 issued    | [TASK_03_REPORT.md](TASK_03_REPORT.md)         |
| 03.1   | Specialty permission, platform decisions, migration policy & docs restructure | 2026-11-11 | Correction 03.2 issued    | [TASK_03_1_REPORT.md](TASK_03_1_REPORT.md)     |
| 03.2   | Final platform consistency fixes                                              | 2026-11-11 | Awaiting review           | [TASK_03_2_REPORT.md](TASK_03_2_REPORT.md)     |
| 04     | Doctors, branches, services & schedules                                       | 2026-11-11 | Awaiting review           | [TASK_04_REPORT.md](TASK_04_REPORT.md)         |
| 05     | Booking Engine                                                                | 2026-11-11 | Correction 05.1 issued    | [TASK_05_REPORT.md](TASK_05_REPORT.md)         |
| 05.1   | Booking identity security, guest claims & staff-created bookings              | 2026-11-12 | Correction 05.2 issued    | [TASK_05_1_REPORT.md](TASK_05_1_REPORT.md)     |
| 05.2   | Canonical booking identity (resolves OD-30)                                   | 2026-11-12 | Correction 05.2.1 issued  | [TASK_05_2_REPORT.md](TASK_05_2_REPORT.md)     |
| 05.2.1 | Canonical identity link lifecycle hardening                                   | 2026-11-12 | Awaiting review           | [TASK_05_2_1_REPORT.md](TASK_05_2_1_REPORT.md) |

## Report template

Use these sections for every new report:

1. Header table: task, date, status, next step
2. Summary
3. Created / changed structure
4. Important configuration and architectural decisions (link to `../architecture/decisions/DECISIONS.md`)
5. Installed or changed dependencies
6. Implemented functionality
7. Commands executed and results (only commands that were actually run)
8. Bugs found and fixed during verification
9. Known limitations
10. Deviations from the specification
