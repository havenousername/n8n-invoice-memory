# Invoice Memory: progressive per-customer memory in Qdrant, driven by n8n

Booth demo for n8n In The Loop 2026, Ecosystem Day, Berlin, 2026-10-14. Qdrant booth. Complements Clelia's stage talk "Building a Self-Healing Research Agent in n8n" (her loop: feedback → memory; this: events → memory).

Date: 2026-10-09, revised same day (manager tenancy, dashboard surface, search box, phone form, positioning, Edge stretch). Owner: Andrei. Build window: 5 days, one person.

## 1. Goal

Managers have workers. Workers have customers. In the motivating use case, a worker receives each invoice PDF a customer sends; the public booth Form selects synthetic PDFs. Qdrant holds one point per customer that gets sharper in stages as the PDF is processed, like a progressive JPEG. Managers watch a live dashboard: a customer card blurs the moment a new PDF lands and sharpens as each stage finishes, the rough amount correcting itself in place. Each manager sees only their workers' customers (tenant). Removal is a soft delete with a 30-day purge.

Audience: n8n builders. Not vector-DB experts. 60–90 s attention at a booth. Two screens.

Success at the booth:
- A passer-by understands "it answers before it finished reading" from the aisle screen with no words.
- Six beats land in 60 s: a visitor's phone makes a card go rough with "1 processing" and a wrong amount, search "servers" lights up the customers whose invoices mention servers with the matched line, overdue filter returns two customers with no similarity involved, switching manager hides a customer, the card sharpens and the amount corrects itself on its own, remove → Qdrant dashboard still shows the point with `deleted_at`, restore brings it back.
- Someone who asks "why Qdrant" gets one request body to read, not a claim to trust.
- A builder scans the QR and can import using documented Config, credential, Data Table, and sub-workflow binding steps.

## 2. Non-goals, killed on purpose

- Per-invoice points. One point per customer is the whole idea.
- CLIP or any visual embedding. "Visual" = a vision LLM reads the PDF and extracts fields.
- ColPali. Not on Cloud Inference.
- Chat interface. Managers don't chat with invoices. The dashboard is the manager surface.
- Per-customer queue or locking. Rebuild-from-log converges; flicker is acceptable.
- Anonymize-at-7-days as a live step. README line only.
- Real identity. Manager comes from a tab on the dashboard. Worker comes from a Form dropdown.
- File upload at the booth. The public Form picks from sample invoices; nobody can upload a real one.
- Competitor tables. Positioning is one request the audience can read, not a feature matrix.
- Attract loop and paper tray: optional extras, built only if hours remain.

## 3. Architecture

```
visitor phone ─QR─▶ Form ─▶ 01 Ingest ──async──▶ 02 Process ──▶ 03 Rebuild point ──▶ Qdrant `customers`
                                                  (invoice stages 0,1,2; narrative rung 3)      ▲                     │
manager ─browser─▶ dashboard/index.html ─GET/POST─▶ 04 Dashboard reads / 05 Dashboard writes ──┘ ─────────────────────┘
cron ──────────▶ 06 Purge                      (list, filter, search, remove, restore)
                 n8n Data Tables: `invoices` (processing ledger), `customers`
```

Source of truth = two n8n Data Tables. The Qdrant point is a materialized view rebuilt from them at every stage. Nothing patches the point in place. Rebuilds read current table state and replace the full view; they do not guarantee serial ordering across concurrent executions. A stale upsert can briefly win. Serialize booth submissions and run a manual rebuild after all overlapping executions settle if an overlap is tested. Retry failed executions explicitly. No automatic reconciliation or concurrency convergence guarantee is built.

Infra: n8n Cloud, Qdrant Cloud with Inference enabled and verified by the smoke gate, OpenRouter. Embeddings happen inside Qdrant Cloud Inference in the upsert and query bodies. No embedding nodes. The dashboard is one static page and testable JavaScript on the booth laptop, polling n8n webhooks. No keys in the page.

## 4. Data model

### 4.1 Entities

| entity | id | where it lives |
|---|---|---|
| manager | `m_<slug>` | `Config` node map, dashboard tabs |
| worker | `w_<slug>` | `Config` node map `worker_id → manager_id`, Form dropdown |
| customer | `<slug>` from filename prefix (`acme-2026-10-01.pdf` → `acme`) | Data Table `customers`, keyed by manager/customer, one Qdrant point |

