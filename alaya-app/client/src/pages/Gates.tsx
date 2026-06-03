import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, X, Pencil, Compass, HeartHandshake, ShieldAlert, Lightbulb } from "lucide-react";
import { useProject } from "@/components/Layout";
import { PageHeader, Panel, Tag, Empty, SkeletonRows } from "@/components/bits";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { HumanGate } from "@/lib/alaya";

const TYPE_META: Record<string, { label: string; icon: any; tone: string }> = {
  direction: { label: "方向闸", icon: Compass, tone: "text-primary border-primary/40 bg-primary/10" },
  meaning: { label: "意义闸", icon: HeartHandshake, tone: "text-chart-3 border-chart-3/40 bg-chart-3/10" },
  risk: { label: "风险闸", icon: ShieldAlert, tone: "text-destructive border-destructive/40 bg-destructive/10" },
};

export default function Gates() {
  const { projectId } = useProject();
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>("all");

  const { data: gates = [], isLoading } = useQuery<HumanGate[]>({
    queryKey: ["/api/human-gates", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/human-gates?projectId=${projectId}`);
      return res.json();
    },
  });

  async function act(gate: HumanGate, action: "approve" | "reject" | "modify") {
    await apiRequest("POST", `/api/human-gates/${gate.id}/${action}`, { rationale: `human ${action} via console` });
    queryClient.invalidateQueries({ queryKey: ["/api/human-gates", projectId] });
    queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
    toast({ title: `闸门已${action === "approve" ? "批准" : action === "reject" ? "否决" : "修改"}`, description: gate.title });
  }

  if (!projectId) return <Empty>选择一个项目</Empty>;

  const filtered = filter === "all" ? gates : gates.filter((g) => g.type === filter);
  const pending = filtered.filter((g) => g.status === "pending");
  const resolved = filtered.filter((g) => g.status !== "pending");

  return (
    <div data-testid="page-gates">
      <PageHeader
        title="Human Gates"
        sub="方向闸 / 意义闸 / 风险闸 — 查看 Agent 推荐、被筛掉的选项、相关知识引用"
        right={
          <div className="flex gap-1 rounded-md border border-border bg-card p-0.5">
            {["all", "direction", "meaning", "risk"].map((t) => (
              <button
                key={t}
                data-testid={`filter-${t}`}
                onClick={() => setFilter(t)}
                className={`rounded px-2.5 py-1 text-xs font-mono hover-elevate ${filter === t ? "bg-secondary text-secondary-foreground" : "text-muted-foreground"}`}
              >
                {t === "all" ? "全部" : TYPE_META[t].label}
              </button>
            ))}
          </div>
        }
      />

      {isLoading ? (
        <SkeletonRows rows={5} />
      ) : filtered.length === 0 ? (
        <Empty>无闸门</Empty>
      ) : (
        <div className="space-y-6">
          <section>
            <div className="mb-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
              待处理 · pending ({pending.length})
            </div>
            {pending.length === 0 ? (
              <Empty>没有待处理闸门</Empty>
            ) : (
              <div className="space-y-3">
                {pending.map((g) => <GateCard key={g.id} gate={g} onAct={act} />)}
              </div>
            )}
          </section>

          {resolved.length > 0 && (
            <section>
              <div className="mb-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
                已处理 · resolved ({resolved.length})
              </div>
              <div className="space-y-3">
                {resolved.map((g) => <GateCard key={g.id} gate={g} onAct={act} />)}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function GateCard({ gate, onAct }: { gate: HumanGate; onAct: (g: HumanGate, a: "approve" | "reject" | "modify") => void }) {
  const meta = TYPE_META[gate.type];
  const Icon = meta.icon;
  const pending = gate.status === "pending";
  const p = gate.payload || {};
  return (
    <Panel data-testid={`gate-${gate.id}`}>
      <div className="flex items-start gap-3 p-4">
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${meta.tone}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Tag className={meta.tone}>{meta.label}</Tag>
            {gate.blocking === 1 && <Tag className="border-destructive/40 bg-destructive/10 text-destructive">blocking</Tag>}
            <span className="text-[11px] font-mono text-muted-foreground">~{gate.estimatedMinutes}min</span>
            {!pending && (
              <Tag className="border-border bg-muted text-muted-foreground">{gate.status}</Tag>
            )}
          </div>
          <h3 className="mt-1.5 text-sm font-medium">{gate.title}</h3>

          {p.recommended && (
            <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="text-[11px] font-mono text-primary mb-0.5 flex items-center gap-1"><Lightbulb className="h-3 w-3" /> Agent 推荐</div>
              <div className="text-sm">{p.recommended}</div>
            </div>
          )}
          {p.reasoning && (
            <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{p.reasoning}</p>
          )}
          {p.userQuote && (
            <blockquote className="mt-2 border-l-2 border-chart-3/50 pl-3 text-sm italic text-muted-foreground">“{p.userQuote}”</blockquote>
          )}
          {p.alternatives && p.alternatives.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] font-mono text-muted-foreground mb-1">被筛掉的备选</div>
              <div className="flex flex-wrap gap-1.5">
                {p.alternatives.map((a) => (
                  <Tag key={a} className="border-border bg-muted text-muted-foreground line-through">{a}</Tag>
                ))}
              </div>
            </div>
          )}
          {p.knowledgeRefs && p.knowledgeRefs.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-mono text-muted-foreground">引用知识</span>
              {p.knowledgeRefs.map((r) => (
                <Tag key={r} className="border-primary/30 bg-primary/10 text-primary">{r}</Tag>
              ))}
            </div>
          )}

          {pending ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <button data-testid={`button-approve-${gate.id}`} onClick={() => onAct(gate, "approve")} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover-elevate active-elevate-2">
                <Check className="h-3.5 w-3.5" /> 批准
              </button>
              <button data-testid={`button-reject-${gate.id}`} onClick={() => onAct(gate, "reject")} className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover-elevate active-elevate-2">
                <X className="h-3.5 w-3.5" /> 否决
              </button>
              <button data-testid={`button-modify-${gate.id}`} onClick={() => onAct(gate, "modify")} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover-elevate active-elevate-2">
                <Pencil className="h-3.5 w-3.5" /> 修改
              </button>
            </div>
          ) : (
            <div className="mt-3 text-xs font-mono text-muted-foreground">
              decision: <span className="text-foreground">{gate.decision ?? "—"}</span>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
