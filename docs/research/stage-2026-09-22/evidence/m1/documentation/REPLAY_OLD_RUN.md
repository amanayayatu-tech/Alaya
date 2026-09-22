# M1.1 replay of 2026-09-19T09-19-20-583Z

Old run is read-only. Scores below are diagnostic and do not replace the original `NO_SIGNAL_ON_DEV`.

## Request replay

Evidence rows store `output` and metadata, not the AgentContext or HTTP body. `draft_output` / `mockData` **cannot be replayed** from this run. Next runs record a sanitized request object.

## Distill path

- K1: provider `schemaValid=true`, `items: []`. This is a legal empty candidate, then frozen to empty knowledge. Hash `8b475aad...`
- K2: provider degraded after missing `items`; runner called `freezeKnowledge(version, [], ...)` and stored another empty package. Hash `8e80132b...` (differs because version is in the hash). This collapsed generate-failure into a successful empty candidate.

Train feedback `allowedIds` were present on distill evidence (20 then 40 ids). The Distiller output did not use them.

## Diagnostic split (unified empty allowedKnowledgeIds=[])

| split | arm | n | actionCorrect | contractValid | strictTaskSuccess |
|---|---|---:|---:|---:|---:|
| train | A | 20 | 3 | 7 | 1 |
| train | B | 20 | 6 | 9 | 2 |
| dev | A | 20 | 4 | 5 | 1 |
| dev | B | 20 | 2 | 8 | 0 |

`actionCorrect` uses the raw `decision` when it is one of the five actions; it does not repair JSON. Original comparison.csv `correct` is `strictTaskSuccess` under the old arm-specific ref errors.

A vs empty-B: both should use the same empty allow-list. Old names `a_arm_must_have_empty_refs` and `unknown_knowledge_ref` described the same empty-set rule. Re-scoring every raw output with `allowedKnowledgeIds=[]` rejects any nonempty refs equally.

## Send vs score gap

Decision schema only typed `knowledgeRefs` as an array. The model request did not include `allowedKnowledgeIds`. Signal ids were therefore a legal-looking array to the provider checker and illegal to the experiment scorer.

Distill schema only required `items` as an array, with no item fields. Empty list was allowed in the task text.
