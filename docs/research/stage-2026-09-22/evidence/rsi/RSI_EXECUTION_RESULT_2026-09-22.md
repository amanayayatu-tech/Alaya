# Alaya RSI 首轮执行结果与交接

日期：2026-09-22。证据层：**DEVELOPMENT**。本轮状态：**P0 已完成；P1 已完成但未达到继续条件；P2/P3 未做真实模型验证，按方案停止。**

## 结论

真实反馈让这次搜索产生了更多合法候选，但没有带来足够的最终任务收益。三次配对的平均改善为 **0.0027538%**，只有 **1/3** 为正；事先约定的继续条件是 **平均至少 0.5%、至少 2/3 为正，并优于 Best Fit**。前两条均未达到。

因此，不能把这次结果说成“Alaya 已实现有效自我改进”。也不能说“反馈完全无用”或“RSI 不可能”：本轮只验证了固定模型、固定装箱任务和有限搜索次数。H2 自我修改、H3 递归继承的效果仍然没有得到真实验证。

## 1. 本轮实际完成了什么

- 从原仓库 `b7090b11b41f358f4d82906c86be835a68c06e64` 建立独立 detached 工作树：[alaya-rsi-dev-20260922](../alaya-rsi-dev-20260922/)。没有把原工作区的未提交改动带入实验。
- 实现真实可运行的 prepare、mock/live preflight、P1–P3 runner、只读分析，以及逐候选/逐 HTTP 回执。核心实现：[runner.ts](../alaya-rsi-dev-20260922/experiments/rsi-binpack/runner.ts)。
- 沿用现有 LLMProvider、TypeScript、node:test 与已安装的 Docker；没有增加 Agent 框架、数据库、UI 或新服务。
- 候选代码在固定 Node 20 容器内执行：无网络、非 root、只读根、资源受限，只收到当前物品与当前箱子容量。独立宿主执行状态更新和评分。
- 修复实际 provider 的截断 JSON 内层对象误识别；实验可以关闭隐藏 fallback，一次实验调用对应一次实际 HTTP 请求。默认产品调用不关闭 fallback。
- 用户取消的是总费用/总调用/日历截止；保留每条搜索 20 次调用、输入/输出上限相同的实验分配，没有设置总费用停机线。

## 2. 主要结果

底座：**MiniMax-M3，temperature=0.7，thinking=disabled**。两组每次均从 Best Fit 开始，每组 3 次独立重复、每条 20 次真实请求。三种 D 分布等权组合；每次重复每个 split 的数量为 train=96、dev=96、test=384。模型只接收训练信息，dev 选择冠军，test 仅在冠军冻结后执行。

| 独立重复 | 独立尝试 test 平均箱数 | 反馈搜索 test 平均箱数 | 相对改善 |
| --- | ---: | ---: | ---: |
| 0 | 125.958333 | 125.958333 | 0% |
| 1 | 126.088542 | 126.078125 | 0.008261% |
| 2 | 126.210938 | 126.210938 | 0% |
| **配对均值** | — | — | **0.002754%** |

正向的一次，相当于 384 条测试序列合计少用 4 个箱子。没有修改 0.5% 阈值，也没有因这一个微弱正值放行下一阶段。独立统计单位只有 3 次搜索配对，不是物品数或测试序列数。

### 辅助结果：合法性与效率

| 指标 | 独立尝试 | 反馈搜索 v0 |
| --- | ---: | ---: |
| 实际 HTTP 请求 | 60 | 60 |
| 合法 train/dev 候选 | 48 | 60 |
| 非法算法 | 9 | 0 |
| 传输失败 | 3 | 0 |
| 成功响应的输入 token | 42,715 | 107,159 |
| 成功响应的输出 token | 13,778 | 28,034 |
| 训练成绩优于起点的候选 | 0 | 2 |

这是一次观察到的合法性差异，不是独立样本的显著性检验。独立组的 3 次传输失败按原方案计入配额；其中一次 90 秒超时，两次 fetch failed，没有额外补请求。不能把这三次归为算法错误；缺失 usage 也不能记为零费用。

反馈组的上下文和输出消耗更高。虽然调用与 token 上限相同，**实际 token 并不相同**。本次不能宣称它更省钱、更高效，或仅凭合法候选更多就宣称学习有效。

主运行 P1 墙钟时间：北京时间 **17:08:32–17:17:13，约 8 分 41 秒**。HTTP 等待、隔离执行在三次重复之间并行，不能将各次时长相加当作墙钟时间。此前还有环境实现、回归与作废轮次的排查时间。

## 3. 必须披露的作废轮次

首次运行 `dev-001` 在 108 次请求后中止。回读实际请求时发现：给 MockLLM 的 Best Fit 示例进入了真实 provider 的 `draft_output`；provider 的通用 system prompt 会提示优先沿用已有示例。这是计划之外的答案锚定，可能压制探索。

这是本次实现中的错误，不能把其结果算成反馈学习的阴性证据。

处理方式：

