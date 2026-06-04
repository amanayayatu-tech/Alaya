import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle, ArrowUpRight, Brain, CheckCircle2, CircleDollarSign,
  GitBranch, LoaderCircle, Play, ShieldCheck, Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProject } from "@/components/Layout";
import {
  BudgetRing,
  EmptyState,
  ErrorState,
  FlywheelStageMap,
  InlineNotice,
  LoadingBlock,
  MetricTile,
  PageShell,
  SectionCard,
  StatusBadge,
} from "@/components/AppPrimitives";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  CONFIDENCE_TONE,
  STATUS_TONE,
  fmtNum,
  type Dashboard as DashboardData,
} from "@/lib/alaya";
import {
  cycleStatusLabels,
  flywheelStageLabels,
  knowledgeStatusLabels,
  metaFor,
  schedulerActionLabels,
  schedulerResultText,
} from "@/lib/labels";

type SchedulerResult = {
  action?: string;
  note?: string;
  nextCycleId?: string;
  cycleId?: string;
};

export default function Dashboard() {
  const { projectId } = useProject();
  const { toast } = useToast();
  const [advancing, setAdvancing] = useState(false);
  const [lastResult, setLastResult] = useState<SchedulerResult | null>(null);
  const { data, isLoading, isError, error, refetch } = useQuery<DashboardData>({
    queryKey: ["/api/projects", projectId, "dashboard"],
    enabled: !!projectId,
  });

  async function advanceCycle() {
    if (!projectId || advancing) return;
    setAdvancing(true);
    try {
      const response = await apiRequest("POST", `/api/projects/${projectId}/scheduler/tick`, { syncFeedback: false });
      const result = await response.json() as SchedulerResult;
      setLastResult(result);
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/human-gates"] });
      toast({ title: "飞轮已请求推进", description: schedulerResultText(result.action, result.note) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: "推进失败", description: message });
    } finally {
      setAdvancing(false);
    }
  }

  if (!projectId) {
    return (
      <EmptyState
        illustrated
        title="先创建一个项目"
        description="Alaya 会围绕项目目标持续记录预测、反馈、知识和人类决策。"
        action={<Link href="/projects/new" className="text-sm font-medium text-primary">创建项目</Link>}
      />
    );
  }
  if (isLoading) return <LoadingBlock rows={6} />;
  if (isError || !data) {
    return <ErrorState message={error instanceof Error ? error.message : "无法读取项目总览"} onRetry={() => refetch()} />;
  }

  const stageMeta = metaFor(flywheelStageLabels, data.flywheelStage, "等待");
  const cycleStatus = metaFor(cycleStatusLabels, data.currentCycle?.status, "未知");
  const b = data.gateBudget;
  const llm = data.llmBudget;
  const lastMeta = metaFor(schedulerActionLabels, lastResult?.action, "尚未推进");
  const hasBlocking = data.blockingRisks > 0 || b.safetyMode || (llm.overBudget && llm.pendingBudgetGate);

  return (
    <PageShell
      title={data.project.name}
      eyebrow="飞轮总览"
      description={
        <>
          {stageMeta.label}。当前第 {data.currentCycle?.idx ?? "—"} 轮，
          累计 {data.cycleCount} 轮；系统只在方向、意义和风险卡点请求人类介入。
        </>
      }
      action={
        <Button
          data-testid="button-advance-cycle"
          onClick={advanceCycle}
          disabled={advancing}
          className="gap-2"
        >
          {advancing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          推进飞轮一轮
        </Button>
      }
      className="pb-8"
      testId="page-dashboard"
    >
      {hasBlocking && (
        <InlineNotice tone="danger">
          {b.safetyMode
            ? `安全模式已触发：待处理阻塞闸门 ${b.pendingBlocking} 条，系统暂停新立项。`
            : llm.overBudget && llm.pendingBudgetGate
              ? `LLM 本周预算已超出：$${llm.usedUsd.toFixed(4)} / $${llm.budgetUsd.toFixed(2)}。`
              : `当前有 ${data.blockingRisks} 个阻塞风险，需要先处理人类闸门。`}
        </InlineNotice>
      )}

      {lastResult && (
        <InlineNotice tone={lastMeta.tone ?? "primary"}>
          <span data-testid="text-last-scheduler-action">{schedulerResultText(lastResult.action, lastResult.note)}</span>
        </InlineNotice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricTile label="当前周期" value={`C${data.currentCycle?.idx ?? "—"}`} sub={<StatusBadge meta={cycleStatus} />} icon={<GitBranch className="h-4 w-4" />} />
        <MetricTile label="累计周期" value={data.cycleCount} sub="已进入飞轮账本" icon={<Timer className="h-4 w-4" />} />
        <MetricTile label="待审批" value={data.pendingHuman} tone={data.pendingHuman > 0 ? "warning" : "default"} sub="人类闸门" icon={<ShieldCheck className="h-4 w-4" />} />
        <MetricTile label="阻塞风险" value={data.blockingRisks} tone={data.blockingRisks > 0 ? "danger" : "default"} sub="必须先处理" icon={<AlertTriangle className="h-4 w-4" />} />
        <MetricTile label="开放预测" value={data.openPredictions} sub="等待观察闭环" icon={<CheckCircle2 className="h-4 w-4" />} />
        <MetricTile label="知识 / strong" value={`${data.knowledgeCount}/${data.strongCount}`} sub="可复用信念" icon={<Brain className="h-4 w-4" />} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_0.8fr]">
        <SectionCard
          title="飞轮正在做什么"
          description="高亮的是最近一次 Agent 运行阶段；每一轮都会留下预测、观察、知识和审计记录。"
        >
          <div className="space-y-4 p-4">
            <FlywheelStageMap stage={data.flywheelStage} />
            <div className="rounded-lg border border-border bg-muted/25 p-4">
              <div className="text-xs text-muted-foreground">本轮目标</div>
              <div className="mt-1 text-sm font-medium leading-6" data-testid="text-current-goal">
                {data.currentCycle?.goal || "等待 Orchestrator 生成方向"}
              </div>
              {data.currentCycle?.eCycle != null && (
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <span>预测误差 <span className="font-mono text-foreground">{fmtNum(data.currentCycle.eCycle)}</span></span>
                  <span>最差 claim <span className="font-mono text-foreground">{fmtNum(data.currentCycle.worstClaimError)}</span></span>
                </div>
              )}
            </div>
          </div>
        </SectionCard>

        <SectionCard title="预算约束" description="Alaya 只在预算允许时自动推进；超限会打开风险闸。">
          <div className="space-y-5 p-4">
            <BudgetRing label="人类闸门预算" value={b.used} total={b.budget} suffix="分钟/周" tone={b.used > b.budget ? "danger" : b.used > b.budget * 0.8 ? "warning" : "primary"} />
            <BudgetRing
              label="LLM 成本预算"
              value={Number(llm.usedCents.toFixed(0))}
              total={Math.max(1, llm.budgetCents)}
              suffix="cents/周"
              tone={llm.overBudget ? "danger" : "success"}
            />
            <div className="rounded-md border border-border bg-muted/25 px-3 py-2 text-xs leading-5 text-muted-foreground">
              待处理: blocking {b.pendingBlocking}，非阻塞 {b.pendingNonBlocking}；本周剩余人工 {b.remaining} 分钟。
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="最近沉淀的知识"
        description="这些信念会影响下一轮方向；过期、隔离、冲突或被合并的知识不会默认进入高风险证据集。"
        action={
          <Link href="/knowledge" className="inline-flex items-center gap-1 text-sm font-medium text-primary" data-testid="link-view-knowledge">
            查看知识库 <ArrowUpRight className="h-4 w-4" />
          </Link>
        }
      >
        {data.recentKnowledge.length === 0 ? (
          <EmptyState title="还没有知识" description="飞轮闭环后，Distiller 和 Librarian 会在这里留下可审计的知识。" illustrated />
        ) : (
          <div className="divide-y divide-card-border">
            {data.recentKnowledge.map((k) => {
              const status = metaFor(knowledgeStatusLabels, k.status);
              return (
                <div key={k.id} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_auto]" data-testid={`row-knowledge-${k.id}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge meta={status} />
                      <span className="text-[11px] text-muted-foreground">C{k.createdByCycle}</span>
                    </div>
                    <div className="mt-1 truncate text-sm font-medium">{k.title}</div>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className={`font-mono tabular-nums ${CONFIDENCE_TONE[k.confidenceLevel] ?? ""}`}>{fmtNum(k.confidenceScore, 2)}</span>
                    <span className={`rounded-md border px-2 py-0.5 text-[11px] ${STATUS_TONE[k.status] ?? "border-border text-muted-foreground"}`}>{k.confidenceLevel}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard title="项目边界" description="红线是自动化不能跨过的物理边界。">
        <div className="grid gap-3 p-4 md:grid-cols-[1fr_1fr]">
          <div>
            <div className="text-xs text-muted-foreground">目标用户</div>
            <div className="mt-1 text-sm">{data.project.targetUser}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">红线</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {data.project.redlines.length === 0 ? (
                <span className="text-sm text-muted-foreground">未设置</span>
              ) : data.project.redlines.map((line) => (
                <StatusBadge key={line} meta={{ label: line, tone: "danger" }} />
              ))}
            </div>
          </div>
        </div>
      </SectionCard>
    </PageShell>
  );
}
