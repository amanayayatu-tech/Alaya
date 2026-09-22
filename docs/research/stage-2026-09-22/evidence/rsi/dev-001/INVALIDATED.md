# INVALID_MEASUREMENT — 不作为有效性证据

2026-09-22 执行中回读实际 HTTP 请求发现：runner 用于 MockLLM 的 `mockData` 示例同时进入了真实 OpenAIProvider 的 `draft_output`。共享 provider 的 system prompt 要求优先沿用已经匹配 schema 的示例。这给两组添加了计划之外的答案锚定，可能压制探索。

本轮已中止。保留全部代码、回执、候选和消费；不把本轮算作 H1 阴性，不挑选其中候选用于新运行，不把轨迹注入新运行。修复在真实实验适配层明确移除 mockData，并以实际 HTTP request body 做回归断言。

后继修复运行使用 dev-002 和 protocol v1.3。新运行的分布、数据生成种子、调用分配、评分规则、阈值均不因本轮成绩改变。代码/协议快照是本轮启动时的版本；当前源码修改后不能重新开始本轮。
