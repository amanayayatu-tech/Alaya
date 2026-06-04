# CODEX MISSION — Alaya 24h Validation & Maturity Run

> **执行人身份：** 你是一位资深全栈工程师 + AI系统架构师，正在独立完成 Alaya 项目从 Phase 1 MVP 到 Phase 2 "可信可观测飞轮" 的跨越。  
> **核心原则：** 先读、再理解、再动手。绝不在没有文件依据的情况下推断。每个任务完成后运行对应测试。  
> **不可逾越的边界：** 严格遵守 `PRINCIPLES.md` 的全部6条底线。违反任何一条立即停止并说明原因。

---

## 环境信息

```
仓库: https://github.com/amanayayatu-tech/Alaya
技术栈: TypeScript / React 18 / Vite / TailwindCSS / shadcn-ui / Express / Drizzle ORM / SQLite (better-sqlite3) / FTS5
包管理: npm (monorepo workspace)
主目录结构:
  alaya-app/server/     — Express 后端 (flywheel.ts 59KB, scheduler.ts 51KB, storage.ts 40KB, routes.ts 22KB, llm.ts 17KB)
  alaya-app/client/src/ — React 前端
  alaya-app/shared/     — 共享类型与 core 纯函数
  alaya-core/           — 独立核心模块 (含 npm run flywheel 模拟)
  alaya-app/tests/      — 测试目录
环境变量: .env (含 LLM_API_KEY, GITHUB_TOKEN, 已由人类提供)
```

---

## 第一步：强制预读（执行任何任务之前必须完成）

按顺序完整读取以下文件，不跳过：

1. `PRINCIPLES.md` — 项目宪法，6条底线
2. `alaya-app/server/flywheel.ts` — 飞轮主逻辑
3. `alaya-app/server/scheduler.ts` — 调度层
4. `alaya-app/server/storage.ts` — 数据层（含 FTS5 操作）
5. `alaya-app/server/routes.ts` — API 路由层
6. `alaya-app/server/llm.ts` — LLM Provider 接口
7. `alaya-app/server/autonomousGoal.ts` — 自主目标系统
8. `alaya-app/shared/` 目录下所有文件 — 共享类型与 core 纯函数
9. `alaya-app/tests/` 目录下所有现有测试 — 了解当前测试覆盖范围

读取完毕后，输出一份 **Pre-Read Summary**，包含：
- 当前飞轮轮次上限是多少、第4轮是否有独立场景
- `knowledgeItems` 表的完整字段列表
- Pre-task knowledge injection 是否已实现（即任务执行前是否从知识库取数注入 prompt）
- 现有测试文件列表及各自覆盖的模块
- 你发现的前5个最高优先级问题（按严重性排序）

---

## TASK-01：第4轮独立场景保障

**前置条件：** 读取 `flywheel.ts` 全文，确认第4轮场景的当前实现状态。

**目标：** 确保调度器在第4轮不会复用第3轮的场景定义，且第4轮必须产生至少1条新的知识原则。

**具体要求：**

```typescript
// 在 flywheel.ts 中，第4轮场景必须满足：
// 1. scenario.roundNumber === 4 时有独立的 scenarioDescription（≠ 第3轮文本）
// 2. 第4轮执行结束后，调用 distillerShouldProduceNewPrinciple() 验证新原则是否产生
// 3. 若第4轮场景缺失，自动生成一个默认第4轮场景（不报错退出）
```

**新增文件：** `alaya-app/server/round4Scenario.ts`（若第4轮场景逻辑需抽离）

**测试要求（必须写，必须通过）：**

```typescript
// alaya-app/tests/flywheel.round4.test.ts
// test 1: 第4轮 scenario description 与第3轮不同
// test 2: 第4轮执行完成后 knowledgeItems 表中出现至少1条 created_at >= 第4轮开始时间的新记录
// test 3: scheduler 在 roundNumber > 3 时不会触发"轮次复用警告"
```

