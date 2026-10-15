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
    <section className="rounded-md border border-border bg-card p-5">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px_220px]">
        <div>
          <p className="text-sm font-medium tracking-normal text-muted-foreground">知识积累与引用</p>
          <div className="mt-2 text-4xl font-semibold tracking-normal text-foreground">
            +{proof.round1vs4KnowledgeDelta}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">第 1 轮后累计新增知识条目（截至当前）。</p>
        </div>
        <div className="rounded-md border border-border bg-background/60 p-3">
          <p className="text-sm text-muted-foreground">原则去重比例</p>
          <p className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{percent(proof.principleNoveltyRate)}</p>
          <p className="mt-2 text-xs text-muted-foreground">按语义标识或标题去重。</p>
        </div>
        <div className="rounded-md border border-border bg-background/60 p-3">
          <p className="text-sm text-muted-foreground">已注入知识的引用比例</p>
          <p className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{percent(proof.injectionEffectiveness)}</p>
          <p className="mt-2 text-xs text-muted-foreground">被引用条目数 / 已注入条目数。</p>
        </div>
      </div>
      <p className="mt-4 text-sm text-muted-foreground">这些指标只记录条目积累和引用，不衡量正确率、节时或认知增强。</p>
      {stalled ? (
        <p className="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          第 1 轮后尚无新增知识记录，可在周期评审中查看具体记录。
        </p>
      ) : null}
      {!stalled && lowNovelty ? (
        <p className="mt-4 rounded-md bg-warning px-3 py-2 text-sm font-medium text-warning-foreground">
          原则去重比例较低，可检查知识条目是否重复。
        </p>
      ) : null}
    </section>
  );
}
