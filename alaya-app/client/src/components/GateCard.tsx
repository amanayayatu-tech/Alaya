import { useMemo, useState } from "react";
import { CheckCircle2, GitBranch, PencilLine, ShieldAlert, XCircle, type LucideIcon } from "lucide-react";

import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { HumanGate } from "@/lib/alaya";
import { gateTypeLabels, metaFor } from "@/lib/labels";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

export type GateCardProps = {
  gate: HumanGate;
  className?: string;
  onResolved?: (gate: HumanGate) => void;
};

type GateAction = "approve" | "reject" | "modify";

const actionMeta: Record<GateAction, { label: string; description: string; icon: LucideIcon; variant: "default" | "outline" | "destructive" }> = {
  approve: {
    label: "批准",
    description: "说明为什么该闸门可以通过。",
    icon: CheckCircle2,
    variant: "default",
  },
  reject: {
    label: "驳回",
    description: "说明拒绝原因和需要避免的后果。",
    icon: XCircle,
    variant: "destructive",
  },
  modify: {
    label: "修改",
    description: "说明需要修改的内容和判断依据。",
    icon: PencilLine,
    variant: "outline",
  },
};

function compactText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value.filter(Boolean).join(" / ") || null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function GateCard({ gate, className, onResolved }: GateCardProps) {
  const [action, setAction] = useState<GateAction | null>(null);
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isBlocking = gate.blocking === 1;
  const canResolve = gate.status === "pending";
  const activeAction = action ? actionMeta[action] : null;
  const rationaleLength = rationale.trim().length;
  const submitDisabled = rationaleLength < 10 || submitting;
  const gateTypeMeta = metaFor(gateTypeLabels, gate.type);

  const payloadRows = useMemo(() => {
    const payload = gate.payload ?? {};
    return [
      ["推荐", payload.recommended],
      ["摘要", payload.summary],
      ["理由", payload.reasoning],
      ["用户原文", payload.userQuote],
      ["来源", payload.source],
      ["分类", payload.category],
      ["回滚触发", payload.rollbackTrigger],
    ]
      .map(([label, value]) => [label, compactText(value)] as const)
      .filter(([, value]) => value);
  }, [gate.payload]);

  async function submitAction() {
    if (!action || submitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiRequest("POST", `/api/human-gates/${gate.id}/${action}`, {
        rationale: rationale.trim(),
      });
      const body = await res.json();
      onResolved?.((body.gate ?? body) as HumanGate);
      setAction(null);
      setRationale("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function openAction(nextAction: GateAction) {
    setAction(nextAction);
    setRationale("");
    setError(null);
  }

  return (
    <>
      <Card
        className={cn(
          "overflow-hidden rounded-lg bg-card",
          isBlocking ? "border-semantic-danger/70 shadow-[0_0_0_1px_hsl(var(--semantic-danger)/0.28)]" : "border-card-border",
          gate.status !== "pending" && "opacity-80",
          className,
        )}
      >
        <CardHeader className="space-y-3 border-b border-card-border p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-semantic-info/35 bg-semantic-info/10 px-2 py-0.5 text-[11px] font-medium text-semantic-info">
                  {gateTypeMeta.label}
                </Badge>
                <StatusBadge status={gate.status} type="gate" />
                {isBlocking && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-semantic-danger/40 bg-semantic-danger/10 px-2 py-0.5 text-[11px] font-medium text-semantic-danger">
                    <ShieldAlert className="h-3 w-3" />
                    阻塞
                  </span>
                )}
              </div>
              <h3 className="mt-3 text-base font-semibold leading-6 text-foreground">{gate.title}</h3>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {(Object.keys(actionMeta) as GateAction[]).map((key) => {
                const meta = actionMeta[key];
                const Icon = meta.icon;
                return (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    variant={meta.variant}
                    disabled={!canResolve}
                    onClick={() => openAction(key)}
                    className="gap-1.5"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {meta.label}
                  </Button>
                );
              })}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-4">
          {payloadRows.length > 0 ? (
            <dl className="grid gap-3 text-sm md:grid-cols-2">
              {payloadRows.map(([label, value]) => (
                <div key={label} className="rounded-md border border-border/70 bg-muted/20 p-3">
                  <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-words text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
              暂无闸门上下文。
            </div>
          )}
          {gate.payload?.knowledgeRefs?.length ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <GitBranch className="h-3.5 w-3.5" />
              {gate.payload.knowledgeRefs.map((ref) => (
                <span key={ref} className="rounded-md border border-border bg-muted/30 px-2 py-0.5 font-mono">
                  {ref}
                </span>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={action !== null} onOpenChange={(open) => !open && setAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{activeAction ? `${activeAction.label}闸门` : "处理闸门"}</DialogTitle>
            <DialogDescription>{activeAction?.description} rationale 至少 10 个字，会写回后端 decision log。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Textarea
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="写下本次判断依据、风险和影响..."
              className="min-h-32"
            />
            <div className={cn("text-xs", rationaleLength < 10 ? "text-semantic-warning" : "text-muted-foreground")}>
              已输入 {rationaleLength} / 10
            </div>
            {error && (
              <div className="rounded-md border border-semantic-danger/40 bg-semantic-danger/10 px-3 py-2 text-sm text-semantic-danger">
                {error}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAction(null)} disabled={submitting}>
              取消
            </Button>
            <Button
              type="button"
              variant={activeAction?.variant === "destructive" ? "destructive" : "default"}
              onClick={submitAction}
              disabled={submitDisabled}
            >
              {submitting ? "提交中" : activeAction?.label ?? "提交"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
