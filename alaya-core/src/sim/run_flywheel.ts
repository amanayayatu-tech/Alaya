/**
 * 4 轮飞轮数值模拟主程序 (PRD 17.3 飞轮验收 + 第4轮复利延展)。
 *
 * 通过标准:
 * - 第3轮建议明确引用前两轮知识,并说明知识如何改变建议(非形式引用)。
 * - 第4轮不复用第3轮模板,而是产出可回滚变更包、审计摘要和新治理原则。
 * - 不重复已否决方向。
 * - pending_human 不无限膨胀。
 * - 5 个 Agent 每轮都有运行记录。
 *
 * 运行: npm run flywheel
 */

import { Store } from "../state/store.js";
import { createLLMProvider } from "../llm/provider.js";
import { SCENARIO } from "./scenario.js";
import {
  runOrchestrator,
  humanResolveDirectionGate,
  runSensor,
  runBuilder,
  evaluatePrediction,
  runDistiller,
  runLibrarian,
} from "../agents/agents.js";
import { evidenceCount } from "../core/types.js";

function hr() {
  console.log("─".repeat(72));
}

async function runFlywheel() {
  const store = new Store();
  store.project = {
    id: "proj_001",
    name: "一键发布产品",
    direction: "帮独立开发者快速发布",
    targetUser: "独立开发者",
    redlines: ["不自动付款", "不自动公开发布"],
    weeklyHumanMinutes: 150,
  };
  const llm = createLLMProvider();

  console.log("\n╔" + "═".repeat(70) + "╗");
  console.log("║  Alaya 4 轮飞轮数值模拟 (全程 mock LLM)" + " ".repeat(28) + "║");
  console.log("╚" + "═".repeat(70) + "╝");

  for (const sc of SCENARIO) {
    hr();
    console.log(`\n【第 ${sc.index} 轮 cycle】`);

    // 1. Orchestrator 生成目标 + 方向闸
    const plan = await runOrchestrator(store, sc, llm);
    console.log(`  目标: ${plan.goal}`);
    if (plan.refs.length) {
      console.log(`  ✦ 引用知识: ${plan.refs.join(", ")}`);
      console.log(`  ✦ 知识如何改变决策: ${plan.reasoning}`);
    }

    // 2. 人类处理方向闸
    humanResolveDirectionGate(store, plan.gate, sc);
    console.log(`  方向闸: 已批准 (备选 ${sc.alternativeGoals.length} 个进入已否决集)`);

    // 3. Sensor 收集反馈
    const sensor = await runSensor(store, sc, llm);
    console.log(`  Sensor: 反馈 ${sc.feedback.length} 条`);
    sc.feedback.forEach((f) => console.log(`    - [${f.category}/${f.sentiment}] "${f.text}"`));

    // 4. Builder 产出 mock build report
    const build = await runBuilder(store, sc, llm, plan.action, plan.refs);
    console.log(`  Builder: build=${build.buildSuccess ? "成功" : "失败"} (mock)`);
    if (build.rollbackPlan) {
      console.log(`  Builder: 产出 rollback-ready change package + audit summary`);
    }

    // 5. 评估预测误差
    const { pred, claim } = evaluatePrediction(store, sc, plan);
    console.log(
      `  预测: "${plan.prediction}"`,
    );
    console.log(
      `  观察: activation=${sc.activationObserved} (目标>=${sc.activationTarget}) ` +
        `=> 误差 e=${claim.error?.toFixed(3)}, E_cycle=${pred.predictionError?.toFixed(3)}, ` +
        `归因=${pred.errorType ?? "无显著误差"} -> ${pred.updateTarget}`,
    );

    // 6. Distiller 提炼知识
    const created = await runDistiller(store, sc, pred, claim.error ?? 0, llm);
    if (created.length) console.log(`  Distiller: 新增知识 ${created.join(", ")}`);
    else console.log(`  Distiller: 强化既有知识证据`);

    // 7. Librarian 整理与状态迁移
    const transitions = await runLibrarian(store, sc, llm);
    if (transitions.length) transitions.forEach((t) => console.log(`  Librarian: ${t}`));
    else console.log(`  Librarian: 无状态迁移`);

    // 本轮知识快照
    console.log(`  知识库快照:`);
    for (const k of store.knowledge.values()) {
      console.log(
        `    [${k.id}] ${k.status.padEnd(10)} score=${k.confidenceScore.toFixed(2)} ` +
          `α=${k.evidenceAlpha} β=${k.evidenceBeta} ev=${evidenceCount(k)} "${k.title}"`,
      );
    }
    const pendingHuman = store.gates.filter((g) => g.status === "pending").length;
    console.log(`  pending_human: ${pendingHuman}`);
  }

  // ---------------- 复利验收 ----------------
  hr();
  console.log("\n【飞轮验收 (PRD 17.3)】\n");

  const cycle3Run = store.agentRuns.find((r) => r.cycleIndex === 3 && r.agent === "orchestrator");
  const cycle3Gate = store.gates.find((g) => g.cycleId === "cycle_3" && g.type === "direction");
  const refsUsed = cycle3Run?.knowledgeRefsUsed ?? [];
  const check1 = refsUsed.length >= 2;
  console.log(
    `  [${check1 ? "✓" : "✗"}] 第3轮建议引用了前两轮知识: ${refsUsed.join(", ") || "无"}`,
  );

  // 第3轮 reasoning 必须说明知识如何改变建议
  const cycle3Reasoning = String(cycle3Gate?.payload.reasoning ?? "");
  const check2 = /改变|迁移|复用|change|reuse|compound/i.test(cycle3Reasoning);
  console.log(
    `  [${check2 ? "✓" : "✗"}] 第3轮说明了被引用知识如何改变决策(非形式引用)`,
  );

  // 不重复已否决方向
  const cycle3Plan = store.agentRuns
    .filter((r) => r.cycleIndex === 3 && r.agent === "orchestrator")
    .map((r) => r.outputSummary)
    .join(" ");
  const reproposedRejected = [...store.rejectedDirections].some((d) =>
    cycle3Plan.includes(d),
  );
  const check3 = !reproposedRejected;
  console.log(
    `  [${check3 ? "✓" : "✗"}] 不重复已否决方向 (已否决: ${[...store.rejectedDirections].join(", ")})`,
  );

  // pending_human 不无限膨胀
  const pending = store.gates.filter((g) => g.status === "pending").length;
  const check4 = pending <= 5;
  console.log(`  [${check4 ? "✓" : "✗"}] pending_human 未膨胀: ${pending} 条 (阈值<=5)`);

  // 5 个 Agent 每轮都有运行记录
  const agents = ["orchestrator", "sensor", "builder", "distiller", "librarian"];
  let allAgentsRan = true;
  for (let ci = 1; ci <= SCENARIO.length; ci++) {
    for (const a of agents) {
      const ran = store.agentRuns.some((r) => r.cycleIndex === ci && r.agent === a);
      if (!ran) allAgentsRan = false;
    }
  }
  const check5 = allAgentsRan;
  console.log(`  [${check5 ? "✓" : "✗"}] 5 个 Agent 每轮都有运行记录 (共 ${store.agentRuns.length} 条)`);

  // 知识库开始淘汰/晋级,而非只增 (PRD 22.6 正确轨道信号)
  const strong = store.strongKnowledge().length;
  const check6 = strong >= 1;
  console.log(`  [${check6 ? "✓" : "✗"}] 知识开始晋级 strong: ${strong} 条`);

  // 误差驱动修正:第1轮失败误差应触发 world_model 更新
  const c1pred = store.predictions.find((p) => p.cycleId === "cycle_1");
  const check7 = c1pred?.errorType === "model" && c1pred.updateTarget === "distiller_world_model_update";
  console.log(`  [${check7 ? "✓" : "✗"}] 预测误差驱动修正: 第1轮失败归因=${c1pred?.errorType} -> ${c1pred?.updateTarget}`);

  // 第4轮必须区别于第3轮:可回滚变更包 + 审计摘要 + 新 principle
  const c3pred = store.predictions.find((p) => p.cycleId === "cycle_3");
  const c4pred = store.predictions.find((p) => p.cycleId === "cycle_4");
  const c4gate = store.gates.find((g) => g.cycleId === "cycle_4" && g.type === "direction");
  const c4principle = [...store.knowledge.values()].find((k) => k.createdByCycle === 4 && k.type === "principle");
  const c4Payload = c4gate?.payload ?? {};
  const check8 = Boolean(
    c4pred &&
    c3pred &&
    c4pred.id === "pred_c4_rollback" &&
    c4pred.action !== c3pred.action &&
    /回滚|审计|rollback|audit/i.test(c4pred.action) &&
    c4Payload.rollbackPlan &&
    c4Payload.auditSummary &&
    c4principle &&
    /可回滚路径与审计摘要|rollback-ready change package|audit summary/i.test(`${c4principle.title} ${c4principle.content}`),
  );
  console.log(`  [${check8 ? "✓" : "✗"}] 第4轮不是第3轮拷贝:产出可回滚变更包、审计摘要和新 principle`);

  hr();
  const allPass = check1 && check2 && check3 && check4 && check5 && check6 && check7 && check8;
  console.log(
    `\n  ${allPass ? "✅ 飞轮验收全部通过 —— 飞轮转起来了,且第3轮决策被前两轮知识改变,第4轮继续产出可追责资产。" : "❌ 飞轮验收未全部通过"}\n`,
  );

  // event_log 完整性
  console.log(`  event_log 共 ${store.eventLog.length} 条 (支持 replay)`);
  console.log(`  decision_log 共 ${store.decisionLog.length} 条`);
  console.log(`  llm_calls 共 ${store.llmCalls.length} 条 (provider=${llm.name})`);
  console.log();

  process.exit(allPass ? 0 : 1);
}

runFlywheel().catch((err) => {
  console.error(err);
  process.exit(1);
});
