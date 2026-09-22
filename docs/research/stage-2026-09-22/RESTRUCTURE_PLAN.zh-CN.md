# Alaya 重构方案：从“大脑平台”退回“可证伪的改进实验器”

日期：2026-09-23<br>
状态：DEVELOPMENT 设计，未授权正式实验、生产替换或 RSI 公共结论。

## 一句话结论

Alaya 还有机会，但机会不在继续把五角色、知识库和审批流程补得更完整；最小可行路径是先复用已经有公开正结果的程序进化/客观评测骨架，证明固定搜索能稳定找出改进，再用严格配对实验测 Alaya 的记忆和反馈策略是否带来额外收益。

这把三个命题分开：

1. 任务和 evaluator 能否测出真实改进？
2. 固定模型 + 搜索器能否在同一任务上找到真实改进？
3. Alaya 的经验、反馈或自我修改，是否让“找改进的方法”本身更强？

前一轮直接测试第 3 个命题，但第 1 个命题没有充分校准，且后续 57 次请求中有 47 次没有具体实例反馈。因此 P1 的 0.002754% 不是对所有 RSI 的不可能性证明，却足以停止当前配置的 P2/P3。

## 参考项目：可迁移的部分和不能照搬的部分

### FunSearch：先做校准，不把它冒充 Alaya

