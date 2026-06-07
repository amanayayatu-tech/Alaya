import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpenCheck, GitBranch, MessageSquare, ScrollText, ShieldAlert, Sparkles } from "lucide-react";
import { useProject } from "@/components/Layout";
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  MetricTile,
  PageShell,
  SectionCard,
  StatusBadge,
  toneClasses,
} from "@/components/AppPrimitives";
import { apiRequest } from "@/lib/queryClient";
import {
  AGENT_ORDER,
  errorToAccuracy,
  evidenceCount,
  fmtNum,
  fmtPct,
  type Cycle,
  type CycleReview,
} from "@/lib/alaya";
import {
  actorLabels,
  confidenceLabels,
  cycleStatusLabels,
  errorTypeLabels,
  gateTypeLabels,
  knowledgeStatusLabels,
  metaFor,
} from "@/lib/labels";

export default function Review() {
  const { projectId } = useProject();
  const [cycleId, setCycleId] = useState<string | null>(null);

  const { data: cycles = [] } = useQuery<Cycle[]>({
    queryKey: ["/api/projects", projectId, "cycles"],
    enabled: !!projectId,
  });

  const orderedCycles = useMemo(() => [...cycles].sort((a, b) => a.idx - b.idx), [cycles]);

  useEffect(() => {
    if (orderedCycles.length === 0) return;
    if (cycleId && orderedCycles.some((cycle) => cycle.id === cycleId)) return;
    const closed = orderedCycles.filter((cycle) => cycle.status === "closed");
    setCycleId((closed.at(-1) ?? orderedCycles.at(-1) ?? null)?.id ?? null);
  }, [orderedCycles, cycleId]);

  const {
    data: review,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<CycleReview>({
    queryKey: ["/api/cycles", cycleId, "review"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/cycles/${cycleId}/review`);
      return response.json();
    },
    enabled: !!cycleId,
  });

  if (!projectId) return <EmptyState title="先选择项目" description="周期评审需要读取该项目的 cycles 和 review 记录。" />;
  if (orderedCycles.length === 0) return <EmptyState title="还没有周期" description="项目创建后会自动生成第一轮候选周期。" illustrated />;

  return (
    <PageShell
      title="周期评审"
      eyebrow="Cycle Review"
      description="按单轮查看反馈、预测、Agent 运行、知识引用和人工决策，确认飞轮是否真的产生复利证据。"
      action={
        <select
          data-testid="select-cycle"
          value={cycleId ?? ""}
          onChange={(event) => setCycleId(event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          aria-label="选择周期"
        >
          {orderedCycles.map((cycle) => (
            <option key={cycle.id} value={cycle.id}>
              第 {cycle.idx} 轮 · {metaFor(cycleStatusLabels, cycle.status).label}
            </option>
          ))}
        </select>
      }
      className="pb-8"
      testId="page-review"
    >
      {isError ? (
        <ErrorState message={error instanceof Error ? error.message : "无法读取周期评审"} onRetry={() => refetch()} />
      ) : isLoading || !review ? (
        <LoadingBlock rows={7} />
      ) : (
        <ReviewContent review={review} />
      )}
    </PageShell>
  );
}

function ReviewContent({ review }: { review: CycleReview }) {
  const resolved = review.predictions.filter((prediction) => prediction.predictionError != null);
  const avgAccuracy = resolved.length
    ? resolved.reduce((sum, prediction) => sum + (errorToAccuracy(prediction.predictionError) ?? 0), 0) / resolved.length
    : null;
  const cycleStatus = metaFor(cycleStatusLabels, review.cycle.status);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricTile label="周期" value={`C${review.cycle.idx}`} sub={<StatusBadge meta={cycleStatus} />} icon={<GitBranch className="h-4 w-4" />} />
        <MetricTile label="反馈" value={review.feedback.length} sub={`${review.bugs.length} 个 bug 信号`} icon={<MessageSquare className="h-4 w-4" />} />
        <MetricTile label="预测" value={review.predictions.length} sub={`${resolved.length} 条已结算`} icon={<ScrollText className="h-4 w-4" />} />
        <MetricTile label="准确率" value={fmtPct(avgAccuracy)} sub={`E_cycle ${fmtNum(review.cycle.eCycle)}`} icon={<Sparkles className="h-4 w-4" />} />
        <MetricTile label="引用知识" value={review.referencedKnowledge.length} sub={`${review.knowledgeUpdated.length} 条本轮更新`} icon={<BookOpenCheck className="h-4 w-4" />} />
      </div>

      <SectionCard title={`第 ${review.cycle.idx} 轮目标`} description="该目标来自当前 cycle 记录，不做额外推断。">
        <div className="p-4">
          <p className="text-base font-medium leading-7" data-testid="text-cycle-goal">{review.cycle.goal}</p>
          {review.cycle.reasoning && <p className="mt-2 text-sm leading-6 text-muted-foreground">{review.cycle.reasoning}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <StatusBadge meta={cycleStatus} />
            <StatusBadge meta={{ label: `worst claim ${fmtNum(review.cycle.worstClaimError)}`, tone: review.cycle.worstClaimError && review.cycle.worstClaimError > 0.3 ? "warning" : "muted" }} />
          </div>
        </div>
      </SectionCard>

      <ActionLedgerTimeline review={review} />

      <SectionCard title="复利证据" description="本轮预测或 Agent 引用的既有知识，是飞轮复用历史经验的核心信号。">
        {review.referencedKnowledge.length === 0 ? (
          <EmptyState title="本轮未引用既有知识" description="早期周期可能只依赖 onboarding seed，后续闭环会逐步积累引用。" illustrated />
        ) : (
          <div className="grid gap-3 p-4 lg:grid-cols-2">
            {review.referencedKnowledge.map((item) => (
              <article key={item.id} className="rounded-lg border border-card-border bg-card p-4" data-testid={`referenced-knowledge-${item.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge meta={metaFor(knowledgeStatusLabels, item.status)} />
                  <StatusBadge meta={metaFor(confidenceLabels, item.confidenceLevel)} />
                  <StatusBadge meta={{ label: `C${item.createdByCycle}`, tone: "muted" }} />
                </div>
                <h2 className="mt-3 line-clamp-2 text-sm font-semibold leading-6">{item.title}</h2>
                <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{item.content}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <StatusBadge meta={{ label: `${evidenceCount(item)} 证据`, tone: "primary" }} />
                  <StatusBadge meta={{ label: `conf ${fmtNum(item.confidenceScore, 2)}`, tone: "muted" }} />
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <SectionCard title={`反馈输入 (${review.feedback.length})`} description="保留来源、类别、情绪、主题和外部链接。">
          {review.feedback.length === 0 ? (
            <EmptyState title="本轮暂无反馈" description="Sensor 没有导入新的外部信号。" />
          ) : (
            <div className="divide-y divide-card-border">
              {review.feedback.map((feedback) => (
                <article key={feedback.id} className="px-4 py-3" data-testid={`feedback-${feedback.id}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge meta={{ label: feedback.category, tone: feedback.category === "bug" ? "danger" : "primary" }} />
                    <StatusBadge meta={{ label: feedback.sentiment, tone: feedback.sentiment === "negative" ? "warning" : feedback.sentiment === "positive" ? "success" : "muted" }} />
                    <StatusBadge meta={{ label: feedback.sourceType, tone: "muted" }} />
                    {feedback.topicKey && <StatusBadge meta={{ label: `主题 ${feedback.topicKey}`, tone: "muted" }} />}
                  </div>
                  <p className="mt-2 text-sm leading-6">{feedback.text}</p>
                  {feedback.sourceUrl && (
                    <a href={feedback.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block break-all text-xs text-primary hover:underline">
                      {feedback.sourceUrl}
                    </a>
                  )}
                </article>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title={`预测与观察 (${review.predictions.length})`} description="每条预测都展示信念、预测、观察、误差类型和准确率。">
          {review.predictions.length === 0 ? (
            <EmptyState title="本轮暂无预测" description="Orchestrator 尚未为本轮生成预测。" />
          ) : (
            <div className="divide-y divide-card-border">
              {review.predictions.map((prediction) => {
                const accuracy = errorToAccuracy(prediction.predictionError);
                return (
                  <article key={prediction.id} className="px-4 py-3" data-testid={`review-prediction-${prediction.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      {prediction.errorType ? <StatusBadge meta={metaFor(errorTypeLabels, prediction.errorType)} /> : <StatusBadge meta={{ label: "未分类", tone: "muted" }} />}
                      <StatusBadge meta={{ label: `acc ${fmtPct(accuracy)}`, tone: accuracy != null && accuracy >= 0.7 ? "success" : "warning" }} />
                      {prediction.knowledgeRefs.map((ref) => <StatusBadge key={ref} meta={{ label: ref, tone: "primary" }} />)}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="text-muted-foreground">{prediction.belief}</span>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span>{prediction.prediction}</span>
                    </div>
                    {prediction.observation && <div className="mt-2 text-xs leading-5 text-muted-foreground">观察: {prediction.observation}</div>}
                  </article>
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title={`5-Agent 运行序列 (${review.agentRuns.length})`} description="按既有 Agent 顺序展示实际运行记录和知识引用。">
        {review.agentRuns.length === 0 ? (
          <EmptyState title="本轮暂无 Agent 运行记录" description="周期仍在规划或等待闸门处理。" illustrated />
        ) : (
          <div className="grid gap-3 p-4 lg:grid-cols-2">
            {[...review.agentRuns]
              .sort((a, b) => AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent))
              .map((run, index) => {
                const meta = metaFor(actorLabels, run.agent);
                return (
                  <article key={run.id} className={`rounded-lg border p-4 ${toneClasses(meta.tone)}`} data-testid={`agent-run-${run.agent}`}>
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-md border border-current/25 text-xs font-semibold">{index + 1}</span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">{meta.label}</div>
                        <div className="truncate text-xs opacity-80">{run.action}</div>
                      </div>
                    </div>
                    <p className="mt-3 text-sm leading-6 opacity-90">{run.outputSummary}</p>
                    {run.knowledgeRefsUsed.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {run.knowledgeRefsUsed.map((ref) => <StatusBadge key={ref} meta={{ label: ref, tone: "primary" }} />)}
                      </div>
                    )}
                  </article>
                );
              })}
          </div>
        )}
      </SectionCard>

      <div className="grid gap-5 xl:grid-cols-2">
        <SectionCard title={`人工决策 (${review.decisions.length})`} description="本轮 gate 处理写入的 decision-log 摘要。">
          {review.decisions.length === 0 ? (
            <EmptyState title="本轮没有人工决策" description="没有需要人类确认的方向、意义或风险闸。" />
          ) : (
            <div className="divide-y divide-card-border">
              {review.decisions.map((decision) => (
                <article key={decision.id} className="px-4 py-3" data-testid={`decision-${decision.id}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge meta={metaFor(gateTypeLabels, decision.gateType)} />
                    <StatusBadge meta={{ label: decision.decision, tone: decision.decision === "reject" ? "danger" : "success" }} />
                  </div>
                  {decision.rationale && <p className="mt-2 text-sm leading-6 text-muted-foreground">{decision.rationale}</p>}
                </article>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title={`本轮知识更新 (${review.knowledgeUpdated.length})`} description="由本轮创建或验证的知识条目。">
          {review.knowledgeUpdated.length === 0 ? (
            <EmptyState title="本轮暂无知识更新" description="Distiller 或 Librarian 尚未写入新知识。" />
          ) : (
            <div className="divide-y divide-card-border">
              {review.knowledgeUpdated.map((item) => (
                <article key={item.id} className="px-4 py-3" data-testid={`updated-knowledge-${item.id}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge meta={metaFor(knowledgeStatusLabels, item.status)} />
                    <StatusBadge meta={metaFor(confidenceLabels, item.confidenceLevel)} />
                    <span className="ml-auto font-mono text-xs text-muted-foreground">{fmtNum(item.confidenceScore, 2)}</span>
                  </div>
                  <div className="mt-2 truncate text-sm font-medium">{item.title}</div>
                </article>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function ActionLedgerTimeline({ review }: { review: CycleReview }) {
  const highRiskActions = review.actionLedger
    .filter((item) => item.requiresApproval === 1 || ["external_write", "destructive", "financial", "compliance_sensitive"].includes(item.riskLevel))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  return (
    <SectionCard title="本轮高风险动作时间线" description="展示经过 Gate 审批的动作、风险级别、回滚方案和审计摘要。">
      {highRiskActions.length === 0 ? (
        <EmptyState title="本轮没有高风险动作" description="action ledger 未记录需要审批的动作。" />
      ) : (
        <div className="divide-y divide-card-border">
          {highRiskActions.map((item) => (
            <article key={item.id} className="px-4 py-3" data-testid={`action-ledger-${item.id}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <ShieldAlert className="h-4 w-4 text-warning" />
                <StatusBadge meta={{ label: item.riskLevel, tone: item.requiresApproval === 1 ? "warning" : "muted" }} />
                <StatusBadge meta={{ label: item.status, tone: item.status === "blocked" ? "danger" : item.status === "approved" ? "success" : "muted" }} />
                {item.approvalGateId && <StatusBadge meta={{ label: item.approvalGateId, tone: "primary" }} />}
                <span className="ml-auto font-mono text-xs text-muted-foreground">{formatTime(item.createdAt)}</span>
              </div>
              <div className="mt-2 text-sm font-medium">{item.actionType}</div>
              {item.target && <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">{item.target}</div>}
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <ActionLedgerDetail label="rollback_plan" value={item.rollbackPlan} />
                <ActionLedgerDetail label="audit_summary" value={item.auditSummary} />
              </div>
            </article>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function ActionLedgerDetail({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-md border border-card-border bg-muted/20 p-3">
      <div className="font-mono text-[11px] uppercase text-muted-foreground">{label}</div>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">{compactValue(value)}</p>
    </div>
  );
}

function compactValue(value: unknown): string {
  if (value == null || value === "") return "none";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
