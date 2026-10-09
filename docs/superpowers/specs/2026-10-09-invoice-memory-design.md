# Invoice Memory: progressive per-customer memory in Qdrant, driven by n8n

Booth demo for n8n In The Loop 2026, Ecosystem Day, Berlin, 2026-10-14. Qdrant booth. Complements Clelia's stage talk "Building a Self-Healing Research Agent in n8n" (her loop: feedback → memory; this: events → memory).

Date: 2026-10-09. Owner: Andrei. Build window: 5 days, one person.

## 1. Goal

A worker uploads invoice PDFs. A manager asks questions in a chat. Qdrant holds one point per customer that gets sharper in stages as the PDF is processed, like a progressive JPEG. The manager never waits: the answer arrives rough in seconds and corrects itself when processing finishes. Customers are split by department (tenant). Removal is a soft delete with a 30-day purge.

Audience: n8n builders. Not vector-DB experts. 60–90 s attention at a booth. Two screens.

Success at the booth:
- A passer-by understands "it answers before it finished reading" from the aisle screen with no words.
- Four moments land in 60 s: rough answer with "N processing", nested-filter answer, department switch hides a customer, remove → dashboard still shows the point with `deleted_at`, restore brings it back.
- A builder scans the QR and the import works on their n8n Cloud without edits beyond two credentials.

## 2. Non-goals, killed on purpose

- Per-invoice points. One point per customer is the whole idea.
- CLIP or any visual embedding. "Visual" = a vision LLM reads the PDF and extracts fields.
- ColPali. Not on Cloud Inference.
- Per-customer queue or locking. Rebuild-from-log converges; flicker is acceptable.
- Anonymize-at-7-days as a live step. README line only.
- Open-web research for unknown questions. Manager chat answers from the collection only.
- Custom frontend beyond one static HTML page (the blur card).
- Real identity. Department comes from which chat URL you use.
- Attract loop and paper tray: optional extras, built only if hours remain.

## 3. Architecture

```
worker ──Form──▶ 01 Ingest ──async──▶ 02 Process ──▶ 03 Rebuild point ──▶ Qdrant `customers`
                                      (stage 0,1,2)       ▲                       │
manager ─Chat──▶ 04 Manager chat ────────────────────────┘ (stage 3, remove, restore)
cron ──────────▶ 05 Purge                                                         │
blur page ─GET─▶ 06 Stage webhook ────────────────────────────────────────────────┘
                 n8n Data Tables: `invoices` (append-only log), `customers`
```

Source of truth = two n8n Data Tables. The Qdrant point is a materialized view rebuilt from them at every stage. Nothing patches the point in place.

Infra: n8n Cloud, Qdrant Cloud (cluster created after 2025-07-07 or with Inference enabled), OpenRouter. Embeddings happen inside Qdrant Cloud Inference in the upsert and query bodies. No embedding nodes.

## 4. Data model

### 4.1 Data Table `invoices` (append-only log)

| column | type | notes |
|---|---|---|
| id | string | `inv_<ulid>` |
| customer_id | string | slug, from filename prefix on upload (`acme-2026-10-01.pdf` → `acme`) |
| department | string | from Form field |
| pdf_hash | string | SHA-256 of the binary, duplicate guard |
| filename | string | |
| text | string | Extract from File output |
| stage | number | 0 received, 1 coarse, 2 sharp, -1 error |
| regex_fields | string | JSON: invoice_no, date, due_date, amount, vendor |
| llm_fields | string | JSON: invoice_no, date, due_date, amount, vendor, customer_name, status, line_items_summary |
| error | string | last error message, empty if none |
| received_at | dateTime | |

### 4.2 Data Table `customers`

| column | type | notes |
|---|---|---|
| customer_id | string | |
| department | string | |
| name | string | display name |
| deleted_at | dateTime | empty = live |
| narrative | string | stage-3 LLM summary, empty until first generated |
| narrative_at | dateTime | |

### 4.3 Qdrant collection `customers`

```json
PUT /collections/customers
{
  "vectors": {
    "summary": {"size": 384, "distance": "Cosine"},
    "digest":  {"size": 96,  "distance": "Cosine",
                "multivector_config": {"comparator": "max_sim"}}
  },
  "sparse_vectors": {"bm25": {"modifier": "idf"}}
}
```

Payload indexes:

| field | type | why |
|---|---|---|
| `department` | keyword, `is_tenant: true` | tenancy |
| `customer_id` | keyword | exact lookup |
| `name` | keyword | exact lookup |
| `deleted_at` | datetime | soft delete filter, purge |
| `last_invoice_at` | datetime | decay formula |
| `stage` | integer | badge, blur page |
| `invoices[].status` | keyword | nested filter |
| `invoices[].amount` | float | nested filter |

