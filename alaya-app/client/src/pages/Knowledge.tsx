import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Search, CheckCircle2, ShieldAlert, X, BookOpen } from "lucide-react";
import { useProject } from "@/components/Layout";
import { PageHeader, Panel, PanelHeader, Tag, Empty, SkeletonRows } from "@/components/bits";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  STATUS_TONE, CONFIDENCE_TONE, AGENT_LABEL, fmtNum, type KnowledgeItem,
} from "@/lib/alaya";

const TYPE_FILTERS = ["all", "identity", "world_model", "principle", "fact", "pattern"];

export default function Knowledge() {
  const { projectId } = useProject();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: all = [], isLoading } = useQuery<KnowledgeItem[]>({
    queryKey: ["/api/knowledge", projectId],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/knowledge?projectId=${projectId}`);
      return r.json();
    },
    enabled: !!projectId,
  });

  const { data: searchResults } = useQuery<KnowledgeItem[]>({
    queryKey: ["/api/knowledge/search", projectId, activeSearch],
    queryFn: async () => {
      const r = await apiRequest("POST", "/api/knowledge/search", { projectId, query: activeSearch });
      return r.json();
    },
    enabled: !!projectId && activeSearch.trim().length > 0,
  });

  const { data: detail } = useQuery<KnowledgeItem>({
    queryKey: ["/api/knowledge", "detail", selectedId],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/knowledge/${selectedId}`);
      return r.json();
    },
    enabled: !!selectedId,
  });

  const approve = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/knowledge/${id}/approve`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
      toast({ title: "已批准", description: "知识置信度与人工核验计数已更新" });
    },
  });
  const quarantine = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/knowledge/${id}/quarantine`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge"] });
      toast({ title: "已隔离", description: "该知识已移出可检索集" });
    },
  });

  if (!projectId) return <Empty>选择一个项目</Empty>;
  if (isLoading) return <SkeletonRows rows={6} />;

  const searching = activeSearch.trim().length > 0;
  const base = searching ? (searchResults ?? []) : all;
  const items = typeFilter === "all" ? base : base.filter((k) => k.type === typeFilter);

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setActiveSearch(query.trim());
  }
  function clearSearch() {
    setQuery("");
    setActiveSearch("");
  }

  return (
    <div data-testid="page-knowledge">
      <PageHeader
        title="Knowledge Base"
        sub="FTS5 全文检索 · 仅返回 active/strong(排除 stale/expired/conflict/quarantined)"
      />

      <form onSubmit={runSearch} className="mb-4 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            data-testid="input-knowledge-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="检索知识(支持中文分词,如「预览」「恐惧」)…"
            className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          type="submit"
          data-testid="button-knowledge-search"
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover-elevate"
        >
          检索
        </button>
        {searching && (
          <button
            type="button"
            onClick={clearSearch}
            data-testid="button-knowledge-clear"
            className="rounded-md border border-border px-3 py-2 text-sm text-foreground hover-elevate"
          >
            清除
          </button>
        )}
      </form>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {TYPE_FILTERS.map((t) => (
          <button
            key={t}
            onClick={() => setTypeFilter(t)}
            data-testid={`filter-type-${t}`}
            className={`rounded-md border px-2.5 py-1 text-xs font-mono ${
              typeFilter === t
                ? "border-primary/40 bg-primary/15 text-primary"
                : "border-border bg-card text-muted-foreground hover-elevate"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {searching && (
        <div className="mb-3 text-xs font-mono text-muted-foreground" data-testid="text-search-status">
          FTS5 检索 "{activeSearch}" → {items.length} 条命中
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Panel>
            <PanelHeader>知识条目 · {items.length}</PanelHeader>
            {items.length === 0 ? (
              <Empty>{searching ? "无匹配结果" : "暂无知识"}</Empty>
            ) : (
              <div className="divide-y divide-card-border">
                {items.map((k) => (
                  <button
                    key={k.id}
                    onClick={() => setSelectedId(k.id)}
                    data-testid={`card-knowledge-${k.id}`}
                    className={`block w-full px-4 py-3 text-left hover-elevate ${
                      selectedId === k.id ? "bg-accent/50" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-muted-foreground">{k.id}</span>
                      <Tag className={STATUS_TONE[k.status] ?? "border-border text-muted-foreground"}>{k.status}</Tag>
                      <Tag className="border-border bg-muted text-muted-foreground">{k.type}</Tag>
                      <span className={`ml-auto font-mono text-xs tabular-nums ${CONFIDENCE_TONE[k.confidenceLevel] ?? ""}`}>
                        {fmtNum(k.confidenceScore, 2)} · {k.confidenceLevel}
                      </span>
                    </div>
                    <div className="mt-1.5 text-sm font-medium">{k.title}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{k.content}</div>
                    {k.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {k.tags.map((t) => (
                          <Tag key={t} className="border-border/60 text-muted-foreground">#{t}</Tag>
                        ))}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="lg:col-span-2">
          <Panel className="sticky top-0">
            <PanelHeader>详情 · detail</PanelHeader>
            {!detail ? (
              <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
                <BookOpen className="h-6 w-6 opacity-40" />
                选择左侧知识查看来源、置信度演化与引用它的 Agent
              </div>
            ) : (
              <div className="space-y-4 p-4" data-testid="detail-knowledge">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag className={STATUS_TONE[detail.status] ?? "border-border"}>{detail.status}</Tag>
                    <Tag className="border-border bg-muted text-muted-foreground">{detail.type}</Tag>
                  </div>
                  <h2 className="mt-2 text-base font-semibold leading-snug">{detail.title}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{detail.content}</p>
                </div>

                <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px]">
                  <KV label="confidence" value={`${fmtNum(detail.confidenceScore, 2)} (${detail.confidenceLevel})`} />
                  <KV label="evidence α/β" value={`${detail.evidenceAlpha} / ${detail.evidenceBeta}`} />
                  <KV label="source" value={`${detail.sourceType}: ${detail.sourceRef || "—"}`} />
                  <KV label="created cycle" value={`C${detail.createdByCycle}`} />
                  <KV label="human ✓" value={String(detail.humanApprovedCount)} />
                  <KV label="usage" value={String(detail.usageCount)} />
                </div>

                <div>
                  <div className="mb-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    被哪些 Agent 引用 · referenced by
                  </div>
                  {detail.referencedByAgents && detail.referencedByAgents.length > 0 ? (
                    <div className="space-y-1.5">
                      {detail.referencedByAgents.map((r, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs" data-testid={`ref-agent-${detail.id}-${i}`}>
                          <Tag className="border-primary/30 bg-primary/10 text-primary">C{r.cycleIdx}</Tag>
                          <span className="font-medium">{AGENT_LABEL[r.agent] ?? r.agent}</span>
                          <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{r.action}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">尚无 Agent 引用记录</div>
                  )}
                </div>

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => approve.mutate(detail.id)}
                    disabled={approve.isPending}
                    data-testid={`button-approve-knowledge-${detail.id}`}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover-elevate disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> 批准
                  </button>
                  <button
                    onClick={() => quarantine.mutate(detail.id)}
                    disabled={quarantine.isPending}
                    data-testid={`button-quarantine-knowledge-${detail.id}`}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive hover-elevate disabled:opacity-50"
                  >
                    <ShieldAlert className="h-3.5 w-3.5" /> 隔离
                  </button>
                </div>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground">{label}</div>
      <div className="truncate text-foreground">{value}</div>
    </div>
  );
}