---

## TASK-02：Pre-task Knowledge Injection Protocol

**这是整个任务包中最重要的一项。**

**前置条件：** 确认 `flywheel.ts` 中 LLM 调用前是否有从 `knowledgeItems` 查询相关知识并注入 system prompt 的逻辑。

**目标：** 每轮任务开始前，强制查询知识库中与本轮任务相关的 `active` 和 `strong` 状态知识，注入到 LLM 的 system context，使知识真正影响下一轮决策。

**实现规范：**

```typescript
// 新增函数: buildKnowledgeContext(taskDescription: string, db: DB): string
// 位置: alaya-app/server/flywheel.ts 或新文件 alaya-app/server/knowledgeInjection.ts
//
// 逻辑:
// 1. 用 FTS5 对 taskDescription 做全文检索，取 active + strong 状态知识
// 2. 按 score DESC 排序，取 TOP 5
// 3. 格式化为:
//    [PRIOR KNOWLEDGE - 置信度 {score}]
//    原则: {statement}
//    证据数: {evidenceCount}
//    ---
// 4. 将此字符串拼入每次 LLM 调用的 system message 开头
// 5. 注入不得超过 800 tokens（做 token 估算截断）
//
// 约束（来自 PRINCIPLES.md 底线4）:
// - 严禁注入 quarantined / conflict / stale / expired 状态的知识
// - 过滤条件只增不减
```

**测试要求：**

```typescript
// alaya-app/tests/knowledgeInjection.test.ts
// test 1: buildKnowledgeContext 只返回 active/strong 知识，不包含 quarantined/conflict/stale
// test 2: 返回知识数量 <= 5
// test 3: 返回字符串不超过 800 tokens 估算（按 chars/4 粗估）
// test 4: 当知识库为空时返回空字符串，不报错
// test 5: 使用 mock LLM 跑一轮完整飞轮，验证 LLM 收到的 system message 包含注入内容
```

---

## TASK-03：PRINCIPLES.md 6条底线的机器守卫测试

**目标：** 把 `PRINCIPLES.md` 的6条底线从文档约束升级为 CI 自动执行的回归测试。

**新建文件：** `alaya-app/tests/principles.guard.test.ts`

**6条底线守卫测试规范：**

```typescript
// ── 底线1：纯函数无副作用 ──
// test 1.1: compute_error 调用100次相同入参，返回值完全一致（幂等性）
// test 1.2: classify_error 不依赖任何 import 的外部状态（用 import analysis 验证，或通过 jest mock 隔离）
// test 1.3: update_confidence 传入固定入参，无论调用顺序如何，结果一致
// test 1.4: transition_state 不写数据库（mock DB，验证 mock 的 write 方法未被调用）

// ── 底线2：strong 晋级必须有人类闸 ──
// test 2.1: 调用 transition_state({ from: 'active', to: 'strong' }) 时，
//           若 humanApproved !== true，返回 { blocked: true, requiresHuman: true }
// test 2.2: 模拟自动化流程（不传 humanApproved），验证知识状态不会变成 'strong'

// ── 底线3：所有写操作必须经过 event_log ──
// test 3.1: 调用 storage.updateKnowledgeItem()，验证 event_log 表中出现对应记录
// test 3.2: 验证 event_log 记录包含非空 actor 字段
// test 3.3: 直接绕过 storage 层用 rawDb 写 knowledgeItems，验证 event_log 无记录（反向验证）

// ── 底线4：脏知识不进高风险证据集 ──
// test 4.1: 插入1条 quarantined 知识，调用 getEvidenceForHighRiskDecision()，验证该知识不出现
// test 4.2: 插入1条 conflict 知识，同上验证
// test 4.3: 插入1条 stale 知识，同上验证
// test 4.4: 插入1条 active 知识，验证它出现在证据集中

// ── 底线5：灰区机制不被简化 ──
// test 5.1: 传入灰区反馈（signal 在 0.3~0.7 之间），验证 alpha/beta 分别做了弱累加（+0.5）
//           而非简单的 +1/+0
// test 5.2: 传入10次连续灰区反馈，验证触发了意义闸（meaningGateTriggered === true）

// ── 底线6：LLM 只通过 LLMProvider 接口调用 ──
// test 6.1: 扫描 server/ 目录所有 .ts 文件，验证不存在直接 import openai / import anthropic
//           （可用 fs.readFileSync + regex 实现）
// test 6.2: 验证 llm.ts 中对外暴露的只有 LLMProvider interface 和实现类，不直接暴露 SDK 对象
```

