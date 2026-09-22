# 2026-09-22 阶段档案

这是 Alaya 的一个可复核阶段收口，不是产品发布包，也不是认知增强的正面结果。

## 先看结论

- 原“五角色 + 知识治理 + 长期自转，最终自然产生认知复利”的路线停止追加建设。
- PR-L6、SQL 经验迁移、M1/M1.1、RSI P1 等失败、受阻、作废和测量缺口均保留在 [evidence/](./evidence/)；不把失败实现合入产品能力声明。
- FunSearch 官方公开装箱算法的离线复现通过：Best Fit 212.0 箱，公开启发式 207.45 箱，改善 2.146%，20/20 实例装箱合法，0 次模型调用。它只校准“任务和评分能测出已知优势”。
- 下一步不是继续修旧平台，而是用固定搜索器和客观 evaluator 建立最小正对照；只有固定方法有效，才测 Alaya 的记忆/反馈策略是否有增量。

## 文件

- [RESTRUCTURE_PLAN.zh-CN.md](./RESTRUCTURE_PLAN.zh-CN.md)：具体重构建议、MVP、验收门和停止规则。
- [funsearch-reproduction.json](./funsearch-reproduction.json)：上游 commit、数据哈希、逐实例结果和边界。
- [evidence/MANIFEST.json](./evidence/MANIFEST.json)：阶段证据文件、源快照、发布哈希和排除项。
- [evidence/rsi/RSI_EXECUTION_RESULT_2026-09-22.md](./evidence/rsi/RSI_EXECUTION_RESULT_2026-09-22.md)：最新 P1 实际结果。
- [evidence/sql/reports/closeout-20260913.md](./evidence/sql/reports/closeout-20260913.md)：SQL 经验迁移收口。
- [evidence/pr-l6/PR_L6_LEARNING_LOOP_FAILED_CASE.md](./evidence/pr-l6/PR_L6_LEARNING_LOOP_FAILED_CASE.md)：PR-L6 失败案例。

## 证据边界

本目录含公开数据上的算法、候选代码和历史运行回执；其中 RSI 的训练/开发/测试数据已经随阶段档案公开，不能再当未来 held-out 证据。M1 的 runner tokenCount/providerRequests 有估算或重试计数陷阱，物理 provider usage 应记为 unknown；它不能和 SQL/RSI 的真实 usage 小计相加。原始路径已将 `/Users/peachy` 脱敏为 `/Users/LOCAL_USER`，原仓库数据库、环境文件、密钥、node_modules、私密对话和未列入白名单的 raw logs 未导出。

## 证据层

档案中的结果按四层理解：local checks 只证明本地机械正确；smoke 只证明路径可走；long-run/formal acceptance 需要冻结合同和命名字段；science/public claim 需要上游所有门通过。当前 FunSearch 复现属于 DEVELOPMENT 的 smoke/calibration evidence，旧产品状态不因本档案自动升级。
