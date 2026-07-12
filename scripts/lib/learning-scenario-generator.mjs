#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const GENERATOR_SCHEMA = 'alaya.learning_loop.generated_cases.v1';
export const ORACLE_SCHEMA = 'alaya.learning_loop.oracle_answers.v1';
export const GENERATOR_VERSION = 1;
export const DEFAULT_DOMAIN_CONFIG_PATH = resolve(__dirname, 'learning-scenario-domain.json');
export const DEFAULT_WORLD_SEEDS = [
  '2026070901',
  '2026070902',
  '2026070903',
  '2026070904',
  '2026070905',
  '2026070906',
  '2026070907',
  '2026070908',
  '2026070909',
  '2026070910',
  '2026070911',
  '2026070912',
  '2026070913',
  '2026070914',
  '2026070915',
  '2026070916',
  '2026070917',
  '2026070918',
  '2026070919',
  '2026070920',
  '2026070921',
  '2026070922',
  '2026070923',
  '2026070924'
];

const DEFAULT_WORLD_SEED = DEFAULT_WORLD_SEEDS[0];
const DEFAULT_COUNT = 120;
const DEFAULT_TRAIN_RATIO = 0.8;

const CANONICAL_SIGNALS = [
  { id: 'earnings_revision', polarity: 'positive', kind: 'fundamental' },
  { id: 'margin_repair', polarity: 'positive', kind: 'fundamental' },
  { id: 'cash_flow_quality', polarity: 'positive', kind: 'quality' },
  { id: 'valuation_discount', polarity: 'positive', kind: 'valuation' },
  { id: 'upside_catalyst', polarity: 'positive', kind: 'catalyst' },
  { id: 'short_crowding', polarity: 'positive', kind: 'positioning' },
  { id: 'guidance_cut', polarity: 'negative', kind: 'fundamental' },
  { id: 'liquidity_risk', polarity: 'negative', kind: 'balance_sheet' },
  { id: 'event_risk', polarity: 'negative', kind: 'risk' },
  { id: 'drawdown_pressure', polarity: 'negative', kind: 'technical' },
  { id: 'regulatory_risk', polarity: 'negative', kind: 'risk' },
  { id: 'risk_budget_tight', polarity: 'negative', kind: 'portfolio' }
];

const DECISIONS = [
  'increase_long',
  'maintain_long',
  'reduce_exposure',
  'avoid_trade',
  'short_bias'
];

const RULE_BLUEPRINTS = [
  { id: 'R1', decision: 'increase_long', requiredPolarity: 'positive', requiredCount: 3, avoidPolarity: 'negative', avoidCount: 1, confidence: 0.82 },
  { id: 'R2', decision: 'maintain_long', requiredPolarity: 'positive', requiredCount: 2, avoidPolarity: 'negative', avoidCount: 2, confidence: 0.69 },
  { id: 'R3', decision: 'reduce_exposure', requiredPolarity: 'negative', requiredCount: 2, avoidPolarity: 'positive', avoidCount: 1, confidence: 0.75 },
  { id: 'R4', decision: 'avoid_trade', requiredPolarity: 'mixed', requiredCount: 3, avoidPolarity: 'none', avoidCount: 0, confidence: 0.61 },
  { id: 'R5', decision: 'short_bias', requiredPolarity: 'negative', requiredCount: 3, avoidPolarity: 'positive', avoidCount: 1, confidence: 0.84 },
  { id: 'R6', decision: 'increase_long', requiredPolarity: 'positive', requiredCount: 2, avoidPolarity: 'negative', avoidCount: 2, confidence: 0.78 },
  { id: 'R7', decision: 'reduce_exposure', requiredPolarity: 'negative', requiredCount: 2, avoidPolarity: 'none', avoidCount: 0, confidence: 0.72 },
  { id: 'R8', decision: 'avoid_trade', requiredPolarity: 'mixed', requiredCount: 4, avoidPolarity: 'none', avoidCount: 0, confidence: 0.58 }
];

