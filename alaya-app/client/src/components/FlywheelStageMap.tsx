import { ArrowRight } from "lucide-react";

import { StatusBadge } from "@/components/StatusBadge";
import { flywheelStageLabels, flywheelStageNote, metaFor } from "@/lib/labels";
import { cn } from "@/lib/utils";

export type FlywheelStageMapProps = {
  lastAgent: string | null;
  className?: string;
};

const agentOrder = ["orchestrator", "sensor", "builder", "distiller", "librarian"] as const;

export function FlywheelStageMap({ lastAgent, className }: FlywheelStageMapProps) {
  const activeAgent = lastAgent && lastAgent !== "idle" ? lastAgent : null;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr]">
        {agentOrder.map((agent, index) => {
          const active = activeAgent === agent;
          const meta = metaFor(flywheelStageLabels, agent);
          return (
            <div key={agent} className="contents">
              <div
                className={cn(
                  "min-h-24 rounded-lg border p-3 transition-colors",
                  active
                    ? "border-semantic-info/50 bg-semantic-info/10 text-foreground shadow-sm"
                    : "border-border bg-muted/20 text-muted-foreground",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{meta.label}</div>
                    <div className="mt-1 text-xs leading-5 opacity-80">{meta.description}</div>
                  </div>
                  {active && <StatusBadge status={agent} type="flywheel" />}
                </div>
              </div>
              {index < agentOrder.length - 1 && (
                <div className="hidden items-center justify-center text-muted-foreground md:flex" aria-hidden="true">
                  <ArrowRight className="h-4 w-4" />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{flywheelStageNote}</p>
    </div>
  );
}
