import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, Filter, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageShell,
  SectionCard,
  StatusBadge,
} from "@/components/AppPrimitives";
import { useProject } from "@/components/Layout";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { evidenceCount, fmtNum, type KnowledgeItem } from "@/lib/alaya";
import { confidenceLabels, knowledgeStatusLabels, metaFor } from "@/lib/labels";
import { cn } from "@/lib/utils";

const ALL = "all";
const MAX_REFERENCES_RENDERED = 50;

export default function Knowledge() {
  const { projectId } = useProject();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [sourceFilter, setSourceFilter] = useState(ALL);
  const [tagFilter, setTagFilter] = useState(ALL);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    data: all = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<KnowledgeItem[]>({
    queryKey: ["/api/knowledge", projectId],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/knowledge?projectId=${projectId}`);
      return response.json();
    },
    enabled: !!projectId,
  });

  const { data: searchResults, isFetching: searching } = useQuery<KnowledgeItem[]>({
    queryKey: ["/api/knowledge/search", projectId, activeSearch],
    queryFn: async () => {
      const response = await apiRequest("POST", "/api/knowledge/search", { projectId, query: activeSearch });
      return response.json();
    },
    enabled: !!projectId && activeSearch.trim().length > 0,
  });

  const { data: detail, isFetching: detailLoading, isError: detailIsError, error: detailError } = useQuery<KnowledgeItem>({
    queryKey: ["/api/knowledge", "detail", selectedId],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/knowledge/${selectedId}`);
      return response.json();
    },
    enabled: !!selectedId,
  });

  const approve = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/knowledge/${id}/approve`, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
      toast({ title: "知识已批准", description: "人工批准记录已进入审计账本。" });
    },
  });

  const quarantine = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/knowledge/${id}/quarantine`, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/knowledge"] });
      toast({ title: "知识已隔离", description: "该知识不会进入决策证据集。" });
    },
  });

  const base = activeSearch ? (searchResults ?? []) : all;
  const sources = useMemo(() => unique(all.map((item) => item.sourceType).filter(Boolean)), [all]);
  const tags = useMemo(() => unique(all.flatMap((item) => item.tags ?? [])), [all]);
  const statuses = useMemo(() => unique(all.map((item) => item.status).filter(Boolean)), [all]);

  const items = base.filter((item) => {
    if (!showSuperseded && item.supersededBy) return false;
    if (statusFilter !== ALL && item.status !== statusFilter) return false;
    if (sourceFilter !== ALL && item.sourceType !== sourceFilter) return false;
    if (tagFilter !== ALL && !(item.tags ?? []).includes(tagFilter)) return false;
    return true;
  });

  function runSearch(event: React.FormEvent) {
    event.preventDefault();
    setActiveSearch(query.trim());
  }

  if (!projectId) return <EmptyState title="先选择项目" description="知识库属于具体项目，每条知识都有来源、证据和状态。" />;
  if (isLoading) return <LoadingBlock rows={7} />;
  if (isError) return <ErrorState message={error instanceof Error ? error.message : "无法读取知识库"} onRetry={() => refetch()} />;

  const renderedReferences = (detail?.referencedByAgents ?? []).slice(0, MAX_REFERENCES_RENDERED);
  const referencesTruncated = Boolean(detail?.referencedByAgentsTruncated)
    || (detail?.referencedByAgents?.length ?? 0) > MAX_REFERENCES_RENDERED;

  return (
    <PageShell
      title="知识库"
      eyebrow="Knowledge"
      description="这里不是普通笔记，而是飞轮沉淀出的可审计信念。状态、证据和人类批准会决定它能不能进入下一轮决策。"
      className="pb-8"
      testId="page-knowledge"
    >
      <SectionCard title="搜索与过滤" description="只使用真实字段：status、sourceType、tags、confidence 和 evidence。">
        <div className="space-y-4 p-4">
          <form onSubmit={runSearch} className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                data-testid="input-knowledge-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索知识标题或内容，例如：预览、回滚、审计"
                className="pl-9"
              />
            </div>
            <Button type="submit" data-testid="button-knowledge-search" disabled={searching}>
              {searching ? "搜索中" : "搜索"}
            </Button>
            {activeSearch && (
              <Button type="button" variant="outline" data-testid="button-knowledge-clear" onClick={() => { setQuery(""); setActiveSearch(""); }}>
                清除
              </Button>
            )}
          </form>
          <div className="text-xs text-muted-foreground" data-testid="text-search-status">
            {activeSearch ? `正在显示“${activeSearch}”的搜索结果，共 ${items.length} 条。` : `当前展示 ${items.length} 条知识。`}
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <SelectFilter label="状态" value={statusFilter} onChange={setStatusFilter} options={statuses} labelFor={knowledgeStatusLabels} />
            <SelectFilter label="来源" value={sourceFilter} onChange={setSourceFilter} options={sources} />
            <SelectFilter label="标签" value={tagFilter} onChange={setTagFilter} options={tags} />
            <label className="flex items-center gap-2 rounded-md border border-border bg-muted/25 px-3 py-2 text-sm">
              <input type="checkbox" checked={showSuperseded} onChange={(event) => setShowSuperseded(event.target.checked)} />
              显示被合并知识
            </label>
          </div>
        </div>
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <SectionCard
          title={`知识条目 (${items.length})`}
          description={activeSearch ? `搜索“${activeSearch}”后的结果。` : "默认展示当前项目知识。被合并条目默认隐藏。"}
          action={<StatusBadge meta={{ label: `${all.length} 总数`, tone: "muted" }} />}
        >
          {items.length === 0 ? (
            <EmptyState
              illustrated
              title="没有匹配的知识"
              description="调整过滤条件，或等待下一轮飞轮闭环后由 Distiller 生成新知识。"
            />
          ) : (
            <div className="grid gap-3 p-4 lg:grid-cols-2">
              {items.map((item) => (
                <KnowledgeCard
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="知识详情" description="查看来源、证据、人类批准和 Agent 引用。">
          {detailLoading && !detail ? (
            <LoadingBlock rows={4} />
          ) : detailIsError ? (
            <div className="p-4">
              <ErrorState message={detailError instanceof Error ? detailError.message : "详情加载失败"} />
            </div>
          ) : !detail ? (
            <EmptyState title="选择一条知识" description="详情会显示证据、状态、合并关系和引用它的 Agent。" illustrated />
          ) : (
            <div className="space-y-4 p-4" data-testid="detail-knowledge">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge meta={metaFor(knowledgeStatusLabels, detail.status)} />
                  <StatusBadge meta={metaFor(confidenceLabels, detail.confidenceLevel)} />
                  <StatusBadge meta={{ label: detail.type, tone: "muted" }} />
                </div>
                <h2 className="mt-3 text-lg font-semibold leading-snug">{detail.title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail.content}</p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <DetailMetric label="置信度" value={`${fmtNum(detail.confidenceScore, 2)} / ${detail.confidenceLevel}`} />
                <DetailMetric label="证据量" value={`${evidenceCount(detail)} (α ${detail.evidenceAlpha} / β ${detail.evidenceBeta})`} />
                <DetailMetric label="人工批准" value={`${detail.humanApprovedCount} 次`} />
                <DetailMetric label="来源" value={`${detail.sourceType}${detail.sourceRef ? ` / ${detail.sourceRef}` : ""}`} />
                <DetailMetric label="创建轮次" value={`Cycle ${detail.createdByCycle}`} />
                <DetailMetric label="被合并到" value={detail.supersededBy ?? "未被合并"} />
              </div>

              {detail.tags.length > 0 && (
                <div>
                  <div className="mb-2 text-xs text-muted-foreground">标签</div>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.tags.map((tag) => <StatusBadge key={tag} meta={{ label: tag, tone: "muted" }} />)}
                  </div>
                </div>
              )}

              <div>
                <div className="mb-2 text-xs text-muted-foreground">引用它的 Agent</div>
                {renderedReferences.length === 0 ? (
                  <div className="rounded-md border border-border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">暂无 Agent 引用记录</div>
                ) : (
                  <div className="space-y-2">
                    {renderedReferences.map((ref, index) => (
                      <div key={`${ref.agent}-${ref.cycleIdx}-${index}`} className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs" data-testid={`ref-agent-${detail.id}-${index}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{ref.agent}</span>
                          <span className="text-muted-foreground">Cycle {ref.cycleIdx}</span>
                        </div>
                        <div className="mt-1 text-muted-foreground">{ref.action}</div>
                      </div>
                    ))}
                  </div>
                )}
                {referencesTruncated && (
                  <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning" data-testid="text-reference-truncated">
                    为避免详情页卡顿，仅显示最近 {Math.min(detail.referencedByAgentsLimit ?? MAX_REFERENCES_RENDERED, MAX_REFERENCES_RENDERED)} 条引用。
                  </div>
                )}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  onClick={() => approve.mutate(detail.id)}
                  disabled={approve.isPending}
                  data-testid={`button-approve-knowledge-${detail.id}`}
                  className="gap-2"
                >
                  <CheckCircle2 className="h-4 w-4" /> 批准知识
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => quarantine.mutate(detail.id)}
                  disabled={quarantine.isPending}
                  data-testid={`button-quarantine-knowledge-${detail.id}`}
                  className="gap-2"
                >
                  <ShieldAlert className="h-4 w-4" /> 隔离
                </Button>
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </PageShell>
  );
}

function KnowledgeCard({ item, selected, onSelect }: { item: KnowledgeItem; selected: boolean; onSelect: () => void }) {
  const status = metaFor(knowledgeStatusLabels, item.status);
  const confidence = metaFor(confidenceLabels, item.confidenceLevel);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`card-knowledge-${item.id}`}
      className={cn(
        "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/40",
        selected ? "border-primary/50 ring-1 ring-primary/30" : "border-card-border",
        item.supersededBy ? "opacity-65" : "",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge meta={status} />
        <StatusBadge meta={confidence} />
        {item.supersededBy && <StatusBadge meta={{ label: "已合并", tone: "muted" }} />}
      </div>
      <h2 className="mt-3 line-clamp-2 text-sm font-semibold leading-6">{item.title}</h2>
      <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{item.content}</p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <MiniStat label="证据" value={evidenceCount(item)} />
        <MiniStat label="批准" value={item.humanApprovedCount} />
        <MiniStat label="置信" value={fmtNum(item.confidenceScore, 2)} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        <StatusBadge meta={{ label: item.sourceType, tone: "muted" }} />
        {item.tags.slice(0, 3).map((tag) => <StatusBadge key={tag} meta={{ label: tag, tone: "muted" }} />)}
      </div>
    </button>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border bg-muted/25 px-2 py-1">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="font-mono text-xs text-foreground">{value}</div>
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/25 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm">{value}</div>
    </div>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
  labelFor,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  labelFor?: Record<string, { label: string }>;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 flex items-center gap-1 text-xs text-muted-foreground">
        <Filter className="h-3.5 w-3.5" />
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
      >
        <option value={ALL}>全部</option>
        {options.map((option) => (
          <option key={option} value={option}>{labelFor?.[option]?.label ?? option}</option>
        ))}
      </select>
    </label>
  );
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