export function loadDomainConfig(path = DEFAULT_DOMAIN_CONFIG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createSeededRng(seed) {
  let state = hashString(String(seed));
  return function rng() {
    state += 0x6d2b79f5;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function stableShuffle(items, seed) {
  const rng = createSeededRng(seed);
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function takeSignals({ worldSeed, ruleIndex, polarity, count, excludeIds = [] }) {
  if (count === 0 || polarity === 'none') return [];

  const excluded = new Set(excludeIds);
  let pool = CANONICAL_SIGNALS.filter((signal) => !excluded.has(signal.id));
  if (polarity === 'positive' || polarity === 'negative') {
    pool = pool.filter((signal) => signal.polarity === polarity);
  }

  if (polarity === 'mixed') {
    const positives = stableShuffle(
      CANONICAL_SIGNALS.filter((signal) => signal.polarity === 'positive' && !excluded.has(signal.id)),
      `${worldSeed}:rule:${ruleIndex}:mixed:positive`
    );
    const negatives = stableShuffle(
      CANONICAL_SIGNALS.filter((signal) => signal.polarity === 'negative' && !excluded.has(signal.id)),
      `${worldSeed}:rule:${ruleIndex}:mixed:negative`
    );
    const mixed = [];
    while (mixed.length < count && (positives.length > 0 || negatives.length > 0)) {
      if (positives.length > 0) mixed.push(positives.shift());
      if (mixed.length < count && negatives.length > 0) mixed.push(negatives.shift());
    }
    return mixed.slice(0, count);
  }

  return stableShuffle(pool, `${worldSeed}:rule:${ruleIndex}:${polarity}`).slice(0, count);
}

export function buildWorldRules({ worldSeed = DEFAULT_WORLD_SEED } = {}) {
  return RULE_BLUEPRINTS.map((blueprint, index) => {
    const requiredSignals = takeSignals({
      worldSeed,
      ruleIndex: index,
      polarity: blueprint.requiredPolarity,
      count: blueprint.requiredCount
    });
    const avoidSignals = takeSignals({
      worldSeed,
      ruleIndex: index,
      polarity: blueprint.avoidPolarity,
      count: blueprint.avoidCount,
      excludeIds: requiredSignals.map((signal) => signal.id)
    });
    const salt = hashString(`${worldSeed}:${blueprint.id}:${requiredSignals.map((signal) => signal.id).join(',')}`);
    const familyDecisions = blueprint.requiredPolarity === 'positive'
      ? ['increase_long', 'maintain_long']
      : blueprint.requiredPolarity === 'negative'
        ? ['reduce_exposure', 'short_bias']
        : ['avoid_trade'];
    const decision = familyDecisions.includes(blueprint.decision)
      ? familyDecisions[salt % familyDecisions.length]
      : blueprint.decision;

    return {
      id: blueprint.id,
      ruleRef: `${String(worldSeed)}:${blueprint.id}`,
      priority: index + 1,
      decision,
      requiredSignals: requiredSignals.map((signal) => signal.id),
      avoidSignals: avoidSignals.map((signal) => signal.id),
      confidenceBase: blueprint.confidence,
      rationaleTemplateIndex: salt % 5
    };
  });
}

function normalizeTrainRatio(trainRatio) {
  const value = Number(trainRatio);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`trainRatio must be greater than 0 and less than 1; received ${trainRatio}`);
  }
  return value;
}

function normalizeCount(count) {
  const value = Number(count);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`count must be a positive integer; received ${count}`);
  }
  return value;
}

function normalizeSplit(split) {
  if (split === undefined || split === null || split === 'all') return 'all';
  if (split === 'train' || split === 'heldout') return split;
  throw new Error(`split must be all, train, or heldout; received ${split}`);
}

function skinSignal(signalId, domainConfig) {
  const canonical = CANONICAL_SIGNALS.find((signal) => signal.id === signalId);
  const skin = domainConfig.signalSkins?.[signalId] ?? {};
  return {
    id: signalId,
    label: skin.label ?? signalId,
    text: skin.text ?? signalId,
    kind: skin.kind ?? canonical?.kind ?? 'unknown',
    polarity: skin.polarity ?? canonical?.polarity ?? 'neutral'
  };
}

