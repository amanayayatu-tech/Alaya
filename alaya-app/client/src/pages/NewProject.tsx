import { FormEvent, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Gauge, Save, ShieldAlert, Sparkles } from "lucide-react";
import { useProject } from "@/components/Layout";
import {
  InlineNotice,
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await apiRequest("POST", "/api/projects", {
        ...form,
        redlines: lines(form.redlines),
        weeklyHumanMinutes: Number(form.weeklyHumanMinutes || 150),
        weeklyLlmBudgetCents: Number(form.weeklyLlmBudgetCents || 100),
        firstClaimTarget: Number(form.firstClaimTarget || 0.3),
      });
      const project = await response.json() as Project;
      await queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setProjectId(project.id);
      toast({ title: "项目已创建", description: project.name });
      navigate("/");
    } catch (error) {
      toast({ title: "创建失败", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageShell
      title="新建项目"
      eyebrow="Onboarding"
      description="用一组可验证输入生成项目身份、世界模型、第一轮周期和初始知识。"
      className="pb-8"
      testId="page-new-project"
    >
      <form onSubmit={submit} className="space-y-5">
        <InlineNotice tone="primary">
          创建时必须写入预测账簿的第一条可测 Claim：指标、达标方向和目标阈值会决定第一轮如何计算误差。
        </InlineNotice>

        <SectionCard
          title="项目身份"
          description="这些字段会成为 seed identity 的主体。"
          action={<StatusBadge meta={{ label: "必填", tone: "warning" }} />}
        >
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <Field label="项目名称" value={form.name} onChange={(value) => setField("name", value)} required placeholder="例如：Alaya WebUI" />
            <Field label="产品一句话" value={form.oneLiner} onChange={(value) => setField("oneLiner", value)} required placeholder="一句话描述方向" />
            <Field label="目标用户" value={form.targetUser} onChange={(value) => setField("targetUser", value)} required placeholder="谁会持续使用它" />
            <Field label="创始人偏好" value={form.founderPreference} onChange={(value) => setField("founderPreference", value)} placeholder="偏好的取舍、风格或限制" />
            <TextAreaField label="绝不做什么" value={form.neverDo} onChange={(value) => setField("neverDo", value)} rows={4} />
            <TextAreaField label="高风险红线" value={form.redlines} onChange={(value) => setField("redlines", value)} rows={4} placeholder="每行一条红线" />
          </div>
        </SectionCard>

        <SectionCard
          title="第一轮预测账簿"
          description="这些字段会进入 world model、第一个 cycle goal 和首条 measurable claim。"
          action={<Sparkles className="h-4 w-4 text-primary" />}
        >
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <TextAreaField label="当前最想验证的假设" value={form.currentHypothesis} onChange={(value) => setField("currentHypothesis", value)} required rows={4} />
            <TextAreaField label="第一轮希望看到的外部信号" value={form.firstSignal} onChange={(value) => setField("firstSignal", value)} required rows={4} />
            <TextAreaField label="已知竞品" value={form.competitors} onChange={(value) => setField("competitors", value)} rows={4} />
            <TextAreaField label="当前可用反馈来源" value={form.feedbackSources} onChange={(value) => setField("feedbackSources", value)} rows={4} />
            <Field label="第一轮指标 key" value={form.firstClaimMetric} onChange={(value) => setField("firstClaimMetric", value)} required />
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
                </select>
              </label>
              <Field label="目标阈值" type="number" value={form.firstClaimTarget} onChange={(value) => setField("firstClaimTarget", value)} required step="0.01" />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="预算边界"
          description="预算会约束人类闸门和 LLM 自动推进。"
          action={<ShieldAlert className="h-4 w-4 text-warning" />}
        >
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <Field label="每周人工预算分钟" type="number" value={form.weeklyHumanMinutes} onChange={(value) => setField("weeklyHumanMinutes", value)} required />
            <Field label="每周 LLM 预算 cents" type="number" value={form.weeklyLlmBudgetCents} onChange={(value) => setField("weeklyLlmBudgetCents", value)} required />
          </div>
        </SectionCard>

        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Gauge className="h-4 w-4" />
            <span>提交后进入飞轮总览，并选中新项目。</span>
          </div>
          <Button disabled={saving} data-testid="button-create-project" className="gap-2">
            <Save className="h-4 w-4" />
            {saving ? "创建中" : "创建项目"}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </PageShell>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  type = "text",
  placeholder,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  step?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-xs text-muted-foreground">{label}</span>
      <Input
        type={type}
        required={required}
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
  required,
  rows = 5,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-xs text-muted-foreground">{label}</span>
      <Textarea
        required={required}
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