A worker belongs to one manager. Tenant = `manager_id`.

### 4.2 Data Table `invoices` (processing ledger)

| column | type | notes |
|---|---|---|
| invoice_id | string | business key; Data Tables reserve their numeric `id` |
| customer_id | string | keyed together with manager_id |
| worker_id | string | from Form |
| manager_id | string | resolved from the worker map |
| pdf_hash | string | SHA-256 of binary; duplicate lookup is scoped by manager/customer |
| filename | string | |
| text | string | Extract from File output |
| stage | number | 0 received, 1 coarse, 2 sharp, -1 error; coarse fields are retained |
| regex_fields | string | JSON: invoice_no, date, due_date, amount, vendor |
| llm_fields | string | JSON: invoice_no, date, due_date, amount, vendor, customer_name, status, line_items_summary |
| error | string | last error message, empty if none |
| received_at | dateTime | |

### 4.3 Data Table `customers`

| column | type | notes |
|---|---|---|
| customer_id | string | keyed together with manager_id |
| worker_id | string | |
| manager_id | string | |
| name | string | display name, from first `llm_fields.customer_name`, else slug |
| deleted_at | dateTime | empty = live |
| narrative | string | rung-3 LLM summary, empty until first generated |
| narrative_at | dateTime | |
| narrative_revision | string | fingerprint of the exact invoice snapshot summarized; stale narratives are hidden |

### 4.4 Qdrant collection `customers`

```json
PUT /collections/customers
{
  "vectors": {
    "summary": {"size": 384, "distance": "Cosine"},
    "digest":  {"size": 96,  "distance": "Cosine",
                "multivector_config": {"comparator": "max_sim"}}
  },
  "sparse_vectors": {"bm25": {"modifier": "idf"}},
  "sharding_method": "custom"
}
PUT /collections/customers/shards   {"shard_key": "m_anna"}
PUT /collections/customers/shards   {"shard_key": "m_ben"}
```

One shard key per manager. Every upsert, query, scroll, and delete carries `shard_key: <manager_id>`. The payload tenant index stays as well: the shard is the physical unit (what a laptop replicates), the payload filter is the logical guard (what a query can see). If custom sharding is unavailable on the cluster (day-1 gate), recreate without custom sharding, remove shard creation and every shard_key selector, and rerun core smoke/tenant checks. The Edge stretch is cut; it cannot claim a manager-only replica.

Payload indexes:

| field | type | why |
|---|---|---|
| `manager_id` | keyword, `is_tenant: true` | tenancy |
| `worker_id` | keyword | dashboard grouping |
| `customer_id` | keyword | exact lookup |
| `deleted_at` | datetime | soft delete filter, purge |
| `last_invoice_at` | datetime | ordering, decay formula |
| `stage` | integer | badge, blur |
| `invoices[].status` | keyword | nested filter |
| `invoices[].amount` | float | nested filter |

Point ID: SHA-256 of `<manager_id>/<customer_id>`, first 32 hex formatted as a UUID with version nibble `4` and variant nibble `8`. The n8n Crypto node computes the hash; the Code node formats it. Deterministic and tenant scoped, so every rebuild overwrites the same point.

Payload:

```
manager_id, worker_id, customer_id, name,
stage            // min invoice stage with -1 mapped to 1 for coarse error display
pending_count    // invoices with stage in {0,1}
invoice_count, total_amount, open_amount, overdue_count, overdue_amount
last_invoice_at
latest           // {id: invoice_id, invoice_no, amount, stage} of newest invoice, for card/timer epoch
summary_stage    // 1 mechanical, 3 only for fresh narrative at stage 2 and pending_count 0
summary_text     // what the `summary` vector was embedded from
summary_generated_at
source_revision  // deterministic fingerprint of current invoice-state snapshot
deleted_at       // absent when live
invoices: [{id, invoice_no, date, due_date, amount, vendor,
            status: open|paid|overdue, stage: 0|1|2|-1, error}]
```

Vectors, all produced by Cloud Inference in the upsert body:

