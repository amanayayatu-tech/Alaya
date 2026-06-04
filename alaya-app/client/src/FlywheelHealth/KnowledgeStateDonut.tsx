import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { FlywheelHealthPayload } from "./index";

type KnowledgeStateDonutProps = {
  totals: FlywheelHealthPayload["totals"];
};

const COLORS = {
  strong: "hsl(var(--chart-5))",
  active: "hsl(var(--chart-1))",
  stale: "hsl(var(--chart-4))",
  quarantined: "hsl(var(--destructive))",
  conflict: "hsl(var(--chart-3))",
};

export function KnowledgeStateDonut({ totals }: KnowledgeStateDonutProps) {
  const data = [
    { name: "strong", value: totals.strongKnowledgeCount, color: COLORS.strong },
    { name: "active", value: totals.activeKnowledgeCount, color: COLORS.active },
    { name: "stale", value: totals.staleKnowledgeCount ?? 0, color: COLORS.stale },
    { name: "quarantined", value: totals.quarantinedCount, color: COLORS.quarantined },
    { name: "conflict", value: totals.conflictCount, color: COLORS.conflict },
  ].filter((item) => item.value > 0);

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold tracking-normal text-card-foreground">Knowledge State</h2>
        <p className="text-sm text-muted-foreground">{totals.totalEvidenceCount} evidence units across decision memory.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_160px] xl:grid-cols-1">
        <div className="h-[240px] min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={64} outerRadius={94} paddingAngle={2}>
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="space-y-2 text-sm">
          {data.map((item) => (
            <div key={item.name} className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
                {item.name}
              </span>
              <span className="font-medium text-foreground">{item.value}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
