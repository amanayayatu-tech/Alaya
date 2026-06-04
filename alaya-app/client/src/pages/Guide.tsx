import { Link } from "wouter";
import {
  ArrowRight,
  BookOpenCheck,
  BrainCircuit,
  CheckCircle2,
  ClipboardCheck,
  DatabaseZap,
  GitBranch,
  HelpCircle,
  Library,
  ListChecks,
  MessageSquareText,
  Play,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  MetricTile,
  PageShell,
  SectionCard,
  StatusBadge,
  toneClasses,
} from "@/components/AppPrimitives";

const flywheelSteps = [
  { label: "想法", detail: "先说清楚你想把项目带到哪里", icon: Sparkles },
  { label: "预测", detail: "把判断写成能验证的说法", icon: ClipboardCheck },
  { label: "执行", detail: "让系统生成任务或变更包", icon: Play },
  { label: "反馈", detail: "收集用户、数据和外部信号", icon: MessageSquareText },
  { label: "知识", detail: "把有用经验沉淀下来", icon: Library },
  { label: "更聪明", detail: "下一轮带着旧经验继续跑", icon: BrainCircuit },
];

const abilities = [
  { title: "把目标拆成一轮轮行动", body: "不再只写一个大愿望，而是每轮都有目标、预测、动作和回看。", icon: GitBranch },
  { title: "自动沉淀可复用经验", body: "跑过的反馈不会散掉，会进入 Knowledge Base（知识库），下一轮能继续用。", icon: DatabaseZap },
  { title: "高风险动作先停一下", body: "遇到危险、预算、意义不清的地方，会打开 Human Gate（人工闸门）请你确认。", icon: ShieldCheck },
  { title: "每一步都有账可查", body: "关键判断会进入 Audit Ledger（审计账本），方便追踪是谁、何时、为什么这么做。", icon: ScrollText },
];

const strengths = [
  ["Flywheel", "飞轮", "不是问一次答一次，而是一轮接一轮，把反馈变成下一轮的燃料。"],
  ["Knowledge Base", "知识库", "把经验存起来，让系统不要每次都从零开始想。"],
  ["Human Gate", "人工闸门", "危险决策前先让人确认，自动化不能绕过红线。"],
  ["Audit Ledger", "审计账本", "每次判断、变更、审批都有记录，事后能复盘。"],
  ["LLM", "大语言模型", "负责生成建议和草稿，但不能跳过规则直接乱来。"],
];

const operationSteps = [
  { title: "写清楚项目边界", body: "进项目设置，填目标用户、项目方向和红线。红线就是系统绝对不能踩的线。", href: "/project" },
  { title: "推进飞轮一轮", body: "回到飞轮总览，点击“推进飞轮一轮”，让系统开始生成预测、任务和下一步。", href: "/" },
  { title: "处理需要你确认的卡点", body: "去人类闸门，把方向、风险、意义不清的地方批掉、改掉或放行。", href: "/gates" },
  { title: "检查沉淀出的经验", body: "看知识库，确认哪些经验已经变成系统以后可以复用的信念。", href: "/knowledge" },
  { title: "复盘每一轮准不准", body: "在周期评审里看预测、反馈、误差和 Agent（智能执行角色）运行记录。", href: "/review" },
  { title: "看飞轮有没有变强", body: "健康证明会告诉你知识有没有增长、人工闸门压力大不大、复利是否出现。", href: "/health" },
  { title: "追踪关键决策来源", body: "审计账本适合回看关键判断的前因后果，尤其适合团队复盘。", href: "/ledger" },
];

const glossary = [
  ["Agent", "智能执行角色", "系统里的分工角色，比如收集反馈、提炼知识、生成任务。"],
  ["LLM", "大语言模型", "负责理解文字和生成建议的模型。"],
  ["Cycle", "周期", "一轮从目标、预测、执行到反馈的闭环。"],
  ["Flywheel", "飞轮", "越跑越积累、越积累越好用的循环。"],
  ["Human Gate", "人工闸门", "需要人确认的卡点。"],
  ["Knowledge", "知识", "被系统保存下来的经验、原则或判断。"],
  ["Audit Ledger", "审计账本", "记录关键动作和决策的地方。"],
  ["Confidence", "置信度", "系统对某条知识有多相信。"],
  ["Strong Knowledge", "强知识", "经过更严格验证、能更放心复用的知识。"],
];