function buildFeatures(selectedSignalIds, avoidSignalIds) {
  const selected = new Set(selectedSignalIds);
  const avoided = new Set(avoidSignalIds);
  const featureMap = {};
  for (const signal of CANONICAL_SIGNALS) {
    featureMap[signal.id] = selected.has(signal.id);
  }
  return {
    canonicalSignals: featureMap,
    selectedSignalIds,
    absentRequiredAvoidSignals: [...avoidSignalIds],
    positiveSignalCount: CANONICAL_SIGNALS.filter((signal) => signal.polarity === 'positive' && selected.has(signal.id)).length,
    negativeSignalCount: CANONICAL_SIGNALS.filter((signal) => signal.polarity === 'negative' && selected.has(signal.id)).length,
    avoidedSignalCount: avoidSignalIds.length,
    selectedAvoidSignalCount: avoidSignalIds.filter((id) => selected.has(id)).length
  };
}

function makeCase({ worldSeed, index, count, trainCutoff, rule, domainConfig, trainRatio }) {
  const pool = index < trainCutoff ? 'train' : 'heldout';
  const caseRng = createSeededRng(`${worldSeed}:case:${index}`);
  const selected = new Set(rule.requiredSignals);
  const unavailable = new Set([...rule.requiredSignals, ...rule.avoidSignals]);
  const preferredFillerPolarity = ['increase_long', 'maintain_long'].includes(rule.decision)
    ? 'positive'
    : ['reduce_exposure', 'short_bias'].includes(rule.decision)
      ? 'negative'
      : null;
  const fillerPool = CANONICAL_SIGNALS.filter((signal) => !unavailable.has(signal.id));
  const preferredFillerPool = preferredFillerPolarity
    ? fillerPool.filter((signal) => signal.polarity === preferredFillerPolarity)
    : fillerPool;
  const fillerCandidates = stableShuffle(
    (preferredFillerPool.length > 0 ? preferredFillerPool : fillerPool).map((signal) => signal.id),
    `${worldSeed}:case:${index}:fillers`
  );
  const fillerTarget = 1 + Math.floor(caseRng() * 3);
  for (const signalId of fillerCandidates.slice(0, fillerTarget)) {
    selected.add(signalId);
  }

  const selectedSignalIds = [...selected].sort();
  const signals = selectedSignalIds.map((signalId) => skinSignal(signalId, domainConfig));
  const confidenceJitter = (Math.floor(caseRng() * 7) - 3) / 100;
  const confidence = Math.max(0.51, Math.min(0.94, Number((rule.confidenceBase + confidenceJitter).toFixed(2))));
  const decisionSkin = domainConfig.decisionSkins?.[rule.decision] ?? {};
  const entity = `${domainConfig.caseStyle?.entityPrefix ?? 'CASE'}-${String(index + 1).padStart(4, '0')}`;
  const title = `${domainConfig.caseStyle?.headlinePrefix ?? 'Learning scenario'} ${entity}`;
  const rationaleTemplates = domainConfig.rationaleTemplates ?? [];
  const rationale = rationaleTemplates[rule.rationaleTemplateIndex % Math.max(1, rationaleTemplates.length)]
    ?? 'The hidden world rule maps this signal bundle to the expected decision.';
  const caseId = `learning_${worldSeed}_${String(index + 1).padStart(4, '0')}`;

  return {
    schema: GENERATOR_SCHEMA,
    generatorVersion: GENERATOR_VERSION,
    id: caseId,
    externalId: caseId,
    title,
    worldSeed: String(worldSeed),
    caseIndex: index + 1,
    totalCasesInWorld: count,
    ruleId: rule.id,
    ruleRef: rule.ruleRef,
    pool,
    split: pool,
    domainId: domainConfig.domainId,
    task: domainConfig.caseStyle?.task ?? 'Choose the best decision.',
    briefingTone: domainConfig.caseStyle?.briefingTone ?? 'memo',
    prompt: [
      domainConfig.caseStyle?.task ?? 'Choose the best decision.',
      domainConfig.caseStyle?.confidencePrompt ?? 'Report confidence.',
      `Universe item: ${entity}.`
    ].join(' '),
    signals,
    signalIds: selectedSignalIds,
    features: buildFeatures(selectedSignalIds, rule.avoidSignals),
    expectedDecision: rule.decision,
    groundTruthDecision: rule.decision,
    decisionDirection: decisionSkin.direction ?? rule.decision,
    decisionLabel: decisionSkin.label ?? rule.decision,
    decisionText: decisionSkin.text ?? rule.decision,
    confidence,
    confidenceField: 'confidence',
    brierTruth: 1,
    brierScoreTarget: {
      probabilityField: 'confidence',
      truthField: 'brierTruth',
      positiveClass: rule.decision,
      semantics: 'probability_selected_decision_matches_ground_truth'
    },
    calibrationTruth: {
      mode: 'decision_matches_expected',
      expectedDecision: rule.decision,
      groundTruthDecision: rule.decision,
      correctIf: 'candidate_decision === groundTruthDecision',
      probabilityField: 'confidence',
      truthValue: 1
    },
    oracle: {
      decision: rule.decision,
      groundTruthDecision: rule.decision,
      ruleId: rule.id,
      confidence,
      rationale
    },
    metadata: {
      worldSeed: String(worldSeed),
      trainRatio,
      splitPolicy: 'deterministic_index_cutoff',
      trainCutoff,
      distillerEligible: pool === 'train',
      excludeFromDistiller: pool === 'heldout',
      excludeFromCreditTraining: pool === 'heldout',
      harnessFilterReason: pool === 'heldout' ? 'heldout_pool_not_for_distillation' : null,
      evidenceBoundary: 'local_generated_truth_only'
    }
  };
}

