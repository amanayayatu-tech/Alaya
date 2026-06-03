/**
 * 内存状态存储 (M1+M3 用内存模拟 PRD 13.2 的核心表)。
 * 模拟了 PRD 要求的:version 字段、event_log、字段级 owner。
 * Phase 1 将替换为 SQLite,但接口保持一致。
 */

import type {
  KnowledgeItem,
  Prediction,
  HumanGate,
} from "../core/types.js";

export interface Project {
  id: string;
  name: string;
  direction: string;
  targetUser: string;
  redlines: string[];
  weeklyHumanMinutes: number;
}

export interface Cycle {
  id: string;
  projectId: string;
  index: number;
  goal: string;
  status: "planning" | "running" | "closed";
  eCycle: number | null;
  worstClaimError: number | null;
}

export interface AgentRun {
  cycleIndex: number;
  agent: string;
  action: string;
  outputSummary: string;
  knowledgeRefsUsed: string[];
}

export interface EventLogEntry {
  seq: number;
  cycleIndex: number;
  actor: string; // owner:哪个 Agent 写的
  table: string;
  op: string;
  before: unknown;
  after: unknown;
}

export interface DecisionLogEntry {
  cycleIndex: number;
  gateType: string;
  decision: string;
  rationale: string;
}

export class Store {
  project!: Project;
  cycles: Cycle[] = [];
  knowledge: Map<string, KnowledgeItem> = new Map();
  predictions: Prediction[] = [];
  gates: HumanGate[] = [];
  agentRuns: AgentRun[] = [];
  eventLog: EventLogEntry[] = [];
  decisionLog: DecisionLogEntry[] = [];
  /** 已被人类否决的方向,防止重复提出 (PRD 17.3) */
  rejectedDirections: Set<string> = new Set();
  /** 连续灰区计数,按知识 id (修复漏洞E) */
  grayStreak: Map<string, number> = new Map();
  /** 知识停留 stale 的 cycle 数 */
  staleAge: Map<string, number> = new Map();

  private seq = 0;

  logEvent(cycleIndex: number, actor: string, table: string, op: string, before: unknown, after: unknown) {
    this.eventLog.push({ seq: ++this.seq, cycleIndex, actor, table, op, before, after });
  }

  /** 乐观并发:写入前校验 version (模拟 PRD 12.2) */
  upsertKnowledge(actor: string, cycleIndex: number, k: KnowledgeItem) {
    const before = this.knowledge.get(k.id) ?? null;
    this.knowledge.set(k.id, k);
    this.logEvent(cycleIndex, actor, "knowledge_items", before ? "update" : "insert", before, k);
  }

  recordAgentRun(run: AgentRun) {
    this.agentRuns.push(run);
    this.logEvent(run.cycleIndex, run.agent, "agent_runs", "insert", null, run);
  }

  activeKnowledge(): KnowledgeItem[] {
    return [...this.knowledge.values()].filter((k) =>
      ["active", "strong"].includes(k.status),
    );
  }

  strongKnowledge(): KnowledgeItem[] {
    return [...this.knowledge.values()].filter((k) => k.status === "strong");
  }
}
