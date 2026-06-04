export type HumanGate = {
  id: string;
  cycleId: string;
  type: string;
  blocking: number;
  title: string;
  status: string;
  estimatedMinutes: number;
};

type HumanGateQueueProps = {
  gates: HumanGate[];
};

export function HumanGateQueue({ gates }: HumanGateQueueProps) {
  return (
    <section className="rounded-md border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-normal text-card-foreground">Human Gate Queue</h2>
          <p className="text-sm text-muted-foreground">{gates.length} pending reviews.</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 font-medium">Gate</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Cycle</th>
              <th className="px-3 py-2 font-medium">Blocking</th>
              <th className="py-2 pl-3 text-right font-medium">Minutes</th>
            </tr>
          </thead>
          <tbody>
            {gates.length === 0 ? (
              <tr>
                <td className="py-5 text-muted-foreground" colSpan={5}>No pending gates.</td>
              </tr>
            ) : gates.map((gate) => (
              <tr key={gate.id} className="border-b border-border/60 last:border-0">
                <td className="py-3 pr-3 font-medium text-foreground">{gate.title}</td>
                <td className="px-3 py-3 text-muted-foreground">{gate.type}</td>
                <td className="px-3 py-3 text-muted-foreground">{gate.cycleId}</td>
                <td className="px-3 py-3">
                  <span className={gate.blocking ? "text-destructive" : "text-muted-foreground"}>
                    {gate.blocking ? "yes" : "no"}
                  </span>
                </td>
                <td className="py-3 pl-3 text-right text-muted-foreground">{gate.estimatedMinutes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
