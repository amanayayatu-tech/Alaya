import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, Brain, ClipboardList, History, ReceiptText, ScrollText,
} from "lucide-react";
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useProject } from "@/components/Layout";
import {
  EmptyState,
  LoadingBlock,
  MetricTile,
  PageShell,
  SectionCard,
  StatusBadge,
} from "@/components/AppPrimitives";
import {
  errorToAccuracy,
  fmtNum,
  fmtPct,
  type Cycle,
  type DecisionLogItem,
  type EventLogItem,
  type LlmCall,
  type Prediction,
} from "@/lib/alaya";
import { actorLabels, errorTypeLabels, gateTypeLabels, metaFor, operationLabels } from "@/lib/labels";
import { apiFetch } from "@/lib/queryClient";

const LEDGER_TABS = [
  { key: "predictions", label: "预测" },
  { key: "events", label: "全局事件" },
  { key: "decisions", label: "决策" },
  { key: "llm", label: "LLM" },
] as const;

type LedgerTab = (typeof LEDGER_TABS)[number]["key"];

export default function Ledger() {
  const { projectId } = useProject();
  const [tab, setTab] = useState<LedgerTab>("predictions");

  const { data: predictions = [], isLoading } = useQuery<Prediction[]>({
    queryKey: ["/api/projects", projectId, "predictions"],
    enabled: !!projectId,
  });
  const { data: cycles = [] } = useQuery<Cycle[]>({
    queryKey: ["/api/projects", projectId, "cycles"],
    enabled: !!projectId,
  });
  const { data: decisions = [] } = useQuery<DecisionLogItem[]>({
    queryKey: ["/api/decision-log", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const response = await apiFetch(`/api/decision-log?projectId=${projectId}`);
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
  });
  const { data: events = [] } = useQuery<EventLogItem[]>({
    queryKey: ["/api/event-log"],
    enabled: !!projectId,
  });
  const { data: llmCalls = [] } = useQuery<LlmCall[]>({
    queryKey: ["/api/llm-calls"],
    enabled: !!projectId,
  });

  const cycleById = useMemo(() => new Map(cycles.map((cycle) => [cycle.id, cycle])), [cycles]);
  const orderedPredictions = useMemo(() => {
    return [...predictions].sort((a, b) => cycleIdx(a.cycleId, cycleById) - cycleIdx(b.cycleId, cycleById));
  }, [predictions, cycleById]);
  const projectCycleIds = useMemo(() => new Set(cycles.map((cycle) => cycle.id)), [cycles]);
  const projectLlmCalls = llmCalls.filter((call) => projectCycleIds.has(call.cycleId));

  if (!projectId) return <EmptyState title="先选择项目" description="预测、决策和 LLM 调用按项目聚合；事件日志展示全局 diagnostics。" />;
  if (isLoading) return <LoadingBlock rows={7} />;

  const resolvedPredictions = orderedPredictions.filter((prediction) => prediction.predictionError != null);
  const avgAccuracy = resolvedPredictions.length
    ? resolvedPredictions.reduce((sum, prediction) => sum + (errorToAccuracy(prediction.predictionError) ?? 0), 0) / resolvedPredictions.length
    : null;
  const chartData = resolvedPredictions.map((prediction) => ({
    cycle: `C${cycleIdx(prediction.cycleId, cycleById)}`,
    accuracy: Number(((errorToAccuracy(prediction.predictionError) ?? 0) * 100).toFixed(1)),
    error: Number(((prediction.predictionError ?? 0) * 100).toFixed(1)),
  }));
  const totalTokens = projectLlmCalls.reduce((sum, call) => sum + call.tokenCount, 0);
  const totalInputTokens = projectLlmCalls.reduce((sum, call) => sum + call.inputTokenCount, 0);
  const totalOutputTokens = projectLlmCalls.reduce((sum, call) => sum + call.outputTokenCount, 0);
  const totalCost = projectLlmCalls.reduce((sum, call) => sum + call.estimatedCost, 0);

  return (
    <PageShell
      title="审计账本"
      eyebrow="Ledger"
      description="预测、观察和人工决策按当前项目展示；事件日志是当前后端提供的全局 diagnostics。"
      className="pb-8"
      testId="page-ledger"
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricTile label="预测总数" value={orderedPredictions.length} sub={`${resolvedPredictions.length} 条已结算`} icon={<ClipboardList className="h-4 w-4" />} />
        <MetricTile label="平均准确率" value={fmtPct(avgAccuracy)} sub="1 - predictionError" icon={<Activity className="h-4 w-4" />} />
        <MetricTile label="人类决策" value={decisions.length} sub="来自闸门处理" icon={<ReceiptText className="h-4 w-4" />} />
        <MetricTile label="全局事件" value={events.length} sub="storage diagnostics" icon={<History className="h-4 w-4" />} />
        <MetricTile label="项目 LLM 成本" value={`$${totalCost.toFixed(4)}`} sub={`${totalTokens} tokens · in ${totalInputTokens} / out ${totalOutputTokens}`} icon={<Brain className="h-4 w-4" />} />
      </div>

      <SectionCard title="预测准确率趋势" description="每个点来自已结算 predictionError；70% 参考线用于快速判断趋势。">
        <div className="h-72 p-4">
          {chartData.length === 0 ? (
            <EmptyState title="暂无已结算预测" description="预测需要观察和误差写入后才会进入趋势图。" illustrated />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="cycle" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} />
                <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} unit="%" />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--popover-border))", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "hsl(var(--foreground))" }}
                />
                <ReferenceLine y={70} stroke="hsl(var(--warning))" strokeDasharray="4 4" label={{ value: "70%", fill: "hsl(var(--warning))", fontSize: 11, position: "insideTopRight" }} />
                <Line type="monotone" dataKey="accuracy" name="准确率" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={{ r: 4, fill: "hsl(var(--primary))" }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="账本明细"
        description="预测、决策、LLM 按项目 cycles 过滤；事件页签展示全局 storage diagnostics。"
        action={
          <div className="flex flex-wrap gap-1">
            {LEDGER_TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={`rounded-md border px-2.5 py-1 text-xs ${tab === item.key ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      >
        {tab === "predictions" && <PredictionLedger predictions={orderedPredictions} cycleById={cycleById} />}
        {tab === "events" && <EventLedger events={events} />}
        {tab === "decisions" && <DecisionLedger decisions={decisions} />}
        {tab === "llm" && <LlmLedger calls={projectLlmCalls} cycleById={cycleById} />}
      </SectionCard>
    </PageShell>
  );
}

function PredictionLedger({ predictions, cycleById }: { predictions: Prediction[]; cycleById: Map<string, Cycle> }) {
  if (predictions.length === 0) return <EmptyState title="暂无预测" description="创建或推进周期后，预测会写入这里。" illustrated />;
  return (
    <div className="divide-y divide-card-border">
      {predictions.map((prediction) => {
        const accuracy = errorToAccuracy(prediction.predictionError);
        return (
          <article key={prediction.id} className="px-4 py-4" data-testid={`row-prediction-${prediction.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge meta={{ label: `C${cycleIdx(prediction.cycleId, cycleById)}`, tone: "muted" }} />
              <StatusBadge meta={{ label: prediction.status === "resolved" ? "已结算" : "开放中", tone: prediction.status === "resolved" ? "success" : "warning" }} />
              {prediction.errorType ? <StatusBadge meta={metaFor(errorTypeLabels, prediction.errorType)} /> : <StatusBadge meta={{ label: "未分类", tone: "muted" }} />}
              {prediction.knowledgeRefs.map((ref) => <StatusBadge key={ref} meta={{ label: ref, tone: "primary" }} />)}
              <span className="ml-auto font-mono text-xs tabular-nums">acc {fmtPct(accuracy)}</span>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <LedgerField label="信念" value={prediction.belief} />
              <LedgerField label="预测" value={prediction.prediction} />
              <LedgerField label="动作" value={prediction.action} />
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <LedgerField label="观察" value={prediction.observation ?? "等待观察"} muted />
              <LedgerField label="预测误差" value={fmtNum(prediction.predictionError)} mono />
              <LedgerField label="最差 claim" value={fmtNum(prediction.worstClaimError)} mono />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function EventLedger({ events }: { events: EventLogItem[] }) {
  if (events.length === 0) return <EmptyState title="暂无全局事件记录" description="后端 storage 记录的 insert、update、resolve 等 diagnostics 会显示在这里。" illustrated />;
  return (
    <div className="divide-y divide-card-border">
      {[...events].reverse().slice(0, 80).map((event) => (
        <article key={event.id} className="grid gap-3 px-4 py-3 md:grid-cols-[9rem_1fr_auto]" data-testid={`row-event-${event.id}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge meta={{ label: `C${event.cycleIdx}`, tone: "muted" }} />
            <StatusBadge meta={metaFor(actorLabels, event.actor)} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge meta={metaFor(operationLabels, event.op)} />
              <span className="truncate text-sm font-medium">{event.tableName}</span>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{compactJson(event.after ?? event.before)}</div>
          </div>
          <div className="text-xs text-muted-foreground">{formatTime(event.ts)}</div>
        </article>
      ))}
    </div>
  );
}

function DecisionLedger({ decisions }: { decisions: DecisionLogItem[] }) {
  if (decisions.length === 0) return <EmptyState title="暂无人工决策" description="批准、驳回或修改闸门后，决策会进入这里。" illustrated />;
  return (
    <div className="divide-y divide-card-border">
      {[...decisions].reverse().map((decision) => (
        <article key={decision.id} className="grid gap-3 px-4 py-4 md:grid-cols-[12rem_1fr_auto]" data-testid={`row-decision-${decision.id}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge meta={metaFor(gateTypeLabels, decision.gateType)} />
            <StatusBadge meta={{ label: decision.decision, tone: decision.decision === "reject" ? "danger" : "success" }} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{decision.rationale || "未填写理由"}</div>
            <div className="mt-1 text-xs text-muted-foreground">{decision.cycleId}</div>
          </div>
          <div className="text-xs text-muted-foreground">{formatTime(decision.ts)}</div>
        </article>
      ))}
    </div>
  );
}

function LlmLedger({ calls, cycleById }: { calls: LlmCall[]; cycleById: Map<string, Cycle> }) {
  if (calls.length === 0) return <EmptyState title="暂无 LLM 调用" description="Mock 或真实模型调用都会进入 llm_calls 账本。" illustrated />;
  return (
    <div className="divide-y divide-card-border">
      {[...calls].reverse().slice(0, 80).map((call) => (
        <article key={call.id} className="grid gap-3 px-4 py-4 md:grid-cols-[10rem_1fr_auto]" data-testid={`row-llm-${call.id}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge meta={{ label: call.cycleId === "onboarding" ? "Onboarding" : `C${cycleIdx(call.cycleId, cycleById)}`, tone: "muted" }} />
            <StatusBadge meta={metaFor(actorLabels, call.agent)} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{call.promptVersion}</div>
            <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{call.inputSummary}</div>
            <div className="mt-2 line-clamp-2 text-xs leading-5">{call.outputSummary}</div>
          </div>
          <div className="space-y-1 text-right font-mono text-xs text-muted-foreground">
            <div>{call.tokenCount} tokens</div>
            <div>in {call.inputTokenCount} / out {call.outputTokenCount}</div>
            <div>${call.estimatedCost.toFixed(5)}</div>
            <div>{call.latencyMs}ms</div>
          </div>
        </article>
      ))}
    </div>
  );
}

function LedgerField({ label, value, mono = false, muted = false }: { label: string; value: string; mono?: boolean; muted?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-muted/20 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-1 break-words text-sm leading-5 ${mono ? "font-mono" : ""} ${muted ? "text-muted-foreground" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function cycleIdx(cycleId: string, cycleById: Map<string, Cycle>): number {
  return cycleById.get(cycleId)?.idx ?? 0;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function compactJson(value: string | null): string {
  if (!value) return "无快照";
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}
