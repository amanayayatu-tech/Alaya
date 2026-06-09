# Alaya PRD

版本：v0.2
日期：2026-06-03
目标读者：后续负责实现的 Codex / 工程 Agent / 产品设计 Agent

---

## 1. 项目一句话

Alaya 是一套以 LLM 为决策核心、规则为护栏、知识库为长期记忆、预测误差为学习信号、SECI 为知识循环方法、每周人类闸门为价值校准点的 AI 一人公司操作系统。

它不是单个聊天机器人，也不是普通任务管理工具，而是一个可以围绕“想法 -> 产品 -> 发布 -> 反馈 -> 洞察 -> 下一轮迭代”持续运转的半自治公司大脑。

---

## 2. 背景与问题

### 2.1 用户真正想解决的问题

用户希望一个人可以借助 AI 管理原本需要小团队完成的工作：

- 从软件想法立项到产品开发。
- 从发布产品到运营社群。
- 从收集用户反馈到修复 Bug。
- 从复盘洞察到下一轮产品迭代。
- 从知识沉淀到长期调用。

用户愿意每周投入 2-3 小时，但不希望持续管理日常执行。系统应该在绝大多数时间自转，只在方向、意义、风险、真实世界认证等关键节点请求人类介入。

### 2.2 当前 AI Agent 系统的问题

现有 Agent 系统通常有以下缺陷：

- 会做任务，但不会形成稳定飞轮。
- 会生成文档，但知识库容易死亡。
- 会处理反馈，但缺少预测、误差、学习机制。
- 会调用上下文，但不懂显性知识和隐性知识如何互相转化。
- 会自动化执行，但缺少人类价值校准点。
- 多 Agent 并发时容易状态冲突、重复劳动、职责模糊。

### 2.3 本项目的核心判断

系统不应追求“完全无人公司”，而应追求：

> 90% 自动运转 + 每周 2-3 小时人类方向盘。

人类不管理日常任务，只负责：

- 决定做什么、不做什么。
- 判断模糊用户信号意味着什么。
- 确认高风险、不可逆、真实世界动作。
- 校准系统人格和长期原则。

### 2.4 战略定位

Alaya 第一阶段不是对外 SaaS，而是用户自己的私有生产杠杆。

本项目不以“快速卖给所有独立开发者”为第一目标，而是先服务一个真实高频工作流：帮助用户把想法、验证、开发、反馈、复盘、知识沉淀串成可持续复利的私有飞轮。

战略判断：

- Alaya 的第一价值不是商业化包装，而是让用户自己的工作流更少重复犯错。
- 前 3 轮飞轮是训练期，大概率是人类在喂系统，而不是系统立刻节省大量时间。
- 真正回报出现在第 N 轮：知识开始复用，预测误差开始校准，意义闸开始减少。
- 系统不追求 99% 全自动可靠性，而是通过人类闸门兜住方向、意义和风险。
- Alaya 不把“全自动公司”作为承诺，而把“半自治经营飞轮”作为承诺。

因此，PRD 的工程取舍必须优先保证脚手架可靠：状态、知识、追溯、误差、闸门、成本、安全，而不是优先堆叠炫目的 Agent 能力。

---

## 3. 产品目标

### 3.1 北极星目标

让一个人可以用 AI Agent 维护一个持续迭代的软件产品飞轮，并把每周人工参与时间控制在 2-3 小时以内。

### 3.2 MVP 目标

MVP 先不做真正对外发布的完整公司系统，而是做一个可运行的本地/半本地 5 Agent 飞轮操作台。

本项目的 MVP 不接受砍成“单 Agent + 单表 + CLI 实验”。5 Agent 飞轮是产品核心，不是可选优化项。MVP 可以降低每个 Agent 的能力纵深，但必须保留五个角色、五段职责、五类运行记录和完整闭环。

MVP 必须支持：

1. 创建一个产品项目。
2. 定义项目 identity、目标用户、产品假设。
3. 同时启动 Orchestrator、Sensor、Builder Adapter、Distiller、Librarian 五个 Agent 的基础流程。
4. 让系统生成本轮迭代计划。
5. 记录预测、行动、反馈、观察、误差。
6. 将反馈进入知识库。
7. 用 SECI 流程把经验转化为可复用知识。
8. 在方向闸、意义闸、风险闸请求人类确认。
9. 用预测误差和知识更新生成下一轮建议。

MVP 允许暂缓：

- 外部社群真实托管。
- 自动公开发布。
- 自动支付/法务/身份认证。
- Builder 直接执行真实代码修改。
- 大规模向量检索与多项目并行。

### 3.3 非目标

MVP 阶段不做：

- 完全无人商业运营。
- 自动注册账号、自动付款、自动法务承诺。
- 真实用户社群全自动托管。
- 多产品组合投资决策。
- 复杂权限组织管理。
- 大规模生产级云部署。

---

## 4. 目标用户

### 4.1 主要用户

独立开发者、AI 创业者、一人公司经营者。

他们的特点：

- 有大量产品想法。
- 会使用 Codex / Cursor / Claude Code / OpenAI API 等工具。
- 希望 AI 不只是帮写代码，而是帮自己维持产品飞轮。
- 能接受每周固定做少量关键判断。
- 需要知识系统避免重复造轮子。

### 4.2 次要用户

小型软件团队负责人。

他们可以用该系统管理：

- 产品迭代。
- 用户反馈。
- Bug 收敛。
- 团队知识沉淀。
- Agent 辅助开发流程。

---

## 5. 核心产品形态

系统形态建议为：

- 本地优先的 Web 应用。
- 后端负责 Agent 编排、状态存储、知识库、任务运行。
- 前端负责项目仪表盘、人类闸门、知识查看、飞轮状态。
- LLM API 先用 OpenAI 占位，保留模型供应商切换能力。
- 可选集成 GitHub、Feishu/Lark、Discord、Slack、邮件、网页表单。

MVP 可以先做成：

```text
Frontend: Next.js + React + TypeScript
Backend: Next.js API routes / Node.js service
Database: SQLite + JSON fields + version columns
Search: SQLite FTS5 / keyword search first; vector store deferred
Agent runtime: 后端服务内编排，保留 5 Agent 角色，先用顺序调度而非复杂并发框架
LLM: OpenAI Responses API 占位
```

技术栈在 MVP 阶段不再摇摆。Codex 实现时不得在 Node.js 与 Python FastAPI、Chroma 与 pgvector 等路线之间反复切换。第一版优先保证飞轮跑通、状态可靠、日志完整。

---

## 6. 核心概念

### 6.1 Flywheel 飞轮

产品每一圈迭代包含：

1. Idea / Goal：本轮想解决什么。
2. Prediction：如果这样做，系统预期外部会发生什么。
3. Build：开发、修复、发布、运营。
4. Observe：收集用户反馈、Bug、指标、社群信号。
5. Error：比较预测和现实的差异。
6. Distill：提炼经验和知识。
7. Decide：人类或系统决定下一轮方向。

### 6.2 Prediction Ledger 预测账本

每次关键行动前，系统必须记录预测。

字段：

- belief：系统当前相信的世界状态。
- prediction：行动后预期看到的反馈。
- action：采取的动作。
- observation：真实观察。
- prediction_error：预期和现实差异。
- error_type：感知误差、执行误差、模型误差、价值误差。
- update_target：需要更新的系统部分。
- human_required：是否需要人类判断。

