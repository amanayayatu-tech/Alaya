import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, Clock3, Database, GitBranch, MessageSquareText, type LucideIcon } from "lucide-react";

import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentRun, DecisionLogItem, EventLogItem, LlmCall } from "@/lib/alaya";
import { actorLabels, gateTypeLabels, metaFor } from "@/lib/labels";
import { cn } from "@/lib/utils";

export type TraceTimelineProps = {
  events: EventLogItem[];
  decisions: DecisionLogItem[];
  agentRuns: AgentRun[];
  llmCalls: LlmCall[];
  className?: string;
};

type TimelineType = "event" | "decision" | "agent_run" | "llm_call";

type TimelineItem = {
  id: string;
  type: TimelineType;
  actor: string;
  ts: string;
  title: string;
  summary: string;
  meta?: string;
};

const typeMeta: Record<TimelineType, { label: string; icon: LucideIcon; className: string }> = {
  event: {
    label: "事件",
    icon: Database,
    className: "border-semantic-neutral/30 bg-semantic-neutral/10 text-semantic-neutral",
  },
  decision: {
    label: "决策",
    icon: GitBranch,
    className: "border-semantic-success/35 bg-semantic-success/10 text-semantic-success",
  },
  agent_run: {
    label: "Agent Run",
    icon: Bot,
    className: "border-semantic-info/35 bg-semantic-info/10 text-semantic-info",
  },
  llm_call: {
    label: "LLM Call",
    icon: MessageSquareText,
    className: "border-semantic-warning/40 bg-semantic-warning/10 text-semantic-warning",
  },
};

function formatTs(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function compact(value: unknown, maxLength = 220): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}...`;
}

function mergeTimelineItems({
  events,
  decisions,
  agentRuns,
  llmCalls,
}: Pick<TraceTimelineProps, "events" | "decisions" | "agentRuns" | "llmCalls">): TimelineItem[] {
  const eventItems = events.map((event) => ({
    id: `event:${event.id}`,
    type: "event" as const,
    actor: event.actor,
    ts: event.ts,
    title: `${event.tableName} · ${event.op}`,
    summary: compact(event.after ?? event.before),
    meta: `Cycle #${event.cycleIdx}`,
  }));

  const decisionItems = decisions.map((decision) => {
    const gateType = metaFor(gateTypeLabels, decision.gateType);
    return {
      id: `decision:${decision.id}`,
      type: "decision" as const,
      actor: "human",
      ts: decision.ts,
      title: `${gateType.label} · ${decision.decision}`,
      summary: compact(decision.rationale),
      meta: decision.cycleId,
    };
  });

  const agentRunItems = agentRuns.map((run) => {
    const actor = metaFor(actorLabels, run.agent);
    return {
      id: `agent_run:${run.id}`,
      type: "agent_run" as const,
      actor: run.agent,
      ts: run.ts,
      title: `${actor.label} · ${run.action}`,
      summary: compact(run.outputSummary),
      meta: `Cycle #${run.cycleIdx}`,
    };
  });

  const llmCallItems = llmCalls.map((call) => {
    const actor = metaFor(actorLabels, call.agent);
    return {
      id: `llm_call:${call.id}`,
      type: "llm_call" as const,
      actor: call.agent,
      ts: call.ts,
      title: `${actor.label} · ${call.promptVersion}`,
      summary: compact(call.outputSummary || call.inputSummary),
      meta: `${call.latencyMs}ms · ${call.tokenCount} tokens · $${call.estimatedCost.toFixed(4)}`,
    };
  });

  return [...eventItems, ...decisionItems, ...agentRunItems, ...llmCallItems].sort((a, b) => {
    const aTime = new Date(a.ts).getTime();
    const bTime = new Date(b.ts).getTime();
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
}

export function TraceTimeline({ events, decisions, agentRuns, llmCalls, className }: TraceTimelineProps) {
  const [actorFilter, setActorFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const parentRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => mergeTimelineItems({ events, decisions, agentRuns, llmCalls }), [events, decisions, agentRuns, llmCalls]);
  const actors = useMemo(() => {
    return Array.from(new Set(items.map((item) => item.actor))).sort((a, b) => a.localeCompare(b));
  }, [items]);
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const actorMatches = actorFilter === "all" || item.actor === actorFilter;
      const typeMatches = typeFilter === "all" || item.type === typeFilter;
      return actorMatches && typeMatches;
    });
  }, [actorFilter, items, typeFilter]);

  const virtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 112,
    overscan: 8,
  });

  return (
    <div className={cn("rounded-lg border border-card-border bg-card", className)}>
      <div className="flex flex-col gap-3 border-b border-card-border p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">运行时间线</div>
          <div className="mt-1 text-xs text-muted-foreground">
            合并 event log、decision log、agent runs 和 LLM calls。
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={actorFilter} onValueChange={setActorFilter}>
            <SelectTrigger className="w-full sm:w-44" aria-label="按 actor 筛选">
              <SelectValue placeholder="Actor" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部 actor</SelectItem>
              {actors.map((actor) => (
                <SelectItem key={actor} value={actor}>
                  {metaFor(actorLabels, actor).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full sm:w-44" aria-label="按类型筛选">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              {(Object.keys(typeMeta) as TimelineType[]).map((type) => (
                <SelectItem key={type} value={type}>
                  {typeMeta[type].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div ref={parentRef} className="h-[520px] overflow-auto">
        {filteredItems.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
            当前筛选下没有时间线条目。
          </div>
        ) : (
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = filteredItems[virtualItem.index];
              const meta = typeMeta[item.type];
              const Icon = meta.icon;
              return (
                <div
                  key={item.id}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute left-0 top-0 w-full px-3 py-2"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <div className="grid grid-cols-[auto_1fr] gap-3 rounded-lg border border-border/70 bg-background/60 p-3">
                    <div className="flex flex-col items-center">
                      <span className={cn("flex h-8 w-8 items-center justify-center rounded-md border", meta.className)}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="mt-2 h-full w-px bg-border" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={cn("px-2 py-0.5 text-[11px] font-medium", meta.className)}>
                          {meta.label}
                        </Badge>
                        <StatusBadge status={item.actor} type="actor" />
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock3 className="h-3.5 w-3.5" />
                          {formatTs(item.ts)}
                        </span>
                      </div>
                      <div className="mt-2 break-words text-sm font-medium text-foreground">{item.title}</div>
                      {item.summary && <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">{item.summary}</div>}
                      {item.meta && <div className="mt-2 font-mono text-[11px] text-muted-foreground">{item.meta}</div>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
