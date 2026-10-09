# Invoice Memory: progressive per-customer memory in Qdrant, driven by n8n

Booth demo for n8n In The Loop 2026, Ecosystem Day, Berlin, 2026-10-14. Qdrant booth. Complements Clelia's stage talk "Building a Self-Healing Research Agent in n8n" (her loop: feedback → memory; this: events → memory).

Date: 2026-10-09, revised same day (manager tenancy, dashboard surface). Owner: Andrei. Build window: 5 days, one person.

## 1. Goal

Managers have workers. Workers have customers. A worker uploads each invoice PDF a customer sends. Qdrant holds one point per customer that gets sharper in stages as the PDF is processed, like a progressive JPEG. Managers watch a live dashboard: a customer card blurs the moment a new PDF lands and sharpens as each stage finishes, the rough amount correcting itself in place. Each manager sees only their workers' customers (tenant). Removal is a soft delete with a 30-day purge.

Audience: n8n builders. Not vector-DB experts. 60–90 s attention at a booth. Two screens.

Success at the booth:
- A passer-by understands "it answers before it finished reading" from the aisle screen with no words.
- Four moments land in 60 s: card goes rough with "2 processing" and a wrong amount, overdue filter returns two customers with no similarity involved, switching manager hides a customer, remove → Qdrant dashboard still shows the point with `deleted_at`, restore brings it back. The card sharpening and the amount correcting itself happen underneath, on their own.
- A builder scans the QR and the import works on their n8n Cloud without edits beyond two credentials.

## 2. Non-goals, killed on purpose

- Per-invoice points. One point per customer is the whole idea.
- CLIP or any visual embedding. "Visual" = a vision LLM reads the PDF and extracts fields.
- ColPali. Not on Cloud Inference.
- Chat interface. Managers don't chat with invoices. The dashboard is the manager surface.
- Free-text search. The dashboard offers a filter control, not a search box.
- Per-customer queue or locking. Rebuild-from-log converges; flicker is acceptable.
- Anonymize-at-7-days as a live step. README line only.
- Real identity. Manager comes from a tab on the dashboard. Worker comes from a Form dropdown.
- Attract loop and paper tray: optional extras, built only if hours remain.

## 3. Architecture

```
worker ──Form──▶ 01 Ingest ──async──▶ 02 Process ──▶ 03 Rebuild point ──▶ Qdrant `customers`
                                      (stages 0,1,2,3)      ▲                     │
manager ─browser─▶ dashboard/index.html ─GET/POST─▶ 04 Dashboard API ─────────────┘
cron ──────────▶ 05 Purge                      (list, filter, remove, restore)
                 n8n Data Tables: `invoices` (append-only log), `customers`
```

Source of truth = two n8n Data Tables. The Qdrant point is a materialized view rebuilt from them at every stage. Nothing patches the point in place.

Infra: n8n Cloud, Qdrant Cloud (cluster created after 2025-07-07 or with Inference enabled), OpenRouter. Embeddings happen inside Qdrant Cloud Inference in the upsert and query bodies. No embedding nodes. The dashboard is one static HTML file on the booth laptop, polling n8n webhooks. No keys in the page.

## 4. Data model

### 4.1 Entities

| entity | id | where it lives |
|---|---|---|
| manager | `m_<slug>` | `Config` node map, dashboard tabs |
| worker | `w_<slug>` | `Config` node map `worker_id → manager_id`, Form dropdown |
| customer | `<slug>` from filename prefix (`acme-2026-10-01.pdf` → `acme`) | Data Table `customers`, one Qdrant point |

A worker belongs to one manager. Tenant = `manager_id`.

### 4.2 Data Table `invoices` (append-only log)

| column | type | notes |
|---|---|---|
| id | string | `inv_<ulid>` |
| customer_id | string | |
| worker_id | string | from Form |
| manager_id | string | resolved from the worker map |
| pdf_hash | string | SHA-256 of the binary, duplicate guard |
| filename | string | |
| text | string | Extract from File output |
| stage | number | 0 received, 1 coarse, 2 sharp, -1 error |
| regex_fields | string | JSON: invoice_no, date, due_date, amount, vendor |
| llm_fields | string | JSON: invoice_no, date, due_date, amount, vendor, customer_name, status, line_items_summary |
| error | string | last error message, empty if none |
| received_at | dateTime | |

### 4.3 Data Table `customers`

| column | type | notes |
|---|---|---|
| customer_id | string | |
| worker_id | string | |
| manager_id | string | |
| name | string | display name, from first `llm_fields.customer_name`, else slug |
| deleted_at | dateTime | empty = live |
| narrative | string | stage-3 LLM summary, empty until first generated |
| narrative_at | dateTime | |