---

## TASK-04：飞轮健康仪表盘（Flywheel Health Dashboard）

**目标：** 在 Web UI 中加入一个专门的"飞轮健康"页面，让复利进度可视化可监控。

**后端 API（在 routes.ts 中新增）：**

```typescript
// GET /api/flywheel/health
// 返回:
{
  rounds: [
    {
      roundNumber: number,
      startedAt: string,        // ISO 时间
      completedAt: string,
      newKnowledgeCount: number,  // 本轮新产生的知识条数
      promotionCount: number,     // 本轮晋级到 strong 的知识条数
      correctionCount: number,    // 本轮因错误归因触发的知识更新次数
      errorTypes: {               // 错误类型分布
        perception: number,
        execution: number,
        model: number,
        value: number
      },
      humanGatesTriggered: number,   // 触发人类闸次数
      humanGatesResolved: number,    // 已解决的人类闸次数
      knowledgeInjectedCount: number // 本轮注入到 LLM 的知识条数（来自 TASK-02）
    }
  ],
  totals: {
    strongKnowledgeCount: number,
    activeKnowledgeCount: number,
    quarantinedCount: number,
    conflictCount: number,
    totalEvidenceCount: number
  },
  compoundingProof: {
    // 关键：证明复利真实存在
    round1vs4KnowledgeDelta: number,  // 第4轮与第1轮的知识差异数
    principleNoveltyRate: number,     // 每轮平均新原则率
    injectionEffectiveness: number    // 注入知识在后续轮次中被引用的比例（可近似：被 evidenceCount 增加的比例）
  }
}
```

**前端组件（在 alaya-app/client/src/ 中新增）：**

```
FlywheelHealth/
  index.tsx          — 主页面
  RoundTimeline.tsx  — 折线图：X=轮次，Y=新知识/晋级/修正数（用 recharts 或 chart.js）
  KnowledgeStateDonut.tsx — 饼图：strong/active/stale/quarantined/conflict 分布
  CompoundingProof.tsx    — 突出显示 compoundingProof 字段，这是核心指标
  HumanGateQueue.tsx      — 待人类审批的闸门列表（复用或新建）
```

**关键 UI 要求：**
- `CompoundingProof` 区域放在页面最顶部，字号最大，因为这是 Alaya 存在的核心证明
- 若 `round1vs4KnowledgeDelta === 0`，显示红色警告："飞轮未产生复利，请检查知识注入配置"
- 若 `principleNoveltyRate < 0.1`（每轮新原则率低于10%），显示黄色警告

**测试要求：**

```typescript
// alaya-app/tests/flywheelHealth.api.test.ts
// test 1: GET /api/flywheel/health 返回 200 和正确结构
// test 2: rounds 数组长度与数据库中实际飞轮轮次数一致
// test 3: totals.strongKnowledgeCount 与 SELECT COUNT(*) FROM knowledgeItems WHERE status='strong' 一致
// test 4: compoundingProof.round1vs4KnowledgeDelta 在跑过4轮后 > 0
```

---

## TASK-05：知识遗忘机制（Bjork 双强度衰减）

**背景：** 知识库只增不减会导致长期检索噪声积累，PRINCIPLES.md Part3 定义了熵减规则，但需要工程实现。

