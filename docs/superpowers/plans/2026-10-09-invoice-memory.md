# Invoice Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the booth demo: invoice PDFs become one progressively sharpening Qdrant point per customer, shown on a live manager dashboard, driven by n8n Cloud workflows.

**Architecture:** Two n8n Data Tables are the source of truth; a Rebuild sub-workflow turns them into one Qdrant point per customer with three Cloud-Inference vectors, called after every processing stage. A static dashboard polls two n8n read webhooks and calls one write webhook. Scripts in the repo create the collection, generate synthetic PDFs, and smoke-test the Qdrant request shapes before any workflow is built.

**Tech Stack:** n8n Cloud (Form Trigger, Data Table, Crypto, Extract from File, HTTP Request, Code, Execute Sub-workflow, Webhook, Respond to Webhook, Schedule Trigger), Qdrant Cloud with Cloud Inference, OpenRouter (HTTP), bash + curl + python3 stdlib for scripts, Node (`node --test`) for the Code-node sources and the dashboard logic, headless Chrome for PDFs.

**Spec:** `docs/superpowers/specs/2026-10-09-invoice-memory-design.md`

Numbering note: the spec's "04 Dashboard API" is split here into `04 Dashboard reads` and `05 Dashboard writes` to respect the 12-node rule; purge becomes `06`. The spec's `02 Process` gets a `02b Write the narrative` sub-workflow for the same reason. The Edge stretch is a separate plan: `2026-10-09-invoice-memory-edge.md`.

## Global Constraints

- n8n Cloud. No Variables, no community nodes, no `require` in Code nodes, no filesystem, no hardcoded credential IDs, webhook IDs, or cluster URLs in exported JSON.
- Every workflow starts with an Edit Fields node named `Config` holding `QDRANT_URL`, `COLLECTION` (`customers`), `OPENROUTER_MODEL`, `PDF_ENGINE` (`native`), `WORKERS`, `MANAGERS`, `SAMPLES_BASE_URL`.
- Credentials: `Qdrant api-key` (Header Auth, header `api-key`), `OpenRouter bearer` (Header Auth, header `Authorization`, value `Bearer <key>`).
- Qdrant collection `customers`: named vectors `summary` (384, Cosine), `digest` (96, Cosine, multivector max_sim), sparse `bm25` (idf); `sharding_method: custom`; shard keys `m_anna`, `m_ben`. Every request body carries `shard_key`.
- Inference models, exact strings: `sentence-transformers/all-minilm-l6-v2`, `answerdotai/answerai-colbert-small-v1`, `qdrant/bm25`.
- Point ID: SHA-256 of `<manager_id>/<customer_id>` formatted as a UUID (first 32 hex, version nibble `4`, variant nibble `8`). Deterministic; this replaces the spec's uuid5 because n8n Code nodes have no crypto; the Crypto node does the hash.
- Node names are sentences. Target 12 nodes per canvas, hard cap 15. Four sticky notes max.
- Synthetic data only. The Form has no file field.
- Latency targets: list under 300 ms, search under 500 ms, measured in n8n around the Qdrant call and returned as `latency_ms`.
- Writing in README, cards, script: American English, Oxford comma, no em dashes, Title Case headings.
- Commit after every task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A PDF whose text extraction is empty (scanned image) must still yield a point: stage 1, amount `null`, digest line with `?`, aggregates exclude it, no crash. Pinned in Task 4 (`view.test.js`, "empty regex fields").
2. The vision model returning `amount` as a formatted string (`"12.300,00 €"` or `"4,250.00"`) must coerce to a number, never reach aggregates as `NaN`. Pinned in Task 4 (`validate.test.js`, "german string amount").
3. The same customer slug under two managers must produce two different points and two different Data Table rows. Pinned in Task 4 (`ids.test.js`) and Task 6 (two seeded managers).
4. A card whose `stage` drops after a new PDF must re-blur, and a changed `latest.amount` must re-render in place. Pinned in Task 9 (`app.test.js`, "stage drop re-blurs").
5. A search with no matches must return an empty list and the dashboard must show "no matches" without dimming every card. Pinned in Task 8 (search returns `[]`) and Task 9 (`app.test.js`, "empty search").

---

### Task 1: Repo Scaffold and Qdrant Setup Script

**Files:**
- Create: `.gitignore`, `.env.example`, `qdrant/lib.sh`, `qdrant/setup.sh`
- Test: manual run against the cluster, twice

**Interfaces:**
- Produces: `qdrant/lib.sh` exporting `q()` = `q <METHOD> <path> [json-body]` that curls `$QDRANT_URL$path` with the `api-key` header and prints the response body. Every later script sources it.

- [ ] **Step 1: Write `.gitignore` and `.env.example`**

```gitignore
.env
samples/html/
*.pdf
!samples/*.pdf
node_modules/
__pycache__/
edge/data/
```

```bash
# .env.example  (copy to .env, never commit .env)
QDRANT_URL=https://xxxx.cloud.qdrant.io:6333
QDRANT_API_KEY=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=google/gemini-2.5-flash
N8N_BASE_URL=https://yourname.app.n8n.cloud
```

- [ ] **Step 2: Write `qdrant/lib.sh`**

```bash
#!/usr/bin/env bash
# source this; needs QDRANT_URL and QDRANT_API_KEY in the environment
set -euo pipefail
: "${QDRANT_URL:?set QDRANT_URL}"; : "${QDRANT_API_KEY:?set QDRANT_API_KEY}"
q() {  # q METHOD /path [json]
  local m=$1 p=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -X "$m" "$QDRANT_URL$p" -H "api-key: $QDRANT_API_KEY" -H 'content-type: application/json' -d "$body"
  else
    curl -sS -X "$m" "$QDRANT_URL$p" -H "api-key: $QDRANT_API_KEY"
  fi
  echo
}
ok() { python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="ok" else 1)'; }
```

- [ ] **Step 3: Write `qdrant/setup.sh`** (idempotent: tolerates "already exists")

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"; set -a; [ -f ../.env ] && . ../.env; set +a
. ./lib.sh
C=/collections/customers

if q GET $C | grep -q '"status":"ok"'; then echo "collection exists"; else
q PUT $C '{
  "vectors": {
    "summary": {"size": 384, "distance": "Cosine"},
    "digest":  {"size": 96,  "distance": "Cosine", "multivector_config": {"comparator": "max_sim"}}
  },
  "sparse_vectors": {"bm25": {"modifier": "idf"}},
  "sharding_method": "custom"
}' | ok; fi

for k in m_anna m_ben; do q PUT $C/shards "{\"shard_key\": \"$k\"}" >/dev/null || true; done

