# Contributing to Alaya

Read [PRINCIPLES.md](./PRINCIPLES.md) before changing code. The principles are project guardrails, not optional style guidance.

## Local Setup

Install dependencies from the repository root:

```sh
npm ci
```

The root `package-lock.json` is the only lockfile source of truth for this
npm-workspaces repository. Do not run or commit subpackage `npm ci` output under
`alaya-app/` or `alaya-core/`.

Common local commands:

```sh
npm --prefix alaya-app run check
npm --prefix alaya-app test
npm run test:scripts
npm run guard
npm run secret:scan
npm run build
```

Use `npm --prefix alaya-app run dev` for local app development. Use mock providers for ordinary development and review unless a task explicitly requires live-provider validation.

## Branches and Commits

- Work from an up-to-date `main`.
- Use focused branches named by scope, for example `codex/docs-governance` or `fix/scheduler-budget`.
- Keep commits reviewable. Prefer one commit per coherent change or task.
- Write commit messages with a short imperative subject, for example `Add contribution guide` or `Refactor scheduler modules`.
- Do not commit local databases, logs, generated secrets, or private key material.

## Pull Request Checklist

Run these gates before opening or merging a PR:

```sh
npm --prefix alaya-app run check
npm --prefix alaya-app test
npm run guard
npm run secret:scan
```

Also run these when the change touches scripts, build output, or repository structure:

```sh
npm run test:scripts
npm run build
npm ci --dry-run
git diff --check
```

Do not delete tests to make a PR pass. When behavior changes, update or add tests that prove the intended contract.

## Validation Logs

Validation reports and run notes belong under [docs/validation/](./docs/validation/). Keep logs factual:

- Record the command, mode, provider type, and whether the run was mock or live.
- Link to the relevant artifact or summary file.
- Separate sampled run evidence from later cleanup or repair checks.
- Do not paste secrets, tokens, or private local paths that are not needed for review.

Long-running or real-provider validation is not part of the default PR gate. Run it only when the task explicitly asks for it and document the result under `docs/validation/`.
