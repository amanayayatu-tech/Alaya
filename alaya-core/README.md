# Alaya Core (M1 + M3)

Alaya PRD v0.2 的内核实现：**四个纯函数（修复 PRD 8 个规格漏洞） + 5 Agent 顺序调度 mock + 3 轮飞轮数值模拟**。全程 mock LLM，零外部 API 依赖。

这一版的目标是回答一个问题：**飞轮到底转不转得起来？** —— 即第 3 轮决策能否真实复用前两轮知识并被其改变，而不是形式引用。

## 快速开始

```bash
cd alaya-core
npm install
npm test         # 运行 34 个单元测试(覆盖 8 个漏洞场景)
npm run flywheel # 运行 3 轮飞轮数值模拟,打印验收结果
npm run typecheck
```

要求 Node 20+。

## 目录结构

```
src/
  core/
    types.ts             # 核心类型 + evidenceCount 口径(修复漏洞D)
    compute_error.ts     # 误差量化 + E_cycle(修复漏洞A/B/C/G)
    classify_error.ts    # 误差归因决策树(PRD 10.6)
    update_confidence.ts # 证据计数置信度 + 灰区弱累加 + 衰减(修复漏洞E/F)
    transition_state.ts  # 知识状态机(PRD 8.6)
  state/store.ts         # 内存状态 + event_log + 字段 owner(模拟 PRD 12.2)
  llm/provider.ts        # LLMProvider 接口 + MockLLM(切真实 API 零改动)
  agents/agents.ts       # 5 Agent:Orchestrator/Sensor/Builder/Distiller/Librarian
  sim/
    scenario.ts          # 确定性 3 轮场景(一键发布产品冷启动)
    run_flywheel.ts      # 飞轮主程序 + 7 项验收
tests/                   # compute_error / confidence / classify_error
```

## 修复的 8 个 PRD 漏洞

| 漏洞 | 问题 | 修复位置 |
|---|---|---|
| A | compute_error 无法处理"越小越好"指标(<=),会把成功误判为失败 | `compute_error.ts`:由 operator 推导方向因子 d |
| B | T=0 时 scale 除零崩溃 | `compute_error.ts`:scale 强制正下限 EPS |
| C | E_cycle 平方加权反而稀释大错,与"惩罚大错"意图相反 | `compute_error.ts`:额外返回 worstClaimError + 关键 claim weight>=3 |
| D | evidence_count 定义不自洽(示例 alpha=2/beta=1 却写 count=1) | `types.ts`:统一 (alpha-1)+(beta-1) |
| E | 灰区(0.3~0.7)不累加,导致正确知识永远晋级不了 strong,飞轮空转 | `update_confidence.ts`:灰区弱累加 + 连续灰区触发意义闸 + 人类/外部验证为主通道 |
| F | 知识衰减函数完全缺失,active->stale 无法触发 | `update_confidence.ts`:`score * exp(-λ * cyclesSinceValidated)` |
| G | binary/categorical/directional claim 不进 E_cycle | `compute_error.ts`:所有可计算类型纳入 |
| H | 字段级写权限无执行机制 | `store.ts`:每次写入记录 actor(owner) + event_log |

每个漏洞都有对应单元测试,见 `tests/`。

## 3 轮飞轮叙事(确定性场景)

一个"一键发布"产品的冷启动：

1. **第1轮**：假设"用户最关心快速发布",上线一键发布。预测 activation>=0.3。
   现实只有 0.12（失败,误差归因 model）。反馈："不敢点,不知道会改什么"。
   → 提炼 K1：用户对不可预期自动操作有恐惧。
2. **第2轮**：基于 K1 改做"发布预览+确认"。预测 activation>=0.3。
   现实升到 0.34（达标）。K1 被强化,提炼 K2：可预览降低高风险动作门槛。
3. **第3轮**：Orchestrator **引用 K1+K2,主动避开"新增不可预览自动化",改为把预览模式迁移到删除操作**。这就是复利——决策被前两轮知识改变。K2 晋级 strong。

## 飞轮验收(全部通过)

运行 `npm run flywheel` 会检查 PRD 17.3 的 7 项标准：

- ✓ 第3轮建议引用了前两轮知识
- ✓ 说明了知识如何改变决策（非形式引用）
- ✓ 不重复已否决方向
- ✓ pending_human 未膨胀
- ✓ 5 个 Agent 每轮都有运行记录
- ✓ 知识开始晋级 strong（而非只增）
- ✓ 预测误差驱动修正

## 与 Phase 1 的衔接

- `LLMProvider` 接口已就绪,切真实 OpenAI 只换 `MockLLM` 实现,业务逻辑零改动。
- `Store` 的接口(version/owner/event_log)按 SQLite 可平移设计,Phase 1 替换为 SQLite + FTS5。
- 四个纯函数与状态机可直接复用,无需重写。

## 已知边界(诚实声明,对应 PRD 22.3)

本版只验证"飞轮逻辑能复利",**不代表系统真的有用**。真实有效性必须在接入真实反馈、真实 LLM 后的多轮工作流中观察。隐性知识捕获、价值误差自动检测、真实反馈无干净奖励函数等结构性难题不在本版解决范围内——它们需要靠人类闸门长期缓解,而非代码根治。