**目标：** 在 `update_confidence.ts`（纯函数）中实现双强度时间衰减，并在 `scheduler.ts` 定时调用。

**实现规范：**

```typescript
// 1. 纯函数层（alaya-app/shared/core/update_confidence.ts）
// 新增导出函数:
export function applyTimeDecay(
  knowledge: { score: number; lastVerifiedAt: number; storageStrength: number },
  currentTime: number,
  lambda: number = 0.03  // 衰减系数，默认值可在 PRINCIPLES.md Part2 症状C 调节
): { newScore: number; newStorageStrength: number } {
  // Bjork 双强度模型:
  // retrievalStrength 随时间衰减: R(t) = R0 * exp(-lambda * daysSinceLastVerified)
  // storageStrength 随每次成功检索增加（但这里只做时间衰减部分）
  // newScore = score * exp(-lambda * daysSinceVerified)
  // 若 newScore < 0.5，知识应降为 stale
  // 纯函数：不写 DB，只返回新值
}

// 2. 调度层（scheduler.ts）
// 新增定时任务: decayStaleKnowledge()
// 每24小时执行一次（或每次飞轮轮次结束后执行）
// 读取所有非 quarantined/expired 知识 → 调用 applyTimeDecay → 若 newScore < 0.5 → 降为 stale
// 全程走 event_log 审计，actor = 'time_decay_scheduler'

// 约束（来自 PRINCIPLES.md 底线1）:
// applyTimeDecay 必须是纯函数，时间作为参数传入，不调用 Date.now()
```

**测试要求：**

```typescript
// alaya-core/src/core/update_confidence.decay.test.ts
// test 1: applyTimeDecay(score=0.8, lastVerified=30天前, lambda=0.03) 返回 score < 0.8
// test 2: applyTimeDecay(score=0.8, lastVerified=0天前) 返回 score ≈ 0.8（无衰减）
// test 3: 当 newScore < 0.5 时，返回标志 shouldDemoteToStale: true
// test 4: applyTimeDecay 是幂等纯函数（相同入参多次调用结果一致）
// test 5: 集成测试：插入一条 active 知识，设 lastVerifiedAt 为90天前，运行 decayStaleKnowledge()，
//         验证该知识状态变为 'stale' 且 event_log 有记录
```

---

## TASK-06：GitHub Actions CI 配置

**目标：** 让每次 push 到 main 分支自动运行所有测试，让 PRINCIPLES.md 的底线成为机器强制约束。

**新建文件：** `.github/workflows/ci.yml`

