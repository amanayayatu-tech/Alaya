import { rawDb, storage } from "./storage";
import type { Cycle, HumanGateItem, KnowledgeItem, Prediction } from "@shared/schema";

type ErrorTypes = {
  perception: number;
  execution: number;
  model: number;
  value: number;
};

type EventRow = {
  id: number;
  cycle_idx: number;
  actor: string;
  table_name: string;
  op: string;
  before: string | null;
  after: string | null;
  ts: string;
};

export type FlywheelHealth = {
  rounds: Array<{
    roundNumber: number;
    startedAt: string;
    completedAt: string;
    newKnowledgeCount: number;
    promotionCount: number;
    correctionCount: number;
    errorTypes: ErrorTypes;
    humanGatesTriggered: number;
    humanGatesResolved: number;
    knowledgeInjectedCount: number;
  }>;
  totals: {
    strongKnowledgeCount: number;
    activeKnowledgeCount: number;
    staleKnowledgeCount: number;
    quarantinedCount: number;
    conflictCount: number;
    totalEvidenceCount: number;
  };
  compoundingProof: {
    round1vs4KnowledgeDelta: number;
    round1vs4StaticKnowledgeDelta?: number;
    round1vsCurrentKnowledgeDelta?: number;
    principleNoveltyRate: number;
    injectionEffectiveness: number;
  };
};

function emptyHealth(): FlywheelHealth {
  return {
    rounds: [],
    totals: {
      strongKnowledgeCount: 0,
      activeKnowledgeCount: 0,
      staleKnowledgeCount: 0,
      quarantinedCount: 0,
      conflictCount: 0,
      totalEvidenceCount: 0,
    },
    compoundingProof: {
      round1vs4KnowledgeDelta: 0,
      round1vs4StaticKnowledgeDelta: 0,
      round1vsCurrentKnowledgeDelta: 0,
      principleNoveltyRate: 0,
      injectionEffectiveness: 0,
    },
  };
}

function safeJson(value: string | null): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function knowledgeEvidence(item: KnowledgeItem): number {
  return Math.max(0, (item.evidenceAlpha - 1) + (item.evidenceBeta - 1));
}

function eventRows(): EventRow[] {
  return rawDb.prepare(`SELECT * FROM event_log ORDER BY id ASC`).all() as EventRow[];
}

function startedAt(events: EventRow[], cycle: Cycle): string {
  const match = events.find((event) => {
    if (event.table_name !== "cycles" || event.op !== "insert") return false;
    return safeJson(event.after).id === cycle.id;
  });
  return match?.ts ?? "";
}

function completedAt(events: EventRow[], cycle: Cycle): string {
  const closeEvent = [...events].reverse().find((event) => {
    if (event.table_name !== "cycles" || event.op !== "close") return false;
    return safeJson(event.after).cycleId === cycle.id;
  });
  if (closeEvent) return closeEvent.ts;

  const snapshot = cycle.reasoning
    .split("\n")
    .find((line) => line.startsWith("__flywheel_snapshot__="))
    ?.slice("__flywheel_snapshot__=".length);
  const parsed = safeJson(snapshot ?? null);
  return typeof parsed.closedAt === "string" ? parsed.closedAt : "";
}

function countPromotions(projectId: string, events: EventRow[], roundNumber: number): number {
  return events.filter((event) => {
    if (event.cycle_idx !== roundNumber || event.table_name !== "knowledge_items") return false;
    const before = safeJson(event.before);
    const after = safeJson(event.after);
    if (after.projectId !== projectId) return false;
    if (before.status === after.status) return false;
    return after.status === "active" || after.status === "strong";
  }).length;
}

function countInjections(projectId: string, events: EventRow[], roundNumber: number): number {
  return events.filter((event) => {
    if (event.cycle_idx !== roundNumber || event.actor !== "knowledge_injection" || event.op !== "inject") return false;
    return safeJson(event.after).projectId === projectId;
  }).length;
}

function errorTypesFor(predictions: Prediction[]): ErrorTypes {
  const counts: ErrorTypes = { perception: 0, execution: 0, model: 0, value: 0 };
  for (const prediction of predictions) {
    if (prediction.errorType === "perception") counts.perception += 1;
    if (prediction.errorType === "execution") counts.execution += 1;
    if (prediction.errorType === "model") counts.model += 1;
    if (prediction.errorType === "value") counts.value += 1;
  }
  return counts;
}

