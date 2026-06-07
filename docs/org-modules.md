# Organization Modules

Organization modules are lightweight knowledge templates for answering the five practical questions behind an operating module:

- What module is this and what problem does it solve?
- Who owns it and where are its responsibility boundaries?
- What upstream/downstream dependencies, data flow and call chain does it have?
- What is the MVP, test plan and execution plan?
- What known pitfalls and redlines must not be crossed?

## Fields

| Field | Purpose |
| --- | --- |
| `moduleName` | Module name. |
| `problemSolved` | The concrete problem this module owns. |
| `ownerRole` | Role accountable for the module. |
| `responsibilityBoundaries` | In/out boundaries. |
| `upstreamDependencies` / `downstreamConsumers` | Callers and consumers. |
| `dataInputs` / `dataOutputs` | Data flow contract. |
| `callChain` | Ordered operational chain. |
| `mvpDefinition` | Minimum useful implementation. |
| `testPlan` | Validation plan. |
| `executionPlan` | Implementation or operating plan. |
| `knownPitfalls` | Failure modes to watch. |
| `redlines` | Hard constraints. |
| `version` | Reader-facing version label. |

## API

```http
POST /api/projects/:id/org-modules
GET /api/projects/:id/org-modules
GET /api/org-modules/:id
PATCH /api/org-modules/:id
DELETE /api/org-modules/:id
GET /api/org-modules/:id/markdown
POST /api/org-modules/:id/knowledge
```

Markdown export returns a stable `text/markdown` document headed by the module name.

## Knowledge Conversion

`POST /api/org-modules/:id/knowledge` converts the module into a Knowledge Base item with:

- `sourceType = external_doc`
- `sourceRef = org_module:<moduleId>:<version>`
- tags including `org_module`, `module:<moduleName>`, and `version:<version>`
- `status = draft`

Draft module knowledge is searchable through the normal knowledge search route, but it is not injected into `[PRIOR KNOWLEDGE]` because injection only allows active/strong unsuperseded knowledge. Operational evidence still wins until a human explicitly approves the converted item.