### 4.4 Qdrant collection `customers`

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
| `manager_id` | keyword, `is_tenant: true` | tenancy |
| `worker_id` | keyword | dashboard grouping |
| `customer_id` | keyword | exact lookup |
| `deleted_at` | datetime | soft delete filter, purge |
| `last_invoice_at` | datetime | ordering, decay formula |
| `stage` | integer | badge, blur |
| `invoices[].status` | keyword | nested filter |
| `invoices[].amount` | float | nested filter |

Point ID: `uuid5(NAMESPACE_URL, "<manager_id>/<customer_id>")`. Deterministic, so every rebuild overwrites.

Payload:

```
manager_id, worker_id, customer_id, name,
stage            // min over invoices[].stage, 0..2
pending_count    // invoices with stage in {0,1}
invoice_count, total_amount, open_amount, overdue_count, overdue_amount
last_invoice_at
latest           // {invoice_no, amount, stage} of the newest invoice, for the card
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

Field values come from `llm_fields` when the invoice's stage ≥ 2, else `regex_fields`. That is what makes the amount visibly correct itself.

Rungs, used by the card ladder: rung 1 = `stage` 1 (coarse), rung 2 = `stage` 2 (sharp), rung 3 = `summary_stage` 3 (narrative). `stage` 0 shows as "received", blur 14px. Badge text: `rung <n>/3 · <pending_count> of <invoice_count> processing`.

The dashboard never needs vector search. The vectors exist so the same point answers free-text questions in a follow-up (README shows the hybrid query body); at the booth they are the "one point, three representations" sentence.

## 5. Workflows

Every workflow starts with an Edit Fields node named `Config`: `QDRANT_URL`, `COLLECTION`, `OPENROUTER_MODEL`, `WORKERS` (JSON map `worker_id → {manager_id, name}`), `MANAGERS` (JSON map `manager_id → name`). Credentials: Qdrant as Header Auth (`api-key`), OpenRouter. No Variables, no community nodes, no Code node npm imports, no filesystem, no hardcoded IDs.

Node names are sentences. Max 12 nodes per canvas, max 4 sticky notes.

### 01 Ingest

Form Trigger (fields: PDF file, worker dropdown) → Config → Code `Hash the PDF, resolve the manager` → Data Table `Seen this hash before?` (get rows by pdf_hash) → If duplicate → Form Ending "Duplicate of INV-4711, nothing to do" / else → Data Table `Upsert customer row` → Data Table `Append invoice row (stage 0)` → Execute Sub-workflow `Process in the background` (02, **Wait for Sub-Workflow Completion: off**) → Form Ending "Received. Watch the dashboard."

### 02 Process (sub-workflow)

When Executed by Another Workflow (inputs: invoice id, customer_id, manager_id, binary) → Execute Sub-workflow `Rebuild point` (03, stage 0 view) → Extract from File (PDF → text) → Code `Coarse read with regex` → Data Table `Update row: stage 1` → Execute Sub-workflow `Rebuild point` → HTTP Request `Ask the vision model to read the PDF` (OpenRouter, PDF as file input, JSON response format, timeout 30 s, retry 1) → Code `Validate fields` → Data Table `Update row: stage 2` (or `stage -1` + error on failure) → Execute Sub-workflow `Rebuild point` → HTTP Request `Write the narrative` (OpenRouter, 3 sentences over digest lines + aggregates, timeout 20 s) → Data Table `Save narrative` → Execute Sub-workflow `Rebuild point`.

Stages run in order inside one execution. Stage 3 runs eagerly; it is the third chime. The coarse regex is deliberately naive: `parseFloat` on the first number after "Total", which reads `12.300,00` as `12.30`. The vision stage fixes it. `ponytail:` deliberate, documented on a sticky note.

### 03 Rebuild point (sub-workflow)

When Executed by Another Workflow (customer_id, manager_id) → Data Table `Load customer row` → Data Table `Load all invoice rows` → Code `Compute view` (aggregates, digest lines, mechanical summary, stage, pending_count, latest, pick llm vs regex fields per invoice, carry `deleted_at` and `narrative` from the customer row) → HTTP Request `Upsert the point with inference` (full upsert, `?wait=true`, three inference objects, payload) → return.

Idempotent. Any stage, any retry, any order produces the same point for the same log.

### 04 Dashboard API

One workflow, three Webhook triggers, each path ends in Respond to Webhook. No auth; synthetic data only, booth laptop only.

- `GET /customers?manager=m_x[&overdue_gte=10000]`: Config → HTTP Request `Scroll this manager's customers` (filter: `manager_id` match, `is_empty deleted_at`; when `overdue_gte` present add `nested: {key: invoices, filter: {status match overdue, amount gte}}`; `order_by last_invoice_at desc`; limit 50; with payload) → Code `Shape cards` → Respond. Returns `[{customer_id, name, worker, stage, rung, pending_count, invoice_count, open_amount, overdue_count, latest, narrative, deleted_at}]`.
- `POST /customers/remove` `{manager, customer}`: Config → Data Table `Set deleted_at` → Execute Sub-workflow `Rebuild point` → Respond `{ok, purge_at}`.
- `POST /customers/restore` `{manager, customer}`: Config → Data Table `Clear deleted_at` → Execute Sub-workflow `Rebuild point` → Respond `{ok}`.