Point ID: `uuid5(NAMESPACE_URL, "<department>/<customer_id>")`. Deterministic, so every rebuild overwrites.

Payload:

```
department, customer_id, name,
stage            // min over invoices[].stage, 0..2
pending_count    // invoices with stage in {0,1}
invoice_count, total_amount, open_amount, overdue_count, overdue_amount
last_invoice_at
summary_stage    // 1 mechanical, 3 narrative
summary_text     // what the `summary` vector was embedded from
summary_generated_at
deleted_at       // absent when live
invoices: [{id, invoice_no, date, due_date, amount, vendor,
            status: open|paid|overdue, stage: 0|1|2|-1, error}]
```

Vectors, all produced by Cloud Inference in the upsert body:

| vector | text source | model |
|---|---|---|
| `summary` | `narrative` if present, else mechanical summary ("13 invoices, €84,200 open, 2 overdue, last 2026-10-09") | `sentence-transformers/all-minilm-l6-v2` |
| `digest` | one line per invoice, newline-joined: `INV-4711 | 2026-10-09 | 12300.00 EUR | due 2026-11-01 | overdue | Hetzner servers` | `answerdotai/answerai-colbert-small-v1` |
| `bm25` | all invoice `text` concatenated | `qdrant/bm25` |

Ceiling: `digest` truncates past ~512 ColBERT tokens, roughly 30 invoices. Fine for a booth. Upgrade path: per-invoice vectors from an embeddings API stored on the log row.

Field values come from `llm_fields` when stage ≥ 2, else `regex_fields`. That is what makes the amount visibly correct itself.

## 5. Workflows

Every workflow starts with an Edit Fields node named `Config`: `QDRANT_URL`, `COLLECTION`, `OPENROUTER_MODEL`, and `DEPARTMENT` where relevant. Credentials: Qdrant as Header Auth (`api-key`), OpenRouter. No Variables, no community nodes, no Code node npm imports, no filesystem, no hardcoded IDs.

Node names are sentences. Max 12 nodes per canvas, max 4 sticky notes.

### 01 Ingest

Form Trigger (fields: PDF file, department dropdown) → Config → Code `Hash the PDF` (SHA-256 of binary) → Data Table `Seen this hash before?` (get rows by pdf_hash) → If duplicate → Form Ending "Duplicate of INV-4711, nothing to do" / else → Data Table `Upsert customer row` → Data Table `Append invoice row (stage 0)` → Execute Sub-workflow `Process in the background` (02, **Wait for Sub-Workflow Completion: off**) → Form Ending "Received. Ask the manager chat in 2 seconds."

### 02 Process (sub-workflow)

When Executed by Another Workflow (inputs: invoice id, customer_id, department, binary) → Execute Sub-workflow `Rebuild point` (03, stage 0 view) → Extract from File (PDF → text) → Code `Coarse read with regex` → Data Table `Update row: stage 1` → Execute Sub-workflow `Rebuild point` → HTTP Request `Ask the vision model to read the PDF` (OpenRouter, PDF as file input, JSON response format, timeout 30 s, retry 1) → Code `Validate fields` → Data Table `Update row: stage 2` (or `stage -1` + error on failure) → Execute Sub-workflow `Rebuild point`.

Stages run in order inside one execution. The coarse regex is deliberately naive: `parseFloat` on the first number after "Total", which reads `12.300,00` as `12.30`. The vision stage fixes it. `ponytail:` deliberate, documented on a sticky note.

### 03 Rebuild point (sub-workflow)

When Executed by Another Workflow (customer_id, department) → Data Table `Load customer row` → Data Table `Load all invoice rows` → Code `Compute view` (aggregates, digest lines, mechanical summary, stage, pending_count, pick llm vs regex fields per invoice) → HTTP Request `Upsert the point with inference` (full upsert, `?wait=true`, three inference objects, payload) → return.

Idempotent. Any stage, any retry, any order produces the same point for the same log.

### 04 Manager chat

Chat Trigger (response mode: Using Response Nodes) → Config (`DEPARTMENT` hardcoded per copy; two copies published: `04a sales`, `04b finance`) → HTTP Request `Route the question` (OpenRouter, JSON: `{intent: customer|filter|search|remove|restore, customer: string|null, min_amount: number|null, status: open|paid|overdue|null}`) → Switch on intent:

