# Contributing to Alaya

Alaya is in research maintenance mode. Read [PRINCIPLES.md](./PRINCIPLES.md)
and the [research closeout](./docs/research/RESEARCH_RELEASE_2026-10-15.zh-CN.md)
before changing code.

## Supported scope

Maintain installation, dependency security, and direct regressions in existing
local workflows. This release supports one local user on Node.js 24 LTS and
npm 11. It does not promise hosted, multi-user, or production operation.

New architecture, agent roles, algorithms, learning mechanisms, experiments,
and long-running evaluations are outside maintenance scope. A historical PRD,
mission, preregistration, or runbook is evidence of an earlier plan, not
authorization to resume it.

## Local setup

Install dependencies only from the repository root:

~~~sh
npm ci
npm run dev
~~~

The root `package-lock.json` is the single lockfile for this npm-workspaces
repository. Do not create subpackage lockfiles. Default development uses the
deterministic mock provider; no API key is needed. Use an isolated demo DB when
inspecting data-changing behavior; see [configuration](./docs/configuration.md#独立演示与安全重置).

Builder output is a change package for manual application. Mock observations,
knowledge growth, successful calls, or passing tests are not evidence of real
business execution or cognitive improvement.

## Changes and checks

Use focused branches, keep diffs reviewable, and preserve unrelated user
changes. Do not commit local databases, env files, credentials, raw provider
logs, or machine-specific paths.

Choose checks that cover the affected path. The ordinary release checks are:

~~~sh
npm run typecheck
npm run test:all
npm run guard
npm run secret:scan
npm run build
git diff --check
~~~

For behavior changes, reuse existing tests and add a direct regression only
when coverage is missing. Do not remove validation to obtain a pass. Do not
start a live provider, external write, deployment, or long run as part of a
routine check.

## Research records

Preserve historical scores, failed gates, invalidated attempts, and original
claim boundaries. Later fixes or static reanalysis must have their own
identity; never overwrite an old experiment to improve its result.

Prefer reading and statically recomputing saved results. State whether a
check used mock, a real model, saved data, or a container, and what it actually
proves. The new fixed-search M1 request file indexes candidates after search;
it is not a physical HTTP or billing ledger.

New experiments and publication actions require explicit authorization.
Prepared papers, PDFs, evidence packages, green CI, or a draft PR are not
submission or release receipts.
