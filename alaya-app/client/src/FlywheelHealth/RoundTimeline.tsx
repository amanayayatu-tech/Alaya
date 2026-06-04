import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FlywheelRoundHealth } from "./index";

type RoundTimelineProps = {
  rounds: FlywheelRoundHealth[];
};

export function RoundTimeline({ rounds }: RoundTimelineProps) {
  const data = rounds.map((round) => ({
    round: `R${round.roundNumber}`,
    newKnowledge: round.newKnowledgeCount,
    promotions: round.promotionCount,
    corrections: round.correctionCount,
    injections: round.knowledgeInjectedCount,
  }));

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold tracking-normal text-card-foreground">Round Timeline</h2>
        <p className="text-sm text-muted-foreground">New knowledge, promotions, corrections, and injected priors by round.</p>
      </div>
      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 20, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="round" stroke="hsl(var(--muted-foreground))" />
            <YAxis allowDecimals={false} stroke="hsl(var(--muted-foreground))" />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="newKnowledge" name="New knowledge" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="promotions" name="Promotions" stroke="hsl(var(--chart-5))" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="corrections" name="Corrections" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="injections" name="Injected priors" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