### 6.3 Human Gates 人类闸门

系统有三类人类闸门：

1. 方向闸：本轮做什么、不做什么。
2. 意义闸：模糊反馈到底意味着什么。
3. 风险闸：涉及钱、身份、法律、不可逆动作、对外承诺。

人类闸门不是管理任务，而是注入价值判断。

### 6.4 SECI 知识螺旋

SECI 用于管理显性知识和隐性知识的转化：

- Socialization：隐性 -> 隐性。
- Externalization：隐性 -> 显性。
- Combination：显性 -> 显性。
- Internalization：显性 -> 隐性。

在本项目里，SECI 不是理论附录，而是知识系统的运行协议。

---

## 7. Agent 角色设计

### 7.1 Orchestrator 编排者

职责：

- 管理每一轮飞轮。
- 拆分任务。
- 调用其他 Agent。
- 维护 cycle 状态。
- 生成方向闸信息包。
- 决定哪些任务 blocking，哪些任务 non-blocking。

输入：

- 项目 identity。
- 当前目标。
- 上一轮 prediction ledger。
- 当前知识库摘要。
- 人类裁决记录。

输出：

- 本轮计划。
- Agent 分工。
- pending_human 事项。
- cycle summary。

不得做：

- 擅自修改 identity。
- 擅自执行高风险外部动作。
- 在不确定价值判断时自行拍板。

### 7.2 Sensor / Community 触手

职责：

- 收集用户反馈、Bug、社群讨论、表单、邮件、聊天记录。
- 对反馈做初步聚类。
- 标记情绪、频次、严重性。
- 提取用户原话。

输入：

- 外部反馈源。
- 产品版本。
- 反馈分类规则。

输出：

- feedback_items。
- bug_candidates。
- feature_requests。
- unclear_signals。

不得做：

- 替用户编造未提供的反馈。
- 把无反馈自动解释成正反馈。
- 删除原始反馈。

### 7.3 Builder Adapter 建造者适配器

职责：

- 将 Orchestrator 产出的 task spec 转换为 Codex / Claude Code 可执行的开发任务。
- 接收外部开发工具的 build report、test report、diff summary。
- 生成 changelog 和 release note 草稿。
- 在 MVP 阶段可用 mock build report 代替真实代码修改。

输入：

- task spec。
- repo context。
- playbook。
- risk constraints。

输出：

- external_tool_task。
- build report。
- test report。
- release notes。
- implementation summary。

不得做：

- 绕过测试。
- 擅自引入重依赖。
- 修改高风险配置而不触发风险闸。
- 在系统内部重造 Claude Code / Codex 的完整写代码能力。

说明：Builder 仍然是 5 Agent 飞轮的一员，但它的产品定位是“开发工具适配器”，不是自研代码生成 Agent。系统的差异化是飞轮、知识、预测误差和人类闸门，而不是重新实现一个二流代码 Agent。

### 7.4 Distiller 提炼者

职责：

- 从执行结果、反馈、预测误差中提炼知识。
- 将隐性判断外化为显性原则。
- 生成 case memory。
- 提议更新 identity、playbook、world_model。

输入：

- prediction ledger。
- feedback_items。
- decision_log。
- build_result。

输出：

- knowledge_candidates。
- principle_candidates。
- anti_patterns。
- next_cycle_insights。

不得做：

- 直接写入永久 identity。
- 把一次性偶然现象升级为长期原则。
- 删除低置信知识，只能送入 quarantine。

### 7.5 Librarian / Auditor 知识管理员

职责：

- 管理知识库结构。
- 去重、合并、版本化、冲突解决。
- 标记 stale、expired、conflict。
- 审计 Agent 是否正确调用知识。
- 管理 trash/quarantine 回捞机制。

输入：

- knowledge_candidates。
- query logs。
- conflict reports。
- usage traces。

输出：

- updated knowledge base。
- conflict resolution report。
- stale knowledge report。
- retrieval quality report。

不得做：

- 无审计地永久删除知识。
- 让过期知识支持高风险动作。
- 把低置信知识直接提升为强证据。

---

## 8. 知识库设计

### 8.1 知识分层

系统至少包含 8 类知识：

1. identity：系统人格、长期原则、红线。
2. world_model：用户、市场、产品、竞品、社群模型。
3. prediction_ledger：预测、行动、观察、误差、修正。
4. decision_log：人类裁决和结果回看。
5. playbooks：SOP、prompt、工具调用策略。
6. case_memory：用户故事、Bug 案例、失败案例。
7. facts：可验证事实、指标、外部资料。
8. quarantine/trash：低置信、过期、冲突、待复核知识。

### 8.2 显性知识

显性知识包括：

- 文档。
- SOP。
- PRD。
- 测试报告。
- Bug 单。
- 用户反馈原文。
- 指标。
- 决策记录。
- 代码变更摘要。

显性知识必须可检索、可引用、可追溯来源。

### 8.3 隐性知识

隐性知识包括：

- 用户真实意图。
- 创始人偏好。
- 产品手感。
- 社群氛围。
- “这个方向不对劲”的经验判断。
- “这个 Bug 背后其实是用户心智问题”的判断。

隐性知识不能假设可以一次性完整提取。系统只能通过：

- 观察人类裁决。
- 记录上下文。
- 生成假设。
- 通过下一轮行动检验。

逐步逼近它。

### 8.4 知识状态

每条知识必须有状态：

- draft：候选知识。
- active：可用于普通任务。
- strong：经过多轮验证，可用于重要决策。
- provisional：早期临时原则。
- stale：可能过期，只能弱引用。
- expired：不能用于决策。
- conflict：存在冲突，等待处理。
- quarantined：低置信隔离。

### 8.5 知识字段

建议数据结构：

```json
{
  "id": "kb_001",
  "project_id": "proj_001",
  "type": "identity | world_model | playbook | case | fact | principle",
  "title": "知识标题",
  "content": "知识正文",
  "source_type": "human_decision | feedback | metric | agent_observation | external_doc",
  "source_ref": "来源引用",
  "confidence_score": 0.67,
  "confidence_level": "medium",
  "evidence_alpha": 2,
  "evidence_beta": 1,
  "evidence_count": 1,
  "status": "active",
  "valid_from": "2026-06-03",
  "valid_until": null,
  "supersedes_id": null,
  "conflict_group": null,
  "created_by": "distiller",
  "approved_by": null,
  "last_used_at": null,
  "usage_count": 0,
  "tags": ["product", "user", "pricing"],
  "notes": "为什么这条知识成立"
}
```

### 8.6 置信度计算与知识状态迁移

禁止使用 LLM 自报的浮点置信度作为决策依据。`confidence_score` 必须由证据计数计算，LLM 只能负责生成候选知识和解释证据，不得直接决定知识强弱。

每条知识维护两个证据计数：

- `evidence_alpha`：支持证据。
- `evidence_beta`：反对证据。

初值：

```text
evidence_alpha = 1
evidence_beta = 1
confidence_score = evidence_alpha / (evidence_alpha + evidence_beta)
```

证据累加规则：

- 预测命中，且归一化误差 `e <= 0.3`：`alpha += 1`。
- 预测失败，且归一化误差 `e >= 0.7`：`beta += 1`。
- 灰区结果：不累加。
- 人类批准：`alpha += 3`。
- 人类否决：`beta += 3`。
- 独立外部来源验证：`alpha += 2`。
- 与 strong 知识冲突：进入 conflict，不直接覆盖。

