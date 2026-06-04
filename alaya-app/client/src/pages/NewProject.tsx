import { FormEvent, useState } from "react";
import { useLocation } from "wouter";
import { Save } from "lucide-react";
import { useProject } from "@/components/Layout";
import { PageHeader, Panel, PanelHeader } from "@/components/bits";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Project } from "@/lib/alaya";

const initial = {
  name: "",
  oneLiner: "",
  targetUser: "",
  currentHypothesis: "",
  neverDo: "",
  redlines: "",
  founderPreference: "",
  competitors: "",
  feedbackSources: "",
  weeklyHumanMinutes: "150",
  weeklyLlmBudgetCents: "100",
  firstClaimMetric: "activation_rate",
  firstClaimOperator: ">=",
  firstClaimTarget: "0.3",
  firstSignal: "",
};

export default function NewProject() {
  const [, navigate] = useLocation();
  const { setProjectId } = useProject();
  const { toast } = useToast();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);

  function setField(key: keyof typeof initial, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiRequest("POST", "/api/projects", {
        ...form,
        redlines: form.redlines.split("\n").map((s) => s.trim()).filter(Boolean),
        weeklyHumanMinutes: Number(form.weeklyHumanMinutes || 150),
        weeklyLlmBudgetCents: Number(form.weeklyLlmBudgetCents || 100),
        firstClaimMetric: form.firstClaimMetric,
        firstClaimOperator: form.firstClaimOperator,
        firstClaimTarget: Number(form.firstClaimTarget || 0.3),
      });
      const project = await res.json() as Project;
      await queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setProjectId(project.id);
      toast({ title: "项目已创建", description: project.name });
      navigate("/");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="page-new-project">
      <PageHeader title="New Project" sub="Onboarding Interview · seed identity / world model" />
      <form onSubmit={submit} className="space-y-5">
        <Panel>
          <PanelHeader>项目身份 · identity seed</PanelHeader>
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <Field label="项目名称" value={form.name} onChange={(v) => setField("name", v)} required />
            <Field label="产品一句话" value={form.oneLiner} onChange={(v) => setField("oneLiner", v)} required />
            <Field label="目标用户" value={form.targetUser} onChange={(v) => setField("targetUser", v)} required />
            <Field label="当前最想验证的假设" value={form.currentHypothesis} onChange={(v) => setField("currentHypothesis", v)} required />
            <Field label="创始人偏好" value={form.founderPreference} onChange={(v) => setField("founderPreference", v)} />
            <Field label="第一轮希望看到的外部信号" value={form.firstSignal} onChange={(v) => setField("firstSignal", v)} required />
            <Field label="第一轮指标 key" value={form.firstClaimMetric} onChange={(v) => setField("firstClaimMetric", v)} required />
            <Field label="第一轮目标阈值" type="number" value={form.firstClaimTarget} onChange={(v) => setField("firstClaimTarget", v)} required />
            <label className="block text-sm">
              <span className="mb-1.5 block text-[11px] font-mono uppercase tracking-wider text-muted-foreground">第一轮 operator</span>
              <select
                value={form.firstClaimOperator}
                onChange={(e) => setField("firstClaimOperator", e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              >
                <option value=">=">&gt;=</option>
                <option value="<=">&lt;=</option>
                <option value="==">==</option>
              </select>
            </label>
          </div>
        </Panel>

        <Panel>
          <PanelHeader>边界与反馈 · boundaries</PanelHeader>
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <TextArea label="绝不做什么" value={form.neverDo} onChange={(v) => setField("neverDo", v)} />
            <TextArea label="高风险红线" value={form.redlines} onChange={(v) => setField("redlines", v)} />
            <TextArea label="已知竞品" value={form.competitors} onChange={(v) => setField("competitors", v)} />
            <TextArea label="当前可用反馈来源" value={form.feedbackSources} onChange={(v) => setField("feedbackSources", v)} />
            <Field label="每周人工预算分钟" type="number" value={form.weeklyHumanMinutes} onChange={(v) => setField("weeklyHumanMinutes", v)} required />
            <Field label="每周 LLM 预算 cents" type="number" value={form.weeklyLlmBudgetCents} onChange={(v) => setField("weeklyLlmBudgetCents", v)} required />
          </div>
        </Panel>

        <div className="flex justify-end">
          <button
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover-elevate disabled:opacity-50"
            data-testid="button-create-project"
          >
            <Save className="h-4 w-4" />
            {saving ? "Creating" : "Create Project"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, value, onChange, required, type = "text" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{label}</span>
      <input
        type={type}
        required={required}
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
        rows={5}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
    </label>
  );
}