function referencedKnowledgeIds(projectId: string): Set<string> {
  const ids = new Set<string>();
  for (const prediction of storage.listPredictionsByProject(projectId)) {
    try {
      for (const id of JSON.parse(prediction.knowledgeRefs) as string[]) ids.add(id);
    } catch {
      // Ignore malformed legacy rows.
    }
  }
  for (const run of storage.listCycles(projectId).flatMap((cycle) => storage.listAgentRuns(cycle.id))) {
    try {
      for (const id of JSON.parse(run.knowledgeRefsUsed) as string[]) ids.add(id);
    } catch {
      // Ignore malformed legacy rows.
    }
  }
  return ids;
}

function injectedKnowledgeIds(projectId: string, events: EventRow[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.actor !== "knowledge_injection" || event.op !== "inject") continue;
    const after = safeJson(event.after);
    if (after.projectId === projectId && typeof after.id === "string") ids.add(after.id);
  }
  return ids;
}

function roundKnowledgeDelta(knowledge: KnowledgeItem[]): number {
  const round1 = knowledge.filter((item) => item.createdByCycle <= 1).length;
  const round4 = knowledge.filter((item) => item.createdByCycle <= 4).length;
  return Math.max(0, round4 - round1);
}

function currentKnowledgeDeltaFromRound1(knowledge: KnowledgeItem[]): number {
  const round1 = knowledge.filter((item) => item.createdByCycle <= 1).length;
  return Math.max(0, knowledge.length - round1);
}

function principleNoveltyRate(knowledge: KnowledgeItem[]): number {
  const principles = knowledge.filter((item) => item.type === "principle");
  if (principles.length === 0) return 0;
  const uniqueKeys = new Set(principles.map((item) => item.semanticKey || item.title.toLowerCase()));
  return +(uniqueKeys.size / principles.length).toFixed(3);
}

function injectionEffectiveness(projectId: string, events: EventRow[]): number {
  const injected = injectedKnowledgeIds(projectId, events);
  if (injected.size === 0) return 0;
  const referenced = referencedKnowledgeIds(projectId);
  let used = 0;
  injected.forEach((id) => {
    if (referenced.has(id)) used += 1;
  });
  return +(used / injected.size).toFixed(3);
}

export function buildFlywheelHealth(projectId: string | undefined): FlywheelHealth {
  if (!projectId || !storage.getProject(projectId)) return emptyHealth();

  const cycles = storage.listCycles(projectId);
  const knowledge = storage.listKnowledge(projectId);
  const predictions = storage.listPredictionsByProject(projectId);
  const gates = storage.listGates(projectId);
  const events = eventRows();

  const rounds = cycles.map((cycle) => {
    const cyclePredictions = predictions.filter((prediction) => prediction.cycleId === cycle.id);
    const cycleGates = gates.filter((gate: HumanGateItem) => gate.cycleId === cycle.id);
    return {
      roundNumber: cycle.idx,
      startedAt: startedAt(events, cycle),
      completedAt: completedAt(events, cycle),
      newKnowledgeCount: knowledge.filter((item) => item.createdByCycle === cycle.idx).length,
      promotionCount: countPromotions(projectId, events, cycle.idx),
      correctionCount: cyclePredictions.filter((prediction) => prediction.errorType != null).length,
      errorTypes: errorTypesFor(cyclePredictions),
      humanGatesTriggered: cycleGates.length,
      humanGatesResolved: cycleGates.filter((gate) => gate.status !== "pending").length,
      knowledgeInjectedCount: countInjections(projectId, events, cycle.idx),
    };
  });

  return {
    rounds,
    totals: {
      strongKnowledgeCount: knowledge.filter((item) => item.status === "strong").length,
      activeKnowledgeCount: knowledge.filter((item) => item.status === "active").length,
      staleKnowledgeCount: knowledge.filter((item) => item.status === "stale").length,
      quarantinedCount: knowledge.filter((item) => item.status === "quarantined").length,
      conflictCount: knowledge.filter((item) => item.status === "conflict").length,
      totalEvidenceCount: +knowledge.reduce((sum, item) => sum + knowledgeEvidence(item), 0).toFixed(3),
    },
    compoundingProof: {
      round1vs4KnowledgeDelta: currentKnowledgeDeltaFromRound1(knowledge),
      round1vs4StaticKnowledgeDelta: roundKnowledgeDelta(knowledge),
      round1vsCurrentKnowledgeDelta: currentKnowledgeDeltaFromRound1(knowledge),
      principleNoveltyRate: principleNoveltyRate(knowledge),
      injectionEffectiveness: injectionEffectiveness(projectId, events),
    },
  };
}
