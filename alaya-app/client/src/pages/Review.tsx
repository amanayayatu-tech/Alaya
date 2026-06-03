import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, MessageSquare, Lightbulb } from "lucide-react";
import { useProject } from "@/components/Layout";
import { PageHeader, Panel, PanelHeader, Stat, Tag, Empty, SkeletonRows } from "@/components/bits";
import { apiRequest } from "@/lib/queryClient";
import {
  AGENT_ORDER, AGENT_LABEL, STATUS_TONE, fmtNum, fmtPct, errorToAccuracy,
  type Cycle, type CycleReview,
} from "@/lib/alaya";

export default function Review() {
  const { projectId } = useProject();
  const [cycleId, setCycleId] = useState<string | null>(null);

  const { data: cycles = [] } = useQuery<Cycle[]>({
    queryKey: ["/api/projects", projectId, "cycles"],
    enabled: !!projectId,
  });

  useEffect(() => {
    if (cycles.length > 0 && (!cycleId || !cycles.some((c) => c.id === cycleId))) {
      const closed = cycles.filter((c) => c.status === "closed");
      const pick = closed.length ? closed[closed.length - 1] : cycles[cycles.length - 1];
      setCycleId(pick.id);
    }
  }, [cycles, cycleId]);

  const { data: review, isLoading } = useQuery<CycleReview>({
    queryKey: ["/api/cycles", cycleId, "review"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/cycles/${cycleId}/review`);
      return r.json();
    },
    enabled: !!cycleId,
  });

  if (!projectId) return <Empty>选择一个项目</Empty>;

  const ordered = [...cycles].sort((a, b) => a.idx - b.idx);

  return (
    <div data-testid="page-review">
      <PageHeader
        title="Cycle Review"
        sub="单轮复盘:反馈 → 预测/观察 → 5-Agent 运行 → 决策 → 知识更新与引用(复利证据)"
        right={
          <select
            data-testid="select-cycle"
            value={cycleId ?? ""}
            onChange={(e) => setCycleId(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground font-mono"
          >
            {ordered.map((c) => (
              <option key={c.id} value={c.id}>
                第 {c.idx} 轮 · {c.status}
              </option>
            ))}
          </select>
        }
      />

      {isLoading || !review ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="space-y-5">
          {/* goal + metrics */}
          <Panel>
            <PanelHeader>
              第 {review.cycle.idx} 轮目标 · cycle goal
            </PanelHeader>
            <div className="p-4">
              <p className="text-sm font-medium leading-relaxed" data-testid="text-cycle-goal">{review.cycle.goal}</p>
              {review.cycle.reasoning && (
                <p className="mt-1.5 text-xs text-muted-foreground">{review.cycle.reasoning}</p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="status" value={review.cycle.status} mono />
                <Stat label="E_cycle" value={fmtNum(review.cycle.eCycle)} />
                <Stat label="worst claim" value={fmtNum(review.cycle.worstClaimError)} />
                <Stat label="预测数" value={review.predictions.length} />
              </div>
            </div>
          </Panel>

          {/* compounding: referenced knowledge */}
          <Panel className={review.referencedKnowledge.length > 0 ? "ring-1 ring-primary/30" : ""}>
            <PanelHeader right={<Lightbulb className="h-3.5 w-3.5 text-primary" />}>
              本轮引用的既有知识 · 复利证据 (referenced knowledge)
            </PanelHeader>
            {review.referencedKnowledge.length === 0 ? (
              <Empty>本轮未引用既有知识</Empty>
            ) : (
              <div className="divide-y divide-card-border">
                {review.referencedKnowledge.map((k) => (
                  <div key={k.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-testid={`referenced-knowledge-${k.id}`}>
                    <span className="font-mono text-[11px] text-primary">{k.id}</span>
                    <Tag className={STATUS_TONE[k.status] ?? "border-border"}>{k.status}</Tag>
                    <span className="text-sm">{k.title}</span>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                      创建于 C{k.createdByCycle} · conf {fmtNum(k.confidenceScore, 2)}
                    </span>
                  </div>
                ))}
                <div className="px-4 py-2 text-[11px] font-mono text-muted-foreground">
                  ↑ 这些知识来自更早的轮次,被本轮规划/预测复用 — 体现飞轮复利
                </div>
              </div>
            )}
          </Panel>

          {/* feedback */}
          <Panel>
            <PanelHeader right={<MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}>
              反馈输入 · feedback ({review.feedback.length})
            </PanelHeader>
            {review.feedback.length === 0 ? (
              <Empty>无反馈</Empty>
            ) : (
              <div className="divide-y divide-card-border">
                {review.feedback.map((f) => (
                  <div key={f.id} className="flex items-start gap-2 px-4 py-2.5 text-sm" data-testid={`feedback-${f.id}`}>
                    <Tag className={
                      f.sentiment === "positive" ? "border-chart-5/30 bg-chart-5/10 text-chart-5"
                      : f.sentiment === "negative" ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : "border-border bg-muted text-muted-foreground"
                    }>{f.category}</Tag>
                    <span className="min-w-0 break-words">{f.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* predictions */}
          <Panel>
            <PanelHeader>预测与观察 · prediction ledger</PanelHeader>
            {review.predictions.length === 0 ? (
              <Empty>无预测</Empty>
            ) : (
              <div className="divide-y divide-card-border">
                {review.predictions.map((p) => {
                  const acc = errorToAccuracy(p.predictionError);
                  return (
                    <div key={p.id} className="p-4" data-testid={`review-prediction-${p.id}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] text-muted-foreground">{p.id}</span>
                        {p.errorType ? (
                          <Tag className="border-chart-3/30 bg-chart-3/10 text-chart-3">{p.errorType} error</Tag>
                        ) : (
                          <Tag className="border-chart-5/30 bg-chart-5/10 text-chart-5">命中</Tag>
                        )}
                        {p.knowledgeRefs.map((r) => (
                          <Tag key={r} className="border-primary/30 bg-primary/10 text-primary">{r}</Tag>
                        ))}
                        <span className="ml-auto font-mono text-xs tabular-nums">
                          acc <span className={acc != null && acc >= 0.7 ? "text-primary" : "text-chart-4"}>{fmtPct(acc)}</span>
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="text-muted-foreground">{p.belief}</span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span>{p.prediction}</span>
                      </div>
                      {p.observation && (
                        <div className="mt-1 font-mono text-xs text-muted-foreground">obs: {p.observation}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          {/* agent runs */}
          <Panel>
            <PanelHeader>5-Agent 运行序列 · agent runs ({review.agentRuns.length})</PanelHeader>
            <div className="divide-y divide-card-border">
              {[...review.agentRuns]
                .sort((a, b) => AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent))
                .map((r, i) => (
                <div key={r.id} className="flex items-start gap-3 px-4 py-2.5" data-testid={`agent-run-${r.agent}`}>
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[10px] text-primary">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{AGENT_LABEL[r.agent] ?? r.agent}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{r.action}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{r.outputSummary}</div>
                    {r.knowledgeRefsUsed.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.knowledgeRefsUsed.map((k) => (
                          <Tag key={k} className="border-primary/30 bg-primary/10 text-primary">{k}</Tag>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {/* decisions + knowledge updated */}
          <div className="grid gap-5 md:grid-cols-2">
            <Panel>
              <PanelHeader>人工决策 · decisions</PanelHeader>
              {review.decisions.length === 0 ? (
                <Empty>无决策记录</Empty>
              ) : (
                <div className="divide-y divide-card-border">
                  {review.decisions.map((d) => (
                    <div key={d.id} className="px-4 py-2.5 text-sm" data-testid={`decision-${d.id}`}>
                      <div className="flex items-center gap-2">
                        <Tag className="border-border bg-muted text-muted-foreground">{d.gateType}</Tag>
                        <span className="font-mono text-xs text-primary">{d.decision}</span>
                      </div>
                      {d.rationale && <div className="mt-1 text-xs text-muted-foreground">{d.rationale}</div>}
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel>
              <PanelHeader>本轮知识更新 · knowledge updated</PanelHeader>
              {review.knowledgeUpdated.length === 0 ? (
                <Empty>无更新</Empty>
              ) : (
                <div className="divide-y divide-card-border">
                  {review.knowledgeUpdated.map((k) => (
                    <div key={k.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-testid={`updated-knowledge-${k.id}`}>
                      <span className="font-mono text-[11px] text-muted-foreground">{k.id}</span>
                      <Tag className={STATUS_TONE[k.status] ?? "border-border"}>{k.status}</Tag>
                      <span className="min-w-0 truncate text-sm">{k.title}</span>
                      <span className="ml-auto font-mono text-[11px] text-muted-foreground">{fmtNum(k.confidenceScore, 2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {review.bugs.length > 0 && (
            <Panel>
              <PanelHeader>Bug 记录</PanelHeader>
              <div className="divide-y divide-card-border">
                {review.bugs.map((b) => (
                  <div key={b.id} className="px-4 py-2.5 text-sm" data-testid={`bug-${b.id}`}>{b.text}</div>
                ))}
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
