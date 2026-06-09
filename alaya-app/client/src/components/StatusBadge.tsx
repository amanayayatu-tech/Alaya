import { Badge } from "@/components/ui/badge";
import {
  actorLabels,
  flywheelStageLabels,
  gateStatusLabels,
  knowledgeStatusLabels,
  metaFor,
  type LabelMeta,
  type SemanticColor,
} from "@/lib/labels";
import { cn } from "@/lib/utils";

export type StatusBadgeType = "gate" | "knowledge" | "actor" | "flywheel";

export type StatusBadgeProps = {
  status: string | null | undefined;
  type: StatusBadgeType;
  className?: string;
};

const labelMaps: Record<StatusBadgeType, Record<string, LabelMeta>> = {
  gate: gateStatusLabels,
  knowledge: knowledgeStatusLabels,
  actor: actorLabels,
  flywheel: flywheelStageLabels,
};

const semanticBadgeClasses: Record<SemanticColor, string> = {
  success: "border-semantic-success/35 bg-semantic-success/10 text-semantic-success",
  warning: "border-semantic-warning/40 bg-semantic-warning/10 text-semantic-warning",
  danger: "border-semantic-danger/40 bg-semantic-danger/10 text-semantic-danger",
  neutral: "border-semantic-neutral/30 bg-semantic-neutral/10 text-semantic-neutral",
  info: "border-semantic-info/35 bg-semantic-info/10 text-semantic-info",
};

export function StatusBadge({ status, type, className }: StatusBadgeProps) {
  const meta = metaFor(labelMaps[type], status);
  const semantic = meta.semantic ?? "neutral";

  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-md px-2 py-0.5 text-[11px] font-medium",
        semanticBadgeClasses[semantic],
        className,
      )}
      title={meta.description}
    >
      {meta.label}
    </Badge>
  );
}
