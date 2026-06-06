import { useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { CompoundingProof } from "./CompoundingProof";
import { HumanGateQueue, type HumanGate } from "./HumanGateQueue";
import { KnowledgeStateDonut } from "./KnowledgeStateDonut";
import { RoundTimeline } from "./RoundTimeline";
import { apiFetch } from "@/lib/queryClient";

export type FlywheelRoundHealth = {
  roundNumber: number;
  startedAt: string;
  completedAt: string;
  newKnowledgeCount: number;
  promotionCount: number;
  correctionCount: number;
  errorTypes: { perception: number; execution: number; model: number; value: number };
  humanGatesTriggered: number;
  humanGatesResolved: number;
  knowledgeInjectedCount: number;
};

export type FlywheelHealthPayload = {
  rounds: FlywheelRoundHealth[];
  totals: {
    strongKnowledgeCount: number;
    activeKnowledgeCount: number;
    staleKnowledgeCount?: number;
    quarantinedCount: number;
    conflictCount: number;
    totalEvidenceCount: number;
  };
  compoundingProof: {
    round1vs4KnowledgeDelta: number;
    principleNoveltyRate: number;
    injectionEffectiveness: number;
  };
};

type FlywheelHealthProps = {
  projectId?: string;
};

async function loadJson<T>(url: string): Promise<T> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export default function FlywheelHealth({ projectId }: FlywheelHealthProps) {
  const [health, setHealth] = useState<FlywheelHealthPayload | null>(null);
  const [gates, setGates] = useState<HumanGate[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const query = useMemo(() => (projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""), [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([
      loadJson<FlywheelHealthPayload>(`/api/flywheel/health${query}`),
      loadJson<HumanGate[]>(`/api/human-gates${query}`),
    ])
      .then(([healthPayload, gatePayload]) => {
        if (cancelled) return;
        setHealth(healthPayload);
        setGates(gatePayload.filter((gate) => gate.status === "pending"));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  if (loading) {
    return (
      <section className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        Loading flywheel health
      </section>
    );
  }

  if (error || !health) {
    return (
      <section className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {error || "Flywheel health is unavailable"}
      </section>
    );
  }

  return (
    <main className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">Flywheel Health</h1>
          <p className="mt-1 text-sm text-muted-foreground">Compounding, knowledge maturity, and human gate pressure.</p>
        </div>
        <div className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
          <Activity className="mr-2 h-4 w-4 text-primary" />
          {health.rounds.length} rounds
        </div>
      </div>

      <CompoundingProof proof={health.compoundingProof} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.9fr)]">
        <RoundTimeline rounds={health.rounds} />
        <KnowledgeStateDonut totals={health.totals} />
      </div>

      <HumanGateQueue gates={gates} />
    </main>
  );
}
