# Alaya 研究版结项记录

日期：2026-10-15。发布标识：`v0.1.0-research.1`。本文件记录研究版范围与停止决定。[本次工程验收](../validation/RESEARCH_RELEASE_2026-10-15.md)记录实际检查；最终源版本以 `v0.1.0-research.1` 标签和 GitHub Release 为准。未部署生产环境或投稿。

## 决定与保留范围

原“五角色 + 知识治理 + 长期自转自然产生认知复利”的追加建设到此结束。固定搜索 M1 已执行且 `go=false`，不再把它列为下一步；不启动 M2/M3、替代算法、新模型实验或长跑。

保留一个可本地单人运行的研究原型：确定性 mock、人工审批、知识状态、预测/观察记录和审计。它可用来理解工作流和复核已有实验，不能宣称已实现 SaaS、自动交付、生产就绪、稳定认知增强或无限 RSI。

代码中的历史命名（如 cognition、compounding、evolution、production mode）保留原身份；名称不是能力验收。Builder 只准备可审阅、可人工应用的变更包，非 dry-run 路径也不会自动执行补丁。mock 场景和部分 scheduler 观察是合成数据；知识数、引用数、置信度、token 消耗及运行时长增长不等于效果提升。

## 实验时间轴

| 阶段 | 已保存结果 | 结论边界 |
| --- | --- | --- |
| 2026-06-05/06 真实模型长期飞轮 | [12h报告](../validation/2026-06-06-12h-real-llm-validation.md)：69轮，23次完整飞轮，460次模型调用 | 特定脚本路径可持续运行；知识被引用、决策改变和检查通过不能代替无记忆对照。报告中的“认知复利/熵减”应按此工程边界阅读。 |
| 2026-06-16/17 24h影子与认知度量 | [冻结基线](../validation/2026-06-17-alaya-shadow-24h-baseline-freeze.md)通过；[adaptive对照](./stage-2026-09-22/evidence/historical/shadow-24h_treat_20260616_001359/summary.json) providerRatio=0.58，失败 | 稳定性与认知效果分别裁决。认知有效知识仅2条，覆盖不足。 |
| 2026-06-17 修复后的thinking对照 | [报告](../validation/WHITEPAPER_cognition_adaptive_null_result.md)：单次 ECE disabled=0.2012、adaptive=0.2067 | null result；没有重复方差或显著性结论。Phase3预注册与骨架保留，不代表重复实验已完成。 |
| 2026-07 PR-L6学习闭环 | [失败档案](./stage-2026-09-22/evidence/pr-l6/PR_L6_LEARNING_LOOP_FAILED_CASE.md)：最后预检baseline评分4题、treatment评分0题，held-out均0；治理反例未关闭 | FAILED / PAUSED / NOT FORMAL ACCEPTANCE / NOT PRODUCTION-READY。大量本地测试通过不能替代有效运行。 |
| 2026-09-09 SQL经验迁移 | [原始分析](./stage-2026-09-22/evidence/sql/sql-transfer-final-20260909/analysis.json)：无经验18/24、原始经验24/24、Alaya蒸馏22/24；蒸馏对原始0胜2负，p=0.5 | INCONCLUSIVE_OR_NO_INCREMENT。去围栏后无经验语义成绩21/24，部分表面增益来自格式；单域合成组合不代表跨域泛化。 |
| 2026-09-13 SQL新结构probe | [收口](./stage-2026-09-22/evidence/sql/reports/closeout-20260913.md)：三族2/4、3/4、4/4，仅1个难族，要求≥2 | 按规则停止，未进入A/B；不推翻旧蒸馏结果，也不证明完整经验在新结构无效。 |
| 2026-09-19 知识迁移M1/M1.1 | [M1](./stage-2026-09-22/evidence/m1/2026-09-19T09-19-20-583Z/report.md) NO_SIGNAL_ON_DEV；[M1.1](./stage-2026-09-22/evidence/m1/2026-09-19T10-00-23-273Z/report.md) K1阻塞、Dev调用0 | 旧M1知识包实际为空，且[输出/评分契约存在缺口](./stage-2026-09-22/evidence/m1/documentation/REPLAY_OLD_RUN.md)。不是干净的知识继承反证。 |
| 2026-09-22 RSI P1 | [有效结果](./stage-2026-09-22/evidence/rsi/dev-002/report.zh-CN.md)：120次HTTP，反馈对独立提案平均+0.002754%，仅1/3正向；[dev-001污染作废](./stage-2026-09-22/evidence/rsi/dev-001/INVALIDATED.md) | NO_PRACTICAL_FEEDBACK_GAIN；未达≥0.5%且至少2/3正向，P2/P3只有mock，不是真实自改或递归效果。 |
| 2026-09-23 FunSearch M0 | [保存结果](./stage-2026-09-22/funsearch-reproduction.json)：212.0→207.45箱，+2.146%，20/20合法，0模型调用 | 公开已知算法校准，不是Alaya新发现，也未端到端验证另一套M1 Docker evaluator。 |
| 2026-09-23 固定搜索M1 | [结果](../../experiments/evolution-mvp/RESULTS_M1.md)：3 seed分别+0.573%、+1.050%、+0.095%，均值+0.573%；候选合法率均≥95% | DEVELOPMENT，go=false；仅1/3 seed达到≥1%，均值低于≥1%门槛。未启用Alaya memory，未进入M2/M3。 |

