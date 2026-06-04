import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, ArrowUpRight, CircleDollarSign, Gauge, LoaderCircle, Play } from "lucide-react";
import { useProject } from "@/components/Layout";
import { PageHeader, Panel, PanelHeader, Stat, Tag, Empty, SkeletonRows } from "@/components/bits";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  AGENT_ORDER, AGENT_LABEL, STATUS_TONE, CONFIDENCE_TONE, fmtNum,
  type Dashboard as DashboardData,
} from "@/lib/alaya";

export default function Dashboard() {
  const { projectId } = useProject();
  const { toast } = useToast();
  const [advancing, setAdvancing] = useState(false);
  const [lastSchedulerAction, setLastSchedulerAction] = useState<string | null>(null);
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/projects", projectId, "dashboard"],
    enabled: !!projectId,
  });

  async function advanceCycle() {
    if (!projectId || advancing) return;
    setAdvancing(true);
    try {
      const response = await apiRequest("POST", `/api/projects/${projectId}/scheduler/tick`, { syncFeedback: false });
      const result = await response.json();
      setLastSchedulerAction(result.action ?? "unknown");
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/human-gates", projectId] });
      toast({ title: "Cycle 已推进", description: result.note ?? result.action });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({ title: "Cycle 推进失败", description: message });
    } finally {
      setAdvancing(false);
    }
  }

  if (!projectId) return <Empty>选择或创建一个项目</Empty>;
  if (isLoading || !data) return <SkeletonRows rows={6} />;

  const b = data.gateBudget;
  const usedPct = Math.min(100, Math.round((b.used / b.budget) * 100));
  const llm = data.llmBudget;
  const llmPct = Math.min(100, Math.round((llm.usedUsd / Math.max(llm.budgetUsd, 0.01)) * 100));
  const stage = data.flywheelStage;

  return (
    <div data-testid="page-dashboard">
      <PageHeader
        title="Dashboard"
        sub={`${data.project.name} · ${data.cycleCount} 轮飞轮 · 当前 cycle #${data.currentCycle?.idx ?? "—"} (${data.currentCycle?.status ?? "—"})`}
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {lastSchedulerAction && (
              <span data-testid="text-last-scheduler-action" className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-mono text-muted-foreground">
                {lastSchedulerAction}
              </span>
            )}
            <button
              data-testid="button-advance-cycle"
              onClick={advanceCycle}
              disabled={advancing}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover-elevate active-elevate-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {advancing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              推进
            </button>
          </div>
        }
      />

      {b.safetyMode && (
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-testid="banner-safety-mode">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span><span className="font-semibold">安全模式已触发</span> · 待处理 blocking 闸门 {b.pendingBlocking} 条 (&gt;3),已冻结新立项。</span>
        </div>
      )}

      {llm.overBudget && llm.pendingBudgetGate && (
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-testid="banner-llm-budget">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span><span className="font-semibold">LLM 成本预算已触发</span> · 本周 ${llm.usedUsd.toFixed(4)} / ${llm.budgetUsd.toFixed(2)}，已暂停自动推进。</span>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="待人工闸门" value={data.pendingHuman} tone={data.pendingHuman > 0 ? "text-chart-4" : ""} sub="pending human gates" />
        <Stat label="开放预测" value={data.openPredictions} sub="open predictions" />
        <Stat label="阻塞风险" value={data.blockingRisks} tone={data.blockingRisks > 0 ? "text-destructive" : ""} sub="blocking risks" />
        <Stat label="知识 / strong" value={`${data.knowledgeCount} / ${data.strongCount}`} sub="knowledge items" />
      </div>

      {/* flywheel + budget */}
      <div className="mt-5 grid gap-4 lg:grid-cols-4">
        <Panel className="lg:col-span-2">
          <PanelHeader>飞轮阶段 · flywheel stage</PanelHeader>
          <div className="flex flex-wrap items-center gap-1.5 p-4">
            {AGENT_ORDER.map((a, i) => {
              const active = a === stage;
              return (
                <div key={a} className="flex items-center gap-1.5">
                  <span
                    data-testid={`stage-${a}`}
                    className={`rounded-md border px-2.5 py-1.5 text-xs font-mono ${
                      active
                        ? "border-primary/50 bg-primary/15 text-primary"
                        : "border-border bg-card text-muted-foreground"
                    }`}
                  >
                    {AGENT_LABEL[a]}
                  </span>
                  {i < AGENT_ORDER.length - 1 && <span className="text-muted-foreground">→</span>}
                </div>
              );
            })}
          </div>
          <div className="border-t border-card-border px-4 py-3 text-sm">
            <div className="text-muted-foreground text-xs font-mono mb-1">current goal</div>
            <div data-testid="text-current-goal">{data.currentCycle?.goal || "—"}</div>
            {data.currentCycle?.eCycle != null && (
              <div className="mt-2 flex gap-4 text-xs font-mono">
                <span className="text-muted-foreground">E_cycle <span className="text-foreground">{fmtNum(data.currentCycle.eCycle)}</span></span>
                <span className="text-muted-foreground">worst <span className="text-foreground">{fmtNum(data.currentCycle.worstClaimError)}</span></span>
              </div>
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader right={<Gauge className="h-3.5 w-3.5 text-muted-foreground" />}>
            人工预算 · gate budget
          </PanelHeader>
          <div className="p-4">
            <div className="flex items-baseline justify-between font-mono">
              <span className="text-2xl font-semibold tabular-nums" data-testid="text-budget-used">{b.used}</span>
              <span className="text-sm text-muted-foreground">/ {b.budget} min/周</span>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${usedPct > 80 ? "bg-chart-4" : "bg-primary"}`}
                style={{ width: `${usedPct}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between text-[11px] font-mono text-muted-foreground">
              <span>已用 {usedPct}%</span>
              <span>剩余 {b.remaining} min</span>
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              意义闸按主题合并 · 低风险候选批量展示以降噪。
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader right={<CircleDollarSign className="h-3.5 w-3.5 text-muted-foreground" />}>
            LLM 预算 · cost budget
          </PanelHeader>
          <div className="p-4">
            <div className="flex items-baseline justify-between font-mono">
              <span className={`text-2xl font-semibold tabular-nums ${llm.overBudget ? "text-destructive" : ""}`} data-testid="text-llm-budget-used">
                ${llm.usedUsd.toFixed(4)}
              </span>
              <span className="text-sm text-muted-foreground">/ ${llm.budgetUsd.toFixed(2)}/周</span>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${llm.overBudget || llmPct > 80 ? "bg-destructive" : "bg-chart-2"}`}
                style={{ width: `${llmPct}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between text-[11px] font-mono text-muted-foreground">
              <span>已用 {llmPct}%</span>
              <span>剩余 ${(llm.remainingCents / 100).toFixed(2)}</span>
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              超预算会进入 blocking risk gate，同周确认后不重复开闸。
            </div>
          </div>
        </Panel>
      </div>

      {/* recent knowledge */}
      <Panel className="mt-5">
        <PanelHeader right={<Link href="/knowledge" className="text-xs font-mono text-primary hover-elevate rounded px-1.5 py-0.5 inline-flex items-center gap-1" data-testid="link-view-knowledge">查看全部 <ArrowUpRight className="h-3 w-3" /></Link>}>
          最近知识更新 · recent knowledge
        </PanelHeader>
        {data.recentKnowledge.length === 0 ? (
          <Empty>暂无知识</Empty>
        ) : (
          <ul className="divide-y divide-card-border">
            {data.recentKnowledge.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-4 py-3" data-testid={`row-knowledge-${k.id}`}>
                <span className="font-mono text-[11px] text-muted-foreground w-28 shrink-0 truncate" title={k.id}>{k.id}</span>
                <span className="flex-1 truncate text-sm">{k.title}</span>
                <span className={`font-mono text-xs tabular-nums ${CONFIDENCE_TONE[k.confidenceLevel] ?? ""}`}>{fmtNum(k.confidenceScore, 2)}</span>
                <Tag className={STATUS_TONE[k.status] ?? "border-border text-muted-foreground"}>{k.status}</Tag>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