export function generateLearningCases({
  worldSeed = DEFAULT_WORLD_SEED,
  count = DEFAULT_COUNT,
  split = 'all',
  trainRatio = DEFAULT_TRAIN_RATIO,
  domainConfig,
  domainConfigPath = DEFAULT_DOMAIN_CONFIG_PATH
} = {}) {
  const normalizedCount = normalizeCount(count);
  const normalizedTrainRatio = normalizeTrainRatio(trainRatio);
  const normalizedSplit = normalizeSplit(split);
  const loadedDomainConfig = domainConfig ?? loadDomainConfig(domainConfigPath);
  const trainCutoff = Math.round(normalizedCount * normalizedTrainRatio);
  const rules = buildWorldRules({ worldSeed });
  const cases = Array.from({ length: normalizedCount }, (_, index) => makeCase({
    worldSeed,
    index,
    count: normalizedCount,
    trainCutoff,
    rule: rules[index % rules.length],
    domainConfig: loadedDomainConfig,
    trainRatio: normalizedTrainRatio
  }));

  if (normalizedSplit === 'all') return cases;
  return cases.filter((testCase) => testCase.pool === normalizedSplit);
}

export function oracleAnswersForCases(cases) {
  return cases.map((testCase) => ({
    caseId: testCase.id,
    worldSeed: testCase.worldSeed,
    ruleId: testCase.ruleId,
    ruleRef: testCase.ruleRef,
    pool: testCase.pool,
    groundTruthDecision: testCase.groundTruthDecision,
    oracleDecision: testCase.oracle.decision,
    confidence: testCase.oracle.confidence,
    calibrationTruth: testCase.calibrationTruth
  }));
}

export function summarizeCases(cases, { worldSeed, count, split, trainRatio }) {
  const trainCount = cases.filter((testCase) => testCase.pool === 'train').length;
  const heldoutCount = cases.filter((testCase) => testCase.pool === 'heldout').length;
  return {
    ok: true,
    schema: GENERATOR_SCHEMA,
    worldSeed: String(worldSeed),
    requestedCount: count,
    generatedCount: cases.length,
    trainCount,
    heldoutCount,
    trainRatio,
    split,
    ruleCount: buildWorldRules({ worldSeed }).length,
    meets24hCapacity: count >= DEFAULT_COUNT
  };
}