| vector | text source | model |
|---|---|---|
| `summary` | `narrative` only when its revision matches the current invoice snapshot and all invoices are sharp, else mechanical summary ("13 invoices, €84,200 open, 2 overdue, last 2026-10-09") | `sentence-transformers/all-minilm-l6-v2` |
| `digest` | one line per invoice, newline-joined: `INV-4711 | 2026-10-09 | 12300.00 EUR | due 2026-11-01 | overdue | Hetzner servers` | `answerdotai/answerai-colbert-small-v1` |
| `bm25` | all invoice `text` concatenated | `qdrant/bm25` |

Digest input is bounded by the chosen model token limit, verified at the day-1 gate. Invoice count is not a reliable token bound. Keep the synthetic corpus within the measured limit and document truncation; per-invoice embeddings are an upgrade path, outside this build.

Field values come from `llm_fields` when the invoice's stage ≥ 2, else `regex_fields`. That is what makes the amount visibly correct itself.

Rungs, used by the card ladder: rung 1 = `stage` 1 (coarse), rung 2 = `stage` 2 (sharp), rung 3 = `summary_stage` 3 (fresh narrative, with `stage` 2 and no pending invoices). New processing hides the previous narrative immediately. `stage` 0 shows as "received", blur 14px. Badge text: `rung <n>/3 · <pending_count> of <invoice_count> processing`.

The search box is the only place vectors run. List, filter, remove, restore are payload operations. That split is said out loud at the booth: "everything you saw until now was filters; this one is three vectors fused."

## 5. Workflows

Seven exported workflows: `01 Ingest`, `02 Process`, `02b Write the narrative`, `03 Rebuild point`, `04 Dashboard reads`, `05 Dashboard writes`, and `06 Purge`. The process/narrative and read/write splits keep canvases small. Target 12 nodes, hard cap 15, and four sticky notes per canvas. Trigger comes first, followed by Edit Fields `Config` (named distinctly on separate branches) with `QDRANT_URL`, `COLLECTION`, `OPENROUTER_MODEL`, `PDF_ENGINE`, worker/manager maps, and sample base URL. Credentials: Qdrant Header Auth (`api-key`) and OpenRouter Header Auth (`Authorization: Bearer ...`). No Variables, community nodes, Code-node npm imports, filesystem, or hardcoded deployment/credential IDs.

### 01 Ingest

Public Form fields are allowlisted sample and worker dropdowns, no file upload. Resolve manager/customer from trusted sample/worker metadata, validate the selection and ownership, download the synthetic sample, and hash with Crypto. Duplicate lookup uses `(manager_id, customer_id, pdf_hash)` and returns a safe duplicate message. Sequential booth submissions are supported; Data Tables lookup-then-insert is not an atomic uniqueness guarantee, so simultaneous identical submissions are a documented demo limitation unless the implementation's duplicate gate proves otherwise. Create/reuse the tenant-scoped customer row and append a stage-0 invoice ledger row. Call `02` with wait off, passing JSON `{invoice_id, customer_id, manager_id, sample_url}`, then finish the Form promptly. The process workflow downloads its own sample; no background binary handoff is assumed.

### 02 Process

Rebuild the received view first, download the allowlisted sample, extract text, compute coarse regex fields, save text/stage 1, and rebuild. Empty extraction yields null amount and a `?` digest line, not a crash. Send the PDF to the pinned OpenRouter model with the gated PDF engine and JSON response format. Validate dates/status and normalize amount strings before persisting stage 2 and rebuilding. If extraction/vision/validation fails, persist stage -1 and the error, retaining coarse fields; rebuild the error view and make the failed execution visible. The German coarse parser is deliberately naive for the synthetic correction beat. Do not send NaN into aggregates.

Call `02b` after successful sharpening. Completion/failure paths rebuild; failed writes remain explicitly retryable. Concurrent full-view upserts may flicker; no per-customer locks are introduced.

### 02b Write the narrative

Load the manager/customer's current invoice snapshot, compute its deterministic revision, and generate three sentences from digest lines and aggregates. Persist narrative, timestamp, and the exact snapshot revision, then rebuild. Rung 3 is eligible only when the stored revision equals current state, stage is 2, and pending count is zero. A response from an older snapshot may be stored but cannot appear as a fresh summary. Failure keeps the mechanical summary/rung 2 and is visible; stage 3 is a display rung, not an invoice-table stage.

