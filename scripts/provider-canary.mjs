#!/usr/bin/env node
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    projectId: { type: "string" },
    cycleId: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    role: { type: "string" },
    forceFailure: { type: "string" },
  },
});

const { storage } = await import("../alaya-app/server/storage.ts");
const { runProviderCanary } = await import("../alaya-app/server/providerCanary.ts");

const projectId = values.projectId ?? storage.listProjects()[0]?.id;
if (!projectId) {
  console.error(JSON.stringify({ ok: false, error: "No project found. Pass --projectId or create a project first." }, null, 2));
  process.exit(1);
}

const result = await runProviderCanary({
  projectId,
  cycleId: values.cycleId,
  provider: values.provider === "openai" ? "openai" : values.provider === "mock" ? "mock" : undefined,
  model: values.model,
  role: ["orchestrator", "sensor", "builder", "distiller", "librarian"].includes(values.role ?? "")
    ? values.role
    : undefined,
  forceFailure: values.forceFailure === "schema_error" || values.forceFailure === "provider_error"
    ? values.forceFailure
    : undefined,
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
