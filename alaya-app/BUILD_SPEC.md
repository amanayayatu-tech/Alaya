# Alaya Phase 1 MVP 构建规格

把已验证的飞轮内核接上 SQLite + FTS5 持久化和 5 个前端页面。内核逻辑已在 `/home/user/workspace/alaya-core` 验证通过(34 测试 + 3 轮飞轮验收全过),**不要重新发明算法**,直接复用 `shared/core/` 下的纯函数。

## 已就绪的核心文件(在 shared/core/)
- `compute_error.ts` —— 误差量化 + E_cycle(已修复漏洞A/B/C/G)
- `classify_error.ts` —— 误差归因决策树
- `update_confidence.ts` —— 证据计数置信度 + 灰区弱累加 + 衰减(已修复漏洞E/F)
- `transition_state.ts` —— 知识状态机
- `types.ts` —— 核心类型 + evidenceCount(已修复漏洞D)
- `agents_ref.ts` / `scenario_ref.ts` —— 5 Agent 逻辑与 3 轮场景参考(移植用)

这些文件可被后端直接 import。它们是纯 TS、无副作用。

## 数据模型 (shared/schema.ts) — PRD 13.2 的 11 张核心表
用 Drizzle sqliteTable 定义。SQLite 不支持数组列,列表存 JSON text。每张状态表带 `version` integer 列(乐观并发,PRD 12.2)。

1. projects: id, name, direction, targetUser, redlines(JSON), weeklyHumanMinutes, seedIdentity(text), worldModel(text), version
2. cycles: id, projectId, idx, goal, status(planning/running/closed), eCycle(real), worstClaimError(real), reasoning(text), version
3. agents: id, projectId, name, role —— 5 个固定角色
4. tasks: id, cycleId, agent, kind, status, spec(JSON)
5. feedbackItems: id, cycleId, text(原话), category, sentiment
6. predictions: id, cycleId, belief, prediction, action, claims(JSON), observation, predictionError(real), worstClaimError(real), errorType, updateTarget, status, knowledgeRefs(JSON)
7. observations: id, cycleId, predictionId, metric, value(real), source
8. knowledgeItems: 完整字段对应 types.ts 的 KnowledgeItem(evidenceAlpha/Beta real, confidenceScore real, confidenceLevel, status, humanApprovedCount, externalVerifiedCount, tags JSON, lastValidatedCycle, createdByCycle, version)
9. humanGateItems: id, cycleId, type(direction/meaning/risk), blocking(int), title, payload(JSON), status, estimatedMinutes, decision
10. decisionLog: id, cycleId, gateType, decision, rationale, ts
11. eventLog: id(自增), cycleIdx, actor(owner), tableName, op, before(JSON), after(JSON), ts
另加 llmCalls 表: id, cycleId, agent, promptVersion, inputSummary, outputSummary, schemaValid(int), retryCount, latencyMs, tokenCount, estimatedCost(real)

### FTS5
建虚拟表 `knowledge_fts` USING fts5(title, content, tags, content='knowledge_items'),用触发器同步。检索 API 用 MATCH,并按 status 过滤(stale/expired/quarantined/conflict 不进高风险结果)。better-sqlite3 支持 FTS5,直接用原生 db.prepare 执行(Drizzle 不直接支持 FTS5,用 db.$client 或 better-sqlite3 实例)。

## 后端 API (server/routes.ts) — PRD 15
- POST/GET/GET:id/PATCH:id /api/projects (创建项目走 onboarding,写 seed identity/world_model)
- POST /api/projects/:id/cycles, GET /api/cycles/:id, POST /api/cycles/:id/start, POST /api/cycles/:id/close
- GET /api/human-gates, GET:id, POST :id/approve, POST :id/reject, POST :id/modify
- POST /api/predictions, GET /api/cycles/:id/predictions, PATCH :id/observation, PATCH :id/error
- POST/GET/GET:id/PATCH:id /api/knowledge, POST :id/approve, POST :id/quarantine, POST /api/knowledge/search(FTS5)
- POST /api/agents/{orchestrator,sensor,builder,distiller,librarian}/run
- POST /api/cycles/:id/run-full —— 一键跑完整一轮飞轮(顺序调度 5 Agent),供演示

所有写操作记 eventLog(actor=对应 Agent 或 "human")。Agent run 复用 agents_ref.ts 的逻辑但写入 SQLite。

## onboarding interview (PRD 13.1)
创建项目时收集:产品一句话、目标用户、当前假设、绝不做什么、高风险红线、创始人偏好、已知竞品、反馈来源、每周预算、第一轮希望看到的信号。据此生成 seed identity + 初始 world_model + 第一轮候选目标。mock LLM 可用确定性模板生成。

## gate budget + 降噪 (PRD 11.4)
weekly_human_minutes=150。同主题意义闸合并。低风险知识候选批量展示。blocking 闸>3条或>5天进安全模式(冻结新立项)。Dashboard 显示本周已用人工时间。

## 5 个前端页面 (PRD 14) — 用 wouter hash 路由 + sidebar
1. Dashboard: 当前项目/cycle/飞轮阶段/pending_human 数/本周人工用时/open predictions/blocking risks/最近知识更新
2. Human Gates: 三类闸门列表,批准/否决/修改,看 Agent 推荐理由、被筛掉选项、相关知识引用
3. Prediction Ledger: 每条预测、观察、误差类型、修正动作、预测准确率趋势(用 recharts)
4. Knowledge Base: 按 type/status/tag 查看,FTS5 搜索框,看来源引用,看 stale/conflict/quarantine,批准候选进 active/strong,看被哪些 Agent 调用
5. Cycle Review: 本轮目标/做了什么/哪些预测对错/反馈摘要/Bug 摘要/知识更新摘要/下一轮建议

## 设计方向
开发者工具风格(精确、克制、数据密集)。冷色中性 + 一个 accent。深色模式优先。text-xl 为最大标题。等宽字体用于数据/置信度/误差值。

## 验收(本地跑通)
- 创建项目走完 onboarding
- 用 run-full 跑通 3 轮飞轮(可复用 scenario_ref 的确定性场景做种子数据,或让用户手动录入反馈)
- 第3轮 cycle review 能显示引用了前两轮知识并改变决策
- 知识从 draft 晋级到 strong
- Human Gates 可批准/否决,decision 进 decisionLog
- FTS5 搜索知识可用
- 全程 mock LLM,llmCalls 表有调用日志和成本统计

## 关键约束(复用 webapp 技能)
- Router 用 useHashLocation,Switch 在 Router 内
- 所有 HTTP 用 apiRequest,不用裸 fetch
- TanStack Query v5 对象形式
- 不用 localStorage/sessionStorage
- better-sqlite3 同步,用 .get()/.all()/.run()
- 交互元素加 data-testid
