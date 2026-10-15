# Alaya · Research Release

Alaya 是一个本地单人使用的研究原型，用来观察 AI 工作流中的预测、人工审批、知识状态与审计记录。本次研究版为 **v0.1.0-research.1**，进入维护模式。

**现有实验尚未证明 Alaya 的记忆、蒸馏或反馈循环带来稳定认知增强。** 2026-09-23 的固定搜索 M1 已完成，三个 seed 的 test 均有正改善，平均为 **+0.573%**，未达到预设 **≥1%** 门槛，`go=false`；没有进入 M2/M3。本次收尾不再追加架构、算法、新实验或长跑。完整时间轴、证据边界和维护范围见[研究版结项记录](./docs/research/RESEARCH_RELEASE_2026-10-15.zh-CN.md)。

## 本地运行

支持 **Node.js 24 LTS + npm 11**，从仓库根目录安装依赖：

~~~bash
npm ci
npm run dev
~~~

打开 [http://localhost:5000](http://localhost:5000)。端口被占用时使用 `PORT=5001 npm run dev`。默认使用确定性 mock LLM，不需要 API key，也不调用外部模型。首次启动会创建本地 SQLite 数据和演示项目。

建议先用一个全新的 checkout。若当前 shell 或本地 env 已配置真实 provider，先移除这些配置（包括角色覆盖和 `ALAYA_MODEL_ROUTING_JSON`）；以下命令只覆盖全局 provider：

~~~bash
ALAYA_LLM_PROVIDER=mock ALAYA_CAP_EXTERNAL_NOTIFICATION=false npm run dev
~~~

这是本机单人演示路径。请勿直接暴露到公网；远程访问、多用户、SaaS 和生产运行不属于研究版支持范围。

## 看一次完整路径

1. 在 Dashboard 选择演示项目，查看当前 cycle 与预测。
2. 打开“人类闸门”，查看依据并批准或否决一项待审决策；Distiller 知识提案获批后才会写入知识库。
3. 到“知识库”查看来源、引用、状态与冲突复核记录。
4. 在 Cycle Review 查看 Agent 输出、预测/观察和 action ledger，核对这次操作留下的记录。

本地演示说明：

| 可以查看或操作 | 解释边界 |
| --- | --- |
| 人工审批、知识检索与状态、预测和审计 | 展示工作流与记录机制；知识数量、引用次数和置信度增长不等于效果提升 |
| 五角色与 scheduler 的 mock cycle | 观察可以来自合成场景，不能作为真实业务结果或独立世界反馈 |
| Builder 变更包、dry-run、审批记录 | 变更仍需人工应用；adapter 不会自动执行补丁、完成交付或证明代码有效 |
| 历史实验和分析入口 | 作为研究材料保留；旧计划不构成启动新实验的授权 |

更多配置、数据保护和旧功能入口见 [configuration](./docs/configuration.md)。需要重新演示时使用[独立演示数据库](./docs/configuration.md#独立演示与安全重置)，不要通配删除可能装有真实工作记录的数据库。

## 已有证据

| 路线 | 保存的结果 |
| --- | --- |
| 24h 影子运行 | 稳定配置基线通过；不证明认知增强，认知样本覆盖不足 |
| SQL 经验迁移 | 原始经验 24/24，Alaya 蒸馏 22/24；未证明蒸馏增量 |
| 知识迁移 M1/M1.1 | 前者比较知识为空且有契约缺口；后者阻塞在 K1，Dev 未执行 |
| RSI P1 | 反馈对独立提案平均改善 +0.002754%，未过继续门；P2/P3 仅 mock |
| FunSearch M0 | 已知公开算法离线复现 +2.146%，0 模型调用；用于校准 |
| 固定搜索 M1 | 3 个 seed 平均 +0.573%，`go=false`；未启用 Alaya memory |

[阶段档案](./docs/research/stage-2026-09-22/)保存失败、受阻和作废记录；[固定搜索 M1](./experiments/evolution-mvp/)提供已保存分数的离线复算方法。它的 `requests.jsonl` 是候选索引，不能当逐 HTTP 账本；runner 自产 `readback.json` 也不能单独证明独立复现。测试通过、工具成功与长期运行都不自动升级为能力结论。

## 项目与维护

~~~text
alaya-core/    纯 TypeScript 内核、状态机、LLM provider
alaya-app/     Express + React + SQLite 本地演示
experiments/   已结束的开发实验、评测与保存分数
docs/research/ 结项说明与阶段证据
docs/validation/ 历史验收、预注册和测量记录
~~~

维护仅处理安装、依赖安全和既有路径的直接回归问题。提交方法见 [CONTRIBUTING.md](./CONTRIBUTING.md)，治理约束见 [PRINCIPLES.md](./PRINCIPLES.md)。[原 PRD](./docs/PRD.md)、重构方案和 AI mission 保留作历史材料，不能当作当前路线图。原作者审阅论文包保持未发布状态，本仓库不声明已投稿。

本地基本检查：

~~~bash
npm run typecheck
npm run test:all
npm run guard
npm run secret:scan
npm run build
~~~

[本次工程验收记录](./docs/validation/RESEARCH_RELEASE_2026-10-15.md)包含安装、测试、UI、重启和备份恢复结果。以上是工程检查，不是认知增强实验。真实 provider、GitHub 写入、通知、部署、长跑和新实验需分别明确授权。

MIT，见 [LICENSE](./LICENSE)。
