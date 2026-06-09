import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [rawKey, rawValue] = arg.slice(2).split("=");
    out[rawKey] = rawValue ?? "true";
  }
  return out;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${file}:${idx + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function latestRunDir() {
  const root = resolve("validation-logs");
  if (!existsSync(root)) return null;
  const candidates = readdirSync(root)
    .filter((name) => name.startsWith("health-signal-"))
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null && value !== "")));
}

function isInjectedKnowledgeId(id) {
  return typeof id === "string" && id.includes("health_signal_contradiction_runner");
}

const args = parseArgs(process.argv.slice(2));
let logDir = args["log-dir"];
if (!logDir) {
  // Keep discovery in the shell simple and deterministic for callers.
  logDir = latestRunDir();
}
if (!logDir) {
  throw new Error("Pass --log-dir=/path/to/health-signal run directory.");
}
logDir = resolve(logDir);

const events = readJsonl(join(logDir, "events.jsonl"));
const metrics = events.filter((event) => event.eventType === "metrics_sample");
const injections = events.filter((event) => event.eventType === "contradiction_feedback_injected");
const scans = events.filter((event) => event.eventType === "conflicts_scanned");
const resolvedReviews = events.filter((event) => event.eventType === "knowledge_review_resolved");
const sampleFailures = events.filter((event) => event.eventType === "sample_failed" || event.eventType === "runner_crashed");

const resolvedReviewIds = unique(resolvedReviews.map((event) => event.reviewId));
const involvedKnowledgeIds = unique(
  resolvedReviews.flatMap((event) => [event.primaryKnowledgeId, event.relatedKnowledgeId]),
);
const injectedConflictKnowledgeIds = involvedKnowledgeIds.filter(isInjectedKnowledgeId);

const sideCounts = injections.reduce((acc, event) => {
  const side = event.side ?? "unknown";
  acc[side] = (acc[side] ?? 0) + 1;
  return acc;
}, {});

const scanTotals = scans.reduce((acc, event) => {
  const conflictCandidateCount = Number(event.conflictCandidateCount ?? 0);
  const reviewRequiredCount = Number(event.reviewRequiredCount ?? 0);
  acc.conflictCandidateTotal += Number.isFinite(conflictCandidateCount) ? conflictCandidateCount : 0;
  acc.reviewRequiredTotal += Number.isFinite(reviewRequiredCount) ? reviewRequiredCount : 0;
  acc.maxConflictCandidateInScan = Math.max(acc.maxConflictCandidateInScan, conflictCandidateCount || 0);
  acc.maxReviewRequiredInScan = Math.max(acc.maxReviewRequiredInScan, reviewRequiredCount || 0);
  return acc;
}, {
  conflictCandidateTotal: 0,
  reviewRequiredTotal: 0,
  maxConflictCandidateInScan: 0,
  maxReviewRequiredInScan: 0,
});

const latestMetric = metrics.at(-1) ?? null;
const maxSnapshotConflictCount = metrics.reduce((max, event) => Math.max(max, Number(event.conflictCount ?? 0) || 0), 0);
const maxResolvedConflictReviews = metrics.reduce((max, event) => Math.max(max, Number(event.resolvedConflictReviews ?? 0) || 0), 0);

const summary = {
  generatedAt: new Date().toISOString(),
  runDir: logDir,
  runName: basename(logDir),
  samplesObserved: metrics.length,
  latestSample: latestMetric?.sample ?? null,
  contradictionInjections: {
    total: injections.length,
    sides: sideCounts,
  },
  conflictScans: {
    totalScans: scans.length,
    ...scanTotals,
    maxSnapshotConflictCount,
  },
  conflictReviews: {
    resolvedUnique: resolvedReviewIds.length,
    resolvedEventCount: resolvedReviews.length,
    maxResolvedConflictReviewsFromMetrics: maxResolvedConflictReviews,
    involvedKnowledgeCount: involvedKnowledgeIds.length,
    injectedConflictKnowledgeCount: injectedConflictKnowledgeIds.length,
    injectedConflictKnowledgeIds,
  },
  health: {
    latestRound1vs4KnowledgeDelta: latestMetric?.round1vs4KnowledgeDelta ?? null,
    latestPendingGates: latestMetric?.pendingGates ?? null,
    latestOpenConflictReviews: latestMetric?.openConflictReviews ?? null,
    latestStallGuardCount: latestMetric?.stallGuardCount ?? null,
  },
  failures: sampleFailures.map((event) => ({
    ts: event.ts,
    eventType: event.eventType,
    sample: event.sample ?? null,
    message: event.message ?? event.error ?? null,
  })),
  notes: [
    "CSV conflictCount is a point-in-time status count; rapid review resolution can keep it at 0 even when conflict reviews were created and resolved.",
    "injectedConflictKnowledgeCount counts distinct resolved review knowledge IDs generated from the anonymized health-signal contradiction runner.",
  ],
};

const output = args.output ? resolve(args.output) : join(logDir, "conflict_lifecycle_summary.json");
writeFileSync(output, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