function FlywheelDiagram() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Alaya 飞轮流程图">
      {flywheelSteps.map((step, index) => {
        const Icon = step.icon;
        return (
          <div key={step.label} className="relative min-h-[132px] rounded-lg border border-border bg-muted/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
            </div>
            <div className="mt-4 text-base font-semibold text-foreground">{step.label}</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.detail}</p>
            {index < flywheelSteps.length - 1 && (
              <ArrowRight className="absolute -right-3 top-1/2 hidden h-5 w-5 -translate-y-1/2 text-primary xl:block" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function PlainAiVsAlaya() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-lg border border-warning/35 bg-warning/10 p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <HelpCircle className="h-4 w-4 text-warning" />
          普通 AI（人工智能）工具
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          你问一次，它答一次。答得好不好，下一次不一定记得；团队后来想复盘，也很难知道当时为什么这么判断。
        </p>
      </div>
      <div className="rounded-lg border border-primary/35 bg-primary/10 p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <RotateCcw className="h-4 w-4 text-primary" />
          Alaya
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          每一轮都会留下预测、反馈、知识和审计记录。下一轮不是从零开始，而是带着上次学到的东西继续改。
        </p>
      </div>
    </div>
  );
}

export default function Guide() {
  return (
    <PageShell
      title="使用说明"
      eyebrow="新手上手"
      description="这页用大白话讲清楚 Alaya 是什么、怎么用、哪里厉害。你可以把它当成第一次打开产品时的地图。"
      testId="page-guide"
      className="pb-8"
    >
      <section className="grid gap-5 rounded-lg border border-card-border bg-card p-5 shadow-sm xl:grid-cols-[0.9fr_1.1fr]">
        <div className="flex flex-col justify-between gap-5">
          <div>
            <StatusBadge meta={{ label: "一句话解释", tone: "primary" }} />
            <h2 className="mt-4 text-2xl font-semibold leading-tight text-foreground md:text-4xl">
              Alaya 把项目从一次性决策，变成会复盘、会学习、能被人控制的持续改进飞轮。
            </h2>
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              你可以把它理解成一个项目驾驶舱：它帮你提出下一步、预测结果、收集反馈、沉淀经验；遇到高风险动作时，它不会直接冲过去，而是停下来让人确认。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile label="核心模式" value="一轮一轮跑" sub="Cycle（周期）闭环" icon={<RotateCcw className="h-4 w-4" />} />
            <MetricTile label="记忆方式" value="知识沉淀" sub="Knowledge（知识）复用" icon={<BookOpenCheck className="h-4 w-4" />} />
            <MetricTile label="安全底线" value="人来把关" sub="Human Gate（人工闸门）" icon={<ShieldCheck className="h-4 w-4" />} />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-background/50 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-foreground">飞轮是怎么转起来的</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                从想法出发，经过验证，再把经验带回下一轮。
              </div>
            </div>
            <StatusBadge meta={{ label: "闭环", tone: "success" }} />
          </div>
          <FlywheelDiagram />
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {abilities.map((item) => {
          const Icon = item.icon;
          return (
            <MetricTile
              key={item.title}
              label={item.title}
              value={<Icon className="h-6 w-6 text-primary" />}
              sub={item.body}
              tone="default"
            />
          );
        })}
      </div>

      <SectionCard
        title="厉害在哪里"
        description="Alaya 的重点不是“替你拍脑袋”，而是让项目判断能持续变准。"
      >
        <div className="grid gap-0 divide-y divide-card-border md:grid-cols-2 md:divide-x md:divide-y-0">
          <div className="p-4">
            <PlainAiVsAlaya />
          </div>
          <div className="divide-y divide-card-border">
            {strengths.map(([english, chinese, body]) => (
              <div key={english} className="grid gap-2 px-4 py-3 sm:grid-cols-[180px_1fr]">
                <div className="text-sm font-semibold text-foreground">
                  {english}（{chinese}）
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="应该怎么操作"
        description="按这个顺序走，基本就能把一个项目跑起来。"
      >
        <div className="divide-y divide-card-border">
          {operationSteps.map((step, index) => (
            <div key={step.title} className="grid gap-3 px-4 py-4 md:grid-cols-[96px_1fr_auto] md:items-center">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-md border border-primary/30 bg-primary/10 font-mono text-xs text-primary">
                  {index + 1}
                </span>
                <span className="text-xs text-muted-foreground">步骤</span>
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{step.title}</div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.body}</p>
              </div>
              <Link
                href={step.href}
                className="inline-flex w-fit items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover-elevate"
              >
                去看看 <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <SectionCard
          title="小词典"
          description="看到英文专有名词时，可以先看这里。"
        >
          <div className="grid gap-0 divide-y divide-card-border md:grid-cols-3 md:divide-x md:divide-y-0">
            {[0, 1, 2].map((column) => (
              <div key={column} className="divide-y divide-card-border">
                {glossary
                  .filter((_, index) => index % 3 === column)
                  .map(([english, chinese, body]) => (
                    <div key={english} className="px-4 py-3">
                      <div className="text-sm font-semibold text-foreground">{english}（{chinese}）</div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          title="安全提醒"
          description="Alaya 很适合加速项目，但不是让系统越权替你决定一切。"
        >
          <div className="space-y-3 p-4">
            {[
              "Alaya 不是自动替你做所有决定，它更像一个会记笔记、会追问、会复盘的项目副驾驶。",
              "红线、预算、Human Gate（人工闸门）是核心保护机制，尤其适合控制高风险自动化。",
              "高风险动作必须能预览、能回滚、能追溯；看不清后果的动作，不应该直接放行。",
            ].map((item) => (
              <div key={item} className={toneClasses("primary") + " flex gap-3 rounded-md border p-3"}>
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-sm leading-6">{item}</p>
              </div>
            ))}
            <div className="rounded-md border border-border bg-muted/25 p-3 text-xs leading-5 text-muted-foreground">
              实用建议：每次推进前先看项目设置里的红线；每次推进后看周期评审和健康证明。这样你能知道系统到底学到了什么，而不是只看它说了什么。
            </div>
          </div>
        </SectionCard>
      </div>
    </PageShell>
  );
}