```yaml
name: Alaya CI

on:
  push:
    branches: [main, 'feat/**', 'fix/**']
  pull_request:
    branches: [main]

jobs:
  unit-and-integration:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies (root)
        run: npm ci
      
      - name: Install dependencies (alaya-app)
        run: cd alaya-app && npm ci
      
      - name: Install dependencies (alaya-core)
        run: cd alaya-core && npm ci
      
      - name: Run alaya-core unit tests
        run: cd alaya-core && npm test
        # 覆盖: compute_error, classify_error, update_confidence, transition_state
        # 包含: applyTimeDecay 测试 (TASK-05)
      
      - name: Run PRINCIPLES guard tests
        run: cd alaya-app && npm test -- --testPathPattern="principles.guard"
        # 覆盖: TASK-03 的6条底线守卫
        # 此步骤失败 = 底线被违反，绝不允许 merge
      
      - name: Run flywheel round4 tests
        run: cd alaya-app && npm test -- --testPathPattern="flywheel.round4"
        # 覆盖: TASK-01
      
      - name: Run knowledge injection tests
        run: cd alaya-app && npm test -- --testPathPattern="knowledgeInjection"
        # 覆盖: TASK-02
      
      - name: Run flywheel health API tests
        run: cd alaya-app && npm test -- --testPathPattern="flywheelHealth"
        # 覆盖: TASK-04
      
      - name: Run full test suite
        run: cd alaya-app && npm test -- --coverage
        # 全量覆盖率报告，目标覆盖率: core 纯函数 > 90%, storage层 > 70%
      
      - name: Run flywheel simulation (alaya-core)
        run: cd alaya-core && npm run flywheel
        # 验证4轮飞轮模拟仍正常运行且第4轮有独立场景
        env:
          CI: true

  live-llm-validation:
    runs-on: ubuntu-latest
    timeout-minutes: 120  # 2小时超时，允许跑多轮真实 LLM 调用
    needs: unit-and-integration  # 单测全过才运行
    if: github.ref == 'refs/heads/main'  # 只在 main 分支跑真实 LLM
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: |
          npm ci
          cd alaya-app && npm ci
      
      - name: Run live flywheel with real LLM (4 rounds)
        run: cd alaya-app && npm run flywheel:live
        env:
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          FLYWHEEL_ROUNDS: 4
          FLYWHEEL_VALIDATE_COMPOUNDING: true  # 验证复利指标
        # 期望输出: round1vs4KnowledgeDelta > 0, 第4轮新原则 >= 1
      
      - name: Assert compounding proof
        run: cd alaya-app && node scripts/assertCompoundingProof.js
        # 读取上一步产生的 flywheel-report.json，断言复利指标
        # 若 round1vs4KnowledgeDelta === 0，以非零退出码终止（让 CI 红掉）
      
      - name: Upload flywheel report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: flywheel-report
          path: alaya-app/flywheel-report.json
```

**还需新建：** `alaya-app/scripts/assertCompoundingProof.js`

```javascript
// 读取 flywheel-report.json
// 断言:
//   compoundingProof.round1vs4KnowledgeDelta > 0
//   compoundingProof.principleNoveltyRate >= 0.1
//   totals.strongKnowledgeCount >= 1 (至少1条知识通过了人类闸变成 strong)
// 失败时: process.exit(1) + 打印诊断信息
```

---

## TASK-07：24小时持续验证调度脚本

**目标：** 在服务器/本地运行一个24小时的持续验证循环，模拟真实使用压力，检测飞轮在长时间运行下的稳定性。

**新建文件：** `scripts/24h_validation.sh`

