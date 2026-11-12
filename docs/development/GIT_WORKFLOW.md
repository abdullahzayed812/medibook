# Git workflow

> **Purpose:** branching, commit, review and task-report conventions.

## Branching

Trunk-based development with short-lived branches.

- `main` is always releasable and protected. No direct pushes.
- Branch from `main`, keep branches small (ideally merged within a few days):
  - `feat/<short-description>` new functionality
  - `fix/<short-description>` bug fixes
  - `chore/<…>`, `docs/<…>`, `refactor/<…>`, `test/<…>`
- Rebase on `main` to stay current. Avoid long-running feature branches; use incremental PRs.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <imperative summary, ≤ 72 chars>

<optional body: what and why, not how>
```

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`.
- Scope: workspace or module, e.g. `backend`, `backend/health`, `shared-types`, `infra`.
- Example: `feat(backend/clinics): add clinic creation endpoint`.
- Each commit should build and pass tests.

## Pull requests

- One logical change per PR. Link the task/issue.
- Required before merge:
  - `npm run validate` passes (format, lint, typecheck, unit tests, build).
  - `npm run test:integration` passes for changes touching the database, Redis or queues.
  - At least one approving review.
  - Docs updated (`docs/`) and an entry in `docs/architecture/decisions/DECISIONS.md` for any
    architectural decision.
  - For task work: a task report in `docs/tasks/TASK_<NN>_REPORT.md`, listed in
    `docs/tasks/README.md`.
- Merge with **squash merge**; the squash message follows Conventional Commits.

## Rules

- Never commit secrets, `.env` files, or real patient data. If a secret is committed, rotate it
  immediately. Removing it from history is not enough.
- Committed migrations are immutable (see CODING_STANDARDS.md § Database).
- Commit `package-lock.json` changes together with the `package.json` change that caused them.
  Use `npm` only.