### 03 Rebuild point

Load the tenant-scoped customer and invoice rows, compute aggregates/digest/mechanical summary/latest/stage/pending/revision, carry soft-delete state, choose only a fresh narrative, compute the deterministic tenant-scoped UUID via Crypto, and full-upsert all three inference vectors plus payload with `wait=true`. Monetary aggregates exclude missing/nonfinite amounts. Rebuilding the same snapshot is idempotent; concurrent different snapshots require serialized booth use or the manual rebuild described above.

### 04 Dashboard reads

Two GET triggers, explicit validation/error responses and CORS for the local dashboard. Allowlist managers; parse optional overdue threshold as a finite nonnegative number, reject invalid input. Every Qdrant read carries shard selection and tenant payload filtering; every search prefetch repeats the live tenant guard.

- `GET /customers?manager=m_x[&overdue_gte=10000]` returns `{cards: Card[], removed: Removed[], latency_ms}`. Live scroll uses `is_empty deleted_at`, indexed descending `last_invoice_at`, and an optional nested invoice filter pairing overdue status with amount >= threshold in the same invoice. A separate removed scroll is tenant scoped and deliberately unaffected by the overdue/search controls. Card includes customer/name/worker, stage/rung/counts, monetary aggregates, `latest.id` and fields, fresh narrative, and delete state. Removed rows include `customer_id`, name, and `purge_at`. Limit 50 is a synthetic-corpus ceiling; no production pagination claim.
- `GET /search?manager=m_x&q=servers` returns `{results: [{customer_id, score, matched_line}], latency_ms}`. Execute section 11's three-vector query. Token overlap against structured invoice line summaries supplies the explanatory snippet. The demo admits only candidates with a lexical matched line; unrelated queries return an empty result list. This conservative snippet gate is application behavior, not evidence that semantic/RRF scores establish relevance or MaxSim returns a winning line. Clearing the browser query clears search locally without inference; empty, malformed, or oversized API query input is rejected with 400.

`latency_ms` measures n8n wall time around the Qdrant request(s), including transport/inference, excluding unrelated workflow setup. List measurement spans both live and removed requests. Do not label Qdrant's server-only `time` as end-to-end latency. Targets of 300/500 ms are rehearsal goals, not product claims.

### 05 Dashboard writes

Two POST paths, `/customers/remove` and `/customers/restore`, with body `{manager, customer}`. Resolve action from the matched trigger, not client-controlled webhook URL text. Validate manager/action/customer and lookup by both manager and customer. Set/clear `deleted_at`, invoke rebuild, and return `{ok: true, purge_at}` for remove or `{ok: true}` for restore only after the table change and rebuild succeed. Invalid/missing targets and upstream failures return non-2xx JSON errors. No optimistic success response on failed Qdrant writes. The demo has no real authentication and contains synthetic data only; manager selection illustrates partitioning, not an authorization boundary.

Cross-origin JSON writes require an OPTIONS preflight response for the write path, advertising POST and Content-Type. Test this from the served localhost dashboard, not just curl.

### 06 Purge

Daily schedule captures the expired customer identity set scoped per manager at a fixed cutoff. Delete matching Qdrant points with the same tenant/cutoff guard, then invoice rows for captured manager/customer pairs, then customer rows. Check success at every step; retries use the remaining source rows and same keys. Never delete the customer rows before collecting identities needed to delete invoices. Booth maintenance does not race restores/ingest with purge; stronger transactional guarantees are outside this synthetic demo.

## 6. Dashboard (`dashboard/index.html` + `app.js`)

Static page and testable controller/helpers, served from localhost; no build step or API keys. Validated n8n base URL is local configuration. Manager tabs, worker-grouped live card grid, search, overdue control, independent removed tray, and mute toggle make up the surface.

Each card shows customer/worker, counts, open amount, latest invoice, rung ladder, observed rung timers, optional current narrative/matched line, and Remove. Blur the content region (14/5/0 px at stages 0/1/2), keeping controls usable. A new invoice resets the progress epoch and hides stale narrative. Timers freeze when observed rungs light; initial ready cards have unknown elapsed durations. Polling can skip stages, so neither three chimes nor backend-accurate timing is guaranteed. The corrected amount updates in place.