`confidence_level` 由规则映射：

| level | 条件 |
|---|---|
| low | `confidence_score < 0.6` 或 `evidence_count = 0` |
| medium | `confidence_score >= 0.6` 且 `evidence_count >= 1` |
| high | `confidence_score >= 0.75` 且 `evidence_count >= 3` |
| verified | `confidence_score >= 0.85` 且 `evidence_count >= 5` 且至少 1 次人类批准 |

状态迁移：

| 迁移 | 触发条件 | 是否需人类 |
|---|---|---|
| draft -> active | `confidence_score >= 0.6` 且 `evidence_count >= 1` | 否 |
| active -> strong | `confidence_score >= 0.85` 且 `evidence_count >= 5` 且至少 1 次人类批准 | 是 |
| active -> stale | 超过有效期未被验证，或衰减后 `confidence_score < 0.5` | 否 |
| 任意 -> conflict | 与现有 strong 知识断言相反且证据相当 | 否，自动标记 |
| 任意 -> quarantined | `evidence_count >= 3` 且 `confidence_score < 0.35` | 否 |
| stale -> expired | stale 超过保留期且无新证据 | 否 |

硬约束：`stale`、`expired`、`quarantined`、`conflict` 状态知识不得进入高风险动作的证据集。

---

## 9. SECI 在系统中的落地

### 9.1 Socialization：隐性到隐性

目标：让 Agent 通过观察人类和用户行为，获得上下文感。

实现：

- 记录人类如何批准/否决建议。
- 记录用户原话和情绪，不只记录摘要。
- 记录社群讨论的语境。
- 记录一次任务为什么被人类觉得“不对”。

产物：

- raw_interactions。
- decision_context。
- user_story。
- founder_preference_trace。

验收：

- 系统能回放一个人类决策发生前后的上下文。
- 系统能区分“用户说的需求”和“用户可能真正遇到的问题”。

### 9.2 Externalization：隐性到显性

目标：把经验判断提炼成可讨论、可验证、可复用的显性知识。

实现：

- Distiller 每轮生成 knowledge_candidates。
- 将人类裁决转换为原则候选。
- 将 Bug 修复转换为 case memory。
- 将失败动作转换为 anti-pattern。

产物：

- principle_candidates。
- anti_patterns。
- user_need_hypotheses。
- product_judgment_notes。

验收：

- 每轮结束至少生成一份 distillation report。
- 每个候选知识都有来源、置信度、适用范围。
- 人类可以批准、修改、拒绝候选知识。

### 9.3 Combination：显性到显性

目标：让显性知识之间形成结构，而不是堆成文档垃圾场。

实现：

- Librarian 定期合并重复知识。
- 检测冲突知识。
- 标记过期知识。
- 维护索引、标签、引用关系。
- 建立从 PRD、Bug、反馈、代码变更到知识项的链接。

产物：

- merged_knowledge。
- conflict_report。
- stale_report。
- retrieval_index。

验收：

- 查询同一问题时，不返回互相矛盾且未标记的知识。
- 过期知识不能用于高风险动作。
- 每条长期知识能追溯到来源。

### 9.4 Internalization：显性到隐性

目标：让知识变成 Agent 的默认行为，而不是每次都从头读文档。

实现：

- 将 strong 知识注入 Agent system prompt。
- 将 playbook 转化为工具调用流程。
- 将 anti-pattern 转化为执行前检查项。
- 将 identity 转化为计划生成约束。

产物：

- agent_prompt_overrides。
- execution_policies。
- tool_call_recipes。
- preflight_checklists。

验收：

- Builder 在执行前能自动引用相关 playbook。
- Orchestrator 在计划时能主动避开 anti-pattern。
- Distiller 能指出本轮哪些知识被实际调用。

---

## 10. 预测编码 / Active Inference 式闭环

### 10.1 核心原则

系统每轮不是被动接收反馈，而是主动提出预测：

> 我相信世界是这样，所以我采取这个行动。如果现实不同，我就修正世界模型。

### 10.2 误差分类

1. 感知误差：
   - 数据源错。
   - 用户反馈不完整。
   - 指标口径不一致。

2. 执行误差：
   - 代码没实现好。
   - 发布失败。
   - 测试缺失。

3. 模型误差：
   - 错估用户需求。
   - 错估功能价值。
   - 错估市场阻力。

4. 价值误差：
   - 做成了，但不是用户真正想做的产品。
   - 短期指标好，但违背长期 identity。
   - 系统想优化的东西不是人类真正想维护的秩序。

### 10.3 误差处理规则

- 感知误差：更新数据源、采集方式、反馈 schema。
- 执行误差：进入 Builder 修复队列。
- 模型误差：进入 Distiller 和 world_model 更新。
- 价值误差：必须进入人类意义闸或方向闸。

### 10.4 可测量断言

每条自然语言 prediction 必须拆成一个或多个 measurable claim。系统只对可测量 claim 自动计算误差；不可测量 claim 必须进入意义闸或保持人工裁定。

| claim 类型 | 适用场景 | 误差计算 |
|---|---|---|
| metric_threshold | 指标达标，例如 activation_rate >= 0.3 | 连续误差 |
| binary | 事件是否发生，例如发布是否成功 | 命中 0，未命中 1 |
| categorical | 多选一结果，例如反馈属于 A/B/C | 命中 0，未命中 1 |
| directional | 指标方向，例如留存上升 | 方向对 0，反向 1，持平 0.5 |
| qualitative | 定性判断，例如用户觉得产品更顺手 | 不自动计算，进入意义闸 |

### 10.5 误差量化公式

对 `metric_threshold` 类 claim，使用归一化误差 `e`，范围为 `[0, 1]`：

```text
e = clip(max(0, d * (T - O)) / s, 0, 1)
```

含义：

- `T`：目标值。
- `O`：观察值。
- `d`：方向因子，达标方向为 `+1`。
- `s`：容差尺度，默认取目标值或历史标准差。
- 达标或超额完成时 `e = 0`。
- 差距越大，`e` 越接近 `1`。

一轮 cycle 的整体预测误差：

```text
E_cycle = sum(w_i * e_i^2) / sum(w_i)
```

使用平方误差是为了惩罚少数大错，避免系统用大量低价值小预测掩盖关键预测失败。

### 10.6 误差归因决策树

误差归因必须按以下顺序判定：

1. 若 observation 数据源缺失、口径不一致、采集失败：`error_type = perception`。
2. 若关联 task 的 build_result 失败、测试缺失、发布未完成：`error_type = execution`。
3. 若指标达标但人类标记“方向不对 / 违背 identity”：`error_type = value`。
4. 以上都不成立且误差超过阈值：`error_type = model`。
5. qualitative claim 不进入自动归因，默认进入意义闸或人工 review。

### 10.7 预测账本字段

```json
{
  "id": "pred_001",
  "cycle_id": "cycle_001",
  "belief": "早期用户最关心的是快速发布，而不是高级定制。",
  "prediction": "如果本轮上线一键发布能力，至少 30% 的活跃测试用户会尝试。",
  "action": "开发一键发布 MVP。",
  "claims": [
    {
      "id": "claim_001",
      "type": "metric_threshold",
      "metric": "activation_rate",
      "operator": ">=",
      "target": 0.3,
      "time_window": "7d",
      "weight": 3
    }
  ],
  "observation": null,
  "prediction_error": null,
  "error_type": null,
  "update_target": null,
  "status": "open"
}
```

