import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { useProject } from "@/components/Layout";
import { PageHeader, Panel, PanelHeader, Tag, Empty, SkeletonRows } from "@/components/bits";
import {
  ERROR_TYPE_TONE, fmtNum, fmtPct, errorToAccuracy, type Prediction, type Cycle,
} from "@/lib/alaya";

export default function Ledger() {
  const { projectId } = useProject();
  const { data: preds = [], isLoading } = useQuery<Prediction[]>({
    queryKey: ["/api/projects", projectId, "predictions"],
    enabled: !!projectId,
  });
  const { data: cycles = [] } = useQuery<Cycle[]>({
    queryKey: ["/api/projects", projectId, "cycles"],
    enabled: !!projectId,
  });

  if (!projectId) return <Empty>选择一个项目</Empty>;
  if (isLoading) return <SkeletonRows rows={6} />;

  const cycleIdx = (cid: string) => cycles.find((c) => c.id === cid)?.idx ?? 0;
  const ordered = [...preds].sort((a, b) => cycleIdx(a.cycleId) - cycleIdx(b.cycleId));
  const chartData = ordered
    .filter((p) => p.predictionError != null)
    .map((p) => ({
      cycle: `C${cycleIdx(p.cycleId)}`,
      accuracy: +(errorToAccuracy(p.predictionError)! * 100).toFixed(1),
      error: +(p.predictionError! * 100).toFixed(1),
    }));

  const resolved = ordered.filter((p) => p.predictionError != null);
  const avgAcc = resolved.length
    ? resolved.reduce((s, p) => s + errorToAccuracy(p.predictionError)!, 0) / resolved.length
    : null;

  return (
    <div data-testid="page-ledger">
      <PageHeader
        title="Prediction Ledger"
        sub="每条预测、观察、误差类型、修正动作 — 含预测准确率趋势"
      />

      <Panel className="mb-5">
        <PanelHeader right={avgAcc != null && <span className="font-mono text-xs text-muted-foreground">平均准确率 <span className="text-primary">{fmtPct(avgAcc)}</span></span>}>
          预测准确率趋势 · accuracy trend
        </PanelHeader>
        <div className="h-64 p-4">
          {chartData.length === 0 ? (
            <Empty>暂无已结算预测</Empty>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="cycle" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} />
                <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} unit="%" />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--popover-border))", borderRadius: 8, fontSize: 12, fontFamily: "var(--font-mono)" }}
                  labelStyle={{ color: "hsl(var(--foreground))" }}
                />
                <ReferenceLine y={70} stroke="hsl(var(--chart-4))" strokeDasharray="4 4" label={{ value: "目标 70%", fill: "hsl(var(--chart-4))", fontSize: 10, position: "insideTopRight" }} />
                <Line type="monotone" dataKey="accuracy" name="准确率" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={{ r: 4, fill: "hsl(var(--primary))" }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </Panel>

      <Panel>
        <PanelHeader>预测账本 · {ordered.length} 条</PanelHeader>
        {ordered.length === 0 ? (
          <Empty>暂无预测</Empty>
        ) : (
          <div className="divide-y divide-card-border">
            {ordered.map((p) => {
              const acc = errorToAccuracy(p.predictionError);
              return (
                <div key={p.id} className="p-4" data-testid={`row-prediction-${p.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag className="border-border bg-muted text-muted-foreground">C{cycleIdx(p.cycleId)}</Tag>
                    <span className="font-mono text-[11px] text-muted-foreground">{p.id}</span>
                    {p.errorType ? (
                      <Tag className={`border-current/30 ${ERROR_TYPE_TONE[p.errorType] ?? "text-muted-foreground"}`}>{p.errorType} error</Tag>
                    ) : (
                      <Tag className="border-chart-5/30 bg-chart-5/10 text-chart-5">命中</Tag>
                    )}
                    {p.knowledgeRefs.map((r) => (
                      <Tag key={r} className="border-primary/30 bg-primary/10 text-primary">{r}</Tag>
                    ))}
                    <span className="ml-auto font-mono text-xs tabular-nums">
                      <span className="text-muted-foreground">acc </span>
                      <span className={acc != null && acc >= 0.7 ? "text-primary" : "text-chart-4"}>{fmtPct(acc)}</span>
                    </span>
                  </div>

                  <div className="mt-2 grid gap-2 text-sm md:grid-cols-2">
                    <Field label="belief" value={p.belief} />
                    <Field label="prediction" value={p.prediction} />
                    <Field label="action" value={p.action} />
                    <Field label="observation" value={p.observation ?? "—"} mono />
                  </div>

                  <div className="mt-2 flex flex-wrap gap-4 font-mono text-[11px] text-muted-foreground">
                    <span>E_cycle <span className="text-foreground">{fmtNum(p.predictionError)}</span></span>
                    <span>worst claim <span className="text-foreground">{fmtNum(p.worstClaimError)}</span></span>
                    {p.updateTarget && <span>→ <span className="text-foreground">{p.updateTarget}</span></span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-0.5 break-words ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
    </div>
  );
}
