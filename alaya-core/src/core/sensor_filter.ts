export enum SensorErrorKind {
  DataMissing = "data_missing",
  SchemaMismatch = "schema_mismatch",
  SourceUnavailable = "source_unavailable",
  SyncError = "sync_error",
  PayloadParseError = "payload_parse_error",
  Unknown = "unknown",
}

export type SensorErrorClassification = "transient" | "recurring" | "structural";

export const SENSOR_RECURRING_COUNT_THRESHOLD = 5;
export const SENSOR_STRUCTURAL_COUNT_THRESHOLD = 20;
export const SENSOR_STRUCTURAL_PER_HOUR_THRESHOLD = 10;
export const SENSOR_ACCUMULATOR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SENSOR_HOURLY_WINDOW_MS = 60 * 60 * 1000;

export interface SensorErrorAccumulatorSnapshot {
  occurrenceCount?: number;
  eventTimestampsMs?: number[];
  structuralCountThreshold?: number;
}

export interface CategorizedSensorError {
  classification: SensorErrorClassification;
  occurrenceCount: number;
  hourlyCount: number;
  windowedEventTimestampsMs: number[];
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function thresholdFromAccumulator(acc: SensorErrorAccumulatorSnapshot): number {
  const configured = acc.structuralCountThreshold;
  return typeof configured === "number" && Number.isInteger(configured) && configured >= SENSOR_RECURRING_COUNT_THRESHOLD
    ? configured
    : SENSOR_STRUCTURAL_COUNT_THRESHOLD;
}

export function windowSensorErrorTimestamps(
  eventTimestampsMs: number[],
  currentTimeMs: number,
): number[] {
  const cutoff = currentTimeMs - SENSOR_ACCUMULATOR_WINDOW_MS;
  return eventTimestampsMs
    .filter((value) => finiteTimestamp(value) && value >= cutoff && value <= currentTimeMs)
    .sort((a, b) => a - b);
}

export function categorizeAccumulatedError(
  acc: SensorErrorAccumulatorSnapshot,
  currentTimeMs: number,
): CategorizedSensorError {
  if (!finiteTimestamp(currentTimeMs)) {
    throw new Error("currentTimeMs must be a finite non-negative timestamp");
  }
  const windowedEventTimestampsMs = windowSensorErrorTimestamps(acc.eventTimestampsMs ?? [], currentTimeMs);
  const occurrenceCount = windowedEventTimestampsMs.length || Math.max(0, Math.trunc(acc.occurrenceCount ?? 0));
  const hourlyCutoff = currentTimeMs - SENSOR_HOURLY_WINDOW_MS;
  const hourlyCount = windowedEventTimestampsMs.filter((value) => value >= hourlyCutoff).length;
  const structuralCountThreshold = thresholdFromAccumulator(acc);

  let classification: SensorErrorClassification = "recurring";
  if (occurrenceCount < SENSOR_RECURRING_COUNT_THRESHOLD) {
    classification = "transient";
  }
  if (
    occurrenceCount >= structuralCountThreshold ||
    hourlyCount > SENSOR_STRUCTURAL_PER_HOUR_THRESHOLD
  ) {
    classification = "structural";
  }

  return {
    classification,
    occurrenceCount,
    hourlyCount,
    windowedEventTimestampsMs,
  };
}