idx() { q PUT "$C/index?wait=true" "{\"field_name\": \"$1\", \"field_schema\": $2}" >/dev/null || true; }
idx manager_id        '{"type":"keyword","is_tenant":true}'
idx worker_id         '{"type":"keyword"}'
idx customer_id       '{"type":"keyword"}'
idx deleted_at        '{"type":"datetime"}'
idx last_invoice_at   '{"type":"datetime"}'
idx updated_at        '{"type":"datetime"}'
idx stage             '{"type":"integer"}'
idx 'invoices[].status' '{"type":"keyword"}'
idx 'invoices[].amount' '{"type":"float"}'
q GET $C | python3 -c 'import sys,json; d=json.load(sys.stdin)["result"]; print("indexes:", sorted(d["payload_schema"].keys())); print("sharding:", d["config"]["params"].get("sharding_method"))'
```

- [ ] **Step 4: Run it twice**

Run: `chmod +x qdrant/*.sh && qdrant/setup.sh && qdrant/setup.sh`
Expected: first run prints `indexes: [...9 names...]` and `sharding: custom`; second run prints `collection exists` then the same two lines. If the cluster rejects `sharding_method: custom`, delete that line and both `shards` calls, remove `shard_key` from every later body, and note it in the README; the Edge plan is then cut.

- [ ] **Step 5: Commit**

```bash
git add .gitignore .env.example qdrant/lib.sh qdrant/setup.sh
git commit -m "feat(qdrant): collection setup script with shard keys and indexes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Smoke Test of Every Qdrant Request Shape

**Files:**
- Create: `qdrant/smoke.sh`
- Test: the script is the test

**Interfaces:**
- Produces: the exact JSON bodies that Tasks 6, 7, 8, 10, and 11 paste into HTTP Request nodes. Treat `smoke.sh` as the source of truth for request shapes.

- [ ] **Step 1: Write `qdrant/smoke.sh`**

```bash
#!/usr/bin/env bash
# Seeds one point with inference, runs the nested filter and the section 11 query, cleans up.
set -euo pipefail
cd "$(dirname "$0")"; set -a; [ -f ../.env ] && . ../.env; set +a
. ./lib.sh
C=/collections/customers
ID=11111111-1111-4111-8111-111111111111
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "1. upsert with inference"
q PUT "$C/points?wait=true" "{
  \"shard_key\": \"m_anna\",
  \"points\": [{
    \"id\": \"$ID\",
    \"vector\": {
      \"summary\": {\"text\": \"1 invoices, 12300.00 EUR open, 1 overdue, last 2026-10-01\", \"model\": \"sentence-transformers/all-minilm-l6-v2\"},
      \"digest\":  {\"text\": \"INV-4711 | 2026-10-01 | 12300.00 EUR | due 2026-10-15 | overdue | Hetzner servers\", \"model\": \"answerdotai/answerai-colbert-small-v1\"},
      \"bm25\":    {\"text\": \"Invoice INV-4711 Hetzner servers total 12300.00\", \"model\": \"qdrant/bm25\"}
    },
    \"payload\": {
      \"manager_id\": \"m_anna\", \"worker_id\": \"w_smoke\", \"customer_id\": \"smoke\", \"name\": \"Smoke GmbH\",
      \"stage\": 2, \"pending_count\": 0, \"invoice_count\": 1,
      \"total_amount\": 12300, \"open_amount\": 12300, \"overdue_count\": 1, \"overdue_amount\": 12300,
      \"last_invoice_at\": \"$NOW\", \"updated_at\": \"$NOW\",
      \"latest\": {\"invoice_no\": \"INV-4711\", \"amount\": 12300, \"stage\": 2},
      \"summary_stage\": 1, \"summary_text\": \"1 invoices, 12300.00 EUR open, 1 overdue\", \"summary_generated_at\": \"$NOW\",
      \"invoices\": [{\"id\": \"inv_smoke\", \"invoice_no\": \"INV-4711\", \"date\": \"2026-10-01\", \"due_date\": \"2026-10-15\",
                     \"amount\": 12300, \"vendor\": \"Hetzner\", \"status\": \"overdue\", \"stage\": 2, \"error\": \"\", \"items\": \"Hetzner servers\"}]
    }
  }]
}" | ok && echo "   ok"

echo "2. nested filter: overdue >= 10000"
q POST "$C/points/scroll" '{
  "shard_key": "m_anna", "limit": 10, "with_payload": ["customer_id"],
  "order_by": {"key": "last_invoice_at", "direction": "desc"},
  "filter": {"must": [
    {"key": "manager_id", "match": {"value": "m_anna"}},
    {"is_empty": {"key": "deleted_at"}},
    {"nested": {"key": "invoices", "filter": {"must": [
      {"key": "status", "match": {"value": "overdue"}},
      {"key": "amount", "range": {"gte": 10000}}]}}}
  ]}}' | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]["points"]; assert any(p["payload"]["customer_id"]=="smoke" for p in r), r; print("   ok", len(r))'

echo "3. section 11 query: three vectors, rrf, decay"
F='{"must":[{"key":"manager_id","match":{"value":"m_anna"}},{"is_empty":{"key":"deleted_at"}}]}'
q POST "$C/points/query" "{
  \"shard_key\": \"m_anna\",
  \"prefetch\": {
    \"prefetch\": [
      {\"query\": {\"nearest\": {\"text\": \"servers\", \"model\": \"qdrant/bm25\"}}, \"using\": \"bm25\", \"limit\": 20, \"filter\": $F},
      {\"query\": {\"nearest\": {\"text\": \"servers\", \"model\": \"answerdotai/answerai-colbert-small-v1\"}}, \"using\": \"digest\", \"limit\": 20, \"filter\": $F},
      {\"query\": {\"nearest\": {\"text\": \"servers\", \"model\": \"sentence-transformers/all-minilm-l6-v2\"}}, \"using\": \"summary\", \"limit\": 20, \"filter\": $F}
    ],
    \"query\": {\"rrf\": {}},
    \"limit\": 20
  },
  \"query\": {\"formula\": {\"sum\": [\"\$score\", {\"mult\": [0.1,
    {\"exp_decay\": {\"x\": {\"datetime_key\": \"last_invoice_at\"}, \"target\": {\"datetime\": \"$NOW\"}, \"scale\": 2592000, \"midpoint\": 0.5}}]}]}},
  \"filter\": $F,
  \"limit\": 5, \"with_payload\": [\"customer_id\", \"invoices\"]
}" | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]["points"]; assert r and r[0]["payload"]["customer_id"]=="smoke", r; print("   ok score", round(r[0]["score"],3))'

echo "4. soft delete filter hides it"
q POST "$C/points/payload?wait=true" "{\"shard_key\": \"m_anna\", \"points\": [\"$ID\"], \"payload\": {\"deleted_at\": \"$NOW\"}}" | ok
q POST "$C/points/scroll" "{\"shard_key\": \"m_anna\", \"limit\": 10, \"filter\": {\"must\": [{\"is_empty\": {\"key\": \"deleted_at\"}}, {\"key\": \"customer_id\", \"match\": {\"value\": \"smoke\"}}]}}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]["points"]; assert r==[], r; print("   ok hidden")'

echo "5. delete by datetime filter (purge shape)"
q POST "$C/points/delete?wait=true" "{\"shard_key\": \"m_anna\", \"filter\": {\"must\": [{\"key\": \"deleted_at\", \"range\": {\"lt\": \"2099-01-01T00:00:00Z\"}}]}}" | ok && echo "   ok purged"
echo "SMOKE PASSED"
```

- [ ] **Step 2: Run it**

Run: `chmod +x qdrant/smoke.sh && qdrant/smoke.sh`
Expected: five `ok` lines then `SMOKE PASSED`. Failure modes and what to change: step 1 rejects an inference model → check the cluster's Inference tab, swap the model string everywhere; step 3 rejects `nearest` inside `prefetch` → move the inference object to `"query": {"text": ..., "model": ...}` per the error message and update the spec's section 11; step 2 fails on `nested` → check that the `invoices[].status` index exists (`setup.sh` output).

- [ ] **Step 3: Commit**

```bash
git add qdrant/smoke.sh
git commit -m "test(qdrant): smoke test for inference upsert, nested filter, hybrid query, soft delete, purge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: OpenRouter PDF Gate

**Files:**
- Create: `qdrant/openrouter_check.sh`
- Test: the script is the test

**Interfaces:**
- Produces: the exact OpenRouter request body Task 7 pastes into the vision node, and the confirmed `OPENROUTER_MODEL` value for `.env` and `Config`.

- [ ] **Step 1: Write `qdrant/openrouter_check.sh`**

```bash
#!/usr/bin/env bash
# Sends one PDF to the pinned model with native PDF input and JSON mode. Needs a PDF path.
set -euo pipefail
cd "$(dirname "$0")"; set -a; [ -f ../.env ] && . ../.env; set +a
: "${OPENROUTER_API_KEY:?}"; : "${OPENROUTER_MODEL:?}"
PDF=${1:?pdf path}
B64=$(base64 < "$PDF" | tr -d '\n')
python3 - "$B64" "$OPENROUTER_MODEL" <<'PY' > /tmp/or_body.json
import json,sys
b64,model=sys.argv[1],sys.argv[2]
print(json.dumps({
 "model": model, "temperature": 0, "max_tokens": 400,
 "response_format": {"type": "json_object"},
 "plugins": [{"id": "file-parser", "pdf": {"engine": "native"}}],
 "messages": [
  {"role": "system", "content": "You read one invoice PDF and return JSON only with keys: invoice_no, date (YYYY-MM-DD), due_date (YYYY-MM-DD), amount (number in EUR, no thousands separators), vendor, customer_name, status (one of: open, paid, overdue), line_items_summary (max 12 words)."},
  {"role": "user", "content": [
    {"type": "text", "text": "Extract the fields."},
    {"type": "file", "file": {"filename": "invoice.pdf", "file_data": "data:application/pdf;base64," + b64}}]}
 ]}))
PY
START=$(date +%s%N)
curl -sS https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $OPENROUTER_API_KEY" -H 'content-type: application/json' -d @/tmp/or_body.json > /tmp/or_resp.json
END=$(date +%s%N)
python3 - <<'PY'
import json
r=json.load(open('/tmp/or_resp.json'))
assert 'choices' in r, r
c=json.loads(r['choices'][0]['message']['content'])
for k in ['invoice_no','date','due_date','amount','vendor','customer_name','status']: assert k in c, (k, c)
print("fields:", c)
PY
echo "latency_ms: $(( (END-START)/1000000 ))"
```

- [ ] **Step 2: Run it with any PDF** (before Task 4 exists, use any invoice-like PDF on disk; after Task 4, use `samples/acme-001.pdf`)

Run: `chmod +x qdrant/openrouter_check.sh && qdrant/openrouter_check.sh samples/acme-001.pdf`
Expected: `fields: {...}` with all seven keys and `latency_ms` under 30000. If the model rejects `file` input, open `https://openrouter.ai/models`, pick the cheapest mid-tier model that lists PDF input and `response_format`, set it in `.env`, rerun. If none works, set `PDF_ENGINE=pdf-text` in `.env` (text extraction instead of vision) and strike the word "vision" from `booth/script.md` in Task 13.

- [ ] **Step 3: Commit**

```bash
git add qdrant/openrouter_check.sh
git commit -m "test(openrouter): PDF input and JSON mode gate for the pinned model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Code-Node Sources with Node Tests

**Files:**
- Create: `workflows/code/ids.js`, `coarse.js`, `validate.js`, `view.js`, `cards.js`, `match.js`, and one `*.test.js` beside each
- Test: `node --test workflows/code/`

**Interfaces:**
- Produces, as CommonJS exports (the n8n Code nodes paste the function body and call it; see each later task):
  - `uuidFromHex(hex: string): string`
  - `resolveUpload(sampleFile: string, workerId: string, workers: Record<string,{manager_id:string,name:string}>): {customer_id, worker_id, manager_id}`
  - `coarseRead(text: string): {invoice_no, date, due_date, amount: number|null, vendor}`
  - `toNumber(v: unknown): number` and `validateFields(obj): {invoice_no, date, due_date, amount: number, vendor, customer_name, status, line_items_summary}` (throws on bad input)
  - `computeView(customer: Row, invoices: Row[], nowIso: string): {payload: object, texts: {summary, digest, bm25}}`
  - `shapeCards(points: {payload}[], workers): Card[]` and `splitRemoved(cards): {cards, removed}`
  - `pickMatchedLine(q: string, invoices: object[]): string|null`

- [ ] **Step 1: Write the tests first** (`workflows/code/*.test.js`, Node's built-in runner)

```js
// workflows/code/ids.test.js
const test = require('node:test'); const assert = require('node:assert');
const { uuidFromHex, resolveUpload } = require('./ids');
test('uuid shape and determinism', () => {
  const h = 'a'.repeat(64);
  const u = uuidFromHex(h);
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(u, uuidFromHex(h));
  assert.notEqual(u, uuidFromHex('b'.repeat(64)));
});
test('resolveUpload derives slug and manager', () => {
  const w = { w_tom: { manager_id: 'm_anna', name: 'Tom' } };
  assert.deepEqual(resolveUpload('Acme-001.pdf', 'w_tom', w), { customer_id: 'acme', worker_id: 'w_tom', manager_id: 'm_anna' });
  assert.throws(() => resolveUpload('acme-001.pdf', 'w_nobody', w), /unknown worker/);
});
```

```js
// workflows/code/coarse.test.js
const test = require('node:test'); const assert = require('node:assert');
const { coarseRead } = require('./coarse');
const EN = 'INVOICE\nInvoice No: INV-4711\nDate: 2026-10-01\nDue date: 2026-10-15\nFrom: Hetzner Online GmbH\n...\nTotal: 4,250.00 EUR';
const DE = 'RECHNUNG\nInvoice No: INV-4712\nDate: 2026-10-02\nDue date: 2026-10-16\nFrom: Hetzner Online GmbH\nTotal: 12.300,00 €';
test('english format parses correctly', () => {
  const r = coarseRead(EN);
  assert.equal(r.invoice_no, 'INV-4711'); assert.equal(r.date, '2026-10-01'); assert.equal(r.due_date, '2026-10-15');
  assert.equal(r.amount, 4250); assert.equal(r.vendor, 'Hetzner Online GmbH');
});
test('german format is deliberately wrong (the booth moment)', () => {
  assert.equal(coarseRead(DE).amount, 12.3);
});
test('empty text yields nulls, not a throw', () => {
  assert.deepEqual(coarseRead(''), { invoice_no: null, date: null, due_date: null, amount: null, vendor: null });
});
```

```js
// workflows/code/validate.test.js
const test = require('node:test'); const assert = require('node:assert');
const { toNumber, validateFields } = require('./validate');
const base = { invoice_no: 'INV-1', date: '2026-10-01', due_date: '2026-10-15', amount: 100, vendor: 'X', customer_name: 'Acme GmbH', status: 'open', line_items_summary: 'servers' };
test('german string amount coerces', () => { assert.equal(toNumber('12.300,00 €'), 12300); assert.equal(toNumber('4,250.00'), 4250); assert.equal(toNumber(7), 7); });
test('valid passes and trims summary', () => { const v = validateFields({ ...base, line_items_summary: 'x'.repeat(200) }); assert.equal(v.line_items_summary.length, 120); });
test('bad status throws', () => assert.throws(() => validateFields({ ...base, status: 'late' }), /bad status/));
test('missing key throws', () => assert.throws(() => validateFields({ ...base, vendor: '' }), /missing vendor/));
test('non numeric amount throws', () => assert.throws(() => validateFields({ ...base, amount: 'lots' }), /amount/));
```

```js
// workflows/code/view.test.js
const test = require('node:test'); const assert = require('node:assert');
const { computeView } = require('./view');
const NOW = '2026-10-09T10:00:00Z';
const cust = { customer_id: 'acme', worker_id: 'w_tom', manager_id: 'm_anna', name: 'Acme GmbH', deleted_at: '', narrative: '', narrative_at: '' };
const row = (o) => ({ id: 'inv_1', stage: 1, regex_fields: '{}', llm_fields: '{}', error: '', text: 'some text', received_at: '2026-10-08T09:00:00Z', ...o });
test('coarse row uses regex fields; sharp row uses llm fields', () => {
  const a = row({ id: 'a', stage: 1, regex_fields: JSON.stringify({ invoice_no: 'INV-1', amount: 12.3, status: 'open' }) });
  const b = row({ id: 'b', stage: 2, received_at: '2026-10-09T09:00:00Z', regex_fields: JSON.stringify({ amount: 1 }), llm_fields: JSON.stringify({ invoice_no: 'INV-2', amount: 12300, status: 'overdue', line_items_summary: 'servers' }) });
  const { payload, texts } = computeView(cust, [a, b], NOW);
  assert.equal(payload.stage, 1); assert.equal(payload.pending_count, 1); assert.equal(payload.invoice_count, 2);
  assert.equal(payload.overdue_count, 1); assert.equal(payload.overdue_amount, 12300); assert.equal(payload.open_amount, 12312.3);
  assert.deepEqual(payload.latest, { invoice_no: 'INV-2', amount: 12300, stage: 2 });
  assert.equal(payload.last_invoice_at, '2026-10-09T09:00:00Z');
  assert.equal(payload.summary_stage, 1); assert.ok(!('deleted_at' in payload));
  assert.match(texts.digest, /INV-2 \| \? \| 12300\.00 EUR \| due \? \| overdue \| servers/);
  assert.equal(payload.invoices[1].items, 'servers');
});
test('empty regex fields still produce a point', () => {
  const { payload, texts } = computeView(cust, [row({ regex_fields: '{}' })], NOW);
  assert.equal(payload.stage, 1); assert.equal(payload.latest.amount, null); assert.equal(payload.open_amount, 0);
  assert.match(texts.digest, /^\? \| \? \| \? EUR/);
});
test('error row counts as coarse, not pending', () => {
  const { payload } = computeView(cust, [row({ stage: -1, error: 'timeout' })], NOW);
  assert.equal(payload.stage, 1); assert.equal(payload.pending_count, 0);
});
test('fresh narrative is used, stale narrative is not', () => {
  const r = row({ stage: 2, llm_fields: JSON.stringify({ amount: 5, status: 'paid' }) });
  const fresh = computeView({ ...cust, narrative: 'All paid.', narrative_at: '2026-10-09T09:30:00Z' }, [r], NOW).payload;
  assert.equal(fresh.summary_stage, 3); assert.equal(fresh.summary_text, 'All paid.');
  const stale = computeView({ ...cust, narrative: 'Old.', narrative_at: '2026-10-01T00:00:00Z' }, [r], NOW).payload;
  assert.equal(stale.summary_stage, 1);
});
test('deleted_at is carried through', () => {
  assert.equal(computeView({ ...cust, deleted_at: '2026-10-05T00:00:00Z' }, [row({})], NOW).payload.deleted_at, '2026-10-05T00:00:00Z');
});
```

```js
// workflows/code/cards.test.js
const test = require('node:test'); const assert = require('node:assert');
const { shapeCards, splitRemoved } = require('./cards');
const W = { w_tom: { manager_id: 'm_anna', name: 'Tom' } };
const pt = (o) => ({ payload: { customer_id: 'acme', name: 'Acme', worker_id: 'w_tom', stage: 2, summary_stage: 3, summary_text: 'narr', pending_count: 0, invoice_count: 3, open_amount: 1, overdue_count: 0, overdue_amount: 0, latest: { invoice_no: 'I', amount: 1, stage: 2 }, updated_at: 'u', ...o } });
test('rung 3 when narrative fresh', () => { const c = shapeCards([pt({})], W)[0]; assert.equal(c.rung, 3); assert.equal(c.narrative, 'narr'); assert.equal(c.worker, 'Tom'); });
test('rung follows stage without narrative', () => { const c = shapeCards([pt({ stage: 0, summary_stage: 1 })], W)[0]; assert.equal(c.rung, 0); assert.equal(c.narrative, ''); });
test('splitRemoved computes purge_at', () => {
  const { cards, removed } = splitRemoved(shapeCards([pt({}), pt({ customer_id: 'beta', deleted_at: '2026-10-01T00:00:00Z' })], W));
  assert.equal(cards.length, 1); assert.equal(removed[0].purge_at, '2026-10-31T00:00:00Z');
});
```

```js
// workflows/code/match.test.js
const test = require('node:test'); const assert = require('node:assert');
const { pickMatchedLine } = require('./match');
const inv = [{ invoice_no: 'INV-1', vendor: 'Hetzner', items: 'Hetzner servers', status: 'open' }, { invoice_no: 'INV-2', vendor: 'Deloitte', items: 'consulting', status: 'paid' }];
test('picks the best overlapping line', () => assert.equal(pickMatchedLine('servers', inv), 'INV-1 · Hetzner servers'));
test('no overlap returns null', () => assert.equal(pickMatchedLine('zebra', inv), null));
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test workflows/code/`
Expected: every file fails with `Cannot find module './ids'` (and so on).

- [ ] **Step 3: Write the implementations**

```js
// workflows/code/ids.js
function uuidFromHex(hex) {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function resolveUpload(sampleFile, workerId, workers) {
  const slug = sampleFile.replace(/\.pdf$/i, '').split('-')[0].toLowerCase();
  const w = workers[workerId];
  if (!w) throw new Error(`unknown worker ${workerId}`);
  return { customer_id: slug, worker_id: workerId, manager_id: w.manager_id };
}
module.exports = { uuidFromHex, resolveUpload };
```

```js
// workflows/code/coarse.js
// ponytail: deliberately naive. "4,250.00" parses right, "12.300,00" parses as 12.3. The vision stage fixes it on stage.
function coarseRead(text) {
  const t = text || '';
  const g = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
  const raw = g(/total[^0-9]*([0-9][0-9.,]*)/i);
  return {
    invoice_no: g(/invoice\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9-]+)/i),
    date: g(/(?<!due\s)date\s*:?\s*(\d{4}-\d{2}-\d{2})/i),
    due_date: g(/due\s*(?:date)?\s*:?\s*(\d{4}-\d{2}-\d{2})/i),
    amount: raw === null ? null : parseFloat(raw.replace(/,/g, '')),
    vendor: g(/from\s*:?\s*([^\n]+)/i),
  };
}
module.exports = { coarseRead };
```

```js
// workflows/code/validate.js
function toNumber(v) {
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!s) return NaN;
  return Number(s);
}
function validateFields(obj) {
  for (const k of ['invoice_no', 'date', 'due_date', 'amount', 'vendor', 'customer_name', 'status']) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === '') throw new Error(`missing ${k}`);
  }
  const amount = toNumber(obj.amount);
  if (!Number.isFinite(amount)) throw new Error('amount not numeric');
  if (!['open', 'paid', 'overdue'].includes(obj.status)) throw new Error(`bad status ${obj.status}`);
  for (const k of ['date', 'due_date']) if (!/^\d{4}-\d{2}-\d{2}$/.test(obj[k])) throw new Error(`bad ${k}`);
  return { ...obj, amount, line_items_summary: String(obj.line_items_summary || '').slice(0, 120) };
}
module.exports = { toNumber, validateFields };
```

```js
// workflows/code/view.js
function computeView(customer, invoices, nowIso) {
  const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  const inv = invoices.map((r) => {
    const f = r.stage >= 2 ? parse(r.llm_fields) : parse(r.regex_fields);
    return {
      id: r.id, invoice_no: f.invoice_no || null, date: f.date || null, due_date: f.due_date || null,
      amount: Number.isFinite(f.amount) ? f.amount : null, vendor: f.vendor || null,
      status: f.status || 'open', stage: r.stage, error: r.error || '', items: f.line_items_summary || '',
      received_at: r.received_at || '',
    };
  }).sort((a, b) => a.received_at.localeCompare(b.received_at));
  const sum = (xs) => +xs.reduce((a, b) => a + b, 0).toFixed(2);
  const priced = inv.filter((i) => i.amount !== null);
  const open = priced.filter((i) => i.status !== 'paid');
  const overdue = priced.filter((i) => i.status === 'overdue');
  const stage = inv.length ? Math.min(...inv.map((i) => (i.stage < 0 ? 1 : i.stage))) : 0;
  const pending = inv.filter((i) => i.stage === 0 || i.stage === 1).length;
  const last = inv[inv.length - 1] || null;
  const mechanical = `${inv.length} invoices, ${sum(open.map((i) => i.amount)).toFixed(2)} EUR open, ${overdue.length} overdue, last ${last ? last.received_at.slice(0, 10) : 'never'}`;
  const fresh = !!(customer.narrative && customer.narrative_at && last && customer.narrative_at >= last.received_at);
  const digest = inv.map((i) => `${i.invoice_no || '?'} | ${i.date || '?'} | ${i.amount === null ? '?' : i.amount.toFixed(2)} EUR | due ${i.due_date || '?'} | ${i.status} | ${i.items}`).join('\n');
  const payload = {
    manager_id: customer.manager_id, worker_id: customer.worker_id, customer_id: customer.customer_id,
    name: customer.name || customer.customer_id,
    stage, pending_count: pending, invoice_count: inv.length,
    total_amount: sum(priced.map((i) => i.amount)), open_amount: sum(open.map((i) => i.amount)),
    overdue_count: overdue.length, overdue_amount: sum(overdue.map((i) => i.amount)),
    last_invoice_at: last ? last.received_at : null,
    latest: last ? { invoice_no: last.invoice_no, amount: last.amount, stage: last.stage } : null,
    summary_stage: fresh ? 3 : 1, summary_text: fresh ? customer.narrative : mechanical,
    summary_generated_at: fresh ? customer.narrative_at : nowIso,
    updated_at: nowIso,
    invoices: inv.map(({ received_at, ...rest }) => rest),
  };
  if (customer.deleted_at) payload.deleted_at = customer.deleted_at;
  return {
    payload,
    texts: {
      summary: payload.summary_text,
      digest: digest || 'no invoices',
      bm25: invoices.map((r) => r.text || '').join('\n').trim() || 'no text',
    },
  };
}
module.exports = { computeView };
```

```js
// workflows/code/cards.js
function shapeCards(points, workers) {
  return points.map(({ payload: q }) => ({
    customer_id: q.customer_id, name: q.name, worker: (workers[q.worker_id] || {}).name || q.worker_id,
    stage: q.stage, rung: q.summary_stage === 3 ? 3 : q.stage,
    pending_count: q.pending_count, invoice_count: q.invoice_count,
    open_amount: q.open_amount, overdue_count: q.overdue_count, overdue_amount: q.overdue_amount,
    latest: q.latest, narrative: q.summary_stage === 3 ? q.summary_text : '',
    updated_at: q.updated_at, deleted_at: q.deleted_at || null,
  }));
}
function splitRemoved(cards) {
  const plus30 = (iso) => new Date(new Date(iso).getTime() + 30 * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    cards: cards.filter((c) => !c.deleted_at),
    removed: cards.filter((c) => c.deleted_at).map((c) => ({ customer_id: c.customer_id, name: c.name, deleted_at: c.deleted_at, purge_at: plus30(c.deleted_at) })),
  };
}
module.exports = { shapeCards, splitRemoved };
```

```js
// workflows/code/match.js
// ponytail: MaxSim does not report which digest line won; token overlap is the cheap stand-in.
function pickMatchedLine(q, invoices) {
  const toks = String(q).toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  let best = null, bestScore = 0;
  for (const i of invoices || []) {
    const line = `${i.invoice_no || ''} ${i.vendor || ''} ${i.items || ''} ${i.status || ''}`.toLowerCase();
    const score = toks.filter((t) => line.includes(t)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best ? `${best.invoice_no} · ${best.items || best.vendor}` : null;
}
module.exports = { pickMatchedLine };
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test workflows/code/`
Expected: all tests pass, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add workflows/code
git commit -m "feat(code): pure functions for n8n Code nodes with node tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Synthetic Invoices

**Files:**
- Create: `samples/gen.py`, `samples/test_gen.py`, `samples/print.sh`
- Generated: `samples/html/*.html`, `samples/manifest.json`, `samples/*.pdf`
- Test: `python3 samples/test_gen.py`

**Interfaces:**
- Produces: `samples/manifest.json`, a list of `{file, worker_id, customer, expected_amount, format, status, items}`; the Form dropdown options in Task 7 are the `file` values; Task 12 uses `expected_amount` and `status` to check ingest.

- [ ] **Step 1: Write `samples/test_gen.py`**

```python
import json, os, subprocess, sys, hashlib
here = os.path.dirname(os.path.abspath(__file__))
subprocess.check_call([sys.executable, os.path.join(here, 'gen.py')])
m = json.load(open(os.path.join(here, 'manifest.json')))
assert len(m) == 14, len(m)
assert sum(1 for r in m if r['format'] == 'de') == 2
assert len({r['customer'] for r in m}) == 6
assert {r['worker_id'] for r in m} == {'w_tom', 'w_lena', 'w_jules', 'w_mia'}
dups = [r for r in m if r.get('duplicate_of')]
assert len(dups) == 1 and dups[0]['customer'] == 'beta'
over = {r['customer'] for r in m if r['status'] == 'overdue' and r['expected_amount'] >= 10000}
assert len(over) == 2, over
for term in ['servers', 'consulting', 'licenses']:
    hits = {r['customer'] for r in m if term in r['items']}
    assert 1 <= len(hits) <= 2, (term, hits)
for r in m:
    html = open(os.path.join(here, 'html', r['file'].replace('.pdf', '.html'))).read()
    assert 'Total' in html and r['customer'] in r['file']
    if r['format'] == 'de': assert '12.300,00' in html or '18.750,00' in html
print('gen ok')
```

- [ ] **Step 2: Run it, verify it fails**

Run: `python3 samples/test_gen.py`
Expected: `FileNotFoundError` for `gen.py`.

- [ ] **Step 3: Write `samples/gen.py`** (stdlib only)

```python
#!/usr/bin/env python3
"""Writes 14 synthetic invoice HTML files and manifest.json. Fake companies only."""
import json, os
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, 'html'), exist_ok=True)

# customer, worker (manager), display name
CUST = {
  'acme':  ('w_tom',   'Acme GmbH'),          # m_anna
  'beta':  ('w_tom',   'Beta Logistics AG'),  # m_anna
  'gamma': ('w_lena',  'Gamma Labs UG'),      # m_anna
  'delta': ('w_jules', 'Delta Retail SE'),    # m_ben
  'eps':   ('w_jules', 'Epsilon Media GmbH'), # m_ben
  'zeta':  ('w_mia',   'Zeta Energy KG'),     # m_ben
}
# file, customer, invoice_no, date, due, amount, status, vendor, items, format
ROWS = [
  ('acme-001.pdf','acme','INV-4711','2026-09-01','2026-09-15', 12300.00,'overdue','Hetzner Online GmbH','Hetzner servers, rack 12, September','de'),
  ('acme-002.pdf','acme','INV-4730','2026-09-20','2026-10-20',  4250.00,'open',   'Hetzner Online GmbH','Hetzner servers, bandwidth overage','en'),
  ('acme-003.pdf','acme','INV-4750','2026-10-01','2026-10-31',   980.00,'open',   'Jetbrains s.r.o.',   'IDE licenses, 4 seats','en'),
  ('beta-001.pdf','beta','INV-9001','2026-08-10','2026-08-24', 18750.00,'overdue','Deloitte GmbH',      'consulting, warehouse audit','de'),
  ('beta-002.pdf','beta','INV-9002','2026-09-12','2026-10-12',  2100.00,'open',   'Deloitte GmbH',      'consulting, follow-up workshop','en'),
  ('beta-003.pdf','beta','INV-9003','2026-10-02','2026-11-01',   640.00,'open',   'Office Depot',       'office supplies, pallets','en'),
  ('beta-004.pdf','beta','INV-9003','2026-10-02','2026-11-01',   640.00,'open',   'Office Depot',       'office supplies, pallets','en'),  # byte-identical duplicate of beta-003
  ('gamma-001.pdf','gamma','INV-2201','2026-09-05','2026-10-05', 1500.00,'paid',  'Microsoft Ireland',  'Office licenses, annual','en'),
  ('gamma-002.pdf','gamma','INV-2202','2026-10-03','2026-11-02', 3200.00,'open',  'Microsoft Ireland',  'Azure compute, September','en'),
  ('delta-001.pdf','delta','INV-5100','2026-09-02','2026-10-02', 7600.00,'open',  'Hetzner Online GmbH','Hetzner servers, store backend','en'),
  ('delta-002.pdf','delta','INV-5101','2026-09-28','2026-10-28', 1250.00,'open',  'Shopify Inc.',       'platform fees, September','en'),
  ('eps-001.pdf','eps','INV-3300','2026-09-15','2026-10-15',  9800.00,'open',    'Adobe Systems',      'Creative licenses, 10 seats','en'),
  ('eps-002.pdf','eps','INV-3301','2026-10-04','2026-11-03',   450.00,'open',    'Canva Pty',          'design subscription','en'),
  ('zeta-001.pdf','zeta','INV-7700','2026-09-08','2026-10-08', 5400.00,'paid',   'Siemens AG',         'turbine inspection, consulting','en'),
]
def money(x, fmt):
    if fmt == 'de': return f"{x:,.2f}".replace(',', 'X').replace('.', ',').replace('X', '.') + ' €'
    return f"{x:,.2f} EUR"
TPL = """<!doctype html><html><head><meta charset="utf-8"><style>
body{{font-family:Helvetica,Arial,sans-serif;margin:48px;color:#111}} h1{{letter-spacing:.1em}} table{{border-collapse:collapse;width:100%;margin-top:24px}}
td,th{{border-bottom:1px solid #ccc;padding:8px;text-align:left}} .total{{font-size:1.4em;margin-top:24px}} .meta td{{border:0;padding:2px 8px 2px 0}}
</style></head><body>
<h1>{title}</h1>
<table class="meta"><tr><td>Invoice No: {no}</td></tr><tr><td>Date: {date}</td></tr><tr><td>Due date: {due}</td></tr>
<tr><td>From: {vendor}</td></tr><tr><td>To: {customer}</td></tr><tr><td>Status: {status}</td></tr></table>
<table><tr><th>Description</th><th>Qty</th><th>Amount</th></tr>
<tr><td>{items}</td><td>1</td><td>{amount}</td></tr></table>
<p class="total">Total: {amount}</p>
<p style="color:#888;font-size:.8em">Synthetic invoice for a demo. Not a real company, not a real debt.</p>
</body></html>"""
manifest = []
for f, c, no, date, due, amt, status, vendor, items, fmt in ROWS:
    html = TPL.format(title='RECHNUNG' if fmt == 'de' else 'INVOICE', no=no, date=date, due=due, vendor=vendor,
                      customer=CUST[c][1], status=status, items=items, amount=money(amt, fmt))
    open(os.path.join(here, 'html', f.replace('.pdf', '.html')), 'w').write(html)
    row = {'file': f, 'worker_id': CUST[c][0], 'customer': c, 'invoice_no': no, 'expected_amount': amt, 'status': status, 'items': items, 'format': fmt}
    if f == 'beta-004.pdf': row['duplicate_of'] = 'beta-003.pdf'
    manifest.append(row)
json.dump(manifest, open(os.path.join(here, 'manifest.json'), 'w'), indent=1)
print(f"wrote {len(manifest)} invoices")
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `python3 samples/test_gen.py`
Expected: `wrote 14 invoices` then `gen ok`.

- [ ] **Step 5: Write `samples/print.sh`** and print the PDFs

```bash
#!/usr/bin/env bash
# HTML -> PDF with headless Chrome. beta-004 is copied from beta-003 so the bytes are identical.
set -euo pipefail
cd "$(dirname "$0")"
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
for f in html/*.html; do
  out="$(basename "${f%.html}").pdf"
  [ "$out" = "beta-004.pdf" ] && continue
  "$CHROME" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="$PWD/$out" "file://$PWD/$f" 2>/dev/null
done
cp beta-003.pdf beta-004.pdf
ls -1 *.pdf | wc -l
shasum -a 256 beta-003.pdf beta-004.pdf
```

Run: `chmod +x samples/print.sh && samples/print.sh`
Expected: `14` then two identical SHA-256 lines. Then: `qdrant/openrouter_check.sh samples/acme-001.pdf` prints `amount: 12300`.

- [ ] **Step 6: Commit** (PDFs are committed on purpose: the Form downloads them from the repo's raw URL)

```bash
git add samples/gen.py samples/test_gen.py samples/print.sh samples/manifest.json samples/*.pdf
git commit -m "feat(samples): 14 synthetic invoice PDFs, two in German number format, one byte-identical duplicate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Data Tables and Workflow 03 Rebuild Point

**Files:**
- Create in n8n Cloud: Data Tables `invoices`, `customers`; workflow `03 Rebuild point`
- Export: `workflows/03-rebuild-point.json`
- Test: `qdrant/check_point.sh` (created here) against a hand-seeded customer

**Interfaces:**
- Consumes: `computeView`, `uuidFromHex` from Task 4 (pasted).
- Produces: sub-workflow `03 Rebuild point` with inputs `customer_id` (string), `manager_id` (string); on completion the Qdrant point for that customer reflects the Data Tables. Every later workflow calls it with exactly those two inputs.

- [ ] **Step 1: Create the Data Tables in the n8n project** (UI, Data tables tab)

`invoices`: columns `id` string, `customer_id` string, `worker_id` string, `manager_id` string, `pdf_hash` string, `filename` string, `text` string, `stage` number, `regex_fields` string, `llm_fields` string, `error` string, `received_at` dateTime.

`customers`: columns `customer_id` string, `worker_id` string, `manager_id` string, `name` string, `deleted_at` dateTime, `narrative` string, `narrative_at` dateTime.

Seed two rows by hand in `customers`: (`acme`, `w_tom`, `m_anna`, `Acme GmbH`) and (`acme`, `w_jules`, `m_ben`, `Acme GmbH`). Seed one row in `invoices` for each: id `inv_seed_a` / `inv_seed_b`, stage `1`, `regex_fields` = `{"invoice_no":"INV-4711","amount":12.3,"status":"open"}`, `text` = `seed`, `received_at` = now.

- [ ] **Step 2: Write `qdrant/check_point.sh`** (the test for this and later tasks)

```bash
#!/usr/bin/env bash
# usage: check_point.sh <manager_id> <customer_id> [jq-ish python expr on payload, default prints it]
set -euo pipefail
cd "$(dirname "$0")"; set -a; [ -f ../.env ] && . ../.env; set +a
. ./lib.sh
M=$1; CU=$2; EXPR=${3:-'print(json.dumps(p, indent=1))'}
q POST /collections/customers/points/scroll "{\"shard_key\": \"$M\", \"limit\": 1, \"with_payload\": true, \"filter\": {\"must\": [{\"key\": \"customer_id\", \"match\": {\"value\": \"$CU\"}}]}}" \
 | python3 -c "import sys,json; pts=json.load(sys.stdin)['result']['points']; assert pts, 'no point'; p=pts[0]['payload']; $EXPR"
```

Run: `chmod +x qdrant/check_point.sh && qdrant/check_point.sh m_anna acme`
Expected: `AssertionError: no point` (the workflow doesn't exist yet).

- [ ] **Step 3: Build workflow `03 Rebuild point`** (nodes in order; names are the sentences)

| # | Node | Settings |
|---|---|---|
| 1 | When Executed by Another Workflow | Input data mode: Define using fields. Fields: `customer_id` string, `manager_id` string |
| 2 | Config | Edit Fields. `QDRANT_URL`, `COLLECTION` = `customers`. Include other input fields: on |
| 3 | Hash the point id | Crypto. Action: Hash, Type: SHA256, Value: `={{ $json.manager_id }}/{{ $json.customer_id }}`, Property name: `idhash` |
| 4 | Load the customer row | Data Table `customers`, Get. Conditions: `customer_id` equals `={{ $('Config').item.json.customer_id }}` AND `manager_id` equals `={{ $('Config').item.json.manager_id }}`. Always output data: on |
| 5 | Load all invoice rows | Data Table `invoices`, Get, same two conditions, Return all. Always output data: on |
| 6 | Compute the view | Code, Run once for all items. Body below |
| 7 | Upsert the point with inference | HTTP Request. PUT `={{ $('Config').item.json.QDRANT_URL }}/collections/{{ $('Config').item.json.COLLECTION }}/points?wait=true`. Auth: Header Auth, `Qdrant api-key`. Body: JSON, Using fields below: `={{ $json.body }}` as raw JSON (Specify Body: Using JSON, JSON: `={{ JSON.stringify($json.body) }}`) |

Code node 6, paste the `uuidFromHex` and `computeView` function bodies from `workflows/code/ids.js` and `view.js` verbatim (without the `module.exports` lines), then:

```js
const cfg = $('Config').first().json;
const customers = $('Load the customer row').all().map(i => i.json).filter(r => r.customer_id);
const invoices = $('Load all invoice rows').all().map(i => i.json).filter(r => r.id);
if (!customers.length) throw new Error(`no customer row for ${cfg.manager_id}/${cfg.customer_id}`);
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const { payload, texts } = computeView(customers[0], invoices, now);
const id = uuidFromHex($('Hash the point id').first().json.idhash);
return [{ json: { body: {
  shard_key: cfg.manager_id,
  points: [{ id, payload, vector: {
    summary: { text: texts.summary, model: 'sentence-transformers/all-minilm-l6-v2' },
    digest:  { text: texts.digest,  model: 'answerdotai/answerai-colbert-small-v1' },
    bm25:    { text: texts.bm25,    model: 'qdrant/bm25' },
  }}],
}}}];
```

Sticky note (one): "Source of truth is the two Data Tables. This workflow is the only writer to Qdrant. Any stage, any retry, same point."

- [ ] **Step 4: Test manually with the seeded rows**

In the workflow editor, run with test input `{"customer_id": "acme", "manager_id": "m_anna"}`, then again with `m_ben`.

Run: `qdrant/check_point.sh m_anna acme 'assert p["stage"]==1 and p["latest"]["amount"]==12.3 and p["worker_id"]=="w_tom", p; print("m_anna ok")'`
Run: `qdrant/check_point.sh m_ben acme 'assert p["worker_id"]=="w_jules", p; print("m_ben ok")'`
Expected: both print ok. Two points exist for slug `acme` (Review Focus 3).

- [ ] **Step 5: Export and scrub**

Download the workflow JSON to `workflows/03-rebuild-point.json`. Open it and confirm: no `"id"` inside any `credentials` block that is an instance-specific id (keep only `"name"`), no cluster URL except in the `Config` node (set its value to `https://REPLACE.cloud.qdrant.io:6333`). Pin the trigger's test input before export so an importer sees items.

Run: `grep -c 'cloud.qdrant.io' workflows/03-rebuild-point.json`
Expected: `1`.

- [ ] **Step 6: Commit**

```bash
git add workflows/03-rebuild-point.json qdrant/check_point.sh
git commit -m "feat(n8n): 03 Rebuild point sub-workflow; point check script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Workflows 01 Ingest, 02 Process, 02b Write the Narrative

**Files:**
- Create in n8n Cloud: `01 Ingest`, `02 Process`, `02b Write the narrative`
- Export: `workflows/01-ingest.json`, `workflows/02-process.json`, `workflows/02b-narrative.json`
- Test: Form submission, then `qdrant/check_point.sh` polled

**Interfaces:**
- Consumes: `03 Rebuild point` (inputs `customer_id`, `manager_id`); `resolveUpload`, `coarseRead`, `validateFields` from Task 4; OpenRouter body from Task 3; `samples/manifest.json` file names.
- Produces: a public Form URL (the QR); `02 Process` inputs `invoice_id`, `customer_id`, `manager_id`, binary `data`; `02b` inputs `customer_id`, `manager_id`.

- [ ] **Step 1: Build `02b Write the narrative`** (sub-workflow, 8 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | When Executed by Another Workflow | Fields: `customer_id`, `manager_id` |
| 2 | Config | `QDRANT_URL`, `COLLECTION`, `OPENROUTER_MODEL`. Include other input fields: on |
| 3 | Hash the point id | Crypto SHA256 of `={{ $json.manager_id }}/{{ $json.customer_id }}` → `idhash` |
| 4 | Read the point | Code: paste `uuidFromHex`; `return [{json:{id: uuidFromHex($json.idhash), ...$('Config').first().json}}]` then HTTP Request POST `={{ $json.QDRANT_URL }}/collections/{{ $json.COLLECTION }}/points` body `={{ JSON.stringify({shard_key: $json.manager_id, ids: [$json.id], with_payload: true}) }}` (two nodes; count them as 4 and 5) |
| 6 | Ask for three sentences | HTTP Request POST `https://openrouter.ai/api/v1/chat/completions`, Header Auth `OpenRouter bearer`, body: see below |
| 7 | Keep only the narrative | Code: `const c = JSON.parse($json.choices[0].message.content); if (typeof c.narrative !== 'string' || c.narrative.length < 20) throw new Error('bad narrative'); return [{json:{narrative: c.narrative.slice(0,600), at: new Date().toISOString().replace(/\.\d{3}Z$/,'Z')}}];` |
| 8 | Save the narrative | Data Table `customers`, Update rows where `customer_id` equals and `manager_id` equals (from Config); set `narrative`, `narrative_at` |
| 9 | Rebuild the point | Execute Sub-workflow `03 Rebuild point`, wait on, inputs `customer_id`, `manager_id` from Config |

Node 6 body (JSON expression):

```js
={{ JSON.stringify({
  model: $('Config').first().json.OPENROUTER_MODEL, temperature: 0, max_tokens: 300,
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: 'You write for a manager. Three plain sentences about this customer: what is open, what is overdue, what changed most recently. No bullet points. Return JSON only: {"narrative": "..."}' },
    { role: 'user', content: 'Aggregates: ' + JSON.stringify((({invoice_count,open_amount,overdue_count,overdue_amount,last_invoice_at}) => ({invoice_count,open_amount,overdue_count,overdue_amount,last_invoice_at}))($json.result[0].payload)) + '\nInvoices:\n' + $json.result[0].payload.invoices.map(i => `${i.invoice_no} | ${i.date} | ${i.amount} EUR | due ${i.due_date} | ${i.status} | ${i.items}`).join('\n') }
  ]}) }}
```

Node 6 settings: Timeout 20000 ms, Retry on fail 1. Node 7 settings: On Error → Stop workflow (a bad narrative leaves the point at rung 2, by design).

- [ ] **Step 2: Build `02 Process`** (sub-workflow, 15 nodes, the cap)

| # | Node | Settings |
|---|---|---|
| 1 | When Executed by Another Workflow | Fields: `invoice_id`, `customer_id`, `manager_id`; Accept binary |
| 2 | Config | `OPENROUTER_MODEL`, `PDF_ENGINE`. Include other input fields: on |
| 3 | Show the point as received | Execute Sub-workflow `03 Rebuild point`, wait on, `customer_id`, `manager_id` |
| 4 | Pull the text out of the PDF | Extract from File, operation PDF, binary property `data`. Input from node 2 (connect 2→4 as well as 2→3→4? No: connect 3→4; Extract reads binary from the item, which 03 passes through unchanged) |
| 5 | Read the PDF as base64 | Extract from File, operation Move File to Base64 String, binary `data`, destination key `b64` |
| 6 | Coarse read with regex | Code: paste `coarseRead`; `const text = $('Pull the text out of the PDF').first().json.text || ''; return [{json:{regex_fields: JSON.stringify(coarseRead(text)), text}}];` |
| 7 | Update the row: stage 1 | Data Table `invoices`, Update where `id` equals `={{ $('Config').first().json.invoice_id }}`: `stage` = 1, `regex_fields`, `text` |
| 8 | Show the coarse view | Execute Sub-workflow `03 Rebuild point` |
| 9 | Ask the vision model to read the PDF | HTTP Request POST OpenRouter, Header Auth `OpenRouter bearer`, Timeout 30000, Retry 1, On Error: Continue (using error output). Body below |
| 10 | Validate the fields | Code: paste `toNumber` and `validateFields`; `const c = JSON.parse($json.choices[0].message.content); return [{json:{llm_fields: JSON.stringify(validateFields(c))}}];` On Error: Continue (using error output) |
| 11 | Update the row: stage 2 | Data Table `invoices` Update where `id` equals: `stage` = 2, `llm_fields` |
| 12 | Update the row: stage -1 | Data Table `invoices` Update where `id` equals: `stage` = -1, `error` = `={{ $json.error ? ($json.error.message || JSON.stringify($json.error)) : 'vision failed' }}`. Connected from the error outputs of 9 and 10 |
| 13 | Show the sharp view | Execute Sub-workflow `03 Rebuild point`. Connected from 11 and from 12 |
| 14 | Only continue if sharp | If: `={{ $('Update the row: stage 2').isExecuted }}` is true |
| 15 | Write the narrative | Execute Sub-workflow `02b Write the narrative`, wait on |

Node 9 body (JSON expression):

```js
={{ JSON.stringify({
  model: $('Config').first().json.OPENROUTER_MODEL, temperature: 0, max_tokens: 400,
  response_format: { type: 'json_object' },
  plugins: [{ id: 'file-parser', pdf: { engine: $('Config').first().json.PDF_ENGINE } }],
  messages: [
    { role: 'system', content: 'You read one invoice PDF and return JSON only with keys: invoice_no, date (YYYY-MM-DD), due_date (YYYY-MM-DD), amount (number in EUR, no thousands separators), vendor, customer_name, status (one of: open, paid, overdue), line_items_summary (max 12 words).' },
    { role: 'user', content: [
      { type: 'text', text: 'Extract the fields.' },
      { type: 'file', file: { filename: 'invoice.pdf', file_data: 'data:application/pdf;base64,' + $('Read the PDF as base64').first().json.b64 } }
    ]}
  ]}) }}
```

Sticky notes (two): "Stages top to bottom: received → coarse (regex, on purpose wrong on German numbers) → sharp (vision) → narrative. Each stage ends in Rebuild." and "Errors land in stage -1 and still rebuild. The card stays half-blurry, the demo continues."

- [ ] **Step 3: Build `01 Ingest`** (12 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | Pick an invoice | Form Trigger. Title "Send an invoice (synthetic data only)". Fields: `sample` dropdown with the 14 file names from `samples/manifest.json`; `worker` dropdown `w_tom`, `w_lena`, `w_jules`, `w_mia`. Respond: Using Form node |
| 2 | Config | `QDRANT_URL`, `COLLECTION`, `SAMPLES_BASE_URL` = `https://raw.githubusercontent.com/<org>/n8n-invoice-memory/main/samples`, `WORKERS` = `{"w_tom":{"manager_id":"m_anna","name":"Tom"},"w_lena":{"manager_id":"m_anna","name":"Lena"},"w_jules":{"manager_id":"m_ben","name":"Jules"},"w_mia":{"manager_id":"m_ben","name":"Mia"}}`, `MANAGERS` = `{"m_anna":"Anna","m_ben":"Ben"}`. Include other input fields: on |
| 3 | Download the chosen sample | HTTP Request GET `={{ $json.SAMPLES_BASE_URL }}/{{ $json.sample }}`, Response format: File, output binary `data` |
| 4 | Hash the PDF | Crypto, Hash SHA256, Binary File: on, binary property `data`, property name `pdf_hash` |
| 5 | Seen this hash before? | Data Table `invoices` Get where `pdf_hash` equals `={{ $json.pdf_hash }}`. Always output data: on |
| 6 | Is it a duplicate? | If: `={{ !!$json.id }}` |
| 7 | Say it is a duplicate | Form (Form Ending). Completion title "Duplicate", message `=That's {{ $('Seen this hash before?').first().json.filename }} again (hash match). Nothing ingested.` |
| 8 | Resolve the customer and manager | Code: paste `resolveUpload`; `const cfg = $('Config').first().json; const r = resolveUpload(cfg.sample, cfg.worker, JSON.parse(cfg.WORKERS)); const id = 'inv_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); return [{json:{...r, invoice_id: id, filename: cfg.sample, pdf_hash: $('Hash the PDF').first().json.pdf_hash, received_at: new Date().toISOString().replace(/\.\d{3}Z$/,'Z')}}];` |
| 9 | Upsert the customer row | Data Table `customers`, Insert or Update (match on `customer_id` and `manager_id`): `worker_id`, `name` = `={{ $json.customer_id.charAt(0).toUpperCase() + $json.customer_id.slice(1) }}` only on insert if the node supports it, otherwise set it every time |
| 10 | Append the invoice row | Data Table `invoices`, Insert: `id` = invoice_id, `customer_id`, `worker_id`, `manager_id`, `pdf_hash`, `filename`, `stage` = 0, `text` = '', `regex_fields` = '{}', `llm_fields` = '{}', `error` = '', `received_at` |
| 11 | Process in the background | Execute Sub-workflow `02 Process`, **Wait for Sub-Workflow Completion: off**, inputs `invoice_id`, `customer_id`, `manager_id`; binary passes with the item |
| 12 | Say it was received | Form (Form Ending). Title "Received", message "Watch the dashboard. Rough in two seconds, sharp in thirty." |

Connections: 6 true → 7; 6 false → 8 → 9 → 10 → 11 → 12. Add a 13th node after 10, **disabled**: Google Drive, Upload file, binary `data`, named `Keep the PDF for accounting retention`, with its own sticky "Disabled. Swap for your storage. The PDF outlives a GDPR removal of the searchable record." Sticky on the Form: "No file field on purpose. Samples download from the repo. To accept uploads, add a File field and delete node 3."

- [ ] **Step 4: Test the happy path**

Activate `01 Ingest`. Open the Form URL. Pick `acme-001.pdf`, worker `w_tom`, submit. Note the time.

Run every 5 s for up to 60 s:
`qdrant/check_point.sh m_anna acme 'print(p["stage"], p["pending_count"], p["latest"], p["summary_stage"])'`
Expected sequence: `0 1 {... 'stage': 0} 1` within 3 s → `1 1 {'amount': 12.3, 'stage': 1} 1` within 6 s → `2 0 {'amount': 12300.0, 'stage': 2} 1` within 40 s → `2 0 ... 3` a few seconds later. The amount flips from 12.3 to 12300 (the booth moment).

- [ ] **Step 5: Test the duplicate path**

Submit `beta-003.pdf` with `w_tom`, wait 40 s, then submit `beta-004.pdf` with `w_tom`.
Expected: the second submission ends on the "Duplicate" page naming `beta-003.pdf`; `qdrant/check_point.sh m_anna beta 'print(p["invoice_count"])'` prints `1`.

- [ ] **Step 6: Test the error path**

Temporarily set `Config.OPENROUTER_MODEL` in `02 Process` to `nonexistent/model`, submit `gamma-001.pdf` with `w_lena`.
Expected within 20 s: `qdrant/check_point.sh m_anna gamma 'print(p["stage"], p["invoices"][0]["error"][:40])'` prints `1 ...` with a non-empty error; the execution list shows `02 Process` finished, not crashed. Restore the model. Delete the gamma rows from both Data Tables and rerun `gamma-001.pdf` so the corpus is clean.

- [ ] **Step 7: Export, scrub, commit**

Export the three workflows, scrub as in Task 6 (no credential ids, `Config` URLs set to placeholders, trigger test data pinned).

```bash
git add workflows/01-ingest.json workflows/02-process.json workflows/02b-narrative.json
git commit -m "feat(n8n): ingest, staged processing, and narrative workflows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Workflow 04 Dashboard Reads

**Files:**
- Create in n8n Cloud: `04 Dashboard reads`
- Export: `workflows/04-dashboard-reads.json`
- Test: curl against the two webhooks

**Interfaces:**
- Consumes: `shapeCards`, `splitRemoved`, `pickMatchedLine` from Task 4; request bodies from Task 2.
- Produces: `GET <N8N_BASE_URL>/webhook/customers?manager=m_anna[&overdue_gte=10000]` → `{cards: Card[], removed: Removed[], latency_ms}`; `GET <N8N_BASE_URL>/webhook/search?manager=m_anna&q=servers` → `{results: [{customer_id, score, matched_line}], latency_ms}`. Task 9 depends on exactly these shapes.

- [ ] **Step 1: Build the list path** (6 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | List this manager's customers | Webhook GET, path `customers`, Respond: Using Respond to Webhook node. Options: Allowed Origins `*` |
| 2 | Config | `QDRANT_URL`, `COLLECTION`, `WORKERS`. Include other input fields: on |
| 3 | Scroll live customers | HTTP Request POST `.../points/scroll`, Header Auth `Qdrant api-key`. Body below. Settings: Include response headers and status: off |
| 4 | Scroll removed customers | same, body differs by one condition (below) |
| 5 | Shape the cards | Code, paste `shapeCards` and `splitRemoved`; body below |
| 6 | Respond with cards | Respond to Webhook, JSON, `={{ $json }}`, header `Access-Control-Allow-Origin: *` |

Node 3 body:

```js
={{ (() => { const c = $('Config').first().json; const qs = $('List this manager\'s customers').first().json.query;
  const must = [ { key: 'manager_id', match: { value: qs.manager } }, { is_empty: { key: 'deleted_at' } } ];
  if (qs.overdue_gte) must.push({ nested: { key: 'invoices', filter: { must: [ { key: 'status', match: { value: 'overdue' } }, { key: 'amount', range: { gte: Number(qs.overdue_gte) } } ] } } });
  return JSON.stringify({ shard_key: qs.manager, limit: 50, with_payload: true, order_by: { key: 'last_invoice_at', direction: 'desc' }, filter: { must } });
})() }}
```

Node 4 body: same, but `must` is `[ { key: 'manager_id', match: { value: qs.manager } } ]` and `must_not: [ { is_empty: { key: 'deleted_at' } } ]` and no nested condition.

Node 5 body (after the pasted functions):

```js
const t0 = $('Scroll live customers').first().json.time || 0;   // Qdrant reports its own time in seconds
const t1 = $('Scroll removed customers').first().json.time || 0;
const workers = JSON.parse($('Config').first().json.WORKERS);
const live = $('Scroll live customers').first().json.result.points;
const gone = $('Scroll removed customers').first().json.result.points;
const { cards } = splitRemoved(shapeCards(live, workers));
const { removed } = splitRemoved(shapeCards(gone, workers));
return [{ json: { cards, removed, latency_ms: Math.round((t0 + t1) * 1000) } }];
```

- [ ] **Step 2: Build the search path** (5 nodes)

| # | Node | Settings |
|---|---|---|
| 7 | Search three vectors in one request | Webhook GET, path `search`, Respond: Using Respond to Webhook node |
| 8 | Config (search) | Edit Fields, same values as node 2 |
| 9 | Run the hybrid query | HTTP Request POST `.../points/query`, Header Auth. Body: the section 11 body from `qdrant/smoke.sh` step 3 with `servers` replaced by `qs.q`, `m_anna` by `qs.manager`, `$NOW` by `new Date().toISOString()`, `with_payload: ['customer_id','invoices']`, built the same way as node 3 with an IIFE |
| 10 | Pick the matched line | Code, paste `pickMatchedLine`; `const r = $json.result.points; const q = $('Search three vectors in one request').first().json.query.q; return [{json:{results: r.map(p => ({customer_id: p.payload.customer_id, score: +p.score.toFixed(4), matched_line: pickMatchedLine(q, p.payload.invoices)})), latency_ms: Math.round(($json.time||0)*1000)}}];` |
| 11 | Respond with matches | Respond to Webhook, JSON, CORS header as node 6 |

Sticky (one, over node 9): "Eight primitives, one request. Tenant filter, is_empty, bm25, ColBERT multivector, dense, inference ×3, RRF, decay formula."

- [ ] **Step 3: Test**

Activate. With the corpus from Task 7 (at least acme, beta under m_anna):

```bash
B=$N8N_BASE_URL/webhook
curl -s "$B/customers?manager=m_anna" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert {c["customer_id"] for c in d["cards"]} >= {"acme","beta"}, d; assert d["latency_ms"] < 300, d["latency_ms"]; print("list ok", d["latency_ms"])'
curl -s "$B/customers?manager=m_anna&overdue_gte=10000" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert {c["customer_id"] for c in d["cards"]} == {"acme","beta"}, d; print("filter ok")'
curl -s "$B/customers?manager=m_ben" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert not any(c["customer_id"]=="acme" and c["worker"]=="Tom" for c in d["cards"]); print("tenant ok")'
curl -s "$B/search?manager=m_anna&q=servers" | python3 -c 'import sys,json; d=json.load(sys.stdin); r=d["results"]; assert r and r[0]["customer_id"]=="acme" and "servers" in (r[0]["matched_line"] or ""), d; assert d["latency_ms"] < 500; print("search ok", d["latency_ms"])'
curl -s "$B/search?manager=m_anna&q=zebra+unicorn" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert all(x["matched_line"] is None for x in d["results"]), d; print("no-match ok")'
```

Expected: five `ok` lines. If `latency_ms` is missing because Qdrant's `time` field isn't exposed, wrap nodes 3 and 9 with `Date.now()` captured in `Config` (add field `t0` = `={{ Date.now() }}`) and compute `Date.now() - t0` in the Code node.

- [ ] **Step 4: Export, scrub, commit**

```bash
git add workflows/04-dashboard-reads.json
git commit -m "feat(n8n): dashboard read webhooks: list with nested filter, hybrid search

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Dashboard Page

**Files:**
- Create: `dashboard/app.js`, `dashboard/app.test.js`, `dashboard/index.html`, `dashboard/chime.wav` (any three short ascending tones; generate with the python snippet below)
- Test: `node --test dashboard/` plus a manual check in the browser

**Interfaces:**
- Consumes: the two read endpoints from Task 8, the write endpoint from Task 10 (buttons are wired here, tested there).
- Produces: `dashboard/app.js` exporting (CommonJS when `module` exists, globals otherwise) `blurFor(stage)`, `diffCards(prev, next)`, `applySearch(cards, results)`, `fmtEUR(n)`.

- [ ] **Step 1: Write `dashboard/app.test.js`**

```js
const test = require('node:test'); const assert = require('node:assert');
const { blurFor, diffCards, applySearch, fmtEUR } = require('./app');
const card = (o) => ({ customer_id: 'acme', stage: 2, rung: 3, latest: { invoice_no: 'I', amount: 12300, stage: 2 }, ...o });
test('blur per stage', () => { assert.equal(blurFor(0), 14); assert.equal(blurFor(1), 5); assert.equal(blurFor(2), 0); });
test('stage drop re-blurs and amount change is reported', () => {
  const ev = diffCards([card({})], [card({ stage: 0, rung: 0, latest: { invoice_no: 'J', amount: 12.3, stage: 0 } })]);
  assert.deepEqual(ev, [{ customer_id: 'acme', rung_from: 3, rung_to: 0, amount_changed: true }]);
});
test('rung up emits chime-worthy event', () => {
  const ev = diffCards([card({ stage: 1, rung: 1 })], [card({ stage: 2, rung: 2 })]);
  assert.equal(ev[0].rung_to, 2); assert.equal(ev[0].amount_changed, false);
});
test('new card has no previous', () => assert.deepEqual(diffCards([], [card({})]), [{ customer_id: 'acme', rung_from: null, rung_to: 3, amount_changed: false }]));
test('empty search dims nothing and flags no matches', () => {
  const s = applySearch([card({}), card({ customer_id: 'beta' })], []);
  assert.equal(s.noMatches, true); assert.deepEqual(s.highlight, {});
});
test('search highlights matches only', () => {
  const s = applySearch([card({}), card({ customer_id: 'beta' })], [{ customer_id: 'acme', score: 0.9, matched_line: 'I · servers' }]);
  assert.equal(s.noMatches, false); assert.deepEqual(s.highlight, { acme: 'I · servers' }); assert.deepEqual(s.dim, ['beta']);
});
test('euro formatting', () => { assert.equal(fmtEUR(12300), '€12,300.00'); assert.equal(fmtEUR(12.3), '€12.30'); assert.equal(fmtEUR(null), '?'); });
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test dashboard/`
Expected: `Cannot find module './app'`.

- [ ] **Step 3: Write `dashboard/app.js`**

```js
// Pure logic for the dashboard. No DOM here. Loaded by index.html and by node --test.
function blurFor(stage) { return stage <= 0 ? 14 : stage === 1 ? 5 : 0; }
function diffCards(prev, next) {
  const byId = Object.fromEntries(prev.map((c) => [c.customer_id, c]));
  return next.map((c) => {
    const p = byId[c.customer_id];
    return {
      customer_id: c.customer_id,
      rung_from: p ? p.rung : null,
      rung_to: c.rung,
      amount_changed: !!p && (p.latest && p.latest.amount) !== (c.latest && c.latest.amount),
    };
  }).filter((e) => e.rung_from !== e.rung_to || e.amount_changed);
}
function applySearch(cards, results) {
  const hits = (results || []).filter((r) => r.matched_line || r.score > 0);
  if (!hits.length) return { noMatches: true, highlight: {}, dim: [] };
  const highlight = Object.fromEntries(hits.map((r) => [r.customer_id, r.matched_line || '']));
  return { noMatches: false, highlight, dim: cards.map((c) => c.customer_id).filter((id) => !(id in highlight)) };
}
function fmtEUR(n) { return n === null || n === undefined ? '?' : '€' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
if (typeof module !== 'undefined') module.exports = { blurFor, diffCards, applySearch, fmtEUR };
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test dashboard/`
Expected: `# fail 0`.

- [ ] **Step 5: Write `dashboard/index.html`**

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice Memory</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#0b0d12;--card:#161a23;--fg:#e8e8ea;--mute:#8a8f9c;--ring:#dc244c;--ok:#2ecc71}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 Helvetica,Arial,sans-serif}
  header{display:flex;gap:16px;align-items:center;padding:16px 24px;border-bottom:1px solid #222}
  header .tab{padding:6px 14px;border-radius:999px;background:#222;cursor:pointer}
  header .tab.on{background:var(--ring)}
  header input{background:#111;border:1px solid #333;color:var(--fg);padding:8px 12px;border-radius:8px;font-size:16px}
  #badge{margin-left:auto;color:var(--mute);font-variant-numeric:tabular-nums}
  #banner{display:none;background:#5a1a1a;padding:8px 24px}
  main{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;padding:24px}
  .card{background:var(--card);border-radius:14px;padding:18px;transition:filter .6s,opacity .3s;position:relative;border:2px solid transparent}
  .card.hit{border-color:var(--ring)} .card.dim{opacity:.25}
  .card h2{margin:0 0 4px;font-size:20px} .card .w{color:var(--mute);font-size:13px}
  .amt{font-size:28px;margin:10px 0 4px;font-variant-numeric:tabular-nums}
  .latest{color:var(--mute)} .latest b{color:var(--fg)}
  .ladder{display:flex;gap:6px;margin:12px 0 6px} .rung{flex:1;height:8px;border-radius:4px;background:#2a2f3a} .rung.lit{background:var(--ok)}
  .times{display:flex;gap:6px;font-size:11px;color:var(--mute)} .times span{flex:1;text-align:center}
  .narr{margin-top:10px;font-size:14px;color:#c9ccd4} .match{margin-top:8px;color:var(--ring);font-size:14px}
  .btns{margin-top:12px;display:flex;gap:8px} .btns button{background:#222;color:var(--fg);border:0;padding:6px 10px;border-radius:6px;cursor:pointer}
  #removed{padding:0 24px 24px;color:var(--mute);font-size:14px}
  #nomatch{display:none;padding:0 24px;color:var(--mute)}
</style></head>
<body>
<header>
  <strong>Invoice Memory</strong>
  <span id="tabs"></span>
  <input id="q" placeholder="search: servers, consulting, licenses">
  <input id="over" type="number" placeholder="overdue over" style="width:130px">
  <label><input type="checkbox" id="mute" checked> mute</label>
  <span id="badge">—</span>
</header>
<div id="banner">offline · showing last known cards</div>
<div id="nomatch">no matches</div>
<main id="grid"></main>
<div id="removed"></div>
<audio id="chime" src="chime.wav"></audio>
<script src="app.js"></script>
<script>
const CONFIG = { base: localStorage.getItem('n8n') || prompt('n8n base URL (https://x.app.n8n.cloud)'), managers: { m_anna: 'Anna', m_ben: 'Ben' } };
localStorage.setItem('n8n', CONFIG.base);
let manager = 'm_anna', prev = [], fails = 0, searchState = null, litAt = {};
const $ = (s) => document.querySelector(s);
function tabs() { $('#tabs').innerHTML = Object.entries(CONFIG.managers).map(([id, n]) => `<span class="tab ${id === manager ? 'on' : ''}" data-id="${id}">${n}</span>`).join(''); }
$('#tabs').onclick = (e) => { if (e.target.dataset.id) { manager = e.target.dataset.id; prev = []; litAt = {}; tabs(); poll(); } };
async function api(path) { const t = performance.now(); const r = await fetch(`${CONFIG.base}/webhook/${path}`); const j = await r.json(); j.rtt_ms = Math.round(performance.now() - t); return j; }
function render(cards, removed) {
  const hl = searchState ? searchState.highlight : {}; const dim = searchState ? searchState.dim : [];
  $('#grid').innerHTML = cards.map((c) => {
    const t = litAt[c.customer_id] || {};
    return `<div class="card ${c.customer_id in hl ? 'hit' : ''} ${dim.includes(c.customer_id) ? 'dim' : ''}" style="filter:blur(${blurFor(c.stage)}px)">
      <h2>${c.name}</h2><div class="w">${c.worker} · ${c.invoice_count} invoices · ${c.pending_count ? c.pending_count + ' processing' : 'up to date'}</div>
      <div class="amt">${fmtEUR(c.open_amount)} open</div>
      <div class="latest">latest <b>${c.latest ? c.latest.invoice_no : '—'}</b> · <b>${fmtEUR(c.latest && c.latest.amount)}</b> · ${['received', 'rough', 'sharp'][c.latest ? c.latest.stage : 0] || 'coarse'}${c.overdue_count ? ` · <b>${c.overdue_count} overdue</b>` : ''}</div>
      <div class="ladder">${[1, 2, 3].map((r) => `<div class="rung ${c.rung >= r ? 'lit' : ''}"></div>`).join('')}</div>
      <div class="times">${[1, 2, 3].map((r) => `<span>${t[r] ? t[r] + 's' : ''}</span>`).join('')}</div>
      ${c.narrative ? `<div class="narr">${c.narrative}</div>` : ''}
      ${hl[c.customer_id] ? `<div class="match">matched ${hl[c.customer_id]}</div>` : ''}
      <div class="btns"><button data-act="remove" data-id="${c.customer_id}">Remove</button></div>
    </div>`;
  }).join('');
  $('#removed').innerHTML = removed.length ? 'removed (manager can\'t see): ' + removed.map((r) => `${r.name} · purge ${r.purge_at.slice(0, 10)} <button data-act="restore" data-id="${r.customer_id}">Restore</button>`).join(' · ') : '';
}
async function poll() {
  try {
    const over = $('#over').value; const d = await api(`customers?manager=${manager}${over ? '&overdue_gte=' + over : ''}`);
    fails = 0; $('#banner').style.display = 'none';
    const ev = diffCards(prev, d.cards); const now = Date.now();
    for (const e of ev) {
      if (e.rung_from === null || e.rung_to < (e.rung_from || 0)) litAt[e.customer_id] = { start: now };
      else if (e.rung_to > (e.rung_from || 0)) { const s = (litAt[e.customer_id] || { start: now }); s[e.rung_to] = ((now - s.start) / 1000).toFixed(1); if (!$('#mute').checked) $('#chime').play().catch(() => {}); }
    }
    prev = d.cards; render(d.cards, d.removed);
    $('#badge').textContent = `${d.latency_ms} ms qdrant · ${d.rtt_ms} ms round trip · cloud`;
  } catch (e) { if (++fails >= 3) $('#banner').style.display = 'block'; }
}
$('#q').oninput = async () => {
  const q = $('#q').value.trim();
  if (!q) { searchState = null; $('#nomatch').style.display = 'none'; render(prev, []); return; }
  const d = await api(`search?manager=${manager}&q=${encodeURIComponent(q)}`);
  searchState = applySearch(prev, d.results); $('#nomatch').style.display = searchState.noMatches ? 'block' : 'none';
  $('#badge').textContent = `${d.latency_ms} ms qdrant · ${d.rtt_ms} ms round trip · search`; render(prev, []);
};
$('#over').oninput = poll;
document.body.onclick = async (e) => {
  const act = e.target.dataset.act; if (!act) return;
  await fetch(`${CONFIG.base}/webhook/customers/${act}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manager, customer: e.target.dataset.id }) });
  poll();
};
tabs(); poll(); setInterval(poll, 2000);
</script></body></html>
```

Generate the chime once: `python3 -c "import wave,struct,math; w=wave.open('dashboard/chime.wav','w'); w.setparams((1,2,22050,0,'NONE','')); [w.writeframes(struct.pack('<h',int(8000*math.sin(2*math.pi*f*i/22050)))) for f in (660,880,1100) for i in range(2200)]; w.close()"`

- [ ] **Step 6: Manual check**

Serve: `python3 -m http.server 8000 -d dashboard` and open `http://localhost:8000`. Enter the n8n base URL. Expected: Anna's cards appear with the ladder; switch to Ben, acme under Tom is gone; type `servers`, acme rings and shows `matched INV-4711 · Hetzner servers`; type `zebra`, "no matches" shows and no card dims; type 10000 in "overdue over", two cards remain. Submit `delta-001.pdf` with `w_jules` from the Form, switch to Ben: delta's card appears blurry and sharpens within 40 s with three timer values and (unmuted) three chimes; delta's English-format amount parses right at the coarse stage, so no flip there. To see the `€12.30` → `€12,300.00` flip, delete acme's rows from both tables and resubmit `acme-001.pdf`.

- [ ] **Step 7: Commit**

```bash
git add dashboard
git commit -m "feat(dashboard): static manager dashboard with blur ladder, search, filter, removed tray

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Workflow 05 Dashboard Writes

**Files:**
- Create in n8n Cloud: `05 Dashboard writes`
- Export: `workflows/05-dashboard-writes.json`
- Test: curl plus `check_point.sh`

**Interfaces:**
- Consumes: `03 Rebuild point`.
- Produces: `POST <N8N_BASE_URL>/webhook/customers/remove` and `.../customers/restore`, body `{manager, customer}` → `{ok: true, purge_at?}`.

- [ ] **Step 1: Build** (7 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | Remove a customer | Webhook POST, path `customers/remove`, Respond: Using Respond node, Allowed Origins `*` |
| 2 | Restore a customer | Webhook POST, path `customers/restore`, same |
| 3 | Decide the new deleted_at | Code (both webhooks connect here): `const b = $json.body; const removing = $json.webhookUrl.endsWith('/remove'); const now = new Date().toISOString().replace(/\.\d{3}Z$/,''); return [{json:{manager_id: b.manager, customer_id: b.customer, deleted_at: removing ? now + 'Z' : '', purge_at: removing ? new Date(Date.now()+30*864e5).toISOString().slice(0,10) : null}}];` |
| 4 | Set or clear deleted_at | Data Table `customers` Update where `customer_id` equals and `manager_id` equals: `deleted_at` = `={{ $json.deleted_at }}` (empty clears) |
| 5 | Rebuild the point | Execute Sub-workflow `03 Rebuild point`, wait on |
| 6 | Respond | Respond to Webhook JSON `={{ {ok: true, purge_at: $('Decide the new deleted_at').first().json.purge_at} }}`, CORS header |

- [ ] **Step 2: Test**

```bash
B=$N8N_BASE_URL/webhook
curl -s -X POST "$B/customers/remove" -H 'content-type: application/json' -d '{"manager":"m_anna","customer":"acme"}'
qdrant/check_point.sh m_anna acme 'assert "deleted_at" in p, p; print("point keeps deleted_at")'
curl -s "$B/customers?manager=m_anna" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert "acme" not in {c["customer_id"] for c in d["cards"]}; assert d["removed"][0]["customer_id"]=="acme" and d["removed"][0]["purge_at"]; print("hidden, in tray")'
curl -s -X POST "$B/customers/restore" -H 'content-type: application/json' -d '{"manager":"m_anna","customer":"acme"}'
qdrant/check_point.sh m_anna acme 'assert "deleted_at" not in p, p; print("restored")'
```

Expected: four confirmations. In the browser (Task 9), Remove on acme moves it to the tray within 2 s, Restore brings it back.

- [ ] **Step 3: Export, scrub, commit**

```bash
git add workflows/05-dashboard-writes.json
git commit -m "feat(n8n): remove and restore webhooks with soft delete

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Workflow 06 Purge

**Files:**
- Create in n8n Cloud: `06 Purge`
- Export: `workflows/06-purge.json`
- Test: manual run with a backdated row

**Interfaces:**
- Consumes: Qdrant delete-by-filter body from Task 2 step 5.

- [ ] **Step 1: Build** (6 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | Every night at three | Schedule Trigger, daily 03:00 |
| 2 | Config | `QDRANT_URL`, `COLLECTION`, `MANAGERS` |
| 3 | One item per manager | Code: `const cutoff = new Date(Date.now()-30*864e5).toISOString().replace(/\.\d{3}Z$/,'Z'); return Object.keys(JSON.parse($json.MANAGERS)).map(m => ({json:{manager_id: m, cutoff}}));` |
| 4 | Delete points removed over 30 days ago | HTTP Request POST `.../points/delete?wait=true`, body `={{ JSON.stringify({shard_key: $json.manager_id, filter: {must: [{key: 'deleted_at', range: {lt: $json.cutoff}}]}}) }}` |
| 5 | Delete their customer rows | Data Table `customers` Delete where `deleted_at` is before `={{ $('One item per manager').first().json.cutoff }}` (if the node lacks date comparison: Get rows with `deleted_at` not empty, filter in a Code node by `< cutoff`, then Delete by `customer_id` + `manager_id`) |
| 6 | Delete their invoice rows | Data Table `invoices` Delete where `customer_id` and `manager_id` match each row from node 5 |

Sticky: "Never run live at the booth. One sentence: purged at 30 days, PDFs stay in storage for tax retention."

- [ ] **Step 2: Test**

Create a throwaway customer by hand in the `customers` table: `zombie`, `w_tom`, `m_anna`, `deleted_at` = 40 days ago; run `03 Rebuild point` for it once so a point exists (add one invoice row too). Run `06 Purge` manually.

Run: `qdrant/check_point.sh m_anna zombie` → Expected: `AssertionError: no point`. The two tables no longer contain `zombie`. `qdrant/check_point.sh m_anna acme 'print("acme survives")'` → prints.

- [ ] **Step 3: Export, scrub, commit**

```bash
git add workflows/06-purge.json
git commit -m "feat(n8n): nightly purge of soft-deleted customers after 30 days

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Full Corpus Ingest and Rehearsal Checks

**Files:**
- Create: `qdrant/corpus_check.sh`
- Test: the script

- [ ] **Step 1: Reset and ingest**

Delete all rows in both Data Tables (UI). Recreate the collection: `qdrant/setup.sh` after `q DELETE /collections/customers` (run `. qdrant/lib.sh` first with `.env` sourced). Submit all 14 samples through the Form, 40 s apart, with the worker from `samples/manifest.json`. Skip `beta-004.pdf` for the corpus (it's the live duplicate moment).

- [ ] **Step 2: Write `qdrant/corpus_check.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"; set -a; [ -f ../.env ] && . ../.env; set +a
B=$N8N_BASE_URL/webhook
python3 - "$B" <<'PY'
import json, sys, urllib.request
B = sys.argv[1]
get = lambda p: json.load(urllib.request.urlopen(f"{B}/{p}"))
m = json.load(open('../samples/manifest.json'))
exp = {}
for r in m:
    if r.get('duplicate_of'): continue
    exp.setdefault(r['customer'], []).append(r)
anna = get('customers?manager=m_anna'); ben = get('customers?manager=m_ben')
cards = {c['customer_id']: c for c in anna['cards'] + ben['cards']}
assert set(cards) == set(exp), (set(cards), set(exp))
for cid, rows in exp.items():
    c = cards[cid]
    assert c['invoice_count'] == len(rows), (cid, c['invoice_count'], len(rows))
    assert c['stage'] == 2 and c['rung'] == 3 and c['pending_count'] == 0, (cid, c['stage'], c['rung'], c['pending_count'])
    exp_open = round(sum(r['expected_amount'] for r in rows if r['status'] != 'paid'), 2)
    assert abs(c['open_amount'] - exp_open) < 0.01, (cid, c['open_amount'], exp_open)
assert {c['customer_id'] for c in anna['cards']} == {'acme', 'beta', 'gamma'}
assert {c['customer_id'] for c in ben['cards']} == {'delta', 'eps', 'zeta'}
f = get('customers?manager=m_anna&overdue_gte=10000')
assert {c['customer_id'] for c in f['cards']} == {'acme', 'beta'}, f
for term, want in [('servers', {'acme'}), ('consulting', {'beta'}), ('licenses', {'acme', 'gamma'})]:
    r = get(f'search?manager=m_anna&q={term}')
    got = {x['customer_id'] for x in r['results'] if x['matched_line']}
    assert got == want, (term, got, want)
    assert r['latency_ms'] < 500, (term, r['latency_ms'])
print('CORPUS OK')
PY
```

- [ ] **Step 3: Run**

Run: `chmod +x qdrant/corpus_check.sh && qdrant/corpus_check.sh`
Expected: `CORPUS OK`. A failing `open_amount` means the vision model misread one invoice: open that invoice's row, read `llm_fields`, and either fix the sample text (make the amount unambiguous) or accept the drift and update `expected_amount` in `gen.py` with a comment. A failing search term means line items need a more distinctive word; edit `gen.py`, regenerate, re-ingest that customer.

- [ ] **Step 4: Commit**

```bash
git add qdrant/corpus_check.sh
git commit -m "test: full corpus check against the dashboard endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: README, Booth Script, and Printed Cards

**Files:**
- Create: `README.md`, `booth/script.md`, `booth/cards.md`
- Test: `grep` checks for forbidden words and the three required blocks

- [ ] **Step 1: Write `README.md`** with these sections, in this order, Title Case headings, no em dashes

```markdown
# Invoice Memory

Pick an invoice PDF. Two seconds later the manager's dashboard has an answer. A worse answer, then a better one, then a summary.

[GIF: one card going from blurred to sharp, amount flipping from €12.30 to €12,300.00]

One Qdrant point per customer, rebuilt in stages from an append-only log in n8n Data Tables. Three vectors on the point, embedded inside Qdrant Cloud Inference. A static dashboard that polls n8n webhooks. Built for the Qdrant booth at n8n In The Loop 2026, Berlin.

## Eight Primitives, One Request

<the exact JSON from spec section 11 and the eight-row table under it>

## Setup in Three Steps

1. Create a free Qdrant Cloud cluster with Inference enabled. Copy `.env.example` to `.env`, fill it in, run `qdrant/setup.sh`, then `qdrant/smoke.sh`.
2. In n8n Cloud create two credentials: `Qdrant api-key` (Header Auth, header `api-key`) and `OpenRouter bearer` (Header Auth, header `Authorization`, value `Bearer <key>`). Create the two Data Tables as listed in `docs/superpowers/specs/2026-10-09-invoice-memory-design.md`, section 4.
3. Import the six JSON files from `workflows/`, open the `Start here` sticky in `01 Ingest`, set the `Config` values, activate all six. Open `dashboard/index.html` from any static server and enter your n8n base URL.

## What Each Workflow Does
<one line each for 01, 02, 02b, 03, 04, 05, 06>

## What Leaves Your Canvas
<the six feature one-liners from spec section 12>

## Why Not the Qdrant Vector Store Node
<the one sentence from spec section 12>

## Known Limits
- Coarse stage reads German number formats wrong on purpose. The vision stage fixes it.
- Two uploads for the same customer in the same second: later rebuild wins, both saw all rows, converges on the next stage.
- `digest` truncates past roughly 30 invoices per customer.
- The matched line in search is picked by token overlap in a Code node; MaxSim doesn't report which vector won.
- Anonymizing payloads at seven days is not built; purge at 30 days is.
- Synthetic invoices only. The Form has no file field. To accept uploads, add a File field and delete `Download the chosen sample`.
- The PDF itself stays wherever you store it; accounting retention outlives a GDPR removal of the searchable record.

## Related
Clelia's talk and repo, Ewa's demos (links).
```

- [ ] **Step 2: Write `booth/script.md`** with the hook, the table setup, the six beats from spec section 10 (and the Edge closer only if the Edge plan ships), the tie-in sentence, and the two spoken feature lines.

- [ ] **Step 3: Write `booth/cards.md`**: A5 "Eight Primitives, One Request" front (the request) and back (the table plus deployment line), two manager name cards (Anna, Ben), the QR card text ("Scan. Pick an invoice. Watch the card on the big screen sharpen."), the Edge caveat line if built ("Qdrant Edge is in beta").

- [ ] **Step 4: Checks**

Run: `grep -nE '—|seamless|powerful|robust|cutting-edge|only Qdrant' README.md booth/*.md; echo "exit $?"`
Expected: no matches, `exit 1`.
Run: `grep -c 'exp_decay' README.md booth/cards.md`
Expected: `1` or more in each.

- [ ] **Step 5: Commit**

```bash
git add README.md booth
git commit -m "docs: README with the one-request exhibit, booth script, printed cards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Rehearsal and Recording Insurance

**Files:**
- Create: `booth/rehearsal.md` (timings log), `booth/insurance.mp4` (not committed; add to `.gitignore`)

- [ ] **Step 1: Three timed runs of the 60 s script.** Record start-to-finish seconds and the stage timers from the dashboard for each run in `booth/rehearsal.md`. If any run exceeds 75 s, cut the restore moment first, then the overdue filter, per the spec's cut order.

- [ ] **Step 2: Warm-up checklist** at the top of `booth/rehearsal.md`: `qdrant/smoke.sh` passes, `qdrant/corpus_check.sh` passes, one warm-up Form submission done, dashboard open on both screens with the chime unmuted on the presenter side, Qdrant Cloud dashboard tab open on the acme point with `deleted_at` scrolled to the top, phone hotspot tested.

- [ ] **Step 3: Record the full flow** with QuickTime screen recording, save as `booth/insurance.mp4`, bind it to a keyboard shortcut (Automator Quick Action or a Dock alias) and test the shortcut once.

- [ ] **Step 4: Commit**

```bash
echo 'booth/insurance.mp4' >> .gitignore
git add .gitignore booth/rehearsal.md
git commit -m "docs: rehearsal timings and warm-up checklist

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
