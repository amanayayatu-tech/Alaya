import { classifyError, routeError } from "./classify_error.js";
import type { AttributionContext, ErrorType } from "./types.js";

export interface GoldRegressionCase {
  id: string;
  active?: boolean;
  input: {
    claimError: number | null;
    context: AttributionContext;
  };
  expectedErrorType: ErrorType;
  expectedRoute: string;
}

export interface RegressionRunResult {
  passed: boolean;
  testedCases: number;
  failedCaseIds: string[];
}

export function runRegressionOnGoldCases(
  cases: GoldRegressionCase[],
  ctxOverrides: Partial<AttributionContext> = {},
): RegressionRunResult {
  const failedCaseIds: string[] = [];
  let testedCases = 0;

  for (const goldCase of cases) {
    if (goldCase.active === false) continue;
    testedCases += 1;
    const context = { ...goldCase.input.context, ...ctxOverrides };
    const actualErrorType = classifyError(goldCase.input.claimError, context);
    const actualRoute = routeError(actualErrorType);
    if (actualErrorType !== goldCase.expectedErrorType || actualRoute !== goldCase.expectedRoute) {
      failedCaseIds.push(goldCase.id);
    }
  }

  return {
    passed: failedCaseIds.length === 0,
    testedCases,
    failedCaseIds,
  };
}
