# K1 zero-call diagnosis (ALAYA-M1.1-OFFICIAL)

Old run `2026-09-19T10-00-23-273Z` stays BLOCKED. No Train/Dev/Test replay. No paid call in this step.

## Config actually used by runner

- Model options passed into OpenAIProvider: MiniMax-M3, baseUrl api.minimax.io/openai, temperature 0.2, maxRetries 1, maxOutputTokens 512.
- This is reconstructed from current `protocol.json` + `runner.ts`, not a byte-for-byte HTTP replay.
- Chat path still sends `draft_output: request.mockData ?? {}`. Logged `mockDataPresent=false` means the field was absent on AgentContext; the HTTP body can still contain `{}`.

## What the saved K1 row is

Saved `output` matches `degradedResponse()` (summary + human_gate_candidate). It is not the model raw text.
Saved `request` is AgentContext, not the HTTP messages/system/thinking/max_tokens payload.
K1 tokenCount 4709 matches ceil(stringify({request,degraded})/4) on that fail path, not summed HTTP usage.

## Fetch-count trap

maxRetries=1 fail path: 2 schema attempts + 1 simplified = 3 fetches. Provider logs retryCount=3. Runner stored providerRequests=retryCount+1=4. Arithmetic of the trap is reproduced offline. Historical 24 is not rewritten.

## Parser trap (constructed truncation, not this MiniMax body)

Baseline `tryParseJsonObject` can return an inner closed knowledge object when the root `items` array is truncated, then schema reports missing `items`. Strict root parse rejects that text. This is a compatible failure mode, not proof the official K1 body was truncated.

## Diagnostic entry

`npm run m1:k1-diagnose` is zero-call by default (`READY_FOR_AUTHORIZED_K1_DIAGNOSE`).
Live replay, if later authorized, uses `diagnosticSingleAttempt` so there is no simplified extra fetch. Budget proposed by the audit: 2 HTTP / 30000 tokens. Not spent here.