- **customer**: HTTP Request `Find the customer` (query, `bm25` nearest text = customer name, filter tenant + `is_empty deleted_at`, limit 1, with payload). Then Code `Decide what to say`:
  - `pending_count > 0`: Chat `Send Message` "~ ROUGH · stage 1/3 · 2 of 13 processing · 13 invoices, €84,200 open, 2 overdue". Then loop: Wait 5 s → re-read point → until `pending_count = 0` or 6 iterations. On 0 → narrative path below. On timeout → Chat final "Still processing. Ask again in a moment."
  - `pending_count = 0` and (`narrative` empty or `narrative_at < last_invoice_at`): Chat `Send Message` old narrative or mechanical summary + "2 invoices since this summary". Then HTTP Request `Write the narrative` (OpenRouter, 3 sentences over digest lines + aggregates) → Data Table `Save narrative` → Execute Sub-workflow `Rebuild point` → Chat final "✓ SHARP · stage 3/3 · <narrative>".
  - fresh: Chat final "<narrative> · from memory · 0 new".
- **filter**: HTTP Request `Scroll with a nested filter` (tenant + not deleted + `nested: {key: invoices, filter: {status match, amount range gte}}`, order by `last_invoice_at` desc, limit 10) → Chat final listing customers with matching invoice count and amount. No vectors involved. Say so in the message.
- **search**: HTTP Request `Hybrid search` (prefetch: `bm25` nearest, `digest` nearest, `summary` nearest, each limit 20 → `rrf` → formula `sum: [$score, mult: [0.1, exp_decay(last_invoice_at, target now, scale 2592000)]]`, limit 3) → HTTP Request `Answer from the top three` (OpenRouter) → Chat final.
- **remove / restore**: Data Table `Set or clear deleted_at` → Execute Sub-workflow `Rebuild point` → Chat final "Acme removed. Managers can't see it. The point stays until <date+30d>, PDFs stay for tax retention." / "Acme restored."

Every branch ends in a Chat node or the UI hangs. Ranking never scores sharpness. A rough customer with a new invoice is what the manager wants first.

Manager queries always carry: `must: [{key: department, match: DEPARTMENT}, {is_empty: {key: deleted_at}}]`.

### 05 Purge

Schedule Trigger (daily 03:00) → Config → HTTP Request `Delete points removed over 30 days ago` (`POST /points/delete` with filter `deleted_at lt now−30d`) → Data Table `Delete matching customer rows` → Data Table `Delete their invoice rows`. One sentence at the booth, never run live.

### 06 Stage webhook

Webhook (GET `/stage`, query `customer`, `department`) → Config → HTTP Request `Retrieve the point` → Respond to Webhook with `{name, stage, pending_count, invoice_count, open_amount, latest: {invoice_no, amount, stage}, deleted}`. No auth, no key, nothing sensitive beyond synthetic data.

### Blur page (`blur/index.html`)

Static, opened from the booth laptop. Polls 06 every 2 s for the configured customer. Renders one card: name, open amount, latest invoice amount, 3-rung ladder. `filter: blur(14px)` at stage 0, `5px` at 1, `0` at 2. Timer per rung frozen at the moment the rung lit. `<audio>` chime on rung change, muted toggle. Wall-clock fallback: if polling fails, rungs advance on a timer so the card never freezes blurry. `REPLAY` label when showing the last run. No keys in the page.

## 6. Synthetic data

`samples/`: 6 customers, 2 departments (`sales`, `finance`), 14 invoice PDFs. Fake companies, fake addresses, EUR. Two invoices use German number format (`12.300,00 €`) so the coarse stage is visibly wrong. One pair is a byte-identical duplicate for the "that's INV-4711 again" moment. Statuses mixed so the nested filter returns 2 of 6.

Generation: `samples/gen.py` (stdlib only) writes HTML invoices; `samples/print.sh` prints them to PDF with headless Chrome. No pip.

Corpus is ingested the night before. At the booth only one or two PDFs are uploaded live.

## 7. Error handling and guardrails

| failure | behavior |
|---|---|
| vision LLM timeout or bad JSON | invoice stays stage 1, `error` set, badge says coarse, demo continues |
| duplicate upload | hash hit, Form Ending says so, nothing ingested |
| two uploads same customer | both rebuild from the log, later upsert wins, converges on next stage; brief flicker, no loss |
| wifi blip mid-stage | execution errors, point stays at last completed stage, n8n Retry re-runs, rebuild is idempotent |
| Cloud Inference cold | one warm-up query at booth open |
| chat branch without a Chat node | UI hangs; test matrix covers every branch |
| OpenRouter down | recorded 60 s flow bound to one key |

Nothing is swallowed. Failed executions stay visible in n8n.

## 8. GDPR semantics

