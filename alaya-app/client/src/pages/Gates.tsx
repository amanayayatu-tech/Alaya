import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ClipboardCheck, Compass, HeartHandshake, Pencil, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProject } from "@/components/Layout";
import {
  BudgetRing,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingBlock,
  PageShell,
  SectionCard,
  StatusBadge,
  toneClasses,
} from "@/components/AppPrimitives";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { HumanGate } from "@/lib/alaya";
import { gateStatusLabels, gateTypeLabels, metaFor, type Tone } from "@/lib/labels";

type GateBudget = {
  budget: number;
  used: number;
  remaining: number;
  pendingEstimatedMinutes: number;
  pendingOverBudget2x: boolean;
  weeklyOverFiveHours: boolean;
  pendingBlocking: number;
  pendingNonBlocking: number;
  oldestBlockingAgeDays: number;
  safetyMode: boolean;
};

type GateAction = "approve" | "reject" | "modify";

const actionText: Record<GateAction, string> = {
  approve: "批准",
  reject: "驳回",
  modify: "修改",
};

const iconForGate: Record<string, typeof Compass> = {
  direction: Compass,
  meaning: HeartHandshake,
  risk: ShieldAlert,
};

export default function Gates() {
  const { projectId } = useProject();
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>("pending");
  const [dialog, setDialog] = useState<{ gate: HumanGate; action: GateAction } | null>(null);
  const [rationale, setRationale] = useState("");
  const [acting, setActing] = useState(false);

  const {
    data: gates = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<HumanGate[]>({
    queryKey: ["/api/human-gates", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/human-gates?projectId=${projectId}`);
      return res.json();
    },
  });

  const { data: budget } = useQuery<GateBudget>({
    queryKey: ["/api/projects", projectId, "gate-budget"],
    enabled: !!projectId,
  });

  const ordered = useMemo(() => {
    return [...gates].sort((a, b) => {
      const aBlock = a.status === "pending" && a.blocking === 1 ? 0 : 1;
      const bBlock = b.status === "pending" && b.blocking === 1 ? 0 : 1;
      if (aBlock !== bBlock) return aBlock - bBlock;
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (a.status !== "pending" && b.status === "pending") return 1;
      return a.id.localeCompare(b.id);
    });
  }, [gates]);

  const filtered = ordered.filter((gate) => {
    if (filter === "all") return true;
    if (filter === "pending") return gate.status === "pending";
    if (filter === "blocking") return gate.status === "pending" && gate.blocking === 1;
    if (filter === "resolved") return gate.status !== "pending";
    return gate.type === filter;
  });

  async function confirmAction() {
    if (!dialog) return;
    setActing(true);
    try {
      await apiRequest("POST", `/api/human-gates/${dialog.gate.id}/${dialog.action}`, {
        rationale: rationale.trim() || `${actionText[dialog.action]}: ${dialog.gate.title}`,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/human-gates"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "gate-budget"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
      toast({ title: `闸门已${actionText[dialog.action]}`, description: dialog.gate.title });
      setDialog(null);
      setRationale("");
    } catch (err) {
      toast({ title: "闸门处理失败", description: err instanceof Error ? err.message : String(err) });
    } finally {
      setActing(false);
    }
  }

  if (!projectId) return <EmptyState title="先选择项目" description="闸门只存在于具体项目的飞轮周期里。" />;
  if (isLoading) return <LoadingBlock rows={6} />;
  if (isError) return <ErrorState message={error instanceof Error ? error.message : "无法读取闸门"} onRetry={() => refetch()} />;

  const pendingCount = gates.filter((gate) => gate.status === "pending").length;
  const blockingCount = gates.filter((gate) => gate.status === "pending" && gate.blocking === 1).length;

  return (
    <PageShell
      title="人类闸门"
      eyebrow="Human Gates"
      description="这里是 Alaya 让人类介入的地方：决定方向、判断信号意义、拦截风险。风险闸和 blocking 闸门会暂停自动推进。"
      action={<StatusBadge meta={{ label: `${pendingCount} 个待处理`, tone: pendingCount > 0 ? "warning" : "success" }} />}
      className="pb-8"
      testId="page-gates"
    >
      {budget && budget.safetyMode && (
        <InlineNotice tone="danger">
          安全模式已触发：阻塞闸门 {budget.pendingBlocking} 个，最久已等待 {budget.oldestBlockingAgeDays.toFixed(1)} 天。
        </InlineNotice>
      )}

      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.2fr]">
        <SectionCard title="闸门预算" description="本周已消耗的人类注意力，以及待处理闸门预计还会消耗多少时间。">
          {budget ? (
            <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <BudgetRing
                label="本周人工时间"
                value={budget.used}
                total={budget.budget}
                suffix="分钟"
                tone={budget.weeklyOverFiveHours || budget.used > budget.budget ? "danger" : budget.used > budget.budget * 0.8 ? "warning" : "primary"}
              />
              <div className="space-y-2 text-sm">
                <SummaryLine label="阻塞待处理" value={`${budget.pendingBlocking} 个`} tone={budget.pendingBlocking > 0 ? "danger" : "success"} />
                <SummaryLine label="非阻塞待处理" value={`${budget.pendingNonBlocking} 个`} tone={budget.pendingNonBlocking > 0 ? "warning" : "muted"} />
                <SummaryLine label="待处理预计" value={`${budget.pendingEstimatedMinutes} 分钟`} tone={budget.pendingOverBudget2x ? "danger" : "muted"} />
                <SummaryLine label="剩余预算" value={`${budget.remaining} 分钟`} tone={budget.remaining <= 0 ? "danger" : "success"} />
              </div>
            </div>
          ) : (
            <LoadingBlock rows={2} />
          )}
        </SectionCard>

        <SectionCard title="筛选" description="默认只看待处理闸门；阻塞型会始终排在前面。">
          <div className="flex flex-wrap gap-2 p-4">
            {[
              ["all", "全部"],
              ["pending", "待处理"],
              ["blocking", "必须先处理"],
              ["direction", "方向决策"],
              ["meaning", "意义确认"],
              ["risk", "风险拦截"],
              ["resolved", "已处理"],
            ].map(([key, label]) => (
              <Button
                key={key}
                type="button"
                variant={filter === key ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(key)}
                data-testid={`filter-${key}`}
              >
                {label}
              </Button>
            ))}
          </div>
        </SectionCard>
      </div>

      {blockingCount > 0 && (
        <InlineNotice tone="danger">
          当前有 {blockingCount} 个阻塞闸门。处理前，调度器会停止创建新的高风险动作或新周期。
        </InlineNotice>
      )}

      <SectionCard title="闸门列表" description="每张卡片只展示做决定需要的信息，更多 payload 细节收在摘要中。">
        {filtered.length === 0 ? (
          <EmptyState title="没有符合条件的闸门" description="如果飞轮正在等待反馈窗口，下一次调度后可能会产生新的方向或意义闸。" illustrated />
        ) : (
          <div className="divide-y divide-card-border">
            {filtered.map((gate) => (
              <GateCard
                key={gate.id}
                gate={gate}
                onAction={(action) => {
                  setDialog({ gate, action });
                  setRationale("");
                }}
              />
            ))}
          </div>
        )}
      </SectionCard>

      <Dialog open={!!dialog} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog ? `${actionText[dialog.action]}闸门` : "处理闸门"}</DialogTitle>
            <DialogDescription>
              {dialog?.gate.title}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="gate-rationale">备注或理由</label>
            <Textarea
              id="gate-rationale"
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="写下为什么批准、驳回或修改。这个备注会进入决策账本。"
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>取消</Button>
            <Button type="button" onClick={confirmAction} disabled={acting} className="gap-2" data-testid="button-confirm-gate-action">
              {acting ? <ClipboardCheck className="h-4 w-4 animate-pulse" /> : null}
              确认{dialog ? actionText[dialog.action] : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function SummaryLine({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/25 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <StatusBadge meta={{ label: value, tone }} />
    </div>
  );
}

function GateCard({ gate, onAction }: { gate: HumanGate; onAction: (action: GateAction) => void }) {
  const type = metaFor(gateTypeLabels, gate.type);
  const status = metaFor(gateStatusLabels, gate.status);
  const Icon = iconForGate[gate.type] ?? Compass;
  const payload = gate.payload ?? {};
  const summary = humanSummary(gate);
  const isPending = gate.status === "pending";

  return (
    <article className="grid gap-3 px-4 py-4 md:grid-cols-[2.2rem_1fr_auto]" data-testid={`gate-${gate.id}`}>
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg border ${toneClasses(type.tone)}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge meta={type} />
          <StatusBadge meta={status} />
          {gate.blocking === 1 && <StatusBadge meta={{ label: "必须先处理", tone: "danger" }} />}
          <span className="text-xs text-muted-foreground">预计 {gate.estimatedMinutes} 分钟</span>
        </div>
        <h2 className="mt-2 text-base font-semibold leading-snug">{gate.title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{summary}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatusBadge meta={{ label: `cycle ${gate.cycleId}`, tone: "muted" }} />
          {payload.topicKey && <StatusBadge meta={{ label: `主题 ${payload.topicKey}`, tone: "muted" }} />}
          {payload.source && <StatusBadge meta={{ label: String(payload.source), tone: "primary" }} />}
          {payload.category && <StatusBadge meta={{ label: String(payload.category), tone: "warning" }} />}
          {Array.isArray(payload.knowledgeRefs) && payload.knowledgeRefs.map((ref) => (
            <StatusBadge key={String(ref)} meta={{ label: String(ref), tone: "primary" }} />
          ))}
        </div>
        {payload.rollbackPlan && (
          <div className="mt-3 rounded-lg border border-danger/25 bg-danger/5 p-3 text-xs leading-5 text-muted-foreground">
            <div className="mb-1 font-medium text-danger">回滚准备</div>
            风险级别: {payload.rollbackPlan.riskLevel ?? "未标注"}；触发条件: {payload.rollbackTrigger ?? "未标注"}。
          </div>
        )}
      </div>
      <div className="flex flex-row gap-2 md:flex-col md:items-end">
        {isPending ? (
          <>
            <Button size="sm" onClick={() => onAction("approve")} className="gap-1.5" data-testid={`button-approve-${gate.id}`}>
              <Check className="h-3.5 w-3.5" /> 批准
            </Button>
            <Button size="sm" variant="outline" onClick={() => onAction("modify")} className="gap-1.5" data-testid={`button-modify-${gate.id}`}>
              <Pencil className="h-3.5 w-3.5" /> 修改
            </Button>
            <Button size="sm" variant="destructive" onClick={() => onAction("reject")} className="gap-1.5" data-testid={`button-reject-${gate.id}`}>
              <X className="h-3.5 w-3.5" /> 驳回
            </Button>
          </>
        ) : (
          <div className="min-w-36 rounded-md border border-border bg-muted/25 px-3 py-2 text-right text-xs text-muted-foreground">
            决策: <span className="text-foreground">{gate.decision ?? "—"}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function humanSummary(gate: HumanGate): string {
  const p = gate.payload ?? {};
  if (p.recommended) return `推荐处理：${p.recommended}`;
  if (p.userQuote) return `外部反馈：${p.userQuote}`;
  if (p.summary) return String(p.summary);
  if (p.reasoning) return String(p.reasoning);
  if (p.auditSummary?.whyNow) return String(p.auditSummary.whyNow);
  return gate.blocking === 1 ? "这是一个阻塞闸门。处理前，飞轮会暂停相关自动推进。" : "这是一个非阻塞闸门，用于确认信号是否值得进入知识循环。";
}