两条不同实验都曾使用“M1”名称：9月19日是知识迁移；9月23日是Shinka固定搜索。它们的数据、合同与结论不能合并。

## 如何复核与不能复核的部分

默认从保存结果开始，不调用模型、不启动Docker。已有[FunSearch分数复算](../../experiments/reconstruction/README.md)与[固定搜索test分数复算](../../experiments/evolution-mvp/README.md)。这些命令只核对保存数值的算术与一致性，不自动证明来源真实或完整重现运行。

新固定搜索M1的 `requests.jsonl` 在搜索结束后生成，是候选与响应文件索引，usage/cost为unknown，不能用于还原物理HTTP、重试或费用。`readback.json` 由runner自产，不能独立证明test隔离或完整复现。公开OR3的10/5/5划分仅是DEVELOPMENT筛查；三个seed均有正改善，runner的 `positive_seed_count` 实际指改善≥1%的seed数量。

旧知识迁移M1另有[计数诊断](./stage-2026-09-22/evidence/m1/documentation/K1_DIAGNOSIS.md)：tokenCount存在估算，providerRequests存在重试计数陷阱。因此不得把这些数直接当真实usage，更不能与其他实验消费合计。没有usage的数据保持unknown。

原始阶段证据、预注册、失败与作废结果保留原身份。后续修复和论文文字不回改它们。历史文档中本机或临时路径是来源标识，不能作为当前安装步骤；可移植的固定上游获取方法见对应实验README。

## 本地演示与数据

支持 Node.js 24 LTS、npm 11；根目录 `npm ci` 后 `npm run dev`，默认确定性mock。阅读[当前README](../../README.md)与[配置/安全重置](../configuration.md#独立演示与安全重置)完成审批→知识→审计的本地流程。

研究版只支持本机单人演示。不要暴露公网、复用生产数据库或把合成观察解释为真实业务成效。重开演示应使用新数据库路径，停止后保留旧库；不能通配删除装有实际记录的 `data.db*`。

## 维护与发布边界

维护仅处理安装、依赖安全与既有使用路径的直接回归；不增加新架构、算法、角色、学习层或长期控制器。现有历史功能的配置材料继续可查，但不是维护范围扩展。

本次收尾不启动任何新模型、搜索、长跑或正式计分实验。真实provider、通知、外部写入、部署、提交、推送、tag、发布或论文投稿按各自明确授权和实际回执判断；本文件不预先声明完成。原论文作者审阅包保留未发布身份，不因研究版结项变成已投稿。

完成标准是：安装和本地mock路径有本次实际验收；文档与停止结果一致；保存证据可访问；没有凭证或原件覆盖；最终版本与验收结果可定位。主发布记录应填写真实结果和commit，不用历史测试数字充当本次结果。