The list query always carries `manager_id` match. There is no endpoint that lists across managers. Response time target: under 300 ms for 10 customers.

### 05 Purge

Schedule Trigger (daily 03:00) → Config → HTTP Request `Delete points removed over 30 days ago` (`POST /points/delete` with filter `deleted_at lt now−30d`) → Data Table `Delete matching customer rows` → Data Table `Delete their invoice rows`. One sentence at the booth, never run live.

## 6. Dashboard (`dashboard/index.html`)

Static, one file, no build step, opened from the booth laptop. Config at the top: n8n base URL, managers list.

- Manager tabs across the top. Switching tabs changes the `manager` query. Each tab is one tenant.
- Grid of customer cards, one per point, grouped by worker. Card: name, worker, open amount, overdue count, latest invoice `INV-4711 · €12.30 · rough`, rung ladder 1-2-3, narrative text under the card when rung 3.
- Blur per card from `stage`: 14px at 0, 5px at 1, 0 at 2. Rung 3 reveals the narrative. Timer per rung frozen at the moment the rung lit.
- Polls `GET /customers` every 2 s. Diffs by `customer_id`; a card whose `stage` dropped goes blurry again. The amount text updates in place, so `€12.30` becomes `€12,300.00` under the viewer's eyes.
- Filter control: one number input "overdue over", applies `overdue_gte`. Cards outside the filter fade out, the rest stay. Label says "payload filter, no similarity".
- Remove and Restore buttons on each card. Removed cards disappear on the next poll. A small "removed" tray at the bottom lists what the manager can't see, with the `purge_at` date, for the dashboard-cutaway moment.
- Chime per rung change, muted toggle. Offline banner if three polls fail; last known cards stay.

Both screens show this page. Aisle-facing: manager A tab, no mouse. Presenter-side: same page plus the Qdrant dashboard tab pre-filtered to the demo customer with `deleted_at` scrolled to the top, and the n8n canvas one alt-tab away for the second conversation.

## 7. Synthetic data

`samples/`: 2 managers, 4 workers, 6 customers, 14 invoice PDFs. Fake companies, fake addresses, EUR. Two invoices use German number format (`12.300,00 €`) so the coarse stage is visibly wrong. One pair is a byte-identical duplicate for the "that's INV-4711 again" moment. Statuses mixed so the overdue filter returns 2 of 6.

Generation: `samples/gen.py` (stdlib only) writes HTML invoices; `samples/print.sh` prints them to PDF with headless Chrome. No pip.

Corpus is ingested the night before. At the booth only one or two PDFs are uploaded live.

## 8. Error handling and guardrails

| failure | behavior |
|---|---|
| vision LLM timeout or bad JSON | invoice stays stage 1, `error` set, card stays half-blurry, rung 2 never lights, demo continues |
| narrative LLM fails | point stays rung 2, mechanical summary, no rung 3 chime |
| duplicate upload | hash hit, Form Ending says so, nothing ingested |
| two uploads same customer | both rebuild from the log, later upsert wins, converges on next stage; brief flicker, no loss |
| wifi blip mid-stage | execution errors, point stays at last completed stage, n8n Retry re-runs, rebuild is idempotent |
| Cloud Inference cold | one warm-up upsert at booth open |
| dashboard polling fails | offline banner, last cards stay |
| OpenRouter down | recorded 60 s flow bound to one key |

Nothing is swallowed. Failed executions stay visible in n8n.

## 9. GDPR semantics

- Remove: `deleted_at` on the customers row, rebuild. Dashboard list filters `is_empty deleted_at`. Qdrant dashboard still shows the point.
- Restore: clear it, rebuild. Shown on stage, ten seconds.
- Purge: 05, delete by filter at 30 days, both tables mirrored.
- Anonymize at 7 days: README line, not built.
- The PDF in storage is an accounting record and stays per tax retention. Said once at the booth. In the repo the storage step is a disabled Google Drive node with a sticky "swap for your storage".