```bash
#!/bin/bash
# Alaya 24h Validation Runner
# 用法: ./scripts/24h_validation.sh
# 需要: LLM_API_KEY, GITHUB_TOKEN 在环境变量中

set -e

LOG_DIR="./validation-logs/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"
REPORT_FILE="$LOG_DIR/validation_report.json"
START_TIME=$(date +%s)
END_TIME=$((START_TIME + 86400))  # 24小时

echo "🚀 Alaya 24h Validation Started at $(date)"
echo "📁 Logs: $LOG_DIR"
echo "⏰ Will run until: $(date -d @$END_TIME)"

ROUND=0
ERRORS=0
MAX_CONSECUTIVE_ERRORS=3
CONSECUTIVE_ERRORS=0

# 初始化报告
echo '{"rounds": [], "errors": [], "startTime": "'$(date -Iseconds)'"}' > "$REPORT_FILE"

while [ $(date +%s) -lt $END_TIME ]; do
  ROUND=$((ROUND + 1))
  ROUND_START=$(date +%s)
  
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🔄 Round $ROUND starting at $(date)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  # Step 1: 单元测试（快速验证底线未被破坏）
  echo "📋 Step 1: Running principles guard tests..."
  if cd alaya-app && npm test -- --testPathPattern="principles.guard" --silent 2>&1 | tee "$LOG_DIR/round${ROUND}_unit.log"; then
    echo "✅ Principles guard: PASSED"
    CONSECUTIVE_ERRORS=0
  else
    echo "❌ CRITICAL: Principles guard FAILED — a baseline has been violated!"
    ERRORS=$((ERRORS + 1))
    CONSECUTIVE_ERRORS=$((CONSECUTIVE_ERRORS + 1))
    # 底线被违反 → 立即停止
    echo "🛑 STOPPING: Baseline violation detected. Review $LOG_DIR/round${ROUND}_unit.log"
    exit 1
  fi
  cd ..
  
  # Step 2: 飞轮模拟（无 LLM，确认逻辑完整）
  echo "⚙️  Step 2: Running flywheel simulation..."
  if cd alaya-core && npm run flywheel 2>&1 | tee "$LOG_DIR/round${ROUND}_flywheel_sim.log"; then
    echo "✅ Flywheel simulation: PASSED"
  else
    echo "⚠️  Flywheel simulation failed (non-critical, continuing)"
    ERRORS=$((ERRORS + 1))
  fi
  cd ..
  
  # Step 3: 真实 LLM 飞轮（每3轮跑一次，避免 API 费用过高）
  if [ $((ROUND % 3)) -eq 0 ]; then
    echo "🤖 Step 3: Running live LLM flywheel (every 3 rounds)..."
    if cd alaya-app && LLM_API_KEY=$LLM_API_KEY npm run flywheel:live 2>&1 | tee "$LOG_DIR/round${ROUND}_live.log"; then
      echo "✅ Live LLM flywheel: PASSED"
      # 验证复利指标
      if node scripts/assertCompoundingProof.js 2>&1 | tee -a "$LOG_DIR/round${ROUND}_live.log"; then
        echo "✅ Compounding proof: VERIFIED"
      else
        echo "⚠️  Compounding proof: NOT YET (expected in early rounds)"
      fi
    else
      echo "⚠️  Live LLM flywheel failed — check API key or rate limits"
      ERRORS=$((ERRORS + 1))
      CONSECUTIVE_ERRORS=$((CONSECUTIVE_ERRORS + 1))
    fi
    cd ..
  fi
  
  # Step 4: Health API 检查（若 server 在运行）
  echo "🏥 Step 4: Checking flywheel health API..."
  if curl -sf http://localhost:5000/api/flywheel/health > "$LOG_DIR/round${ROUND}_health.json" 2>&1; then
    echo "✅ Health API: OK"
    # 检查复利指标
    DELTA=$(node -e "const r=require('./$LOG_DIR/round${ROUND}_health.json'); console.log(r.compoundingProof?.round1vs4KnowledgeDelta || 0)")
    echo "   round1vs4KnowledgeDelta: $DELTA"
    if [ "$DELTA" -gt "0" ] 2>/dev/null; then
      echo "   🎉 Compounding CONFIRMED!"
    fi
  else
    echo "ℹ️  Health API not available (server may not be running)"
  fi
  
  ROUND_END=$(date +%s)
  ROUND_DURATION=$((ROUND_END - ROUND_START))
  echo "⏱  Round $ROUND completed in ${ROUND_DURATION}s"
  
  # 连续错误保护
  if [ $CONSECUTIVE_ERRORS -ge $MAX_CONSECUTIVE_ERRORS ]; then
    echo "🛑 STOPPING: $MAX_CONSECUTIVE_ERRORS consecutive errors detected"
    exit 1
  fi
  
  # 轮次间隔（避免 API rate limit）
  echo "💤 Sleeping 600s before next round..."
  sleep 600
done

# 最终报告
TOTAL_RUNTIME=$(( $(date +%s) - START_TIME ))
echo ""
echo "══════════════════════════════════════════"
echo "🏁 Alaya 24h Validation COMPLETED"
echo "   Total rounds: $ROUND"
echo "   Total errors: $ERRORS"
echo "   Total runtime: ${TOTAL_RUNTIME}s"
echo "   Logs: $LOG_DIR"
echo "══════════════════════════════════════════"
```

---

## TASK-08：知识库 schema 字段补强