---

## 11. 人类闸门设计

### 11.1 方向闸

触发：

- 每轮开始。
- 出现重大方向变化。
- 连续两轮目标未达成。

信息包：

- Agent 推荐目标。
- 两个备选目标。
- 被搁置目标和理由。
- 上一轮预测误差。
- 相关知识引用。
- 风险提示。

人类动作：

- 批准推荐。
- 改选备选。
- 修改目标。
- 否决重排。

### 11.2 意义闸

触发：

- 用户反馈模糊。
- Agent 判断置信度处于灰区。
- 多个解释互相冲突。
- 价值误差出现。

信息包：

- 用户原话。
- Agent 的三个解释。
- 每个解释的证据。
- 推荐处理方式。
- 如果不处理的风险。

人类动作：

- 认定为有效信号。
- 认定为噪声。
- 标记继续观察。
- 修改解释。

### 11.3 风险闸

触发：

- 涉及支付、退款、合同、法务。
- 涉及身份认证、账号授权。
- 涉及删除数据、公开发布、对外承诺。
- 涉及用户隐私或敏感信息。

规则：

- 风险闸必须 blocking。
- 超时不能自动通过。
- 系统只能进入安全模式。

### 11.4 闸门预算与降噪

人类每周可投入时间默认为 2-3 小时，因此系统必须有 gate budget，而不是无限创建 pending_human。

默认预算：

```text
weekly_human_minutes = 150
direction_gate_budget = 30 分钟
meaning_gate_budget = 70 分钟
risk_gate_budget = 30 分钟
review_buffer = 20 分钟
```

降噪规则：

- 同一主题、同一用户群、同一功能点的意义闸必须合并。
- 低风险知识候选默认批量展示，允许一次批准/拒绝多条。
- 如果某类意义闸连续 10 次人类批准率 > 95%，下一轮降级为自动通过 + 抽样复核。
- 如果某类意义闸连续 10 次人类否决率 > 80%，下一轮自动提高触发阈值。
- 风险闸永远不自动通过。
- 超出周预算时，non-blocking 意义闸进入 observation backlog，不阻塞系统低速运行。
- blocking 闸门超过 3 条或超过 5 天未处理，系统进入安全模式：冻结新立项，只做反馈收集、知识整理和低风险维护。

---

## 12. 状态与并发设计

### 12.1 不使用单个共享 YAML 作为生产状态

MVP 可以导出 YAML/Markdown，但内部状态必须使用数据库。

原因：

- 多 Agent 并发读写会冲突。
- 单文件难以版本化字段。
- 读改写整个文档容易损坏状态。

### 12.2 数据库设计原则

- 每张表有 version 字段。
- 写入时使用乐观并发控制。
- Agent 只能写自己有权限的字段。
- 任务级锁，而不是全局锁。
- 所有状态变化进入 event_log。

### 12.3 核心表

- projects。
- cycles。
- agents。
- tasks。
- feedback_items。
- predictions。
- observations。
- knowledge_items。
- human_gate_items。
- decision_log。
- event_log。

---

## 13. 核心流程

### 13.1 创建项目

用户输入：

- 项目名称。
- 产品方向。
- 目标用户。
- 当前阶段。
- 人类红线。
- 每周可投入时间。

创建项目必须包含 onboarding interview。系统不得凭空生成 seed identity 和 world_model。

Onboarding interview 至少覆盖：

- 产品一句话。
- 目标用户。
- 当前最想验证的假设。
- 绝不做什么。
- 高风险红线。
- 创始人偏好。
- 已知竞品。
- 当前可用反馈来源。
- 每周人工预算。
- 第一轮希望看到的外部信号。
- 第一轮可观测 claim 配置：metric、operator、target。

系统输出：

- seed identity。
- 初始 world_model。
- 第一轮候选目标。
- 第一轮 prediction ledger 的默认 measurable claim 配置。

### 13.2 开始一轮飞轮

流程：

1. Orchestrator 读取 identity、world_model、上轮结果。
2. 生成三个候选目标。
3. 创建方向闸。
4. 人类确认。
5. 系统生成 prediction ledger，并拆成 measurable claims。
6. Sensor、Builder Adapter、Distiller、Librarian 均进入本轮任务队列，保留 5 Agent 飞轮记录。

### 13.3 收集反馈

流程：

1. Sensor 导入外部反馈。
2. 分类为 bug、feature_request、unclear_signal、metric_signal。
3. 对明确 Bug 创建任务。
4. 对模糊信号创建意义闸候选。

### 13.4 结束一轮飞轮

流程：

1. 汇总行动结果。
2. 对比 prediction 和 observation。
3. 分类 prediction_error。
4. Distiller 生成知识候选。
5. Librarian 合并知识。
6. Orchestrator 生成下一轮建议。

---

## 14. 前端页面需求

### 14.1 Dashboard

展示：

- 当前项目。
- 当前 cycle。
- 飞轮阶段。
- pending_human 数量。
- 本周人工用时。
- open predictions。
- blocking risks。
- 最近知识更新。

### 14.2 Human Gates 页面

功能：

- 查看方向闸、意义闸、风险闸。
- 批准、否决、修改。
- 查看 Agent 推荐理由。
- 查看被筛掉选项。
- 查看相关知识引用。

### 14.3 Prediction Ledger 页面

功能：

- 查看每条预测。
- 查看实际观察。
- 查看误差类型。
- 查看系统修正动作。
- 查看预测准确率趋势。

### 14.4 Knowledge Base 页面

功能：

- 按 type/status/tag 查看知识。
- 查看来源和引用。
- 查看 stale/conflict/quarantine。
- 批准候选知识进入 active/strong。
- 查看知识被哪些 Agent 调用。

### 14.5 Cycle Review 页面

功能：

- 本轮目标。
- 做了什么。
- 哪些预测对了/错了。
- 用户反馈摘要。
- Bug 修复摘要。
- 知识更新摘要。
- 下一轮建议。

---

## 15. 后端 API 需求