## 10. Booth

Hook, spoken to the aisle: "It answers before it's finished reading. Watch it sharpen."

60-second script:
- 0:00 hook, drop the PDF in the Form, point at the card going blurry.
- 0:08 card: `INV-4711 · €12.30 · rough · 1 of 13 processing`. "That's regex. It's wrong. It's two seconds old. The manager already has it."
- 0:18 type 10000 in "overdue over". Two cards stay. "No vectors. Nested filter on the invoices inside the point."
- 0:28 click the other manager's tab. Acme is gone. "Same collection. One filter on `manager_id`. Tenancy is a payload field."
- 0:38 chime, card snaps sharp, `€12,300.00`, then narrative appears. "Vision model finished. Same card, corrected in place. Nobody re-asked."
- 0:48 Remove Acme. Card gone, appears in the removed tray with the purge date. Alt-tab to the Qdrant dashboard: point still there, `deleted_at`. Restore. Back.
- 0:58 "Four workflows, one collection. Want the JSON?"

Tie-in, once: "Clelia's agent learns from corrections; this one learns from events. Same collection, same loop."

Insurance: full flow recorded on day 5, bound to one key.

## 11. Repo

```
n8n-invoice-memory/
  README.md                  hook, 3-step setup, GIF of a card sharpening, feature one-liners
  qdrant/setup.sh            create collection + indexes via curl, idempotent
  qdrant/smoke.sh            upsert one point with inference, scroll with nested filter, formula query, assert hits
  workflows/01-ingest.json … 05-purge.json
  dashboard/index.html
  samples/gen.py, print.sh, *.pdf
  booth/script.md, booth/cards.md
  docs/superpowers/specs/
```

README hook: "Upload an invoice PDF. Two seconds later the manager's dashboard has an answer. A worse answer, then a better one, then a summary."

Setup: (1) free Qdrant Cloud cluster, run `qdrant/setup.sh`; (2) two credentials; (3) import the JSONs, open the `Start here` sticky, edit the worker map, upload a sample, open `dashboard/index.html` with your n8n URL. Triggers ship with pinned data so an opened workflow shows items before any credential exists.

Feature one-liners (README and cards, presenter speaks two):
- Tenant index: one collection, no Switch node routing to five credentials.
- Nested filter: match a customer by one invoice's fields without pulling 400 invoices into a Code node.
- Multivector: one point per customer that still matches a single invoice line.
- Cloud Inference: deletes the embeddings node and its API key.
- Soft delete + delete by filter: GDPR is one payload field and one scheduled call.
- Formula decay: freshness ranking happens in the query, not in a Sort node after you fetched everything.

Answer to "why not the Qdrant Vector Store node": "Right default for one-vector-per-chunk RAG. This needs three named vectors on one point, nested filters and server-side embedding, which is a REST body, so it's one HTTP Request with the same credential."

## 12. Verification

Day-1 checks, each can change the plan:
- `qdrant/smoke.sh` passes: inference models accepted in upsert (`summary`, `digest` as multivector, `bm25`), nested filter on `invoices[]` returns the seeded point, formula with `datetime_key` works on the indexed field.
- Pinned OpenRouter model accepts PDF file input and `response_format` JSON. Selection rule: cheapest mid-tier model on openrouter.ai/models that lists both; if none, stage 2 reads extracted text instead of the PDF and the "visual" claim is dropped.
- Data Tables available on the n8n Cloud plan in use. Fallback: Google Sheets with the same columns.
- Execute Sub-workflow with wait off returns the Form Ending in under 2 s.
- `GET /customers` under 300 ms with the full sample corpus.

Per-workflow test matrix: every If branch and every webhook path run once with real data, screenshot of the dashboard for each. Full 60 s rehearsal three times on day 5, timed.

One runnable check in the repo: `qdrant/smoke.sh`. Fails if inference, nested filter, formula, or collection config break.

## 13. Build order and cuts

Order: smoke.sh → collection → 03 Rebuild → 01 + 02 → samples → 04 list endpoint → dashboard page → 04 remove/restore → 05 → README → rehearsal + recording.

Rough 40 h. Cuts in order if slipping: attract loop, paper tray, chime, narrative stage, ColBERT `digest` (fall back to `summary` + `bm25`), restore moment.

## 14. Assumptions

- Qdrant Cloud cluster has Inference enabled and the three free hosted models listed above.
- n8n Cloud plan has Data Tables (built-in, 200 MiB per instance, kilobytes used here) and allows Execute Sub-workflow without waiting.
- Booth wifi works; phone hotspot as backup.
- Nobody at the booth uploads a real invoice. Form page says "synthetic data only".
