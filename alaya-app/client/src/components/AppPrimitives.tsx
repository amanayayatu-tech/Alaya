import type { ReactNode } from "react";
import {
  AlertTriangle, ArrowRight, BookOpen, CheckCircle2, Clock, DatabaseZap,
  FileWarning, LoaderCircle, RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  flywheelStageLabels,
  metaFor,
  type LabelMeta,
  type Tone,
} from "@/lib/labels";
import emptyFlywheel from "@/assets/empty-flywheel.png";

const toneClass: Record<Tone, string> = {
  default: "border-border bg-card text-foreground",
  primary: "border-primary/35 bg-primary/10 text-primary",
  success: "border-success/35 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-danger/40 bg-danger/10 text-danger",
  muted: "border-border bg-muted text-muted-foreground",
};

export function toneClasses(tone: Tone = "default"): string {
  return toneClass[tone] ?? toneClass.default;
}

export function PageShell({
  title,
  eyebrow,
  description,
  action,
  children,
  className,
  testId,
}: {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("space-y-5", className)} data-testid={testId}>
      <header className="flex flex-col gap-4 border-b border-border/70 pb-5 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
              {eyebrow}
            </div>
          )}
          <h1 className="text-2xl font-semibold leading-tight text-foreground md:text-3xl">{title}</h1>
          {description && <div className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("overflow-hidden border-card-border bg-card shadow-sm", className)}>
      {(title || description || action) && (
        <CardHeader className="flex flex-col gap-3 border-b border-card-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {title && <div className="text-sm font-semibold text-foreground">{title}</div>}
            {description && <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </CardHeader>
      )}
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

export function StatusBadge({ meta, children, className }: { meta?: LabelMeta; children?: ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-md px-2 py-0.5 text-[11px] font-medium", toneClasses(meta?.tone), className)}>
      {children ?? meta?.label ?? "未知"}
    </Badge>
  );
}

export function MetricTile({
  label,
  value,
  sub,
  icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={cn("rounded-lg border bg-card p-4", tone === "default" ? "border-card-border" : toneClasses(tone))}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-1 text-xs leading-5 text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function BudgetRing({
  label,
  value,
  total,
  suffix,
  tone = "primary",
}: {
  label: string;
  value: number;
  total: number;
  suffix?: string;
  tone?: Tone;
}) {
  const safeTotal = Math.max(total, 1);
  const pct = Math.min(100, Math.round((value / safeTotal) * 100));
  const stroke = tone === "danger" ? "stroke-danger" : tone === "warning" ? "stroke-warning" : tone === "success" ? "stroke-success" : "stroke-primary";
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-24 w-24 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r="42" className="fill-none stroke-muted" strokeWidth="10" />
          <circle
            cx="50"
            cy="50"
            r="42"
            className={cn("fill-none transition-all", stroke)}
            strokeWidth="10"
            strokeDasharray={`${pct * 2.64} 264`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-xl font-semibold tabular-nums">{pct}%</div>
          <div className="text-[10px] text-muted-foreground">已用</div>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{value}</span> / {total} {suffix}
        </div>
        <Progress value={pct} className="mt-3 h-2" />
      </div>
    </div>
  );
}

export function FlywheelStageMap({ stage }: { stage: string }) {
  const steps = ["sensor", "distiller", "orchestrator", "builder", "librarian"];
  return (
    <div className="grid gap-2 md:grid-cols-5">
      {steps.map((key, index) => {
        const active = key === stage;
        const meta = metaFor(flywheelStageLabels, key);
        return (
          <div
            key={key}
            className={cn(
              "relative rounded-lg border p-3 transition-colors",
              active ? toneClasses(meta.tone) : "border-border bg-muted/25 text-muted-foreground",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-current/25 text-xs font-semibold">
                {index + 1}
              </span>
              {index < steps.length - 1 && <ArrowRight className="hidden h-4 w-4 md:block" />}
            </div>
            <div className="mt-3 text-sm font-semibold">{meta.short ?? meta.label}</div>
            <div className="mt-1 text-xs leading-5 opacity-80">{meta.description}</div>
          </div>
        );
      })}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  illustrated = false,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  illustrated?: boolean;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-5 py-10 text-center">
      {illustrated ? (
        <img src={emptyFlywheel} alt="" className="h-32 w-auto rounded-md object-contain opacity-90" />
      ) : (
        <DatabaseZap className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      )}
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description && <div className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">{description}</div>}
      </div>
      {action}
    </div>
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 rounded-lg border border-card-border bg-card p-4">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full rounded-md" />
      ))}
    </div>
  );
}

export function ErrorState({ title = "加载失败", message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-danger/35 bg-danger/10 p-4 text-danger">
      <div className="flex items-start gap-3">
        <FileWarning className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {message && <div className="mt-1 break-words text-xs leading-5 opacity-90">{message}</div>}
          {onRetry && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry} className="mt-3 gap-2">
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function InlineNotice({ tone = "warning", children }: { tone?: Tone; children: ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "danger" ? AlertTriangle : Clock;
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", toneClasses(tone))}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 leading-6">{children}</div>
    </div>
  );
}

export function JsonPreview({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background p-3 text-xs leading-5 text-muted-foreground">
      {text || "—"}
    </pre>
  );
}
