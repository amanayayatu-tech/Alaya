# Phase3 发布级 16-run 执行手册

> 在用户本机 Mac `/Users/peachy/Documents/alaya` 执行。沙盒/助手无法访问本机、MiniMax、.git。
> 目标：8 对配对 run（disabled / adaptive 各 8），含先行 2 对 pilot。每 run 跑到自然 summary.json，不主动 Ctrl-C。

---

## 0. 设计：配对 + 交错 + 随机化

- **配对**：第 i 对的两臂用**相同注入序号集**（如 sample_0001..0040_tiered_support），只差 `MINIMAX_THINKING`。
- **交错顺序**：避免时间漂移（API 负载、模型端波动）系统性偏向某一臂。每对内部随机决定先跑 disabled 还是 adaptive，并记录顺序。
- **随机化种子表**：跑前用下面脚本生成 8 对的执行顺序，写入 `validation-logs/phase3_run_order.txt` 并 commit（预注册的一部分）。

```bash
# 生成配对执行顺序（在本机跑一次，结果入库）
python3 - <<'PY'
import random
random.seed(20260617)  # 固定种子，可复现
arms=["disabled","adaptive"]
order=[]
for pair in range(1,9):
    a=arms[:]; random.shuffle(a)
    order.append((pair,a[0],a[1]))
for p,first,second in order:
    print(f"pair{p:02d}\tfirst={first}\tsecond={second}")
PY
```

---

## 1. 防早停（每个 run 必做）

```bash
# tmux 会话 + 防休眠
tmux new -s phase3_pXX_arm
caffeinate -i bash -lc '<下面的启动命令>'
# 跑到自然 summary.json；24h（或 scenario 自然时长）内不主动中断
```

---

## 2. 双臂启动命令模板（唯一变量 MINIMAX_THINKING）

**Disabled 臂**
```bash
cd /Users/peachy/Documents/alaya
PORT=4801 \
ALAYA_DB_PATH=./validation-logs/phase3_pXX_base.db \
ALAYA_SCHEDULER=false \
ALAYA_AUTO_SEED_DEMO=false \
ALAYA_LLM_PROVIDER=openai \
OPENAI_BASE_URL=https://api.minimax.io/openai \
OPENAI_MODEL=MiniMax-M3 \
OPENAI_API_KEY=$OPENAI_API_KEY \
MINIMAX_THINKING=disabled \
node scripts/health-signal-36h-validation.mjs \
  --scenario cognition-coverage \
  --log-dir validation-logs/phase3_pXX_YYYYMMDD_HHMMSS_base
```

**Adaptive 臂**（仅改 3 处：端口、DB、log-dir，以及 MINIMAX_THINKING）
```bash
cd /Users/peachy/Documents/alaya
PORT=4802 \
ALAYA_DB_PATH=./validation-logs/phase3_pXX_treat.db \
ALAYA_SCHEDULER=false \
ALAYA_AUTO_SEED_DEMO=false \
ALAYA_LLM_PROVIDER=openai \
OPENAI_BASE_URL=https://api.minimax.io/openai \
OPENAI_MODEL=MiniMax-M3 \
OPENAI_API_KEY=$OPENAI_API_KEY \
MINIMAX_THINKING=adaptive \
node scripts/health-signal-36h-validation.mjs \
  --scenario cognition-coverage \
  --log-dir validation-logs/phase3_pXX_YYYYMMDD_HHMMSS_treat
```

> ⚠️ 核对启动命令实际 flag 名（`--scenario` / `--log-dir`）与脚本一致；交接文档与脚本是真理来源，本模板按惯例填写，跑前用 `node scripts/health-signal-36h-validation.mjs --help` 校对。

---

## 3. 命名规范（产物归档）

```
validation-logs/phase3_pXX_YYYYMMDD_HHMMSS_base/    # disabled 臂
validation-logs/phase3_pXX_YYYYMMDD_HHMMSS_treat/   # adaptive 臂
  └── summary.json          # 自然收尾的汇总
  └── quality_summary.json  # analyzer 产物（已 gitignore）
```
- `validation-logs/` 不进 git；只把每 run 的关键指标摘录进 `analysis/phase3_results.csv`（见 §4）。

---

## 4. 每 run 完成后的有效性核对 + 数据摘录

每个 run 跑完，**先过 §5 预注册硬门**，再摘录：

```bash
# 摘录单个 run 的关键指标到 CSV（在本机跑）
python3 scripts/extract_phase3_metrics.py \
  validation-logs/phase3_pXX_..._base/quality_summary.json base pXX \
  >> analysis/phase3_results.csv
```
摘录字段（每行一个 run）：
`pair, arm, ece, faithfulness, scored, eligible, providerRatio, correctnessMode_truth_count, bucket8_n, bucket8_accuracy, bucket8_confMean, run_valid(0/1), reason_if_invalid`

> **bucket8 三列是下钻审查的命门**：注入样本应集中在 conf 0.81-0.86（bucket 8）。若 bucket8_accuracy 系统性≈0 → 该 run 度量无效，作废重跑。

---

## 5. Pilot 决策闸门（跑完前 2 对后必做，进阶段 B 前）

```bash
# 用前 2 对的 4 个有效 run 估 sigma_d，决定最终 N
python3 analysis/phase3_pilot_decision.py analysis/phase3_results.csv
```
脚本输出 σ_d 估计与对应建议 N（参照预注册 §3 表）。把决策写入 `validation-logs/phase3_N_decision.md` 并 commit。**N 冻结后不再改。**

---

## 6. 完成全部 run 后

```bash
python3 analysis/phase3_stats.py analysis/phase3_results.csv
# 输出：配对 t 检验（单侧优越性）、TOST 等效、CI、正态性校验、reliabilityTable 汇总
```
将输出回填进白皮书 `WHITEPAPER_phase3.md` 的结果与下钻验证章节。

---

## 7. 红线（违反即作废发布资格）

- 跑数据期间**改任何代码 / 度量定义 / 判据** → 实验失效。
- 剔除非硬门失败的 run → 数据污染。
- 跳过 reliabilityTable 下钻 → 违反核验纪律。
- 用次指标 faithfulness 抵消 ECE 主结论。