**目标：** 给 `knowledgeItems` 表新增若干字段，让知识的可追溯性和复利证明更完整。

**前置：** 读取 `storage.ts` 确认当前 `knowledgeItems` 表结构，用 Drizzle ORM migration。

**需要新增的字段（若尚不存在）：**

```typescript
// 在 storage.ts 或 shared/schema.ts 中：
{
  supersededBy: integer('superseded_by'),     // 指向合并目标的 knowledge id
  usageCount: integer('usage_count').default(0), // 被注入到 LLM 的累计次数（来自 TASK-02）
  lastInjectedAt: integer('last_injected_at'),   // 最近一次被注入的时间戳
  storageStrength: real('storage_strength').default(1.0), // Bjork 双强度（来自 TASK-05）
  noveltyScore: real('novelty_score'),            // 与已有知识的语义差异度（0~1）
  sourceRound: integer('source_round'),           // 在第几轮飞轮中产生
}
```

**Drizzle migration：**
- 生成并运行 migration，不破坏现有数据
- 为新字段设置合理 DEFAULT，确保现有记录不报错

**测试要求：**
```typescript
// 验证 migration 后现有知识记录仍可正常读写
// 验证 usageCount 在 TASK-02 的注入逻辑执行后自增
```

---

## 执行顺序与时间规划

```
第 1-2 小时:  预读（强制，不可跳过）+ Pre-Read Summary
第 2-4 小时:  TASK-01（第4轮场景）+ TASK-03（底线守卫测试）
第 4-7 小时:  TASK-02（知识注入协议）— 这是核心，给足时间
第 7-9 小时:  TASK-08（Schema 补强）+ TASK-05（衰减机制）
第 9-12 小时: TASK-04（健康仪表盘）— 后端 API + 前端组件
第 12-14 小时: TASK-06（GitHub Actions CI）
第 14-16 小时: TASK-07（24h 验证脚本）+ 集成联调
第 16-24 小时: 运行 24h_validation.sh，监控输出，修复发现的问题
```

---

## 每完成一个 TASK 后的强制检查清单

```
□ 对应测试全部通过（无跳过、无 skip）
□ npm run flywheel（alaya-core）仍然正常运行
□ PRINCIPLES.md 的6条底线守卫测试全部通过
□ TypeScript 编译无新增错误（tsc --noEmit）
□ 没有引入新的直接 import openai / import anthropic（违反底线6）
□ event_log 审计路径未被旁路（所有写操作仍有 actor 记录）
□ 提交信息格式: feat/fix/test/refactor/docs: 简短描述
```

---

## 关键约束重申

1. **绝不自动批准 strong 晋级** — 即使在测试中，也用 `humanApproved: true` 显式传参，不设全局开关
2. **所有时间参数显式传入** — 纯函数不调用 `Date.now()`，时间从外部注入，保证可测试性
3. **LLM 只通过接口调用** — 任何新增 LLM 调用必须走 `LLMProvider` 接口，不直接引入 SDK
4. **知识注入严格过滤** — `buildKnowledgeContext` 的过滤条件 `status IN ('active', 'strong')` 是硬约束，不得因"覆盖面不够"而放宽
5. **衰减是纯函数** — `applyTimeDecay` 必须通过单测验证幂等性，时间衰减不依赖 wall clock

---

## 输出要求

每完成一个 TASK，输出：
1. 修改了哪些文件（新增/修改/删除）
2. 测试命令与输出摘要（通过/失败数）
3. 若发现 PRINCIPLES.md 底线冲突，**立即停止**并说明冲突位置

最终输出一份 `VALIDATION_REPORT.md`，包含：
- 8个 TASK 的完成状态
- 底线守卫测试的通过率
- 飞轮复利指标（round1vs4KnowledgeDelta, principleNoveltyRate）
- 发现的问题列表及处理方式
- 24h 验证期间的错误统计
