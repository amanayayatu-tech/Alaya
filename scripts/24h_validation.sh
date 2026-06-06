#!/usr/bin/env bash
# Alaya 24h validation runner.
# Secrets are read from env or existing local-only secret files and are never printed.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DURATION_SECONDS="${ALAYA_VALIDATION_DURATION_SECONDS:-86400}"
SLEEP_SECONDS="${ALAYA_VALIDATION_SLEEP_SECONDS:-600}"
LOG_DIR="./validation-logs/$(date +%Y%m%d_%H%M%S)"
SUMMARY="$LOG_DIR/SUMMARY.csv"
START_TIME="$(date +%s)"
END_TIME=$((START_TIME + DURATION_SECONDS))

mkdir -p "$LOG_DIR"
echo "round,timestamp,guard,sim,live,delta" > "$SUMMARY"

if [ -n "${LLM_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  export OPENAI_API_KEY="$LLM_API_KEY"
fi

if [ -n "${MINIMAX_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  export OPENAI_API_KEY="$MINIMAX_API_KEY"
fi

if [ -n "${GH_PAT:-}" ] && [ -z "${ALAYA_GITHUB_TOKEN:-}" ]; then
  export ALAYA_GITHUB_TOKEN="$GH_PAT"
fi

if [ -n "${GITHUB_TOKEN:-}" ] && [ -z "${ALAYA_GITHUB_TOKEN:-}" ]; then
  export ALAYA_GITHUB_TOKEN="$GITHUB_TOKEN"
fi

export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.minimax.io/openai}"
export OPENAI_MODEL="${OPENAI_MODEL:-MiniMax-M3}"
HEALTH_URL="${ALAYA_HEALTH_URL:-http://localhost:5000/api/flywheel/health}"
LLM_CONNECTIVITY_URL="${ALAYA_LLM_CONNECTIVITY_URL:-https://api.minimax.io/v1/chat/completions}"
GITHUB_CONNECTIVITY_URL="${ALAYA_GITHUB_CONNECTIVITY_URL:-https://api.github.com}"
CONNECT_TIMEOUT_SECONDS="${ALAYA_CONNECT_TIMEOUT_SECONDS:-10}"

live_prereqs_available() {
  local has_llm=0
  local has_github=0
  if [ -n "${OPENAI_API_KEY:-}" ] || { [ -n "${OPENAI_API_KEY_FILE:-}" ] && [ -s "$OPENAI_API_KEY_FILE" ]; }; then
    has_llm=1
  fi
  if [ -n "${ALAYA_GITHUB_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ] || { [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -s "$GITHUB_TOKEN_FILE" ]; } || { [ -n "${ALAYA_GITHUB_TOKEN_FILE:-}" ] && [ -s "$ALAYA_GITHUB_TOKEN_FILE" ]; }; then
    has_github=1
  fi
  [ "$has_llm" -eq 1 ] && [ "$has_github" -eq 1 ]
}

url_reachable() {
  local url="$1"
  local code
  code="$(curl --connect-timeout "$CONNECT_TIMEOUT_SECONDS" -sS -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || true)"
  [ "$code" != "000" ] && [ -n "$code" ]
}

live_connectivity_available() {
  url_reachable "$LLM_CONNECTIVITY_URL" && url_reachable "$GITHUB_CONNECTIVITY_URL"
}

echo "Alaya validation started at $(date) | logs: $LOG_DIR"
if ! live_prereqs_available; then
  echo "Live validation prerequisites not fully available; live step will be skipped."
elif ! live_connectivity_available; then
  echo "Live validation API connectivity unavailable; live step will be marked SKIP_NET until reachable."
fi

ROUND=0
ERRORS=0
CONSEC=0
MAX_CONSEC=3

while [ "$(date +%s)" -lt "$END_TIME" ]; do
  ROUND=$((ROUND + 1))
  TS="$(date +%H:%M:%S)"
  GUARD=FAIL
  SIM=SKIP
  LIVE=SKIP
  DELTA=NA

  echo "==== Round $ROUND @ $TS ===="

  if ( cd alaya-app && node --import tsx --test tests/principles.guard.test.ts ) >"$LOG_DIR/r${ROUND}_guard.log" 2>&1; then
    GUARD=PASS
    echo "guard PASS"
  else
    echo "CRITICAL: principles guard failed; stopping."
    echo "$ROUND,$TS,FAIL,$SIM,$LIVE,$DELTA" >> "$SUMMARY"
    exit 1
  fi

  if ( cd alaya-core && npm run flywheel ) >"$LOG_DIR/r${ROUND}_sim.log" 2>&1; then
    SIM=PASS
    echo "sim PASS"
  else
    SIM=FAIL
    ERRORS=$((ERRORS + 1))
    echo "sim FAIL"
  fi

  if [ $((ROUND % 3)) -eq 0 ]; then
    if ! live_prereqs_available; then
      LIVE=SKIP
      echo "live SKIP"
    elif ! live_connectivity_available; then
      LIVE=SKIP_NET
      {
        echo "Live validation skipped because API connectivity is unavailable."
        echo "LLM connectivity URL: $LLM_CONNECTIVITY_URL"
        echo "GitHub connectivity URL: $GITHUB_CONNECTIVITY_URL"
      } >"$LOG_DIR/r${ROUND}_live.log"
      echo "live SKIP_NET"
    elif ( cd alaya-app && npm run flywheel:live ) >"$LOG_DIR/r${ROUND}_live.log" 2>&1; then
      LIVE=PASS
      CONSEC=0
      echo "live PASS"
    else
      LIVE=FAIL
      ERRORS=$((ERRORS + 1))
      CONSEC=$((CONSEC + 1))
      echo "live FAIL"
    fi
  fi

  if curl -sf "$HEALTH_URL" >"$LOG_DIR/r${ROUND}_health.json" 2>/dev/null; then
    DELTA="$(node -e "try{const r=require(process.argv[1]); console.log(r.compoundingProof?.round1vs4KnowledgeDelta ?? 'NA')}catch{console.log('NA')}" "$PWD/$LOG_DIR/r${ROUND}_health.json")"
    echo "delta=$DELTA"
  fi

  echo "$ROUND,$TS,$GUARD,$SIM,$LIVE,$DELTA" >> "$SUMMARY"

  if [ "$CONSEC" -ge "$MAX_CONSEC" ]; then
    echo "Stopping after $MAX_CONSEC consecutive live failures."
    exit 1
  fi

  if [ "$(date +%s)" -ge "$END_TIME" ]; then
    break
  fi
  echo "sleep ${SLEEP_SECONDS}s"
  sleep "$SLEEP_SECONDS"
done

echo "Completed | rounds=$ROUND errors=$ERRORS | summary: $SUMMARY"
if [ "$ERRORS" -gt 0 ]; then
  echo "Validation failed with $ERRORS failed step(s)."
  exit 1
fi
