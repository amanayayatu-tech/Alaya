# Alaya 受约束 RSI 实验结果

证据层：**MOCK_ONLY**。底座：MiniMax-M3；thinking=disabled。

- H1：NO_PRACTICAL_FEEDBACK_GAIN
- H2：未验证（未满足前阶段条件或尚未完成）
- H3：未验证（未满足前阶段条件或尚未完成）

完成 6 条搜索；实际 HTTP 0 次；已记录输入 0、输出 0 token。
已知 usage 的按量价格等值估算：$0.000000，不是账户账单。缺 usage 响应 0；缺失/错误响应 0，均不当作零费用。
价格：[MiniMax 官方标准按量价](https://platform.minimax.io/docs/guides/pricing-paygo)，核实日期 2026-09-22。

候选 6 个，train/dev 合法 6 个，代码哈希 1 种。

|阶段|世界/重复|方法|test 平均箱数|Best Fit|请求数|
|---|---|---|---:|---:|---:|
|P1|D-combined/0|independent|127.2500|127.2500|0|
|P1|D-combined/2|independent|125.2500|125.2500|0|
|P1|D-combined/1|independent|126.7500|126.7500|0|
|P1|D-combined/0|v0|127.2500|127.2500|0|
|P1|D-combined/2|v0|125.2500|125.2500|0|
|P1|D-combined/1|v0|126.7500|126.7500|0|

## P1: NO_PRACTICAL_FEEDBACK_GAIN

v0 相对 independent：平均 gain=0.0000%；正向 0/3。配对值：0.0000, 0.0000, 0.0000。P1 是 3 对筛查，不作稳健统计证明。

## 结论边界

这是固定模型、固定装箱分布与有限调用次数的 DEVELOPMENT 对照。没有训练底座权重、没有写入 Alaya 产品知识库，也不是通用认知增强或无限 RSI 的证明。
若 H1 未达到 0.5% 且至少 2/3 为正的预设条件，则按协议停止 P2/P3；不能用某个训练冠军代替主指标。
所有模型请求、候选源代码、train/dev 结果、冠军冻结事件和 test 结果保存在本目录；test 从未反馈给模型。