Poll every two seconds after the previous request settles; no overlapping interval requests. Manager/filter/source generations and per-query sequence guards reject obsolete list/search/error/write responses even if abort races. Switching tenant clears the old grid, removed tray, rings, and timers immediately, then refetches that tenant; keep query text but rerun it. Same-context failures retain the last accepted cards. Three failed list polls show an offline banner; aborts/stale requests do not count.

Search debounces 200 ms, has distinct pending/error/no-match states, intersects API-admitted results with visible live cards, and reruns on the poll cadence. Clearing query clears rings without losing the removed tray. Zero visible hits means no-match with no dimming. The overdue filter validates a finite nonnegative threshold and operates only on live cards; its label says "payload filter, no similarity". Search says "three vectors, one request", with the documented lexical snippet gate.

Check HTTP status and response shape for every read/write, bound hung requests with timeouts, and surface failures. Capture manager/customer/action at click time, prevent duplicate writes, and refresh only after success; a late write result cannot mutate a different tenant. Render untrusted text with `textContent`, never HTML interpolation. The latency badge separates backend `latency_ms` and browser RTT and labels the operation/source. Chimes default muted and audio playback rejection is handled.

Edge stretch adds source selection and manager-scoped replica health. Auto fallback requires three current Cloud failures and a ready local replica for the selected manager; Local success does not reset Cloud failures. Only a successful validated Cloud probe returns automatic mode to Cloud; manual Local stays Local. Source changes invalidate/reissue reads, query, and filter. Writes are disabled when reading Local, with "writes need the cloud". See the separate Edge plan for exact source-mode/UI contracts.

Both screens show this page. Presenter-side also has the Qdrant dashboard and n8n canvas ready for the cutaway.

## 7. Synthetic data

`samples/`: 2 managers, 4 workers, 6 customers, 14 invoice PDFs. Fake companies, fake addresses, EUR. Two invoices use German number format (`12.300,00 €`) so the coarse stage is visibly wrong. One pair is a byte-identical duplicate for the "that's INV-4711 again" moment. Statuses mixed so the overdue filter returns 2 of 6. Line items chosen so three search terms each hit one or two customers and no others: servers, consulting, licenses.

Generation: `samples/gen.py` (stdlib only) writes HTML invoices; `samples/print.sh` prints them to PDF with headless Chrome. No pip.

Run full-corpus acceptance first, then reset the acme demo rows/point and reseed only acme-002 and acme-003. Reserve acme-001 for the live German correction beat; its fresh received_at makes it the latest despite its older document date. If delta is used for a separate demo, clear its synthetic rows/point first. Preingesting every unique PDF without this reset would turn the booth submission into a duplicate. Use a documented synthetic reset/reseed procedure between rehearsals, never ad hoc row deletion at the booth. Visitors select samples; nobody uploads files.

## 8. Error handling and guardrails

| failure | behavior |
|---|---|
| vision LLM timeout or bad JSON | invoice is stage -1 with coarse fields retained, `error` set, card stays half-blurry, rung 2 never lights, demo continues |
| narrative LLM fails | point stays rung 2, mechanical summary, no rung 3 chime |
| duplicate sample submission | scoped hash hit, Form Ending says so; concurrent lookup/insert limitation is documented |
| two uploads same customer | tenant-scoped rows are retained; stale upserts may flicker; serialize booth submissions or manually rebuild after overlapping executions settle |
| wifi blip mid-stage | execution errors, point stays at last completed stage, n8n Retry re-runs, rebuild is idempotent |
| Cloud Inference cold | one warm-up upsert at booth open |
| dashboard polling fails | offline banner, last cards stay |
| OpenRouter down | recorded 60 s flow bound to one key |

Nothing is swallowed. Failed executions stay visible in n8n.

## 9. GDPR semantics

- Remove: `deleted_at` on the customers row, rebuild. Dashboard list filters `is_empty deleted_at`. Qdrant dashboard still shows the point.
- Restore: clear it, rebuild. Shown on stage, ten seconds.
- Purge: 06, captured tenant-scoped identities and guarded Qdrant delete at 30 days, then invoices and customers.
- Anonymize at 7 days: README line, not built.
- Synthetic PDFs remain repository samples. Production accounting-record retention needs deployment-specific policy; no compliance guarantee or real storage integration is implemented. An optional disabled storage stub is instructional only.

