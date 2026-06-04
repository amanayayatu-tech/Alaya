import type { HTMLAttributes, ReactNode } from "react";

export function PageHeader({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Panel({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div {...props} className={`rounded-lg border border-card-border bg-card ${className}`}>{children}</div>
  );
}

export function PanelHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-card-border px-4 py-3">
      <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">{children}</div>
      {right}
    </div>
  );
}

export function Stat({ label, value, mono = true, tone = "", sub }: { label: string; value: ReactNode; mono?: boolean; tone?: string; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-card-border bg-card p-4">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1.5 text-lg font-semibold ${mono ? "font-mono tabular-nums" : ""} ${tone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Tag({ children, className = "", testid }: { children: ReactNode; className?: string; testid?: string }) {
  return (
    <span
      data-testid={testid}
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-mono leading-none ${className}`}
    >
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-muted/60" />
      ))}
    </div>
  );
}
