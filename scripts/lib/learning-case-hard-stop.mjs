function reasonFrom(value) {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "string" && value) return value;
  return String(value ?? "learning_case_failure");
}

function normalizedFailure(input = {}) {
  return Object.freeze({
    sample: Number.isFinite(Number(input.sample)) ? Number(input.sample) : null,
    ordinal: Number.isFinite(Number(input.ordinal)) ? Number(input.ordinal) : null,
    caseId: typeof input.caseId === "string" && input.caseId ? input.caseId : null,
    phase: typeof input.phase === "string" && input.phase ? input.phase : "unknown",
    reason: reasonFrom(input.reason ?? input.error),
    latchedAt: typeof input.latchedAt === "string" && input.latchedAt ? input.latchedAt : null,
  });
}

export function createLearningCaseHardStop({ onLatch = () => {} } = {}) {
  if (typeof onLatch !== "function") throw new TypeError("onLatch must be a function");
  let failure = null;

  const latch = (input = {}) => {
    if (failure) return { latched: false, failure };
    failure = normalizedFailure(input);
    onLatch(failure);
    return { latched: true, failure };
  };

  const runProvider = async (context, operation) => {
    if (typeof operation !== "function") throw new TypeError("provider operation must be a function");
    if (failure) return { status: "blocked", failure, value: null };
    try {
      return { status: "executed", failure: null, value: await operation() };
    } catch (error) {
      latch({ ...context, reason: error, latchedAt: new Date().toISOString() });
      throw error;
    }
  };

  const runCleanup = async (operation) => {
    if (typeof operation !== "function") throw new TypeError("cleanup operation must be a function");
    return operation();
  };

  return Object.freeze({
    isLatched: () => failure !== null,
    snapshot: () => failure,
    latch,
    runProvider,
    runCleanup,
  });
}