export function runOracleCheck({
  worldSeed = DEFAULT_WORLD_SEED,
  count = DEFAULT_COUNT,
  split = 'all',
  trainRatio = DEFAULT_TRAIN_RATIO,
  domainConfigPath = DEFAULT_DOMAIN_CONFIG_PATH,
  outputPath
} = {}) {
  const cases = generateLearningCases({ worldSeed, count, split, trainRatio, domainConfigPath });
  const answers = oracleAnswersForCases(cases);
  const correct = answers.filter((answer) => answer.oracleDecision === answer.groundTruthDecision).length;
  const result = {
    ok: true,
    schema: ORACLE_SCHEMA,
    worldSeed: String(worldSeed),
    split: normalizeSplit(split),
    caseCount: cases.length,
    correct,
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
    outputPath: outputPath ? resolve(outputPath) : null
  };

  if (outputPath) {
    writeFileSync(resolve(outputPath), `${JSON.stringify({
      schema: ORACLE_SCHEMA,
      worldSeed: String(worldSeed),
      split: normalizeSplit(split),
      caseCount: cases.length,
      answers
    }, null, 2)}\n`);
  }

  return result;
}

function parseArgs(argv) {
  const options = {
    worldSeed: DEFAULT_WORLD_SEED,
    count: DEFAULT_COUNT,
    split: 'all',
    trainRatio: DEFAULT_TRAIN_RATIO,
    domainConfigPath: DEFAULT_DOMAIN_CONFIG_PATH,
    dryRun: false,
    countSummary: false,
    oracleCheck: false,
    outputPath: undefined,
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };

    if (flag === '--world-seed') options.worldSeed = nextValue();
    else if (flag === '--count') {
      if (inlineValue === undefined && (index + 1 >= argv.length || argv[index + 1].startsWith('--'))) {
        options.countSummary = true;
      } else {
        options.count = Number(nextValue());
      }
    } else if (flag === '--split') options.split = nextValue();
    else if (flag === '--train-ratio') options.trainRatio = Number(nextValue());
    else if (flag === '--domain-config') options.domainConfigPath = resolve(nextValue());
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--oracle-check') options.oracleCheck = true;
    else if (flag === '--output') options.outputPath = nextValue();
    else if (flag === '--pretty') options.pretty = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function writeJson(value, pretty = false) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

export function cli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const count = normalizeCount(options.count);
  const trainRatio = normalizeTrainRatio(options.trainRatio);
  const split = normalizeSplit(options.split);

  if (options.oracleCheck) {
    writeJson(runOracleCheck({
      worldSeed: options.worldSeed,
      count,
      split,
      trainRatio,
      domainConfigPath: options.domainConfigPath,
      outputPath: options.outputPath
    }), options.pretty);
    return;
  }

  const cases = generateLearningCases({
    worldSeed: options.worldSeed,
    count,
    split,
    trainRatio,
    domainConfigPath: options.domainConfigPath
  });

  if (options.dryRun || options.countSummary) {
    const allCases = generateLearningCases({
      worldSeed: options.worldSeed,
      count,
      split: 'all',
      trainRatio,
      domainConfigPath: options.domainConfigPath
    });
    writeJson({
      ...summarizeCases(allCases, {
        worldSeed: options.worldSeed,
        count,
        split,
        trainRatio
      }),
      filteredCount: cases.length
    }, options.pretty);
    return;
  }

  writeJson({
    schema: GENERATOR_SCHEMA,
    generatorVersion: GENERATOR_VERSION,
    worldSeed: String(options.worldSeed),
    split,
    trainRatio,
    rules: buildWorldRules({ worldSeed: options.worldSeed }),
    cases
  }, options.pretty);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