- Remove: `deleted_at` on the customers row, rebuild. Managers filter `is_empty deleted_at`. Dashboard still shows the point.
- Restore: clear it, rebuild. Shown on stage, ten seconds.
- Purge: 05, delete by filter at 30 days, both tables mirrored.
- Anonymize at 7 days: README line, not built.
- The PDF in storage is an accounting record and stays per tax retention. Said once at the booth. In the repo the storage step is a disabled Google Drive node with a sticky "swap for your storage".

## 9. Booth

Screens: aisle-facing = blur card. Presenter-side = chat page at 175 % zoom, Qdrant dashboard tab pre-filtered to the demo customer with `deleted_at` scrolled to the top, n8n canvas one alt-tab away for the second conversation. Two chat windows (sales, finance) and two printed department cards.

Hook, spoken to the aisle: "It answers before it's finished reading. Watch it sharpen."

60-second script:
- 0:00 hook, drop the PDF, point at the blur.
- 0:10 "what's new with Acme?" → rough answer, "2 processing".
- 0:18 "which customers have an overdue invoice over 10k?" → nested filter, no similarity.
- 0:28 pick up the FINANCE card, same question in the other window, Acme is gone.
- 0:38 chime, card snaps sharp, second message lands with the corrected amount.
- 0:48 "remove Acme" → gone; alt-tab to dashboard, `deleted_at`; "restore Acme" → back.
- 0:58 "Three workflows, one collection. Want the JSON?"

Tie-in, once: "Clelia's agent learns from corrections; this one learns from events. Same collection, same loop."

Insurance: full flow recorded on day 5, bound to one key.

## 10. Repo

```
n8n-invoice-memory/
  README.md                  hook, 3-step setup, GIF of the two bubbles, feature one-liners
  qdrant/setup.sh            create collection + indexes via curl, idempotent
  qdrant/smoke.sh            upsert one point with inference, run the formula query, assert a hit
  workflows/01-ingest.json … 06-stage-webhook.json, 04a/04b chat copies
  blur/index.html
  samples/gen.py, print.sh, *.pdf
  booth/script.md, booth/cards.md
  docs/superpowers/specs/
```

README hook: "Upload an invoice PDF. Ask about that customer two seconds later and get an answer. A worse answer, then a better one."

Setup: (1) free Qdrant Cloud cluster, run `qdrant/setup.sh`; (2) two credentials; (3) import the JSONs, open the `Start here` sticky, upload a sample. Triggers ship with pinned data so an opened workflow shows items before any credential exists.

Feature one-liners (README and cards, presenter speaks two):
- Tenant index: one collection, no Switch node routing to five credentials.
- Nested filter: match a customer by one invoice's fields without pulling 400 invoices into a Code node.
- Multivector: one point per customer that still matches a single invoice line.
- Cloud Inference: deletes the embeddings node and its API key.
- Soft delete + delete by filter: GDPR is one payload field and one scheduled call.
- Formula decay: freshness ranking happens in the query, not in a Sort node after you fetched everything.

Answer to "why not the Qdrant Vector Store node": "Right default for one-vector-per-chunk RAG. This needs three named vectors on one point, nested filters and server-side embedding, which is a REST body, so it's one HTTP Request with the same credential."

## 11. Verification

Day-1 checks, each can change the plan:
- `qdrant/smoke.sh` passes: inference models accepted in upsert (`summary`, `digest` as multivector, `bm25`), `nearest` text query works inside `prefetch`, formula with `datetime_key` works on the indexed field.
- Pinned OpenRouter model accepts PDF file input and `response_format` JSON. Selection rule: cheapest mid-tier model on openrouter.ai/models that lists both; if none, stage 2 reads extracted text instead of the PDF and the "visual" claim is dropped.
- Data Tables available on the n8n Cloud plan in use. Fallback: Google Sheets with the same columns.
- Execute Sub-workflow with wait off returns the Form Ending in under 2 s.

Per-workflow test matrix: every Switch branch and every If branch run once with real data, screenshot of the chat for each. Full 60 s rehearsal three times on day 5, timed.

One runnable check in the repo: `qdrant/smoke.sh`. Fails if inference, formula, or collection config break.

## 12. Build order and cuts

Order: smoke.sh → collection → 03 Rebuild → 01 + 02 → samples → 04 customer branch → blur page + 06 → 04 remaining branches → 05 → README → rehearsal + recording.

Rough 45 h. Cuts in order if slipping: attract loop, paper tray, chime, `search` intent, ColBERT `digest` (fall back to `summary` + `bm25`), restore moment.

## 13. Assumptions

- Qdrant Cloud cluster has Inference enabled and the three free hosted models listed above.
- n8n Cloud version ≥ 1.105 (Chat node Send Message), Data Tables enabled.
- Booth wifi works; phone hotspot as backup.
- Nobody at the booth uploads a real invoice. Form page says "synthetic data only".