1. 中止该运行，保留全部候选、请求与费用，并写明 [INVALIDATED.md](../alaya-rsi-dev-20260922/outputs/rsi-binpack/dev-001/INVALIDATED.md)。
2. 在实验真实调用入口统一移除 mockData，同时覆盖候选生成与后续策略编辑，不改产品 provider 的正常 draft 用途。
3. 用假 HTTP 断言实际请求中的 `draft_output` 为空。
4. 以 `dev-002` / protocol v1.3 重做；不使用上一轮的候选或经验，不改分布、种子、选择规则、资源分配或通过阈值。

本文所有有效性数字只来自 `dev-002`。作废轮次不隐藏，也不并入它的收益。

## 4. 验证和真实证据

- 现有 provider 与新增实验直接回归：**13/13 通过**。
- Core 类型检查、实验 TypeScript 检查、`git diff --check` 通过。
- 最新完整 mock 流程覆盖 P1/P2/P3，保存于 `offline-003/mock-check`；两个 P3 编辑分支的 parent/source/material 相同，实际 editor 分别为 v1/v0。**这仅证明流程，不证明自改或递归有效。**
- 真实 P1 后直接尝试 P2，被 `PREVIOUS_PHASE_STOPPED` 拒绝，未产生新模型请求。
- 独立回读核对源代码/数据哈希、120 个唯一 HTTP ID、每条 20 次、两组模型参数一致、真实请求无 mock 示例、训练反馈不含 dev/test、dev-only 冠军选择。
- **六个冻结冠军全部重跑**：每个 384 条 test 序列，逐序列箱数全部与原记录相同。
- 从原始落盘结果重新分析，summary 哈希一致。

原始与重算入口：

- [自动生成的结果报告](../alaya-rsi-dev-20260922/outputs/rsi-binpack/dev-002/report.zh-CN.md)
- [summary.json](../alaya-rsi-dev-20260922/outputs/rsi-binpack/dev-002/summary.json)
- [独立回读回执](../alaya-rsi-dev-20260922/outputs/rsi-binpack/dev-002/readback.json)
- [原始运行目录](../alaya-rsi-dev-20260922/outputs/rsi-binpack/dev-002/)
- [运行时授权方案副本](../alaya-rsi-dev-20260922/outputs/rsi-binpack/dev-002/plan-at-authorization.md)

## 5. 全部调用与费用，不只统计成功轮次

| 用途 | HTTP 请求 | 已知 usage 按量价等值（美元） | usage 未知请求 |
| --- | ---: | ---: | ---: |
| 最早真实预检 | 2 | 0.000782 | 0 |
| dev-001 预检 | 2 | 0.001021 | 0 |
| dev-001 作废运行 | 108 | 0.065564 | 1 |
| dev-002 预检 | 2 | 0.000953 | 0 |
| dev-002 有效 P1 | 120 | 0.081791 | 3 |
| **全部** | **234** | **0.150110** | **4** |

使用 2026-09-22 核实的 [MiniMax 官方标准按量价格](https://platform.minimax.io/docs/guides/pricing-paygo)：输入 $0.30/M、输出 $1.20/M、缓存读取 $0.06/M。以上是 PAYG 等值估算，**不是账户实际账单**，订阅/余额扣减口径未核对。

四次未知 usage 包括作废运行中止时的一次未落盘响应，以及有效运行三次传输失败。按每请求既定最大分配保守估计，额外预留等值 **$0.024**；不把未知量算零。已知加该保守估计约 **$0.17411**，仍不能冒充已确认扣费。

## 6. 保留、停止与下一步

**保留**：客观评分、容器隔离、真实 HTTP 回执、训练/验证/测试边界，以及已修复的实际调用入口。这些已经把项目从只有计划推进到可复算的真实对照。

**停止**：本版方法的 P2/P3 真实调用。原因是 P1 未达继续条件，不是费用耗尽，也不是人为新增 Reviewer、G1–G7 或长期门禁。不要恢复平台长跑来绕过这个结果。

**下一步建议只有一个**：先解决“当前搜索方法能否在开发任务上稳定产出可泛化的改进”这一瓶颈，再谈方法的递归继承。可见的较少非法提案不等于更好的最终解法。若要换模型、开启不同推理设置、增加搜索配额或换任务，应明确作为下一版实验，而不是混入本轮继续追阳性。**本轮没有自动开展这些扩展。**

原 Alaya 工作区的用户改动没有覆盖；没有产品数据库写入、Git 提交、推送或上线，没有使用子代理。P2/P3 仅完成程序与 mock 检查，不能声称已做真实自我改进实验。

## 7. 可直接使用的复核命令

```bash
cd /Users/LOCAL_USER/Documents/alaya-rsi-dev-20260922
node --import tsx --test experiments/rsi-binpack/rsi.test.ts alaya-core/tests/llm_provider.test.ts
npm --prefix alaya-core run typecheck
./node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck experiments/rsi-binpack/*.ts
node --import tsx experiments/rsi-binpack/analyze.ts --run-id dev-002
node --import tsx outputs/rsi-binpack/dev-002/readback.mjs
```

以上复核不调用真实模型；readback 会重新执行容器中的冻结候选。新的 live 运行不能复用或覆盖本轮目录。原方案第 11 节命令现已实现，但本轮 `run --phase 2/3` 不满足前阶段条件，不能执行真实后续阶段。