### 15.1 项目

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`

### 15.2 飞轮周期

- `POST /api/projects/:id/cycles`
- `GET /api/cycles/:id`
- `POST /api/cycles/:id/start`
- `POST /api/cycles/:id/close`

### 15.3 人类闸门

- `GET /api/human-gates`
- `GET /api/human-gates/:id`
- `POST /api/human-gates/:id/approve`
- `POST /api/human-gates/:id/reject`
- `POST /api/human-gates/:id/modify`

### 15.4 预测账本

- `POST /api/predictions`
- `GET /api/cycles/:id/predictions`
- `PATCH /api/predictions/:id/observation`
- `PATCH /api/predictions/:id/error`

### 15.5 知识库

- `POST /api/knowledge`
- `GET /api/knowledge`
- `GET /api/knowledge/:id`
- `PATCH /api/knowledge/:id`
- `POST /api/knowledge/:id/approve`
- `POST /api/knowledge/:id/quarantine`
- `POST /api/knowledge/search`

### 15.6 Agent 运行

- `POST /api/agents/orchestrator/run`
- `POST /api/agents/sensor/run`
- `POST /api/agents/builder/run`
- `POST /api/agents/distiller/run`
- `POST /api/agents/librarian/run`

---

## 16. LLM Prompt 约束

每个 Agent 调用 LLM 时必须包含：

- 当前角色。
- 当前任务。
- 可用知识摘要。
- 禁止事项。
- 输出 JSON Schema。
- 是否允许创建 human gate。
- 是否允许写知识库。

LLM 输出必须结构化，不允许只输出自然语言。

示例：

```json
{
  "summary": "本轮建议优先修复用户注册流程。",
  "recommended_action": {},
  "alternatives": [],
  "knowledge_refs": [],
  "human_gate_required": true,
  "human_gate_type": "direction",
  "confidence_level": "medium",
  "confidence_evidence": {
    "alpha": 2,
    "beta": 1,
    "reason": "有一条用户反馈和一条历史预测支持"
  },
  "risks": []
}
```

### 16.1 LLM 输出契约与降级

每次 LLM 输出必须经过 schema 校验。

失败处理：

1. 第一次失败：带 schema error retry。
2. 第二次失败：降级到更简单 schema。
3. 第三次失败：创建 non-blocking human gate 或写入 agent_error。
4. 涉及风险闸时：直接 blocking，不允许自动降级通过。

所有 LLM 调用必须记录：

- prompt_version。
- input 摘要。
- output 摘要。
- schema_valid。
- retry_count。
- latency_ms。
- token_count。
- estimated_cost。
- error_message。

---

## 17. MVP 验收标准

### 17.1 功能验收

MVP 完成时，系统必须能：

- 创建项目。
- 创建并启动一轮 cycle。
- 生成方向闸。
- 记录人类决策。
- 创建预测账本。
- 将预测拆成 measurable claims。
- 导入或手动录入反馈。
- 生成观察结果。
- 计算预测误差。
- 根据证据更新知识置信度。
- 生成知识候选。
- 批准知识进入 active。
- 生成下一轮建议。

### 17.2 知识验收

系统必须能证明：

- 每条知识有来源。
- 每条长期知识有状态。
- 过期知识不会被用于高风险建议。
- 人类裁决会进入 decision_log。
- Agent 调用知识会留下记录。

### 17.3 飞轮验收

至少跑通 4 轮模拟飞轮：

- 第 1 轮：冷启动项目。
- 第 2 轮：根据反馈修正 world_model。
- 第 3 轮：复用前两轮知识生成更好的计划。
- 第 4 轮：把第 3 轮的“看到将改什么”升级为 rollback-ready change package + audit summary。

通过标准：

- 第 3 轮建议中能明确引用前两轮的知识。
- 第 3 轮建议必须说明被引用知识如何改变了建议，而不是只形式引用知识 ID。
- 第 4 轮必须使用独立命名的 gate/prediction/action,不得复用第 3 轮模板。
- 第 4 轮的 direction gate 或 Builder task spec 必须包含 rollbackPlan、rollbackTrigger、rollbackSteps、riskLevel 与 auditSummary。
- 第 4 轮必须由 Distiller 生成至少一条 `knowledge_items.type = "principle"` 且 `createdByCycle = 4` 的知识,内容指向“高风险动作必须具备可回滚路径与审计摘要”。
- 未显式定义的第 5 轮及以后不得自动回退到第 3 或第 4 轮模板。
- 系统不会重复提出已被否决的方向，除非提供新证据。
- 人类 pending 队列不会无限膨胀。
- 5 个 Agent 均必须留下本轮运行记录，即使其中某些 Agent 只执行 mock 或 adapter 行为。

---

## 18. 安全与治理

### 18.1 高风险动作

以下动作必须触发风险闸：

- 付款。
- 退款。
- 删除生产数据。
- 发布公开声明。
- 修改价格。
- 发送批量邮件。
- 访问隐私数据。
- 第三方账号授权。

### 18.2 隐私

- 用户反馈入库前标记是否含 PII。
- 发送给外部 LLM 前做脱敏。
- 不在 prompt 中泄露密钥。
- event_log 不记录完整 secret。

### 18.3 失败模式

系统必须处理以下失败模式：

| 失败模式 | 检测信号 | 降级动作 |
|---|---|---|
| 人类两周未处理 pending_human | pending_human 超过 SLA | 冻结新立项，只做低风险维护和知识整理 |
| Agent 重复生成相同任务 | task fingerprint 重复 | 合并任务，写入 anti-pattern |
| 知识冲突 | 新知识与 strong 知识断言相反 | 标记 conflict，禁止用于高风险动作 |
| 预测连续失败 | 连续 2 轮 `E_cycle` 高于阈值 | 触发方向闸，要求重审 world_model |
| LLM 输出不符合 schema | schema validation 连续失败 | retry -> 简化 schema -> human gate |
| 外部反馈源不可用 | 数据源连接失败或为空 | 标记 perception error，不自动解释为无反馈 |
| LLM 成本失控 | token 或费用超过预算 | 停止低优先级调用，只保留风险闸和方向闸 |
| Agent 死循环 | 同一 Agent 连续执行相同动作 | 熔断该 Agent，交 Orchestrator 汇总 |
| Builder 执行风险 | 代码变更涉及依赖、删除、权限、密钥 | 触发风险闸，要求人工确认 |

### 18.4 LLM 成本预算

MVP 必须支持项目级 token budget：

- 每个 cycle 有 token 上限。
- 每个 Agent 有调用上限。
- Librarian 不允许每轮全库扫描，必须按变更集增量处理。
- 超预算时优先保留 Orchestrator、风险闸、方向闸，暂停低优先级总结。

### 18.5 代码执行安全

Builder Adapter 在 MVP 阶段不得自动执行破坏性命令。涉及代码修改时：

- 默认生成 task spec 和 build report schema。
- 真实代码修改交给 Codex / Claude Code 外部工具。
- 接收外部工具返回的 diff summary、test report、failure log。
- 涉及删除文件、修改依赖、修改密钥、执行迁移、公开发布时触发风险闸。

---

## 19. 阶段路线图

### Phase 0：PRD 与原型

产物：

- 本 PRD。
- 信息架构。
- 数据模型。
- 简单 UI 原型。
- 预测误差计算函数规范。
- 证据置信度规则。
- 5 Agent 飞轮骨架图。

### Phase 0.5：算法与飞轮骨架验证

产物：

- `compute_error` 纯函数。
- `classify_error` 纯函数。
- `update_confidence` 纯函数。
- 知识状态迁移函数。
- 5 Agent 顺序调度 mock。
- 4 轮飞轮数值模拟,其中第 4 轮验证可回滚变更包、审计摘要和新治理原则。

约束：Phase 0.5 不是砍掉 5 Agent，而是在不接真实外部工具前，先让五个 Agent 以 mock/adapter 形态跑完整飞轮。

### Phase 1：本地 MVP

产物：

- 本地 Web App。
- SQLite 数据库。
- 手动反馈录入。
- 5 个 Agent 的基础流程，不可砍。
- 人类闸门页面。
- 预测账本页面。
- 知识库页面。
- 闸门预算与 pending_human 降噪。
- LLM 调用日志与成本统计。

### Phase 2：真实项目灰度

产物：

- 接入一个真实软件项目 repo。
- Builder 可以生成真实代码任务。
- Sensor 支持 GitHub issues 或表单反馈。
- Distiller 生成真实知识候选。

### Phase 3：外部运营集成

产物：

- 接入 Feishu/Lark、Discord、邮件或社群。
- 支持自动回复低风险标准问题。
- 支持发布 release notes。

### Phase 4：半自治飞轮

产物：

- 连续 4 周 cycle 自动完成。
- 每周人工处理时间 < 3 小时。
- pending_human 无无限堆积。
- 知识库 conflict 比例 < 10%。
- stale/expired 知识不参与高风险建议。
- 系统根据裁决继续转下一轮。

---

## 20. 给 Codex 的实施指令

如果让 Codex 根据本 PRD 开始制作，实施顺序如下。注意：5 Agent 飞轮是第一版必须保留的骨架，不得优化成单 Agent。

1. 创建一个新项目目录。
2. 初始化 Next.js + TypeScript + SQLite。
3. 实现数据库 schema、version 字段、event_log。
4. 实现 `compute_error`、`classify_error`、`update_confidence`、知识状态迁移，并写单元测试。
5. 实现 5 Agent 的顺序调度骨架：Orchestrator、Sensor、Builder Adapter、Distiller、Librarian。
6. 实现 project/cycle/human_gate/prediction/knowledge 的 CRUD。
7. 实现 onboarding interview 和 seed identity/world_model 写入。
8. 跑通 4 轮 mock 飞轮，每轮五个 Agent 都必须写运行记录；第 4 轮必须产出可回滚变更包、审计摘要和 `createdByCycle=4` 的 principle。
9. 实现前端 Dashboard、Human Gates、Prediction Ledger、Knowledge Base、Cycle Review。
10. 接入 OpenAI API，并加 schema 校验、retry、降级、调用日志、成本统计。
11. 实现 gate budget、意义闸合并、pending_human 安全模式。
12. 将 Builder Adapter 接到 Codex/Claude Code task spec 输出，不在系统内部重写代码生成器。
13. 最后接 GitHub issues、表单反馈或其他真实反馈源。

第一版优先保证：

- 状态可靠。
- 结构清楚。
- 5 Agent 飞轮完整。
- 人类闸门可用。
- 知识来源可追踪。
- 预测误差可计算。
- 置信度由证据更新。
- 飞轮能跑通。

不要第一版就追求：

- 高级自动化。
- 复杂并发多 Agent 框架。
- 完整外部集成。
- 漂亮但不可用的前端。

---

## 21. 成功标准

项目成功不是看 Agent 生成了多少内容，而是看：

- 人类是否真的只处理关键判断。
- 系统是否能减少重复劳动。
- 知识库是否越跑越有用，而不是越跑越乱。
- 下一轮决策是否能引用上一轮经验。
- 预测误差是否能驱动系统修正。
- Agent 是否知道什么时候该停下来问人。

最终目标：

> 让一个独立开发者拥有 Alaya：一个能持续学习、持续执行、持续沉淀、持续自我修正的 AI 公司操作系统。

---

## 22. 可能出现的问题、核心难点与极难克服项

本章用于约束实现预期。Alaya 的风险不在于“功能做不出来”，而在于“功能都做出来后，飞轮仍然不产生真实复利”。以下问题不得被视为普通 bug，而应被视为系统级难点。

### 22.1 总体风险判断

Alaya 落在一个“价值很高、成功率很低”的象限。

价值高，是因为它试图把想法、开发、发布、反馈、洞察、知识沉淀串成连续飞轮；成功率低，是因为当前 AI Agent 更擅长单点任务，而不擅长跨环节、跨时间、带责任约束的长期闭环。

因此，第一版实现成功只代表“系统能跑”，不代表“系统真的有用”。真正的有效性必须在连续多轮真实工作流中观察。

### 22.2 最可能出现的问题

| 问题 | 表现 | 根因 | 缓解方案 | 残余风险 |
|---|---|---|---|---|
| 飞轮空转 | Agent 每轮都生成总结、建议、知识，但下一轮没有明显变好 | LLM 擅长解释，不等于擅长学习 | 强制 prediction ledger、知识引用影响说明、3 轮后复盘 | 仍可能只是形式引用 |
| 知识库膨胀 | active 知识越来越多，检索越来越差 | 系统默认沉淀，缺少淘汰 | stale/expired/quarantine、Librarian 增量审计 | 删除错知识会造成隐性损失 |
| 伪知识污染 | 一次偶然事件被提炼成长期原则 | Distiller 把局部经验过度抽象 | 证据计数、human approval、strong 晋级门槛 | 早期数据少时仍难避免 |
| 人类闸门爆炸 | pending_human 越积越多 | 意义闸、风险闸、知识审批都消耗人类注意力 | gate budget、合并、抽样、低速模式 | 真实噪声高时仍会压垮人类 |
| 预测账本形式化 | 预测写得像口号，不可证伪 | LLM 偏好模糊语言 | measurable claims、qualitative 进意义闸 | 重要判断往往就是 qualitative |
| 错误归因 | 明明是数据问题，却被当成模型误差；明明是价值问题，却被当成执行问题 | 现实反馈通常多因一果 | 误差归因决策树、人类 review、conflict 标记 | 很多归因永远无法确定 |
| Agent 职责重叠 | Orchestrator、Distiller、Librarian 对同一事项给出不同判断 | 真实任务边界天然模糊 | 字段级写权限、仲裁规则、event_log | 边界维护成本高 |
| Builder 风险 | task spec 导致外部 Codex/Claude Code 修改错误文件或引入隐患 | 代码执行是高风险动作 | Builder Adapter、diff summary、测试、风险闸 | 仍依赖外部工具质量 |
| 成本失控 | LLM 调用、总结、检索、重试消耗过高 | 多 Agent + 长上下文天然耗 token | token budget、增量处理、低优先级暂停 | 复杂项目成本仍可能偏高 |
| 用户反馈噪声 | 真实反馈矛盾、情绪化、不可量化 | 用户语言不是干净数据 | Sensor 保留原文、聚类、意义闸 | 模糊反馈仍需人类判断 |

### 22.3 极难克服的问题

以下问题不是靠多写几个 prompt 或多加几个表就能解决的，只能通过架构约束、长期校准和人类闸门缓解。

#### 22.3.1 隐性知识无法被完全捕获

创始人的判断、产品手感、用户语境、方向直觉，很多时候并没有被明确表达。Alaya 只能捕获被记录、被裁决、被反馈暴露出来的那部分隐性知识。

系统必须承认：

- founder model 永远不完整。
- 涉及创始人偏好、产品气质、长期方向的判断，默认更容易升级为意义闸。
- 不允许把“观察到几次人类裁决”误认为“已经理解人类”。

无法根治点：人类自己也未必能清晰说出为什么某个方向“不对”。

#### 22.3.2 价值误差很难自动检测

价值误差指“事情做成了，但不是应该做的事”。这是 Alaya 最关键、也最难自动化的误差类型。

系统可以检测：

- 连续预测失败。
- 指标达标但人类否决。
- 与 identity 冲突。
- 用户反馈与预期目标错位。

但系统很难自动判断：

- 这个方向是不是值得继续。
- 这个用户反馈是噪声还是未来趋势。
- 短期指标好是否会伤害长期产品。
- 某次成功是否只是偶然。

无法根治点：价值判断本质上需要责任主体。Alaya 可以辅助，但不能替代。

#### 22.3.3 真实世界反馈没有干净奖励函数

在模型训练、自动调参等窄场景中，系统可以依赖明确数值反馈。但 Alaya 处理的是产品、用户、社群、运营、开发的混合反馈。

困难在于：

- 用户不一定说真需求。
- 数据不一定反映价值。
- 指标上升不一定代表方向正确。
- 没有反馈不等于没有问题。
- 有强烈反馈不等于值得做。

无法根治点：Alaya 的很多学习信号必须经过人类解释，不能完全自动闭环。

#### 22.3.4 多 Agent 协同的复杂度会持续上升

5 Agent 飞轮是产品核心，但它也天然带来复杂度：

- 每个 Agent 都有上下文。
- 每个 Agent 都可能产生知识。
- 每个 Agent 都可能误解其他 Agent 的输出。
- 状态同步、冲突解决、权限边界会持续消耗工程精力。

缓解原则：

- MVP 保留 5 Agent 角色，但先用顺序调度。
- 不做复杂并发多 Agent 框架。
- 所有 Agent 行为必须进入 event_log。
- 所有写入必须有 owner 和 version。

无法根治点：只要保留 5 Agent 飞轮，就必须长期维护协调成本。

#### 22.3.5 人类 2-3 小时预算可能不够

PRD 的核心承诺是每周 2-3 小时人类方向盘。但真实系统接入后，早期很可能需要更多时间。

特别是前 3 轮：

- 人类要喂 seed identity。
- 人类要纠正错误提炼。
- 人类要处理过多意义闸。
- 人类要校准 world_model。
- 人类要判断哪些知识可以保留。

因此，前 3 轮不得作为“节省时间”的验证期，而应作为“训练系统”的投入期。

无法根治点：如果系统长期无法把人类时间降到 3 小时以内，Alaya 就没有形成私有杠杆。

#### 22.3.6 它可能做成了，却不值得继续做

Alaya 的工程实现可行，不代表产品经济性成立。

风险包括：

- 维护成本高于节省时间。
- 复杂度高于用户能承受的使用门槛。
- 只有作者本人能用，难以迁移给他人。
- 通用化后失去针对性，针对性强又难商业化。

因此第一阶段必须坚持“私有生产杠杆”定位，不急于对外 SaaS 化。

无法根治点：通用产品和私人工具之间存在结构性张力。

### 22.4 高难度工程点

| 工程点 | 难点 | 第一版要求 |
|---|---|---|
| 状态一致性 | 多 Agent 写入、重试、失败回滚 | SQLite version + event_log + owner 权限 |
| LLM 输出稳定性 | JSON schema 失败、字段语义错位 | schema validate + retry + downgrade |
| 知识检索质量 | 知识多后检索错、漏、旧 | FTS5 + 状态过滤 + 来源追溯 |
| 成本控制 | 多 Agent 调用成本增长 | token budget + 增量处理 |
| 闸门控量 | 人类注意力有限 | gate budget + 合并 + backlog |
| 真实反馈导入 | 外部数据混乱、缺失、噪声 | 先手动录入，再接 GitHub/form |
| Builder 安全 | 代码修改风险 | Adapter 模式，不内建自动执行 |
| Prompt 版本管理 | prompt 改动会改变系统行为 | prompt_version 落盘 |
| 测试策略 | 飞轮系统难写单测 | 纯函数单测 + 4 轮模拟 + event replay |

### 22.5 必须设置的失败阈值

如果出现以下情况，应暂停扩张，回到架构修正，而不是继续加功能：

- 连续 3 轮 cycle 后，下一轮建议仍无法说明“前轮知识如何改变了本轮决策”。
- 连续 2 周 pending_human 超过预算 2 倍。
- 知识库 active 项持续增长，但 strong 项几乎不增长。
- 预测大量停留在 qualitative，无法形成 measurable claims。
- 人类每周投入持续超过 5 小时。
- Builder Adapter 生成的 task spec 多次导致外部代码工具误改方向。
- Librarian 无法有效识别 stale/conflict。
- LLM 成本超过用户愿意为该私有杠杆支付的预算。

### 22.6 判断项目是否进入正确轨道

Alaya 进入正确轨道的信号不是“Agent 输出更多”，而是：

- 人类需要解释的重复问题减少。
- 下一轮计划越来越少从零开始。
- 被否决方向不再反复出现。
- 知识库开始淘汰，而不只是新增。
- 意义闸数量下降，但质量上升。
- 预测从模糊自然语言逐渐变成可测量断言。
- 系统能主动说“我不知道，需要人类判断”。

如果这些信号没有出现，即使功能完整，也应视为飞轮没有真正转起来。

### 22.7 风险分层矩阵

以下风险不应被理解为“上线后再观察”的普通风险，而应作为 Alaya 的架构约束。第一版必须让这些风险可见、可记录、可降级，否则系统越自动化，误差越容易被包装成进步。

| 层级 | 风险类型 | 典型表现 | 最坏后果 | 第一版必须具备的缓解机制 |
|---|---|---|---|---|
| P0 | 价值方向误判 | 系统持续推进一个指标好但意义错的方向 | 飞轮越转越偏，用户信任崩溃 | blocking direction gate、identity 冲突检测、人工否决记录 |
| P0 | 预测误差定义失败 | prediction_error 无法判断，或被系统随意解释 | 学习信号失真，系统无法真正改进 | 每条 prediction 必须声明观测口径、时间窗、成功阈值 |
| P0 | 知识污染 | 错误经验被写成 strong knowledge 并反复调用 | 后续 Agent 以错误知识为前提持续决策 | knowledge source、confidence、review_status、stale/conflict 审计 |
| P1 | 人类闸门淹没 | pending gate 过多，人类不再认真判断 | 人类变成橡皮图章，系统失去价值校准 | gate budget、合并同类项、低价值闸门自动降级 |
| P1 | 多 Agent 责任空洞 | 每个 Agent 都“合理”，整体结果却错误 | 难以追责，无法定位修正点 | event_log、agent trace、输入输出版本化 |
| P1 | 外部反馈噪声 | issue、社群、表单反馈大量重复或情绪化 | Sensor 被噪声牵引，方向频繁摇摆 | 去重、来源权重、反馈分类、meaning gate |
| P2 | 成本失控 | LLM 调用量随知识库和周期增长 | 私人工具经济性消失 | token budget、缓存、增量摘要、模型分层 |
| P2 | 工具链不稳定 | Codex/GitHub/表单/API 中断或格式变化 | 自动化链路频繁卡死 | adapter 隔离、失败重试、人工 fallback |
| P2 | 迁移性不足 | 只有创建者本人能理解和使用 | 难以产品化，但不一定影响私用价值 | onboarding interview、project identity、world_model 显性化 |

### 22.8 预测编码闭环的核心断点

Alaya 的理论核心接近“预测编码式大脑”：系统基于当前 belief/world_model 生成 prediction，通过外部 observation 修正 belief，再推动下一轮 action。这个设计有价值，但它最难的地方不是生成 prediction，而是防止 prediction_error 被错误定义。

最可能出现的断点：

- 观测信号不干净：用户反馈、开发进度、社群反应、收入数据往往混在一起，无法像模型训练 loss 那样直接作为奖励函数。
- 反馈严重延迟：一个产品方向可能 2 周后才有用户反馈，3 个月后才体现商业价值，短周期飞轮容易过早否定正确方向。
- 系统会追逐可测指标：一旦某些指标更容易被观测，Agent 可能倾向于优化它们，而不是优化真正重要但难测的价值。
- 预测会自我实现：系统预测某方向重要，于是 Builder 投入更多资源，最后该方向有更多结果，看起来像预测正确，但其实是资源倾斜造成的。
- 预测会自我保护：Agent 可能把失败解释成外部噪声、执行不足、时间不够，而不是承认 belief 错误。
- 价值误差不等于事实误差：事实预测可以被数据修正，但“该不该做”“值不值得做”“是否符合身份”这类判断不能完全交给数据。

第一版必须采用的设计原则：

- prediction 必须包含 `claim`、`expected_observation`、`time_window`、`success_threshold`、`failure_threshold`、`uncertainty`。
- observation 必须记录来源、采集方式、时间、是否经过人工解释。
- prediction_error 只能分为 `confirmed`、`partially_confirmed`、`disconfirmed`、`inconclusive`，不得强行把不确定解释成成功。
- belief 更新必须说明“哪条 observation 改变了哪条 belief”，不能只生成新的总结。
- 对于价值类预测，默认进入 meaning gate，而不是自动更新 world_model。
- 连续 2 次 inconclusive 的预测必须降级，不得继续作为强依据。

极难克服点：真实世界产品系统没有天然的、即时的、无争议的误差信号。Alaya 只能把 prediction_error 管得更透明，不能把价值判断完全数学化。

### 22.9 知识飞轮的核心断点

Alaya 的长期价值取决于知识库是否越用越准，而不是越用越大。知识管理最难的地方在于：显性知识可以存储，但隐性知识只能被部分外化；显性知识可以检索，但“什么时候该调用哪条知识”依然高度依赖语境。

可能出现的问题：

- 知识库变成文档垃圾场：所有 cycle 都沉淀内容，但没有淘汰、合并、冲突处理。
- 隐性知识外化失真：人类的真实判断被 Distiller 简化成漂亮但空泛的原则。
- 旧知识继续影响新决策：市场、产品、用户、模型能力变化后，旧结论没有过期机制。
- Agent 调用知识时断章取义：某条知识在原语境成立，但被用于完全不同的场景。
- 强知识过早形成：一次成功经验被提升为 strong，导致后续系统过度相信。
- 知识来源权重不清：用户反馈、创始人判断、LLM 推断、数据指标混在一起，系统无法区分可信度。
- 反例沉淀不足：系统喜欢记录“做成了什么”，但不记录“为什么不该做什么”。
- 权限与责任不清：多个 Agent 都能写知识时，错误知识的 owner、reviewer、修订责任会模糊。

第一版知识库必须坚持：

- 每条知识都要有 `source_event_id` 或 `source_cycle_id`。
- 每条知识都要有 `knowledge_type`：fact、principle、heuristic、decision、anti_pattern、open_question。
- 每条知识都要有 `confidence`，且 strong 必须来自多轮证据或人工确认。
- 每条知识都要有 `scope`，说明适用边界。
- 每次被 Agent 调用都要记录 `retrieval_reason`。
- Librarian 必须能标记 `stale`、`conflict`、`duplicate`、`overgeneralized`。
- 反例和否决原因必须作为一等知识保存。

极难克服点：知识调用不是检索问题，而是语境判断问题。RAG 可以找到相似文本，但不能保证它知道“这条经验现在是否仍然该用”。

### 22.10 5 Agent 飞轮的核心断点

5 Agent 不可以砍掉，因为它们对应飞轮中的五种不同职责。但保留 5 Agent 的代价是：系统会出现局部理性、全局失真的问题。

关键断点：

- Orchestrator 可能过度规划，生成看似完整但不可执行的 cycle。
- Sensor 可能被高噪声反馈牵引，误把声音最大的人当成最重要的用户。
- Builder 可能把模糊策略转成过度具体的任务，导致外部 Codex 执行偏航。
- Distiller 可能把一次偶然结果总结成稳定原则。
- Librarian 可能过度保守，保留太多知识；也可能过度清理，删除有价值的弱信号。
- Agent 之间可能互相确认错误：前一个 Agent 的错误输出被后一个 Agent 当成事实。
- Agent prompt 改动可能改变整个系统行为，但这种变化不容易被测试覆盖。

第一版必须约束：

- 5 Agent 可以顺序运行，但不能共享未经版本化的隐式上下文。
- 每个 Agent 的输入必须明确列出：cycle、retrieved_knowledge、human_decisions、observations。
- 每个 Agent 的输出必须落盘，且带 prompt_version。
- 后续 Agent 引用前序 Agent 输出时，必须保留引用关系。
- 任何跨 Agent 的关键结论，都必须能从 event_log 回放。
- 如果某个 Agent 输出 schema 失败，不允许静默跳过，只能降级为 human gate 或 fallback draft。

极难克服点：多 Agent 系统的失败常常不是单个 Agent 犯错，而是多个看似合理的中间结果组合成错误方向。这类问题只能通过 trace、回放和闸门降低伤害，无法靠一次 prompt 优化根治。

### 22.11 第一版不应试图根治的问题

为了避免 MVP 被“理论正确性”拖死，以下问题第一版只做承认、记录、降级，不做彻底解决：

- 不追求全自动价值判断：意义判断必须保留人类最终责任。
- 不追求完美预测模型：只要求 prediction 可观察、可回放、可修正。
- 不追求完整隐性知识捕获：只捕获被决策、反馈、否决暴露出来的部分。
- 不追求复杂多 Agent 并发：先顺序调度，确保 trace 清晰。
- 不追求通用 SaaS：先服务一个真实使用者的私有生产杠杆。
- 不追求所有外部工具接入：优先 GitHub Issues / 表单 / 手动反馈。
- 不追求知识库自动自治：strong knowledge 必须有人类确认或多轮证据。
- 不追求“节省第一周时间”：前 3 轮应被视为训练和校准系统。

### 22.12 最应该警惕的伪成功

Alaya 最危险的不是做不出来，而是看起来做出来了。

伪成功包括：

- Agent 每轮都能产出报告，但报告没有改变下一轮行动。
- 知识库越来越大，但很少被正确调用。
- Dashboard 指标越来越多，但人类更难判断方向。
- 预测都被标记为成功，但缺少清晰观测依据。
- 每个 Agent 输出都很流畅，但没有一个 Agent 愿意说“不知道”。
- 人类闸门数量下降，是因为系统绕过了人类，而不是因为问题变少。
- Builder 任务越来越多，但真正可发布、可反馈、可学习的产出没有增加。
- 系统形成“解释一切”的能力，却没有形成“承认错误”的能力。

因此，第一版验收时不能只看功能是否跑通，还必须看：

- 是否出现了真实 prediction_error。
- 是否有 belief 被 prediction_error 改写。
- 是否有知识被删除、降级或标记冲突。
- 是否有 Agent 主动触发 human gate。
- 是否有下一轮 action 明确引用上一轮学习。
- 是否能从 event_log 解释一次完整决策链。

如果这些都没有发生，Alaya 只是一个多 Agent 工作流工具，还不是一个会学习的私有生产飞轮。
