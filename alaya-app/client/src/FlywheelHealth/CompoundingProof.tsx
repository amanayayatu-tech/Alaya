type CompoundingProofProps = {
  proof: {
    round1vs4KnowledgeDelta: number;
    principleNoveltyRate: number;
    injectionEffectiveness: number;
  };
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function CompoundingProof({ proof }: CompoundingProofProps) {
  const stalled = proof.round1vs4KnowledgeDelta === 0;
  const lowNovelty = proof.principleNoveltyRate < 0.1;

  return (
    <section className={`rounded-md border p-5 ${stalled ? "border-destructive/50 bg-destructive/10" : "border-primary/30 bg-primary/10"}`}>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px_220px]">
        <div>
          <p className="text-sm font-medium uppercase tracking-normal text-muted-foreground">Compounding Proof</p>
          <div className="mt-2 text-4xl font-semibold tracking-normal text-foreground">
            +{proof.round1vs4KnowledgeDelta}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">Round 1 to round 4 knowledge delta.</p>
        </div>
        <div className="rounded-md border border-border bg-background/60 p-3">
          <p className="text-sm text-muted-foreground">Principle novelty</p>
          <p className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{percent(proof.principleNoveltyRate)}</p>
        </div>
        <div className="rounded-md border border-border bg-background/60 p-3">
          <p className="text-sm text-muted-foreground">Injection effectiveness</p>
          <p className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{percent(proof.injectionEffectiveness)}</p>
        </div>
      </div>
      {stalled ? (
        <p className="mt-4 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground">
          Flywheel has not produced compounding. Check knowledge injection configuration.
        </p>
      ) : null}
      {!stalled && lowNovelty ? (
        <p className="mt-4 rounded-md bg-warning px-3 py-2 text-sm font-medium text-warning-foreground">
          Principle novelty is low. Review distiller and librarian merge behavior.
        </p>
      ) : null}
    </section>
  );
}