## 10. Booth

Hook, spoken to the aisle: "It answers before it's finished reading. Watch it sharpen."

On the table: QR to the Form (pick a sample invoice, pick a worker), QR to the repo, printed cards (section 11).

60-second script:
- 0:00 hook. "Scan that, pick an invoice." Visitor's phone submits. Card goes blurry.
- 0:08 card: `INV-4711 · €12.30 · rough · 1 of 13 processing`. "Regex. Wrong. Two seconds old. The manager already has it."
- 0:16 type "servers" in search. Two cards light up with `matched INV-4711 · Hetzner servers`. "Three vectors fused in one request: keywords, invoice lines, summary. Latency's on the badge."
- 0:26 clear search, type 10000 in "overdue over". Two cards stay. "No vectors. Nested filter on the invoices inside the point."
- 0:34 click the other manager's tab. Acme under Tom is gone; switch back to Anna for the remaining beats. "Same collection. One filter on `manager_id`. Tenancy is a payload field, the index knows it."
- 0:42 observed stage change chimes, card snaps sharp, `€12,300.00`; narrative appears when its separate fresh-summary stage completes. "Vision model finished. Same card, corrected in place. Nobody re-asked."
- 0:50 Remove Acme. Card gone, in the removed tray with the purge date. Alt-tab to the Qdrant dashboard: point still there, `deleted_at`. Restore. Back.
- 0:58 "Seven workflows, one collection. The request is on the card. Want the JSON?"
- Edge stretch, only if built, as the closer at 1:00: switch the laptop's wifi off. Badge shows the measured local latency. Same list, same filter, same search. "Her laptop holds a snapshot of her shard. Only hers. Same engine, in-process, no server. Qdrant Edge." Wifi on, next sync pulls the invoice that landed meanwhile, the next accepted replica state appears; the sync interval may skip intermediate stages.

Tie-in, once: "Clelia's agent learns from corrections; this one learns from events. Same collection, same loop."

Insurance: full flow recorded on day 5, bound to one key.

## 11. Why Qdrant, Specifically

House rule: never say "only Qdrant can do this". Say "in one request" and hand them the request. Composable means retrieval primitives combined at query time; this demo's proof is that the search box is one body. Competitors are not named on cards or in the README. If a visitor names one, answer with the capability, not the vendor.

The exhibit, printed on an A5 card and in the README under "Eight Primitives, One Request":

```json
POST /collections/customers/points/query
{
  "shard_key": "m_anna",
  "prefetch": {
    "prefetch": [
      {"query": {"nearest": {"text": "servers", "model": "qdrant/bm25"}},
       "using": "bm25", "limit": 20, "filter": {"must": [
         {"key": "manager_id", "match": {"value": "m_anna"}},
         {"is_empty": {"key": "deleted_at"}}]}},
      {"query": {"nearest": {"text": "servers", "model": "answerdotai/answerai-colbert-small-v1"}},
       "using": "digest", "limit": 20, "filter": {"must": [{"key": "manager_id", "match": {"value": "m_anna"}}, {"is_empty": {"key": "deleted_at"}}]}},
      {"query": {"nearest": {"text": "servers", "model": "sentence-transformers/all-minilm-l6-v2"}},
       "using": "summary", "limit": 20, "filter": {"must": [{"key": "manager_id", "match": {"value": "m_anna"}}, {"is_empty": {"key": "deleted_at"}}]}}
    ],
    "query": {"rrf": {}},
    "limit": 20
  },
  "query": {"formula": {"sum": ["$score", {"mult": [0.1,
    {"exp_decay": {"x": {"datetime_key": "last_invoice_at"},
                   "target": {"datetime": "2026-10-14T00:00:00Z"},
                   "scale": 2592000, "midpoint": 0.5}}]}]}},
  "filter": {"must": [{"key": "manager_id", "match": {"value": "m_anna"}}, {"is_empty": {"key": "deleted_at"}}]},
  "limit": 5,
  "with_payload": true
}
```

Count, printed under it:

