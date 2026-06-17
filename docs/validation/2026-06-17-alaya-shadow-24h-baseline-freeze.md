# Alaya 底座 · 投研主题版 24h 影子验收 · 冻结基线记录

核验日期: 2026-06-17

结论: PASS — 24h 影子验收通过, 基线冻结

核验方式: 独立只读核验 `summary.json` / `SHADOW_FINDINGS.md` / 错误门 / watchdog / 主题正确性 / A 类判据。

归档来源: 本地核验记录 `ALAYA_BASELINE_FREEZE_RECORD.md`（未提交原始本机路径）。

## 冻结基线标识

| 项 | 值 |
|---|---|
| RUN 目录 | `validation-logs/shadow-24h_base_20260616_001359` |
| 评估来源 | `summary.json` 自然结束, 非早停 |
| harness 修复 | `a264fe86 Fix shadow duration drain guard (harness only)` |
| 关键配置 | 稳定配置: 关闭 `MINIMAX_THINKING=adaptive` |
| LLM | provider=openai, base=api.minimax.io, model=MiniMax-M3 |
| scenario | conflict-flood, duration=24h |
| 主题 | 投研主题语料, commit `fe3d95ba` |
| 冻结 tag | `baseline/shadow-24h-base-20260616` |

稳定配置是本基线成立的前提。`MINIMAX_THINKING=adaptive` 会触发 `schema_error` / `invalid_json`, 使 `providerRatio` 掉到 0.58, 不属于本冻结基线配置。

## 8 条验收硬门核验结果

| # | 硬门 | 要求 | 实际 | 判定 |
|---|---|---|---|---|
| 1 | assessment source | `summary.json` 自然结束 | PASS, 0 failing, analyzer exit=0 | PASS |
| 2 | duration / metricsSnapshots | >=24h / >=48 | 24.0146h (86,452,387ms) / 49 | PASS |
| 3 | decisionTsr | PASS, 收敛 `tiered_thesis`, disallowed=0 | PASS, tiered=5, disallowed=0, eligible=9 | PASS |
| 4 | resolutionAccuracy | acc>=0.9, cov>=0.6, PASS | accuracy=1.0, scored=250, coverage=0.796178 | PASS |
| 5 | rssSlopeUnder50MbPerHour | <50 MB/h | slope=-0.074283 MB/h | PASS |
| 6 | 错误门全 0 | UNIQUE / runner_crashed / sample_failed / errorLevel | 全 0 | PASS |
| 7 | watchdog + finalDrain | 全绿 + complete | `finalDrain.status=complete` | PASS |
| 8 | A 类全 PASS | 含 tokenSourceProvider >=95% | `providerRatio=1.0` | PASS |

补充: `sampleCount=288`; 主题正确性已核为 `tiered_thesis` / `long_support` / `short_risk`, 无 `ppg` / `ecg` 残留; `validation-logs/` 产物不纳入 git。

## 与失败臂 treatment 的对照

| 维度 | baseline 冻结基线 | treatment 验收 FAIL |
|---|---|---|
| `MINIMAX_THINKING` | 稳定, 非 adaptive | adaptive |
| `providerRatio` | 1.0 PASS | 0.58 FAIL |
| 其余 7 门 | 全 PASS | 全 PASS |
| 验收结论 | PASS, 可冻结 | FAIL, 不可冻结 |

结论: treatment 失败的唯一根因是实验变量 `MINIMAX_THINKING=adaptive` 引发的 `schema_error` / `invalid_json`, 与 Alaya 底座无关。底座在稳定配置下满分过门。

## 非阻断项 / 遗留课题

- `faithfulness` / `confidenceCalibration` 在非认知实验配置下样本密度低, blockingEligible=false, 不阻断本轮验收。
- latency SLO: scheduler tick p95 偏高, 产品侧问题, sloBlocking=false。
- 认知增强对照实验是单独课题: 需先解决 adaptive thinking 的 `schema_error` / `invalid_json` 根因, 或改用不污染 token source 的增强变量; 同时把 `confidenceCalibration.scored` / `faithfulness.eligible` 从约 2 提到 >=30, 方可下结论。当前认知结论仍为覆盖不足, 不可下结论。

## 本次执行证据

```bash
RUN_BASE=validation-logs/shadow-24h_base_20260616_001359
node scripts/shadow-analyze.mjs --log-dir="$RUN_BASE"
```

结果:

```text
validation-logs/shadow-24h_base_20260616_001359/SHADOW_FINDINGS.md
exit=0
```

聚合事实:

```text
sampleCount=288
validationDurationMs=86452387
durationHours=24.014551944444445
finalDrain.status=complete
providerRatio=1
decisionTsr.status=pass
resolutionAccuracy.status=pass
resolutionAccuracy.accuracy=1
resolutionAccuracy.scoreableCoverage=0.796178
rssSlopeMbPerHour=-0.074283
rssSlopeUnder50MbPerHour=true
```

方法论: 本基线由预注册门槛裁决得出, 未为求 PASS 而调规则、写死或反向修改判据。FAIL / LOW_COVERAGE 均如实记录。
