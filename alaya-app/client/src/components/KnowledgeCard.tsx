import { useState } from "react";
import { ChevronDown, ChevronRight, GitMerge, Tags } from "lucide-react";

import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { KnowledgeItem } from "@/lib/alaya";
import { actorLabels, metaFor } from "@/lib/labels";
import { cn } from "@/lib/utils";

export type KnowledgeCardProps = {
  knowledge: KnowledgeItem;
  className?: string;
};

function normalizedConfidence(knowledge: KnowledgeItem): number {
  const alpha = Number.isFinite(knowledge.evidenceAlpha) ? knowledge.evidenceAlpha : 1;
  const beta = Number.isFinite(knowledge.evidenceBeta) ? knowledge.evidenceBeta : 1;
  const fromEvidence = alpha + beta > 0 ? alpha / (alpha + beta) : knowledge.confidenceScore;
  const value = Number.isFinite(fromEvidence) ? fromEvidence : 0;
  return Math.min(1, Math.max(0, value));
}

export function KnowledgeCard({ knowledge, className }: KnowledgeCardProps) {
  const superseded = Boolean(knowledge.supersededBy);
  const [collapsed, setCollapsed] = useState(superseded);
  const confidence = normalizedConfidence(knowledge);
  const creator = metaFor(actorLabels, knowledge.createdBy);

  return (
    <Card className={cn("overflow-hidden rounded-lg", superseded && "opacity-60 grayscale", className)}>
      <CardHeader className="space-y-3 border-b border-card-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={knowledge.status} type="knowledge" />
              <span className="rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {knowledge.type}
              </span>
              {superseded && (
                <span className="inline-flex items-center gap-1 rounded-md border border-semantic-neutral/30 bg-semantic-neutral/10 px-2 py-0.5 text-[11px] font-medium text-semantic-neutral">
                  <GitMerge className="h-3 w-3" />
                  已被替代
                </span>
              )}
            </div>
            <h3 className="mt-3 break-words text-base font-semibold leading-6 text-foreground">{knowledge.title}</h3>
            <div className="mt-1 text-xs text-muted-foreground">来源：{creator.label}</div>
          </div>
          {superseded && (
            <Button type="button" variant="outline" size="sm" onClick={() => setCollapsed((value) => !value)} className="shrink-0 gap-1.5">
              {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {collapsed ? "展开" : "折叠"}
            </Button>
          )}
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent className="space-y-4 p-4">
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{knowledge.content}</p>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">置信度</span>
              <span className="font-mono text-foreground">{confidence.toFixed(2)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-semantic-info transition-[width]"
                style={{ width: `${confidence * 100}%` }}
              />
            </div>
          </div>

          {knowledge.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Tags className="h-3.5 w-3.5" />
              {knowledge.tags.map((tag) => (
                <span key={tag} className="rounded-md border border-border bg-muted/30 px-2 py-0.5">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {superseded && knowledge.supersededBy && (
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              已合并到 <span className="font-mono text-foreground">{knowledge.supersededBy}</span>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