| # | primitive | what it replaces in your workflow |
|---|---|---|
| 1 | tenant filter on an `is_tenant` index | a Switch node routing to one collection per manager |
| 2 | `is_empty` on `deleted_at` | a second "deleted customers" list you have to subtract |
| 3 | sparse BM25 vector | an Elastic index next to your vector store |
| 4 | ColBERT multivector, MaxSim | one point per invoice and a dedupe-by-customer Code node |
| 5 | dense summary vector | the thing you already have |
| 6 | server-side inference, three models | three embedding nodes and their API keys |
| 7 | RRF fusion | a Merge node and a Sort node |
| 8 | formula with datetime decay | a Sort node after fetching everything |

Plus, outside this request: nested filter on `invoices[]` (the overdue control), delete by filter (purge), full upsert with inference (rebuild).

Speed: no number is claimed. The latency badge shows `latency_ms` on every request, measured in n8n around the Qdrant call, with the browser round-trip beside it. If someone asks "is it fast", point at the badge. The tenant index supports tenant-filtered vector retrieval; ordered payload-scroll scaling is not established by this demo. Do not claim flat list latency as customer count grows.

Anchor for anyone writing copy: composability (primitives at query time), performance via filtrable HNSW and the tenant index, built in-house in Rust. Deployment flexibility (cloud, BYOC, on-prem, edge, air-gapped) goes on the card's back, not in the 60 s.

## 11b. Stretch: Qdrant Edge Replica for the Traveling Manager

Stretch only, governed by `docs/superpowers/plans/2026-10-09-invoice-memory-edge.md`. The story is a read-only local replica of one manager's shard, updated while connected and searchable while offline. No unconditional claim that sharing model names proves identical preprocessing, sparse weighting, retrieval APIs, or inference parity.

Day-1 gates separately establish custom shard snapshot selection, full restore, partial snapshot application (including upsert/soft-delete/purge), exact local read/query support including nested filters/multivector/RRF/formula, model dimensions and preprocessing parity, and an offline restart with downloaded models cached. Prove local BM25 compatibility with cloud-written vectors. A same-manager synthetic result comparison is required. Partial update support is required for this stretch; failure cuts it rather than silently substituting full downloads every cycle. If required query parity fails, cut the Edge stretch; do not silently simplify its search behavior.

Sidecar binds localhost, holds one configured manager, exposes dashboard-compatible read envelopes and `/health` with `{manager, read_ready, search_ready, last_sync, last_error}`. On offline startup, load the saved valid snapshot generation first, then initialize `query_embed` from already cached models/assets. Reject other managers. Build a candidate snapshot off to the side, validate, then replace the active read state atomically; failures keep the last known valid replica. Full restore/update latency determines the honest staleness banner. Models must be warm and cached before wifi is disabled.

The source selector separates chosen mode from active source. Automatic Local fallback requires local readiness; successful Local reads cannot imply Cloud recovery. Cloud probes with timeout/backoff alone return automatic mode to Cloud. Manual Local remains Local. All source changes invalidate old request generations and reapply query/filter. Remove/Restore stay disabled on Local; writes remain a Cloud-only operation. Missing manager replicas show an unavailable state, never another manager's data.

Cloud `latency_ms` spans n8n Qdrant HTTP calls; Local `latency_ms` measures Qdrant execution only, with query embedding and HTTP/RTT reported separately. Label these scopes explicitly and do not compare them as equivalent clocks. Demo numbers are measured, not a fixed "2 ms" promise. Show replica age and source, explain stale/offline limitations, and rehearse loss/recovery while list/search requests are in flight. Purges and soft deletes arrive through verified snapshot updates; this is a synthetic read-replica demo, not a deletion-compliance guarantee.

## 12. Repo

```
n8n-invoice-memory/
  README.md                  hook, 3-step setup, GIF of a card sharpening, feature one-liners
  scripts/                   Python 3.11+ stdlib only, unittest beside each module (rules: plan, Script Rules)
    setup_collection.py      create or verify the collection, shard keys, and indexes, idempotent
    bodies.py                reference Qdrant request bodies the workflows rebuild
    smoke.py                 every request shape against a disposable collection
    check_point.py, reads_check.py, writes_check.py, corpus_check.py, openrouter_check.py
  workflows/01-ingest.json … 06-purge.json (including 02b narrative)
  dashboard/index.html, app.js, app.test.js
  samples/gen.py, print.sh, *.pdf
  edge/sidecar.py, edge/requirements.txt   (stretch)
  booth/script.md, booth/cards.md
  docs/superpowers/specs/
```

