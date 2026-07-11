#!/usr/bin/env bash
set -uo pipefail

LANE="${1:?usage: run-lane.sh canonical-cli|legacy-cli|canonical-native|legacy-native [OUTPUT_ROOT]}"
case "$LANE" in canonical-cli|legacy-cli|canonical-native|legacy-native) ;; *) echo "invalid lane: $LANE" >&2; exit 2;; esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ROOT="${2:-${YPI_EVAL_OUTPUT_ROOT:-$REPO/tmp/runtime-parity}}"
OUT="$ROOT/$LANE"
mkdir -p "$OUT"
rm -f "$OUT"/{context.txt,counter,cost.jsonl,trace.log,output.txt,stderr.txt,time.txt,exit,meta.json}
LEGACY=0
[[ "$LANE" == legacy-* ]] && LEGACY=1
python3 - "$OUT/context.txt" <<'PY'
import sys
p=sys.argv[1]
keys={333:'KEY_ALPHA=173',1777:'KEY_BETA=229',2888:'KEY_GAMMA=401'}
with open(p,'w') as f:
  for i in range(1,3001):
    value=keys.get(i,f'noise={i*7919}')
    f.write(f'record={i:04d} {value}\n')
PY
START_NS="$(python3 -c 'import time; print(time.monotonic_ns())')"
set +e
if [[ "$LANE" == *-cli ]]; then
  PROMPT="$(cat "$SCRIPT_DIR/prompt.txt")"
  env -u RLM_ROOT_PROMPT_FILE -u RLM_START_TIME -u RLM_CALL_COUNT \
    YPI_LEGACY_IMPL="$LEGACY" YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
    CONTEXT="$OUT/context.txt" RLM_PROVIDER="${PI_E2E_PROVIDER:-openai-codex}" \
    RLM_MODEL="${PI_E2E_MODEL:-gpt-5.6-sol}" RLM_THINKING_LEVEL="${PI_E2E_THINKING:-max}" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=2 RLM_MAX_CALLS=2 RLM_TIMEOUT="${RLM_EVAL_TIMEOUT:-300}" \
    RLM_BUDGET="${RLM_EVAL_BUDGET:-1}" RLM_JSON=1 RLM_JJ=0 RLM_SHARED_SESSIONS=0 \
    RLM_CHILD_DISCOVERY=0 RLM_TRACE_ID="parity-$LANE" RLM_CALL_COUNTER_FILE="$OUT/counter" \
    RLM_COST_FILE="$OUT/cost.jsonl" PI_TRACE_FILE="$OUT/trace.log" \
    /usr/bin/time -v -o "$OUT/time.txt" "$REPO/rlm_query" "$PROMPT" \
    >"$OUT/output.txt" 2>"$OUT/stderr.txt"
  RC=$?
else
  env -u RLM_ROOT_PROMPT_FILE -u RLM_START_TIME -u RLM_CALL_COUNT -u RLM_BUDGET -u RLM_COST_FILE \
    YPI_LEGACY_IMPL="$LEGACY" YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
    RLM_PROVIDER="${PI_E2E_PROVIDER:-openai-codex}" RLM_MODEL="${PI_E2E_MODEL:-gpt-5.6-sol}" \
    RLM_THINKING_LEVEL="${PI_E2E_THINKING:-max}" RLM_DEPTH=0 RLM_MAX_DEPTH=2 RLM_MAX_CALLS=4 \
    RLM_TIMEOUT="${RLM_EVAL_TIMEOUT:-180}" RLM_JSON=1 RLM_JJ=0 RLM_SHARED_SESSIONS=0 \
    RLM_CHILD_DISCOVERY=0 RLM_TRACE_ID="parity-$LANE" RLM_CALL_COUNTER_FILE="$OUT/counter" \
    /usr/bin/time -v -o "$OUT/time.txt" make -C "$REPO" test-recursion-e2e \
    >"$OUT/output.txt" 2>"$OUT/stderr.txt"
  RC=$?
fi
set -e
END_NS="$(python3 -c 'import time; print(time.monotonic_ns())')"
printf '%s\n' "$RC" > "$OUT/exit"
python3 - "$OUT" "$LANE" "$RC" "$START_NS" "$END_NS" <<'PY'
import json,pathlib,re,sys
out=pathlib.Path(sys.argv[1]); lane=sys.argv[2]; rc=int(sys.argv[3]); elapsed=(int(sys.argv[5])-int(sys.argv[4]))/1e9
try: calls=int((out/'counter').read_text().strip())
except Exception: calls=0
cost=tokens=0
if (out/'cost.jsonl').exists():
  for line in (out/'cost.jsonl').read_text().splitlines():
    try:
      row=json.loads(line); cost+=float(row.get('cost',0)); tokens+=int(row.get('tokens',0))
    except Exception: pass
rss=None
if (out/'time.txt').exists():
  m=re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)',(out/'time.txt').read_text())
  if m: rss=int(m.group(1))
text=(out/'output.txt').read_text(errors='replace') if (out/'output.txt').exists() else ''
expected='RESULT=803 EVIDENCE=KEY_ALPHA,KEY_BETA,KEY_GAMMA' if lane.endswith('-cli') else 'E9: full ypi recursive child call'
meta={'lane':lane,'exit_code':rc,'expected_output_present':expected in text,'elapsed_seconds':round(elapsed,3),'calls':calls,'cost':round(cost,6),'tokens':tokens,'max_rss_kib':rss}
(out/'meta.json').write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps(meta))
PY
exit "$RC"
