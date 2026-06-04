import { FormEvent, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Github, RefreshCw, Save } from "lucide-react";
import { useProject } from "@/components/Layout";
import { Empty, PageHeader, Panel, PanelHeader, SkeletonRows, Tag } from "@/components/bits";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Project } from "@/lib/alaya";

interface ExternalSource {
  id: string;
  projectId: string;
  kind: string;
  config: { owner?: string; repo?: string };
  status: string;
  lastSyncedAt: string | null;
}

export default function ProjectSetup() {
  const { projectId } = useProject();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [github, setGithub] = useState({ owner: "", repo: "" });
  const [form, setForm] = useState({
    direction: "",
    targetUser: "",
    seedIdentity: "",
    worldModel: "",
    redlines: "",
    weeklyHumanMinutes: "150",
    weeklyLlmBudgetCents: "100",
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: "0.3",
  });

  const { data: project, isLoading } = useQuery<Project>({
    queryKey: ["/api/projects", projectId],
    enabled: !!projectId,
  });
  const { data: sources = [] } = useQuery<ExternalSource[]>({
    queryKey: ["/api/projects", projectId, "integrations"],
    enabled: !!projectId,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/projects/${projectId}/integrations`);
      return res.json();
    },
  });

  useEffect(() => {
    if (!project) return;
    setForm({
      direction: project.direction,
      targetUser: project.targetUser,
      seedIdentity: project.seedIdentity,
      worldModel: project.worldModel,
      redlines: project.redlines.join("\n"),
      weeklyHumanMinutes: String(project.weeklyHumanMinutes),
      weeklyLlmBudgetCents: String(project.weeklyLlmBudgetCents),
      firstClaimMetric: project.firstClaimMetric,
      firstClaimOperator: project.firstClaimOperator,
      firstClaimTarget: String(project.firstClaimTarget),
    });
  }, [project]);

  useEffect(() => {
    const source = sources.find((s) => s.kind === "github_issues");
    if (!source) return;
    setGithub({ owner: source.config.owner ?? "", repo: source.config.repo ?? "" });
  }, [sources]);

  if (!projectId) return <Empty>选择一个项目</Empty>;
  if (isLoading || !project) return <SkeletonRows rows={6} />;

  async function saveProject(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/projects/${projectId}`, {
        direction: form.direction,
        targetUser: form.targetUser,
        seedIdentity: form.seedIdentity,
        worldModel: form.worldModel,
        redlines: JSON.stringify(form.redlines.split("\n").map((s) => s.trim()).filter(Boolean)),
        weeklyHumanMinutes: Number(form.weeklyHumanMinutes || 150),
        weeklyLlmBudgetCents: Number(form.weeklyLlmBudgetCents || 100),
        firstClaimMetric: form.firstClaimMetric,
        firstClaimOperator: form.firstClaimOperator,
        firstClaimTarget: Number(form.firstClaimTarget || 0.3),
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
      toast({ title: "项目配置已保存", description: project?.name ?? "project" });
    } finally {
      setSaving(false);
    }
  }

  async function saveGithub(syncNow: boolean) {
    setSyncing(true);
    try {
      const res = await apiRequest("POST", `/api/projects/${projectId}/integrations/github`, {
        owner: github.owner,
        repo: github.repo,
        syncNow,
      });
      const data = await res.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "integrations"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/human-gates", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
      toast({
        title: syncNow ? "GitHub Issues 已同步" : "GitHub source 已保存",
        description: data.sync ? `imported=${data.sync.imported}, gates=${data.sync.gatesCreated}` : `${github.owner}/${github.repo}`,
      });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div data-testid="page-project-setup">
      <PageHeader title="Project Setup" sub={`${project.name} · identity / world model / integrations`} />

      <form onSubmit={saveProject} className="space-y-5">
        <Panel>
          <PanelHeader>人工校准 · identity & world model</PanelHeader>
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <Field label="方向" value={form.direction} onChange={(v) => setForm((p) => ({ ...p, direction: v }))} />
            <Field label="目标用户" value={form.targetUser} onChange={(v) => setForm((p) => ({ ...p, targetUser: v }))} />
            <TextArea label="seed identity" value={form.seedIdentity} onChange={(v) => setForm((p) => ({ ...p, seedIdentity: v }))} />
            <TextArea label="world model" value={form.worldModel} onChange={(v) => setForm((p) => ({ ...p, worldModel: v }))} />
            <TextArea label="红线" value={form.redlines} onChange={(v) => setForm((p) => ({ ...p, redlines: v }))} />
            <Field label="每周人工预算分钟" type="number" value={form.weeklyHumanMinutes} onChange={(v) => setForm((p) => ({ ...p, weeklyHumanMinutes: v }))} />
            <Field label="每周 LLM 预算 cents" type="number" value={form.weeklyLlmBudgetCents} onChange={(v) => setForm((p) => ({ ...p, weeklyLlmBudgetCents: v }))} />
            <Field label="第一轮指标 key" value={form.firstClaimMetric} onChange={(v) => setForm((p) => ({ ...p, firstClaimMetric: v }))} />
            <Field label="第一轮目标阈值" type="number" value={form.firstClaimTarget} onChange={(v) => setForm((p) => ({ ...p, firstClaimTarget: v }))} />
            <label className="block text-sm">
              <span className="mb-1.5 block text-[11px] font-mono uppercase tracking-wider text-muted-foreground">第一轮 operator</span>
              <select
                value={form.firstClaimOperator}
                onChange={(e) => setForm((p) => ({ ...p, firstClaimOperator: e.target.value }))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              >
                <option value=">=">&gt;=</option>
                <option value="<=">&lt;=</option>
                <option value="==">==</option>
              </select>
            </label>
          </div>
        </Panel>

        <div className="flex justify-end">
          <button disabled={saving} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover-elevate disabled:opacity-50">
            <Save className="h-4 w-4" />
            {saving ? "Saving" : "Save Setup"}
          </button>
        </div>
      </form>

      <Panel className="mt-6">
        <PanelHeader
          right={sources.map((s) => (
            <Tag key={s.id} className={s.status === "active" ? "border-primary/40 bg-primary/10 text-primary" : "border-destructive/40 bg-destructive/10 text-destructive"}>
              {s.kind}:{s.status}
            </Tag>
          ))}
        >
          外部反馈 · GitHub Issues
        </PanelHeader>
        <div className="grid gap-4 p-4 md:grid-cols-[1fr_1fr_auto]">
          <Field label="owner" value={github.owner} onChange={(v) => setGithub((p) => ({ ...p, owner: v }))} />
          <Field label="repo" value={github.repo} onChange={(v) => setGithub((p) => ({ ...p, repo: v }))} />
          <div className="flex items-end gap-2">
            <button
              type="button"
              disabled={syncing || !github.owner || !github.repo}
              onClick={() => saveGithub(false)}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm hover-elevate disabled:opacity-50"
            >
              <Github className="h-4 w-4" />
              Save
            </button>
            <button
              type="button"
              disabled={syncing || !github.owner || !github.repo}
              onClick={() => saveGithub(true)}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover-elevate disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              Sync
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
    </label>
  );
}

function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
    </label>
  );
}
