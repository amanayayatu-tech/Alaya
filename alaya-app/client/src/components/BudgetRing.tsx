import { cn } from "@/lib/utils";

export type BudgetRingSemantic = "success" | "warning" | "danger";

export type BudgetRingProps = {
  used: number;
  total: number;
  label: string;
  semantic: BudgetRingSemantic;
  className?: string;
};

const ringClasses: Record<BudgetRingSemantic, { stroke: string; text: string; bg: string }> = {
  success: {
    stroke: "stroke-semantic-success",
    text: "text-semantic-success",
    bg: "bg-semantic-success/10",
  },
  warning: {
    stroke: "stroke-semantic-warning",
    text: "text-semantic-warning",
    bg: "bg-semantic-warning/10",
  },
  danger: {
    stroke: "stroke-semantic-danger",
    text: "text-semantic-danger",
    bg: "bg-semantic-danger/10",
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function BudgetRing({ used, total, label, semantic, className }: BudgetRingProps) {
  const safeTotal = Math.max(0, total);
  const safeUsed = clamp(Number.isFinite(used) ? used : 0, 0, Math.max(safeTotal, 0));
  const usageRatio = safeTotal > 0 ? safeUsed / safeTotal : 1;
  const remainingRatio = safeTotal > 0 ? (safeTotal - safeUsed) / safeTotal : 0;
  const effectiveSemantic = remainingRatio < 0.2 ? "danger" : semantic;
  const tone = ringClasses[effectiveSemantic];
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamp(usageRatio, 0, 1));
  const normalized = clamp(usageRatio, 0, 1);

  return (
    <div className={cn("flex items-center gap-4", className)}>
      <div className="relative h-24 w-24 shrink-0" aria-label={`${label} ${normalized.toFixed(2)}`}>
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" role="img">
          <circle cx="50" cy="50" r={radius} className="fill-none stroke-muted" strokeWidth="10" />
          <circle
            cx="50"
            cy="50"
            r={radius}
            className={cn("fill-none transition-[stroke-dashoffset]", tone.stroke)}
            strokeWidth="10"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </svg>
        <div className={cn("absolute inset-3 flex flex-col items-center justify-center rounded-full", tone.bg)}>
          <div className={cn("text-lg font-semibold tabular-nums", tone.text)}>{normalized.toFixed(2)}</div>
          <div className="text-[10px] text-muted-foreground">used</div>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          <span className="font-mono text-foreground">{safeUsed}</span>
          <span> / </span>
          <span className="font-mono">{safeTotal}</span>
        </div>
        <div className={cn("mt-2 text-xs font-medium", tone.text)}>
          剩余 {(remainingRatio * 100).toFixed(0)}%
        </div>
      </div>
    </div>
  );
}
