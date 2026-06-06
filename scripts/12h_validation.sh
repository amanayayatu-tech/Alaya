#!/usr/bin/env bash
# Alaya 12h validation runner.
# Secrets are read from env or existing local-only secret files and are never printed.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DURATION_SECONDS="${ALAYA_VALIDATION_DURATION_SECONDS:-43200}"
SLEEP_SECONDS="${ALAYA_VALIDATION_SLEEP_SECONDS:-600}"
MAX_ROUNDS="${ALAYA_VALIDATION_MAX_ROUNDS:-72}"
LOG_DIR="./validation-logs/12h_$(date +%Y%m%d_%H%M%S)"
SUMMARY="$LOG_DIR/SUMMARY.csv"
ALERTS="$LOG_DIR/alerts.log"
START_TIME="$(date +%s)"
END_TIME=$((START_TIME + DURATION_SECONDS))

mkdir -p "$LOG_DIR"
echo "round,timestamp,guard,sim,live,delta" > "$SUMMARY"
: > "$ALERTS"

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
export OPENAI_API_MODE="${OPENAI_API_MODE:-chat}"
export OPENAI_MAX_OUTPUT_TOKENS="${OPENAI_MAX_OUTPUT_TOKENS:-1024}"
export ALAYA_REAL_LLM_MAX_RETRIES="${ALAYA_REAL_LLM_MAX_RETRIES:-2}"

HEALTH_URL="${ALAYA_HEALTH_URL:-http://localhost:5000/api/flywheel/health}"
LLM_CONNECTIVITY_URL="${ALAYA_LLM_CONNECTIVITY_URL:-https://api.minimax.io/v1/chat/completions}"
GITHUB_CONNECTIVITY_URL="${ALAYA_GITHUB_CONNECTIVITY_URL:-https://api.github.com}"
CONNECT_TIMEOUT_SECONDS="${ALAYA_CONNECT_TIMEOUT_SECONDS:-10}"

live_prereqs_available() {
  local has_llm=0
  local has_github=0
  if [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY_FILE:-}" ] || [ -s "/private/tmp/alaya-minimax-key" ]; then
    has_llm=1
  fi
  if [ -n "${ALAYA_GITHUB_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN_FILE:-}" ] || [ -s "/private/tmp/alaya-github-token" ]; then
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

record_noncritical_failure() {
  local label="$1"
  local round="$2"
  local count

  case "$label" in
    flywheel)
      FLYWHEEL_CONSEC=$((FLYWHEEL_CONSEC + 1))
      count="$FLYWHEEL_CONSEC"
      ;;
    "live connectivity")
      LIVE_CONNECTIVITY_CONSEC=$((LIVE_CONNECTIVITY_CONSEC + 1))
      count="$LIVE_CONNECTIVITY_CONSEC"
      ;;
    "e2e:llm-flywheel")
      LIVE_E2E_CONSEC=$((LIVE_E2E_CONSEC + 1))
      count="$LIVE_E2E_CONSEC"
      ;;
    "flywheel health")
      HEALTH_CONSEC=$((HEALTH_CONSEC + 1))
      count="$HEALTH_CONSEC"
      ;;
    *)
      OTHER_NONCRITICAL_CONSEC=$((OTHER_NONCRITICAL_CONSEC + 1))
      count="$OTHER_NONCRITICAL_CONSEC"
      ;;
  esac

  if [ "$count" -ge 3 ]; then
    local message="ALERT: 3 consecutive non-critical validation errors for ${label} through round ${round}; continuing."
    echo "$message"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),round=${round},latest=${label}" >> "$ALERTS"
    record_noncritical_success "$label"
  fi
}

record_noncritical_success() {
  local label="$1"
  case "$label" in
    flywheel)
      FLYWHEEL_CONSEC=0
      ;;
    "live connectivity")
      LIVE_CONNECTIVITY_CONSEC=0
      ;;
    "e2e:llm-flywheel")
      LIVE_E2E_CONSEC=0
      ;;
    "flywheel health")
      HEALTH_CONSEC=0
      ;;
    *)
      OTHER_NONCRITICAL_CONSEC=0
      ;;
  esac
}

extract_health_delta() {
  local path="$1"
  node -e "const fs=require('fs');try{const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(r.compoundingProof?.round1vs4KnowledgeDelta ?? 'NA')}catch{console.log('NA')}" "$path"
}

echo "Alaya 12h validation started at $(date) | logs: $LOG_DIR"
if ! live_prereqs_available; then
  echo "Live validation prerequisites not fully available; live step will be skipped."
elif ! live_connectivity_available; then
  echo "Live validation API connectivity unavailable; live step will be marked SKIP_NET until reachable."
fi

ROUND=0
ERRORS=0
FLYWHEEL_CONSEC=0
LIVE_CONNECTIVITY_CONSEC=0
LIVE_E2E_CONSEC=0
HEALTH_CONSEC=0
OTHER_NONCRITICAL_CONSEC=0

while [ "$(date +%s)" -lt "$END_TIME" ] && [ "$ROUND" -lt "$MAX_ROUNDS" ]; do
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

  if npm run flywheel >"$LOG_DIR/r${ROUND}_sim.log" 2>&1; then
    SIM=PASS
    record_noncritical_success "flywheel"
    echo "sim PASS"
  else
    SIM=FAIL
    ERRORS=$((ERRORS + 1))
    record_noncritical_failure "flywheel" "$ROUND"
    echo "sim FAIL"
  fi

  if [ $((ROUND % 3)) -eq 0 ]; then
    if ! live_prereqs_available; then
      LIVE=SKIP
      echo "live SKIP"
    elif ! live_connectivity_available; then
      LIVE=SKIP_NET
      ERRORS=$((ERRORS + 1))
      record_noncritical_failure "live connectivity" "$ROUND"
      {
        echo "Live validation skipped because API connectivity is unavailable."
        echo "LLM connectivity URL: $LLM_CONNECTIVITY_URL"
        echo "GitHub connectivity URL: $GITHUB_CONNECTIVITY_URL"
      } >"$LOG_DIR/r${ROUND}_live.log"
      echo "live SKIP_NET"
    else
      record_noncritical_success "live connectivity"
      if npm run e2e:llm-flywheel >"$LOG_DIR/r${ROUND}_live.log" 2>&1; then
        LIVE=PASS
        record_noncritical_success "e2e:llm-flywheel"
        echo "live PASS"
      else
        LIVE=FAIL
        ERRORS=$((ERRORS + 1))
        record_noncritical_failure "e2e:llm-flywheel" "$ROUND"
        echo "live FAIL"
      fi
    fi

    if curl -sf "$HEALTH_URL" >"$LOG_DIR/r${ROUND}_health.json" 2>/dev/null; then
      DELTA="$(extract_health_delta "$LOG_DIR/r${ROUND}_health.json")"
      record_noncritical_success "flywheel health"
      echo "delta=$DELTA"
    else
      ERRORS=$((ERRORS + 1))
      record_noncritical_failure "flywheel health" "$ROUND"
      echo "health SKIP"
    fi
  fi

  echo "$ROUND,$TS,$GUARD,$SIM,$LIVE,$DELTA" >> "$SUMMARY"

  if [ "$(date +%s)" -ge "$END_TIME" ] || [ "$ROUND" -ge "$MAX_ROUNDS" ]; then
    break
  fi
  echo "sleep ${SLEEP_SECONDS}s"
  sleep "$SLEEP_SECONDS"
done

echo "Completed | rounds=$ROUND noncritical_errors=$ERRORS | summary: $SUMMARY | alerts: $ALERTS"