Google DeepMind 的 FunSearch 把 LLM 生成程序与外部 evaluator 连接，在装箱等任务中搜索启发式；官方仓库和 notebook 是可检查的公开基线（[仓库](https://github.com/google-deepmind/funsearch)，[官方说明](https://deepmind.google/blog/funsearch-making-new-discoveries-in-mathematical-sciences-using-large-language-models/)）。本阶段已在固定上游 commit `cc53f274237d7ab05c19df939edbc1f9616a7c19` 上重跑 OR3：Best Fit 212.0、公开启发式 207.45，改善 2.146%，20/20 装箱合法，0 次模型调用。

能迁移：任务合同、外部评分、合法性检查、已知正结果校准。不能迁移：一个已知启发式的复现不等于新搜索成功，更不等于认知或 RSI。

### ShinkaEvolve：第一候选固定搜索底座

ShinkaEvolve 是开源的程序进化框架；论文明确把 parent sampling、代码新颖性拒绝采样和模型 ensemble 作为搜索效率机制，并报告了公开任务上的改进（[论文](https://arxiv.org/abs/2509.19349)，[代码](https://github.com/SakanaAI/ShinkaEvolve)）。它已有 `ShinkaEvolveRunner`、`LocalJobConfig`、候选 archive、island 和 OpenAI-compatible/headless 路由。

能迁移：候选生成、父代/档案、多样性和固定预算搜索。不能直接当沙箱：`LocalJobConfig` 本身只是宿主子进程；模型生成代码必须继续经现有 Docker 隔离 evaluator。不能把其论文上的样本效率直接外推到 MiniMax、当前题库或 Alaya。

### Darwin Gödel Machine：只作为后续方法层参照

DGM 通过修改自身代码并在 SWE-bench/Polyglot 等下游任务上验证候选版本，强调多分支历史和经验性的性能选择（[技术报告](https://arxiv.org/abs/2505.22954)，[项目说明](https://sakana.ai/dgm/)）。其报告的提升是有具体 benchmark、候选版本和对照的结果，不是“系统拥有无限认知复利”的证明。

能迁移：版本图、候选归档、下游验收、父版本与子版本隔离。不能现在照搬：DGM 的 SWE-bench 环境和成本远超当前目标；在 Alaya 还没有固定搜索正结果前，递归改写只会增加变量。

### GEPA：可选的提示/文本优化器，不做第一阶段核心

GEPA 可以用反思和 Pareto 搜索优化 prompt、代码或 agent 配置（[论文](https://arxiv.org/abs/2507.19457)，[代码](https://github.com/gepa-ai/gepa)）。它适合后续把“反馈摘要/策略提示”作为待优化文本，但会再引入一个搜索器。第一阶段只选一个固定搜索底座，避免把 Shinka、GEPA、DGM 同时叠加后无法归因。

## 目标架构

```text
任务合同 + 版本数据
        │
        ▼
固定 evaluator（纯评分 + 合法性 + Docker）
        │                         ▲
        ▼                         │
搜索器（先 Shinka，固定预算） ────┘
        │
        ├── C0：Best Fit / 现有手写基线
        ├── C1：固定搜索，无历史经验
        ├── C2：固定搜索 + 原始可审计经验
        └── C3：固定搜索 + Alaya 反馈/蒸馏（后置）
```

Alaya 产品层继续保留本地 UI、人工闸、审计 ledger 和确定性 mock；它们不再被当作搜索有效性的证据。实验层写入独立的 `experiments/` 与 run manifest，不写产品 SQLite，不改变 scorer，不把生成候选自动升级为 strong 知识。

## 具体实施建议

### 1. 先冻结 evaluator 合同

复用本阶段已有的 `experiments/rsi-binpack/domain.ts`、`sandbox.ts`、`worker.mjs` 的安全思路，并用 Python adapter 给 Shinka 调用：

- 输入仅包含当前实例和固定容量；候选程序不得读取未来物品、网络、宿主环境或测试集。
- Docker：非 root、无网络、只读根、限制 CPU/内存/时间；候选失败必须是失败，不静默修正。
- 输出同时记录 score、合法性、箱数、stderr、超时、候选 SHA-256、镜像 digest 和 evaluator 版本。
- 数据拆成 train/dev/test；dev 只用于选冠军，test 只在冠军冻结后运行。第一轮使用公开 OR3 时标为 development calibration，不声称 private generalization。
- 所有请求、响应、usage、失败和重试都写 append-only JSONL；usage 不可得写 `unknown`，不能写零。

最小 adapter 不改 core：Shinka 只负责生成/选候选，`evaluate.py` 负责把候选送进已有 Docker worker；若直接用 `LocalJobConfig`，必须说明它不是沙箱，沙箱仍由 evaluator 负责。

### 2. 复现固定搜索，作为 C1

先不启用 Alaya 知识、Distiller、五角色或自改代码。建议固定配置：

- 初始程序：Best Fit；
- 搜索器：ShinkaEvolve（审查版本 `9912af12d423504b8d580f4179fd15f5f88b8c50`），1 个 task、1 个 evaluator、不启用 prompt evolution，不启用 W&B 上传；
- 预算：每个 seed 150 个候选上限，与 Shinka 论文公开样本量量级接近；并行度先设 1–2，避免资源/成本混杂；
- 模型：一个明确的 OpenAI-compatible endpoint（MiniMax 或本地模型二选一），固定模型、temperature、max output；不要同时使用 headless，因为 headless CLI 的参数传递和 usage 账本需要单独核对；
- 重复：3 个预注册 seed 作为 development screen；每个 seed 结束后才做 dev 选优和 test；
- go：至少 2/3 个 seed 在 test 优于 Best Fit，且平均改善 ≥1%，所有候选合法率 ≥95%；
- stop：未达到则停在 C1，先查搜索/模型/任务，不增加记忆层。

这个门槛不是科学论文的最终显著性门，而是足以决定是否值得测 Alaya 增量的开发门；正式结论要另行增加任务族、样本和统计预注册。

### 3. 再测 Alaya 的额外价值，作为 C2/C3

只有 C1 通过才开这一层。每个 seed、任务、模型和请求上限严格配对：

- C1：无历史；
- C2：注入原始可审计经验（不做摘要）；
- C3：注入 Alaya Distiller/反馈策略；
- 选择只看 train/dev，最终只看冻结后的 test；不把 test 反馈回知识库；
- 至少两个相互独立的任务族，避免装箱单任务偶然性；
- 记录最终任务分数、合法率、失败类型、输入/输出 token 和墙钟时间，合法候选更多不能替代任务收益；
- 开始前冻结 seed、分布、预算、提示版本、评分和停止条件。

开发门可用 5 个配对 seed：C3 相对 C1 至少 3/5 正向，平均改善 ≥1%，并且 paired bootstrap 95% CI 不跨 0；否则关闭该机制。不要因为一次正值下调阈值。

### 4. 最后才做有限自我修改

若 C3 在至少两个任务族通过，才允许一次“方法层”修改：候选只能改搜索器配置、反馈格式或选择策略，不能直接改 evaluator、测试集、账本或安全边界。每个子版本：

1. 从父版本复制到独立目录；
2. 先跑静态合同和小 smoke；
3. 在新任务/新 seed 上与父版本配对；
4. 未达门槛自动丢弃，不能自我合并；
5. 保存 parent SHA、patch、score、成本和失败原因。

只在一代方法修改获得正结果后，再考虑第二代递归继承。这里仍然是“在明确定义的任务上经验性改进”，不是无限 RSI 保证。

## 最小可行性验证（MVP）

### 已完成的 M0：评测校准

命令和产物已经在阶段档案中固定：

```bash
cd /Users/peachy/Documents/alaya-stage-closeout-20260922
python3 -m pip install -r experiments/reconstruction/requirements.txt
python3 experiments/reconstruction/reproduce_funsearch.py \
  --upstream /tmp/alaya-research-20260922.zEA1vB/funsearch \
  --output docs/research/stage-2026-09-22/funsearch-reproduction.json
```

结果：`PUBLISHED_ADVANTAGE_REPRODUCED`；平均箱数 212.0 → 207.45，改善 2.146%，所有装箱合法，0 次模型调用。

### M1：固定搜索 screen（下一步，未执行）

交付物必须只有一个独立 run 目录：`manifest.json`、`protocol.json`、`requests.jsonl`、`results.jsonl`、`summary.json`、`readback.json` 和候选 SHA。运行前先做：

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e /tmp/alaya-research-20260922.zEA1vB/ShinkaEvolve
```

然后用一个最小 `LocalJobConfig(eval_program_path="evaluate.py")` 启动 Shinka；`evaluate.py` 不直接执行候选，而是调用现有 Docker worker。先用 `num_generations`/`max_api_costs` 做软限额，再以外部 requests ledger 做硬预算；没有实际 usage 时状态只能是 `COST_UNKNOWN`，不算零。

M1 完成标准：3 个预注册 seed 均完成；没有 test 泄漏；候选/请求/容器回执可重放；2/3 seed 达到 C1 go 条件。任何一个硬合同失败都标记 invalidated，不能把“没跑完”当负结果。

### M2：Alaya 增量 screen（M1 通过后才可执行）

冻结 C1/C2/C3 的提示、模型、预算和数据划分，运行 5 个配对 seed × 至少 2 个任务族。主结果只读冻结后的 test。若 C3 未通过，停止 Distiller/递归扩展，保留固定搜索作为可用工具。

## 完成/停止定义

| 阶段 | 通过意味着 | 不能声称 |
| --- | --- | --- |
| M0 | evaluator 能测到公开已知优势 | Alaya 学会了、RSI 成功 |
| M1 | 固定搜索在开发任务上重复找到改进 | 认知增强、跨任务泛化 |
| M2 | Alaya 机制在配对任务上带来增量 | 无限递归自我改进 |
| M3 | 一代方法修改在新任务上仍优于父版本 | 通用 AGI 或无界 RSI |

任何阶段未达到预声明门槛就停止该层，不能靠增加 UI、知识表、角色或长期运行来绕过。若公开固定搜索都无法通过 M1，最值得放弃的是“当前模型/搜索/任务组合”，不是再造一套治理层。

## 现阶段明确不做

- 不把当前旧产品数据库迁移到新实验器；
- 不重跑已关闭的 PR-L6、SQL、M1 或 RSI P1 来追阳性；
- 不把 dev/test 数据再当未来 held-out；
- 不同时引入 Shinka、GEPA 和 DGM；
- 不以合法候选率、知识条目数、HTTP 200、token 消耗或 UI 完整度替代最终任务分数；
- 不把任何 DEVELOPMENT screen 写成正式 science/public claim。

## 证据与来源

- [FunSearch 官方仓库](https://github.com/google-deepmind/funsearch) 与 [官方说明](https://deepmind.google/blog/funsearch-making-new-discoveries-in-mathematical-sciences-using-large-language-models/)
- [ShinkaEvolve 论文](https://arxiv.org/abs/2509.19349) 与 [官方仓库](https://github.com/SakanaAI/ShinkaEvolve)
- [Darwin Gödel Machine 论文](https://arxiv.org/abs/2505.22954) 与 [官方说明](https://sakana.ai/dgm/)
- [GEPA 论文](https://arxiv.org/abs/2507.19457) 与 [官方仓库](https://github.com/gepa-ai/gepa)