README hook: "Pick an invoice PDF. Two seconds later the manager's dashboard has an answer. A worse answer, then a better one, then a summary." Second section of the README is "Eight Primitives, One Request" with the body from section 11.

Setup: (1) create a gated Qdrant Cloud cluster and run `python3 scripts/setup_collection.py`; (2) create two credentials and the two Data Tables; (3) import workflows in dependency order (03, 02b, 02, 01, 04, 05, 06), rebind credentials/table/sub-workflow selections, configure worker/manager maps and URLs, activate triggers, select a reserved sample in the Form, and serve/configure the localhost dashboard. Triggers ship with pinned data so an opened workflow shows items before any credential exists.

Printed cards: A5 "Eight Primitives, One Request" (request on the front, table on the back), two manager name cards, the QR card. Feature one-liners (README and the card's back, presenter speaks two):
- Tenant index: one collection, no Switch node routing to five credentials.
- Nested filter: match a customer by one invoice's fields without pulling 400 invoices into a Code node.
- Multivector: one point per customer that still matches a single invoice line.
- Cloud Inference: deletes the embeddings node and its API key.
- Soft delete + delete by filter: reversible hiding and scheduled synthetic-data cleanup.
- Formula decay: freshness ranking happens in the query, not in a Sort node after you fetched everything.

Answer to "why not the Qdrant Vector Store node": "Right default for one-vector-per-chunk RAG. This needs three named vectors on one point, nested filters and server-side embedding, which is a REST body, so it's one HTTP Request with the same credential."

## 13. Verification

Day-1 checks, each can change the plan:
- `scripts/smoke.py` passes on a disposable collection: custom sharding and shard keys accepted, inference models accepted in upsert (`summary`, `digest` as multivector, `bm25`), nested filter on `invoices[]` returns the seeded point and rejects a decoy whose conditions hold on different invoices, the other manager's same-slug point stays isolated, soft delete, restore, and purge by filter behave, the section 11 request returns it with inference inside `prefetch` and the formula on the indexed datetime.
- Pinned OpenRouter model accepts PDF file input and `response_format` JSON. Selection rule: cheapest mid-tier model on openrouter.ai/models that lists both; if none, stage 2 reads extracted text instead of the PDF and the "visual" claim is dropped.
- Data Tables and required column/update/filter operations are available on the n8n Cloud plan. An alternative store requires an explicitly revised/tested plan; Google Sheets is not a drop-in fallback.
- Execute Sub-workflow with wait off returns the Form Ending promptly and the child can independently download the sample from its JSON inputs; measure the under-2-second target.
- `GET /customers` under 300 ms and `GET /search` under 500 ms with the full sample corpus, recording measured n8n wall latency rather than assuming the targets pass.
- Edge gate (`edge/gate.py`, section 11b) passes or the stretch is cut on day 1, not day 4.

Per-workflow test matrix: every If branch and every webhook path run once with real data, screenshot of the dashboard for each. Full 60 s rehearsal three times on day 5, timed.

Runnable checks include `scripts/smoke.py`, the `scripts/` unit tests, pure Code-node tests, dashboard controller tests, real webhook checks, and browser race/error/CORS rehearsal. Cloud/Edge gates remain external acceptance checks.

## 14. Build order and cuts

Order: smoke.py and the Edge gate → collection → 03 Rebuild → 01 + 02 + 02b → samples/background seed with reserved live samples → 04 reads → dashboard → 05 writes → 06 purge → cards + README → [day 4: Edge sidecar + source switch] → rehearsal + recording.

Rough 45 h core, 55 h with the Edge stretch. Cuts in order if slipping: Edge stretch, attract loop, paper tray, chime, matched-line highlight (keep the card ring), narrative stage, restore moment. Not cut: the search box, it's the vector beat.

## 15. Assumptions

- Qdrant Cloud cluster has Inference enabled and the three hosted models listed above, and accepts custom sharding on a single node.
- n8n Cloud plan has Data Tables with sufficient configured storage for this synthetic corpus and allows Execute Sub-workflow without waiting.
- Booth wifi works; phone hotspot as backup.
- Nobody at the booth uploads a real invoice. Form page says "synthetic data only".
