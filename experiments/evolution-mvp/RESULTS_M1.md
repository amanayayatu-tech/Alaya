# M1 fixed-search result

状态：`DEVELOPMENT`。本次 M1 已按预注册协议跑完 3 个 seed；门槛未通过，因此不进入 M2 或 M3。

固定条件：ShinkaEvolve `9912af12d423504b8d580f4179fd15f5f88b8c50`、FunSearch OR3 数据（train/dev/test = 10/5/5）、每个 seed 最多 150 个候选、固定 evaluator、候选在无网络只读 Docker worker 中执行。没有使用 Alaya memory、prompt evolution 或 W&B；没有设置总金额停止条件。原始输出保存在本地且被 Git 忽略：
`experiments/evolution-mvp/outputs/m1-fixed-search-v2-20260923/`。

| seed | 候选数 | train 合法率 | dev champion | baseline test | champion test | test 改善 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `m1-01` | 149 | 100.00% | 208.2 | 209.6 | 208.4 | +0.573% |
| `m1-02` | 150 | 99.33% | 207.8 | 209.6 | 207.4 | +1.050% |
| `m1-03` | 150 | 100.00% | 209.0 | 209.6 | 209.4 | +0.095% |

聚合结果：

- 完成 3/3 个 seed；所有 seed 的候选合法率均达到 95% 门槛。
- 达到单 seed `>=1%` 改善的 seed 为 1/3；要求为至少 2/3。
- test 改善算术均值为 `+0.573%`；要求为至少 `+1%`。
- 因此 `go=false`。三个 seed 的 test 都是在 dev champion 冻结后才执行，未把 test 用作搜索选择。

`m1-02` 有 1 个候选因候选代码的局部变量未初始化而判为无效；该异常被记录在 train ledger 中，未被修复或静默丢弃，且整体合法率仍为 99.33%。

这只是固定 OR3 任务上的开发筛选结果，不是生产性能、Alpha、泛化能力或正式科学结论。API usage/cost 在当前 ledger 中记为 `unknown`，不将 provider 日志里的零计价视为账单凭证。
