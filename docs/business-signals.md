# Business Signals

Alaya now has a generic local CSV/JSON business signal adapter for OPC, e-commerce, customer-service, finance, hardware-feedback and health-signal workflows.

## Schema

Each `ExternalBusinessSignal` contains:

| Field | Notes |
| --- | --- |
| `source` / `sourceId` | Local system name and upstream row id. |
| `projectId` | Alaya project that receives the signal. |
| `signalType` | `marketing_asset`, `sales_plan`, `customer_consultation`, `order`, `return_request`, `customer_service`, `finance_reconciliation`, `hardware_feedback`, `health_signal`, or `other`. |
| `observedAt` | Upstream observation timestamp. |
| `payload` | JSON object. Sensitive payloads are stored/audited as a redacted field summary. |
| `sensitivityLevel` | `public`, `internal`, `customer_pii`, `health_sensitive`, `financial`, or `compliance_sensitive`. |
| `dedupeKey` | Stable idempotency key. Re-importing the same key skips duplicate signal, feedback and gate creation. |
| `riskLevel` | Existing Alaya risk level. Sensitive health/financial/compliance rows require `financial` or `compliance_sensitive`. |

## API

```http
POST /api/projects/:id/business-signals/import
Content-Type: application/json

{
  "rows": [
    {
      "source": "local_orders",
      "sourceId": "order-100",
      "signalType": "order",
      "observedAt": "2026-06-07T00:00:00Z",
      "payload": { "sku": "sku-1", "amount": 42 },
      "sensitivityLevel": "internal",
      "dedupeKey": "local_orders:order-100",
      "riskLevel": "local_write"
    }
  ]
}
```

The route injects `projectId` from the URL. The adapter also supports local file imports through `importBusinessSignalsFromFile()` for `.json` arrays and headered `.csv` files.

## Governance Flow

Business signals do not become active knowledge directly.

```text
CSV/JSON row -> external_business_signals -> feedback_items -> non-blocking Meaning Gate -> human approval -> draft/active knowledge path
```

Sensitive rows are redacted before persistence to `event_log`, `trace_events`, and `action_ledger`. The import records an action-ledger entry with rollback information, but does not execute external writes.
