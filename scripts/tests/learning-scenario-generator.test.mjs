import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildWorldRules,
  DEFAULT_DOMAIN_CONFIG_PATH,
  generateLearningCases,
  loadDomainConfig,
  runOracleCheck
} from '../lib/learning-scenario-generator.mjs';

const generatorPath = fileURLToPath(new URL('../lib/learning-scenario-generator.mjs', import.meta.url));

test('same worldSeed twice yields byte-identical case sequence', () => {
  const first = JSON.stringify(generateLearningCases({ worldSeed: '2026070901', count: 120 }));
  const second = JSON.stringify(generateLearningCases({ worldSeed: '2026070901', count: 120 }));
  assert.equal(first, second);
});

test('train and heldout pools do not overlap and follow the configured split', () => {
  const cases = generateLearningCases({ worldSeed: '2026070901', count: 120, trainRatio: 0.8 });
  const train = cases.filter((testCase) => testCase.pool === 'train');
  const heldout = cases.filter((testCase) => testCase.pool === 'heldout');
  const trainIds = new Set(train.map((testCase) => testCase.id));
  const heldoutIds = new Set(heldout.map((testCase) => testCase.id));

  assert.equal(train.length, 96);
  assert.equal(heldout.length, 24);
  assert.equal(trainIds.intersection ? trainIds.intersection(heldoutIds).size : [...trainIds].filter((id) => heldoutIds.has(id)).length, 0);
  assert.deepEqual(
    generateLearningCases({ worldSeed: '2026070901', count: 120, split: 'train' }).map((testCase) => testCase.id),
    train.map((testCase) => testCase.id)
  );
  assert.deepEqual(
    generateLearningCases({ worldSeed: '2026070901', count: 120, split: 'heldout' }).map((testCase) => testCase.id),
    heldout.map((testCase) => testCase.id)
  );
});

test('--oracle-check reports accuracy exactly 1.0', () => {
  const stdout = execFileSync(process.execPath, [
    generatorPath,
    '--world-seed',
    '2026070901',
    '--count',
    '120',
    '--oracle-check'
  ], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.equal(result.accuracy, 1);
  assert.equal(result.correct, 120);
  assert.equal(result.caseCount, 120);
});

test('every case has calibrationTruth and groundTruthDecision', () => {
  const cases = generateLearningCases({ worldSeed: '2026070901', count: 120 });
  assert.ok(cases.length > 0);
  for (const testCase of cases) {
    assert.equal(testCase.calibrationTruth.mode, 'decision_matches_expected');
    assert.equal(typeof testCase.groundTruthDecision, 'string');
    assert.equal(testCase.expectedDecision, testCase.groundTruthDecision);
    assert.equal(testCase.brierScoreTarget.probabilityField, 'confidence');
    assert.equal(typeof testCase.confidence, 'number');
  }
});

test('different worldSeed values produce different rule sets', () => {
  const firstRules = buildWorldRules({ worldSeed: '2026070901' });
  const secondRules = buildWorldRules({ worldSeed: '2026070902' });
  assert.notDeepEqual(firstRules, secondRules);
  assert.ok(firstRules.length >= 6 && firstRules.length <= 10);
  assert.ok(secondRules.length >= 6 && secondRules.length <= 10);
});

test('--oracle-check exported oracle_answers.json maps one-to-one with generated cases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alaya-learning-oracle-'));
  try {
    const outputPath = join(dir, 'oracle_answers.json');
    const result = runOracleCheck({
      worldSeed: '2026070901',
      count: 120,
      outputPath
    });
    const exported = JSON.parse(readFileSync(outputPath, 'utf8'));
    const cases = generateLearningCases({ worldSeed: '2026070901', count: 120 });

    assert.equal(result.accuracy, 1);
    assert.equal(exported.caseCount, cases.length);
    assert.equal(exported.answers.length, cases.length);
    assert.deepEqual(
      exported.answers.map((answer) => answer.caseId),
      cases.map((testCase) => testCase.id)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replacing domain config changes skin while preserving schema invariants and logic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alaya-learning-domain-'));
  try {
    const defaultConfig = loadDomainConfig(DEFAULT_DOMAIN_CONFIG_PATH);
    const replacementConfig = JSON.parse(JSON.stringify(defaultConfig));
    replacementConfig.domainId = 'gotra_equity_skin_test';
    replacementConfig.caseStyle.headlinePrefix = 'GOTRA thesis packet';
    replacementConfig.signalSkins.earnings_revision.text = 'A test skin rewrites revision evidence without changing the canonical signal.';
    const replacementPath = join(dir, 'domain.json');
    writeFileSync(replacementPath, `${JSON.stringify(replacementConfig, null, 2)}\n`);

    const originalCases = generateLearningCases({ worldSeed: '2026070901', count: 16 });
    const replacementCases = generateLearningCases({
      worldSeed: '2026070901',
      count: 16,
      domainConfigPath: replacementPath
    });

    assert.equal(replacementCases.length, originalCases.length);
    assert.equal(replacementCases[0].domainId, 'gotra_equity_skin_test');
    assert.notEqual(replacementCases[0].title, originalCases[0].title);
    assert.deepEqual(
      replacementCases.map((testCase) => ({
        id: testCase.id,
        ruleId: testCase.ruleId,
        groundTruthDecision: testCase.groundTruthDecision,
        signalIds: testCase.signalIds
      })),
      originalCases.map((testCase) => ({
        id: testCase.id,
        ruleId: testCase.ruleId,
        groundTruthDecision: testCase.groundTruthDecision,
        signalIds: testCase.signalIds
      }))
    );
    for (const testCase of replacementCases) {
      assert.equal(testCase.schema, 'alaya.learning_loop.generated_cases.v1');
      assert.equal(testCase.calibrationTruth.mode, 'decision_matches_expected');
      assert.equal(typeof testCase.groundTruthDecision, 'string');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
