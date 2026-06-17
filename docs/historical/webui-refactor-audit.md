# Alaya WebUI Refactor Audit

> Historical frontend refactor audit. This file is archived for provenance and
> is not the current UI or setup source of truth.

Scope: `alaya-app/client/src/` on `main` at commit `8ac4366`.

Prompt guardrails:

- Alaya is a self-evolving governance engine, not a generic AI assistant or skill marketplace.
- UI must only expose real domain objects: Project, Cycle, Prediction, Knowledge, HumanGate, Agent Run, Event Log, Decision Log, LLM Calls.
- Frontend refactor must not change database schema, pure core functions, strong-promotion rules, or audit write paths.
- No runtime skill/image features will be added.

Design process note:

- Used `frontend-design` guidance for a restrained operational-console direction: clear human decision points, semantic risk/status color, dense but readable information, and progressive disclosure.
- Used the built-in image generation path for a static empty-state / flywheel governance illustration reference. Saved project-bound asset at `client/src/assets/empty-flywheel.png`.
- Browser automation was attempted against `http://127.0.0.1:5001`; the dev server ran, but Playwright/Chrome launch was closed by local system permissions. Runtime findings below are therefore based on source inspection plus live API checks, not screenshot evidence.

## Current API Map

Layout:

- `GET /api/projects`
- Fields used: `id`, `name`, `direction`.
- Pain: project selector is functional but reads like a developer console; navigation labels are mostly English and do not explain user intent.
- Refactor target: persistent project context with Chinese navigation labels and one-line page purpose.

Dashboard `/`:

- `GET /api/projects/:id/dashboard`
- `POST /api/projects/:id/scheduler/tick`
- Fields used: `project`, `currentCycle`, `cycleCount`, `flywheelStage`, `pendingHuman`, `gateBudget`, `llmBudget`, `openPredictions`, `blockingRisks`, `knowledgeCount`, `strongCount`, `recentKnowledge`.
- Pain: stage labels use agent names rather than human-readable flywheel work; key action result is shown as raw action text; budgets are bars but not visually prioritized as human governance constraints.
- Refactor target: hero with current project status, five-step flywheel visualization, clear budget rings, and scheduler result translated into created-next-cycle / waiting / safety-mode language.

Gates `/gates`:

- `GET /api/human-gates?projectId=`
- `POST /api/human-gates/:id/approve`
- `POST /api/human-gates/:id/reject`
- `POST /api/human-gates/:id/modify`
- Current fields used: `id`, `cycleId`, `type`, `blocking`, `title`, `payload`, `status`, `estimatedMinutes`, `decision`.
- Pain: no `GET /api/projects/:id/gate-budget` call; blocking gates are not globally summarized; action buttons do not collect a human rationale; type labels are partly internal.
- Refactor target: put blocking risk gates first, show gate budget at the top, translate type/status into plain Chinese, and use confirmation/rationale dialogs for approve/reject/modify.

Ledger `/ledger`:

- `GET /api/projects/:id/predictions`
- `GET /api/projects/:id/cycles`
- Current fields used: prediction `belief`, `prediction`, `action`, `claims`, `observation`, `predictionError`, `worstClaimError`, `errorType`, `updateTarget`, `knowledgeRefs`; cycle `idx`.
- Pain: currently a prediction ledger, not the requested audit ledger. It does not read `event-log`, `decision-log`, `agent-runs`, or `llm-calls`.
- Refactor target: keep prediction trend where useful, but make the main view a trace timeline merging Event Log, Decision Log, Agent Runs, and LLM Calls with filters.

Knowledge `/knowledge`:

- `GET /api/knowledge?projectId=`
- `POST /api/knowledge/search`
- `GET /api/knowledge/:id`
- `POST /api/knowledge/:id/approve`
- `POST /api/knowledge/:id/quarantine`
- Current fields used: `id`, `projectId`, `type`, `title`, `content`, `sourceType`, `sourceRef`, `evidenceAlpha`, `evidenceBeta`, `confidenceScore`, `confidenceLevel`, `status`, `humanApprovedCount`, `tags`, `createdByCycle`, `referencedByAgents`.
- Pain: only filters by `type`; prompt requires filters by `status`, `sourceType`, and `tags`. `supersededBy` exists in backend type contract but is not represented in client type or UI. Search copy mentions implementation details rather than user value.
- Refactor target: full-width search, status/source/tag filters, card-level evidence count, superseded knowledge folded/dimmed, and detail drawer with agent references.

Review `/review`:

- `GET /api/projects/:id/cycles`
- `GET /api/cycles/:id/review`
- Current fields used: cycle summary, feedback, predictions, agent runs, decisions, referencedKnowledge, knowledgeUpdated, bugs.
- Pain: uses a single select instead of the required left cycle list / right detail split; compounding evidence exists but is visually minor; agent order and decision impact are not strongly connected.
- Refactor target: two-column review, visible cycle timeline, clear “knowledge changed this decision” section, predictions/errors, gates/decisions, and agent run sequence.

New Project `/projects/new`:

- `POST /api/projects`
- Current fields used: onboarding fields from `onboardingSchema`.
- Pain: single long form; no progressive 3-step onboarding; field labels explain what to enter but not how each field shapes the flywheel.
- Refactor target: 3-step wizard: identity/goal, world model/redlines, budgets/first measurable claim; maintain current payload shape.

Project Setup `/project`:

- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `GET /api/projects/:id/integrations`
- `POST /api/projects/:id/integrations/github`
- Current fields used: project identity/world model/redlines/budgets/first claim; GitHub source `kind`, `config`, `status`, `lastSyncedAt`.
- Pain: all settings are in one long form; no tabs; GitHub integration is functional but sparse; save feedback is only toast-level.
- Refactor target: tabs for Basic, World Model & Redlines, Budgets, Integrations; show explicit save/sync results.

Not Found fallback:

- No API.
- Pain: default English error card uses hard-coded gray colors and references router internals.
- Refactor target: localized empty state consistent with the new design system.

## Shared Component / Style Audit

Current reusable code:

- `components/Layout.tsx`: sidebar, project selection, theme toggle, top header.
- `components/bits.tsx`: `PageHeader`, `Panel`, `PanelHeader`, `Stat`, `Tag`, `Empty`, `SkeletonRows`.
- `components/ui/*`: shadcn/Radix primitives available for dialogs, tabs, buttons, cards, select, progress, tooltip, skeleton, etc.
- `lib/alaya.ts`: client types and formatting helpers.
- `lib/queryClient.ts`: React Query client and `apiRequest`.
- `index.css` + `tailwind.config.ts`: existing CSS variables, dark/light theme, chart colors, hover elevation utilities.

Gaps:

- No central human-readable label map for `flywheelStage`, gate type/status, knowledge status, actor, operation, or scheduler action.
- No business components such as `StatusBadge`, `GateCard`, `KnowledgeCard`, `CycleTimeline`, `BudgetRing`, `FlywheelStageMap`, `TraceTimeline`.
- Loading states are mostly generic row skeletons; error states are inconsistent or missing.
- Color tokens exist but do not expose explicit `success`, `warning`, `danger` semantic names.
- Current page titles and navigation mix English product terms with Chinese, increasing cognitive load.

## Refactor Targets

1. Add `lib/labels.ts` for human-readable labels and descriptions backed only by real fields.
2. Add reusable business components under `components/`.
3. Update design tokens in `index.css` / `tailwind.config.ts` with semantic success/warning/danger while preserving shadcn variables.
4. Refactor 7 route pages and `Layout` without adding backend writes or fictional concepts.
5. Keep backend unchanged unless a read-only aggregation endpoint is strictly required. Current audit indicates existing endpoints are sufficient.
6. Validate with guard, tests, flywheel, long evolution, typecheck, build, and runtime checks.
