import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SENSOR_ACCUMULATOR_WINDOW_MS,
  SENSOR_HOURLY_WINDOW_MS,
  SENSOR_STRUCTURAL_COUNT_THRESHOLD,
  SensorErrorKind,
  categorizeAccumulatedError,
} from "../src/core/sensor_filter.js";

const nowMs = Date.parse("2026-06-11T12:00:00.000Z");

function events(count: number, spacingMs = 1_000, endMs = nowMs): number[] {
  return Array.from({ length: count }, (_, index) => endMs - (count - index - 1) * spacingMs);
}

test("sensor error kind enum exposes stable firewall categories", () => {
  assert.equal(SensorErrorKind.DataMissing, "data_missing");
  assert.equal(SensorErrorKind.SchemaMismatch, "schema_mismatch");
  assert.equal(SensorErrorKind.SourceUnavailable, "source_unavailable");
  assert.equal(SensorErrorKind.SyncError, "sync_error");
  assert.equal(SensorErrorKind.PayloadParseError, "payload_parse_error");
});

test("categorizeAccumulatedError classifies <5 events as transient", () => {
  const result = categorizeAccumulatedError({ eventTimestampsMs: events(4) }, nowMs);
  assert.equal(result.classification, "transient");
  assert.equal(result.occurrenceCount, 4);
  assert.equal(result.hourlyCount, 4);
});

test("categorizeAccumulatedError classifies recurring before structural thresholds", () => {
  const result = categorizeAccumulatedError({ eventTimestampsMs: events(8) }, nowMs);
  assert.equal(result.classification, "recurring");
  assert.equal(result.occurrenceCount, 8);
});

test("categorizeAccumulatedError classifies >= structural count threshold as structural", () => {
  const result = categorizeAccumulatedError({ eventTimestampsMs: events(SENSOR_STRUCTURAL_COUNT_THRESHOLD) }, nowMs);
  assert.equal(result.classification, "structural");
  assert.equal(result.occurrenceCount, SENSOR_STRUCTURAL_COUNT_THRESHOLD);
});

test("categorizeAccumulatedError classifies >10 events per hour as structural", () => {
  const result = categorizeAccumulatedError({ eventTimestampsMs: events(11, SENSOR_HOURLY_WINDOW_MS / 12) }, nowMs);
  assert.equal(result.classification, "structural");
  assert.equal(result.hourlyCount, 11);
});

test("categorizeAccumulatedError expires events outside the rolling seven-day window", () => {
  const stale = nowMs - SENSOR_ACCUMULATOR_WINDOW_MS - 1_000;
  const result = categorizeAccumulatedError({ eventTimestampsMs: [stale, ...events(4)] }, nowMs);
  assert.equal(result.classification, "transient");
  assert.equal(result.occurrenceCount, 4);
  assert.equal(result.windowedEventTimestampsMs.includes(stale), false);
});

test("categorizeAccumulatedError accepts an app-controlled structural threshold", () => {
  const result = categorizeAccumulatedError({
    eventTimestampsMs: events(12, 10 * 60 * 1_000),
    structuralCountThreshold: 12,
  }, nowMs);
  assert.equal(result.classification, "structural");
  assert.equal(result.hourlyCount < 11, true);
});
