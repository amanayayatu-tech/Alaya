import { FormEvent, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Github, RefreshCw, Save, Settings2, ShieldCheck, WalletCards } from "lucide-react";
import { useProject } from "@/components/Layout";
import {
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingBlock,
  MetricTile,
  PageShell,
  SectionCard,
  StatusBadge,
} from "@/components/AppPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

type ProjectForm = {
  direction: string;
  targetUser: string;
  seedIdentity: string;
  worldModel: string;
  redlines: string;
  weeklyHumanMinutes: string;
  weeklyLlmBudgetCents: string;
  firstClaimMetric: string;
  firstClaimOperator: string;
  firstClaimTarget: string;
};

const emptyProjectForm: ProjectForm = {
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
};

export default function ProjectSetup() {
  const { projectId } = useProject();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [github, setGithub] = useState({ owner: "", repo: "" });
  const [form, setForm] = useState<ProjectForm>(emptyProjectForm);

  const {
    data: project,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<Project>({
    queryKey: ["/api/projects", projectId],
    enabled: !!projectId,
  });
  const { data: sources = [] } = useQuery<ExternalSource[]>({
    queryKey: ["/api/projects", projectId, "integrations"],
    enabled: !!projectId,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/projects/${projectId}/integrations`);
      return response.json();
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
    const source = sources.find((item) => item.kind === "github_issues");
    if (!source) return;
    setGithub({ owner: source.config.owner ?? "", repo: source.config.repo ?? "" });
  }, [sources]);

  const githubSource = useMemo(() => sources.find((source) => source.kind === "github_issues"), [sources]);

  if (!projectId) return <EmptyState title="先选择项目" description="项目设置会修改当前项目的身份、世界模型、红线和预算。" />;
  if (isError) return <ErrorState message={error instanceof Error ? error.message : "无法读取项目设置"} onRetry={() => refetch()} />;
  if (isLoading || !project) return <LoadingBlock rows={7} />;

  const projectName = project.name;

  function setField(key: keyof ProjectForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function saveProject(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/projects/${projectId}`, {
        direction: form.direction,
        targetUser: form.targetUser,
        seedIdentity: form.seedIdentity,
        worldModel: form.worldModel,
        redlines: JSON.stringify(lines(form.redlines)),
        weeklyHumanMinutes: Number(form.weeklyHumanMinutes || 150),
        weeklyLlmBudgetCents: Number(form.weeklyLlmBudgetCents || 100),
        firstClaimMetric: form.firstClaimMetric,
        firstClaimOperator: form.firstClaimOperator,
        firstClaimTarget: Number(form.firstClaimTarget || 0.3),
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/knowledge"] });
      toast({ title: "项目配置已保存", description: projectName });
    } catch (error) {
      toast({ title: "保存失败", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  async function saveGithub(syncNow: boolean) {
    setSyncing(true);
    try {
      const response = await apiRequest("POST", `/api/projects/${projectId}/integrations/github`, {
        owner: github.owner.trim(),
        repo: github.repo.trim(),
        syncNow,
      });
      const data = await response.json();
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "integrations"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/human-gates", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "dashboard"] });
      toast({
        title: syncNow ? "GitHub Issues 已同步" : "GitHub 来源已保存",
        description: data.sync ? `导入 ${data.sync.imported} 条，创建闸门 ${data.sync.gatesCreated} 个` : `${github.owner}/${github.repo}`,
      });
    } catch (error) {
      toast({ title: "GitHub 配置失败", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <PageShell
      title="项目设置"
      eyebrow="Project Setup"
      description={`${project.name} 的人工校准、红线、预算和外部反馈来源。`}
      className="pb-8"
      testId="page-project-setup"
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="当前周期" value={`C${project.currentCycleIdx}`} sub={`version ${project.version}`} icon={<Settings2 className="h-4 w-4" />} />
        <MetricTile label="红线数量" value={project.redlines.length} sub="自动化不能跨越" tone={project.redlines.length > 0 ? "danger" : "default"} icon={<ShieldCheck className="h-4 w-4" />} />
        <MetricTile label="人工预算" value={`${project.weeklyHumanMinutes}`} sub="分钟/周" icon={<WalletCards className="h-4 w-4" />} />
        <MetricTile label="LLM 预算" value={`${project.weeklyLlmBudgetCents}`} sub="cents/周" icon={<WalletCards className="h-4 w-4" />} />
      </div>

      <form onSubmit={saveProject} className="space-y-5">
        <SectionCard title="人工校准" description="保存 seedIdentity 或 worldModel 会同步更新 onboarding seed 知识。">
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <Field label="方向" value={form.direction} onChange={(value) => setField("direction", value)} />
            <Field label="目标用户" value={form.targetUser} onChange={(value) => setField("targetUser", value)} />
            <TextAreaField label="Seed Identity" value={form.seedIdentity} onChange={(value) => setField("seedIdentity", value)} rows={9} />
            <TextAreaField label="World Model" value={form.worldModel} onChange={(value) => setField("worldModel", value)} rows={9} />
            <TextAreaField label="红线" value={form.redlines} onChange={(value) => setField("redlines", value)} rows={5} placeholder="每行一条" />
            <div className="grid gap-4">
              <Field label="第一轮指标 key" value={form.firstClaimMetric} onChange={(value) => setField("firstClaimMetric", value)} />
              <div className="grid gap-3 sm:grid-cols-[0.7fr_1fr]">
                <label className="block text-sm">
                  <span className="mb-1.5 block text-xs text-muted-foreground">Operator</span>
                  <select
                    value={form.firstClaimOperator}
                    onChange={(event) => setField("firstClaimOperator", event.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value=">=">&gt;=</option>
                    <option value="<=">&lt;=</option>
                    <option value="==">==</option>
                  </select>
                </label>
                <Field label="目标阈值" type="number" value={form.firstClaimTarget} onChange={(value) => setField("firstClaimTarget", value)} step="0.01" />
              </div>
              <Field label="每周人工预算分钟" type="number" value={form.weeklyHumanMinutes} onChange={(value) => setField("weeklyHumanMinutes", value)} />
              <Field label="每周 LLM 预算 cents" type="number" value={form.weeklyLlmBudgetCents} onChange={(value) => setField("weeklyLlmBudgetCents", value)} />
            </div>
          </div>
        </SectionCard>

        <div className="flex justify-end">
          <Button disabled={saving} data-testid="button-save-project" className="gap-2">
            <Save className="h-4 w-4" />
            {saving ? "保存中" : "保存设置"}
          </Button>
        </div>
      </form>

      <SectionCard
        title="外部反馈"
        description="GitHub Issues 同步会把外部反馈写入当前周期，并按风险或意义打开闸门。"
        action={
          githubSource ? (
            <StatusBadge meta={{ label: `${githubSource.kind}: ${githubSource.status}`, tone: githubSource.status === "active" ? "success" : "warning" }} />
          ) : (
            <StatusBadge meta={{ label: "未配置", tone: "muted" }} />
          )
        }
      >
        <div className="space-y-4 p-4">
          <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
            <Field label="Owner" value={github.owner} onChange={(value) => setGithub((prev) => ({ ...prev, owner: value }))} />
            <Field label="Repo" value={github.repo} onChange={(value) => setGithub((prev) => ({ ...prev, repo: value }))} />
            <div className="flex items-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={syncing || !github.owner.trim() || !github.repo.trim()}
                onClick={() => saveGithub(false)}
                className="gap-2"
              >
                <Github className="h-4 w-4" />
                保存
              </Button>
              <Button
                type="button"
                disabled={syncing || !github.owner.trim() || !github.repo.trim()}
                onClick={() => saveGithub(true)}
                className="gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                同步
              </Button>
            </div>
          </div>
          {githubSource?.lastSyncedAt && (
            <InlineNotice tone="success">
              最近同步: {new Date(githubSource.lastSyncedAt).toLocaleString()}
            </InlineNotice>
          )}
        </div>
      </SectionCard>
    </PageShell>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  step?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-xs text-muted-foreground">{label}</span>
      <Input
        type={type}
        value={value}
        step={step}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 6,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-xs text-muted-foreground">{label}</span>
      <Textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}
