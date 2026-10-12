# Office Budget Memory: Design

Date: 2026-10-12. Supersedes the invoice domain of `2026-10-09-invoice-memory-design.md`, whose pipeline, staging, rebuild, and tenancy decisions carry over unless this document says otherwise.

Booth demo for n8n In The Loop 2026, Ecosystem Day, Berlin, 2026-10-14.

## 1. Goal

A fictional software company, Q8nten GmbH, runs six offices in two regions. The name reads as German *Quanten* and carries the Q of Qdrant and the 8n of n8n. Office controllers send a constant stream of German documents: purchase commitments, client deals, credit notes, amendments to all three, and the occasional duplicate. n8n takes every document in, reads it in stages, and rebuilds one Qdrant point per office: the office's live budget position, its documents, and a cached summary. Regional managers watch their offices on a dashboard; each sees only their own region.

A visitor leaves with three answers:

1. **Why n8n.** The uploads and the handling that people used to do by hand (intake, checking for duplicates, reading, retrying, keeping summaries current) run as workflows, including a simulated working day.
2. **Why Qdrant.** One point carries three vector representations with different meanings: exact words and codes, single document lines, and the office's overall situation. The dashboard shows each one's answer and the fused answer from one request.
3. **The feature.** Caching and handling documents in a multi-tenant, high-volume setting where information arrives duplicated, goes out of date, and needs constant upkeep. Expensive reading happens once per document; every question after that is answered from the point in milliseconds, with no model call.

**The position, in one line:** everything the company knows about an office lives in one place, one point, instead of being spread across a collection of chunks. Duplicates, outdated figures, and aggregation are settled once, when the point is rebuilt, not by every question at query time.

**What is new, said so it survives scrutiny.** Most document demos cut files into chunks and retrieve chunks. Here each office is one living point, a pattern the booth calls *progressive entity memory*:
- the point improves as each document is read (rough, then sharp, then summarized) and is served at every stage;
- it rewrites its own summary when its facts change (the revision fingerprint is the cache invalidation);
- it carries several representations, each made for a different kind of information;
- n8n keeps it maintained: intake, duplicates, amendments, reconcile sweeps, and summary refreshes, with nobody clicking.

House rule from the earlier spec still holds: never claim "only Qdrant can do this"; say "in one request" and show the request.

**The demo sells it.** Visuals are bold and animated, every concept is explained in a sentence on screen, and every animation is triggered by a real state change read from Qdrant (section 6). Nothing on screen is decorative or faked.

Success at the booth:
- From the aisle, a passer-by sees cards update as documents arrive, rough first, then corrected.
- In about 60 seconds the presenter shows a duplicate, an amendment superseding an older figure, the three search lenses, and a manager switch.
- The repo QR leads to an importable, documented setup.

## 2. Domain

**Company:** Q8nten GmbH (fictional). Quarter: Q4 2026; documents are dated October 2026.

**Tenants and offices.** Shard keys `m_anna` and `m_ben` are unchanged.

| Manager | Region | Office | Cost center | Controller |
|---|---|---|---|---|
| Anna (`m_anna`) | Central | Berlin | CC-BER-01 | Tom (`w_tom`) |
| | | Munich | CC-MUC-01 | Tom (`w_tom`) |
| | | Vienna | CC-VIE-01 | Lena (`w_lena`) |
| Ben (`m_ben`) | West | Amsterdam | CC-AMS-01 | Jules (`w_jules`) |
| | | Paris | CC-PAR-01 | Jules (`w_jules`) |
| | | London | CC-LON-01 | Mia (`w_mia`) |

**Categories** (canonical key, English name, German label): `people` People (Personal), `cloud` Cloud infrastructure (Cloud-Infrastruktur), `gpu` GPU compute (GPU-Rechenleistung), `office` Office and facilities (Büro und Ausstattung), `travel` Travel and events (Reisen und Events).

**Budgets.** Each office has a fixed Q4 budget per category, generated with the samples and placed in Config by the workflow generator. Nobody types budgets into tables.

**Documents.** One page, German labels, German number format (`12.300,00 €`) and dates (`14.10.2026`), the same layout for every document:

| Type | Key | Fields printed |
|---|---|---|
| Purchase commitment (*Bestellung*) | `PO-1042` | Belegnummer, Version, Datum, Kostenstelle, Lieferant, Kategorie, Beschreibung, Betrag |
| Client deal (*Kundenauftrag*) | `DEAL-2207` | Belegnummer, Version, Datum, Kostenstelle, Kunde, Beschreibung, Auftragswert |
| Credit note (*Gutschrift*) | `CN-3001` | Belegnummer, Version, Datum, Kostenstelle, Lieferant, Kategorie, Beschreibung, Betrag |

**Money flows.** Commitments take budget from a category, credit notes give budget back to a category, and deals add bookings to the office. The dashboard animates all three as flows.

- **Amendment:** the same key with a higher version, printed as "Version 2 (ersetzt Version 1)". The highest version present is current; older versions are superseded, kept, and counted, never summed.
- **Duplicate:** a byte-identical copy of a document already received, for example the same file arriving by email and portal.

**Where documents come from.**
- **AI workers.** `00 Working day` plays the controllers. For each document it picks an office, shows the model that office's recent documents, and asks for the next business event under a strict schema: a new commitment, deal, or credit note, an amendment of one of the listed recent keys, or a resend of one of them. The model writes the counterparty, category, amount, and the German and English descriptions; code assigns keys and versions, checks every value against the office's budget and the categories, and renders the PDF. Rendering is deterministic, so a resend is byte-identical and the duplicate check catches it for real. Every issued document is logged in `issued`, the ground truth for verification. Said at the booth: the workers are simulated by an AI; in real life these documents come from people and suppliers.
- **Booth documents.** Four static PDFs for beats that must land every time: `ber-po-1042-v1.pdf` (GPU servers, sent before the booth beats), `muc-po-2041-v1.pdf` (Hetzner, Cloud infrastructure, 12.300,00 €), `ber-po-1042-v1-copy.pdf` (byte-identical duplicate), and `ber-po-1042-v2.pdf` (an amendment raising the GPU servers so Berlin goes over plan in GPU compute). Two more static PDFs, one deal and one credit note, exist only for the extraction gate.
- **One renderer.** A small PDF writer (`workflows/code/pdf.js`) renders both the AI workers' documents inside n8n and the static PDFs in the repo, so every document looks the same. File names are `<office>-<key>-v<version>.pdf`; a resend keeps its original name with `-copy`.

## 3. Data

Two Data Tables are the source of truth; Qdrant holds a view rebuilt from them.

**`documents`** (one row per received file): `document_id` (business key), `doc_key`, `version` (number), `doc_type` (`cost`, `deal`, `credit`), `kind` (`document`, `duplicate`), `duplicate_of`, `office_id`, `manager_id`, `worker_id`, `pdf_hash`, `filename`, `text`, `stage` (number: 0 received, 1 rough, 2 sharp, -1 error), `regex_fields`, `llm_fields`, `error`, `received_at` (date).

**`offices`**: `office_id`, `manager_id`, `name`, `narrative`, `narrative_at` (date), `narrative_revision`.

**`simulation`** (one row, `name` = `day`): `running` (boolean).

**`issued`** (one row per document an AI worker issued): `issued_id`, `office_id`, `manager_id`, `worker_id`, `doc_type`, `doc_key`, `version`, `date`, `counterparty`, `category`, `amount`, `description_de`, `description_en`, `resend_of`, `filename`, `issued_at`. Ground truth for the burst check; the pipeline never reads it.

Every `documents` row also stores `pdf_base64`: the file is read from the row, never downloaded twice, whatever its source.

## 4. Qdrant

New collection `offices`, created and verified by `scripts/setup_collection.py` with the same vector configuration and shard keys as before. The old `customers` collection is left in place; dropping it is the owner's call.

**Point per office**, id from SHA-256 of `<manager_id>/<office_id>` as before. Payload:

```
office_id, manager_id, name, region
stage, pending_count               // min stage of current documents; documents not yet sharp
lines[]                            // per category: category, name, budget, committed, credited, remaining, over_by
committed, budget, used_pct        // totals over all categories
booked, deal_count                 // current deals
documents[]                        // key, version, type, kind, counterparty, category, amount, description_en,
                                   //   date, status (current | superseded | duplicate), stage, received_at
superseded_count, duplicate_count
latest                             // newest received document, any kind
summary_stage, summary_text, summary_generated_at, source_revision
updated_at
```

**Vectors and their meanings** (inference inside Qdrant Cloud, models unchanged):

| Vector | Built from | Lens on the dashboard | Answers |
|---|---|---|---|
| `bm25` (sparse) | raw German text of every document plus the English descriptions | Keyword | exact codes and names: `PO-1042`, `CC-BER-01`, "Hetzner" |
| `digest` (ColBERT multivector) | one English line per current document | Line | one specific commitment: "GPU servers for the inference launch" |
| `summary` (dense) | the office summary | Meaning | the situation: "which office is overspending on travel?" |
| `page` (image, gated) | the rendered PDF page of the latest document | Looks like | documents by appearance: "the one with the red stamp" |

The `page` vector makes the multimodal claim literal: the first three are text representations. It ships only if the day-1 gate proves an image model on the cluster's Cloud Inference; otherwise it is cut and the booth says "three representations", not "multimodal".

The vision read returns an English description of every document, so English questions match German documents in the Line and Meaning lenses.

**Payload indexes:** `manager_id` (keyword, tenant), `office_id` (keyword), `stage` (integer), `updated_at` and `latest.received_at` (datetime), `lines[].category` (keyword), `lines[].over_by` (float), `documents[].type` (keyword).

**Requests** (reference bodies in `scripts/bodies.py`):
- List: scroll the manager's offices, ordered by `updated_at`.
- Over plan: nested filter on `lines` with `over_by` greater than X (replaces "overdue over").
- Ask: one `points/query/batch` request with four searches under the tenant filter: Keyword only, Line only, Meaning only, and the fused query (the three as prefetches, RRF, then freshness decay on `updated_at`).

## 5. n8n workflows

Generated as importable JSON by `scripts/build_workflows.py`, as today: no instance ids, Data Tables and credentials by name, sub-workflows accept the caller's item and state their contract under the trigger.

| Workflow | Change |
|---|---|
| `00 Working day` (new) | Started by the console with a count. Responds at once, sets `running`, and for each slot: checks `running`, picks an office, reads its recent issued documents, asks the model for the next event, validates it and assigns key and version in code, renders the PDF, logs it in `issued`, hands it to `01b`, and waits about 15 s. Ends with one `06 Reconcile`. One execution per burst. |
| `01b Record a document` (new, shared) | Input: either a static `file` (Form, console) or a generated `filename` with `pdf_base64`, `office_id`, and `worker_id` (only from `00`). A static file is validated against the booth manifest and downloaded. Then it hashes, checks the hash per manager and office, and stores the PDF in the row. A duplicate appends a `duplicate` row and rebuilds the office; a new document upserts the office row, appends the document row, starts `02` without waiting, and answers with its ids. |
| `01 Ingest` | The phone Form, reduced to Form, `01b`, and a Duplicate or Received page. One dropdown: the document pool. |
| `02 Process` | Same stages and error routing; the PDF comes from the row's `pdf_base64`. The rough read parses the German labels and converts the date; it misreads every German amount by a factor of 1,000, on purpose. The vision read uses a strict schema: `doc_type`, `doc_key`, `version`, `office`, `date`, `counterparty`, `category` (one of five, or none for deals), `amount`, `description_en`. Validation checks each field. |
| `02b Write the summary` | Three sentences about the office's budget position: committed against budget, categories over plan, deals booked, and the most recent change, including amendments. Same freshness rule and fingerprint. |
| `03 Rebuild office point` | Same shape. The view takes the highest version of each key as current, counts superseded and duplicate rows without summing them, sums current costs and credit notes per category against the budget, sums current deals, and computes the stage, latest document, and summary freshness. |
| `05 Dashboard writes` | `POST /send` (a static file) to `01b`, answering with its JSON; `POST /day/stop` sets `running` to false. `POST /day/start` belongs to `00`. Every webhook requires the dashboard's secret header. |
| `07 Maintenance` (new) | `POST /reset` clears `documents`, `offices`, and `issued`, stops the day, and deletes the office points (between rehearsals). `GET /issued` returns the issued rows for the burst check. Secret header required. |
| `06 Reconcile` (new) | Every 5 minutes and at the end of each burst, rebuilds all six office points from the tables, so a view written out of order by overlapping runs is replaced within minutes. |

Removed: `04 Dashboard reads` (the dashboard reads Qdrant directly), remove and restore, and `06 Purge`.

**Execution budget.** n8n Cloud counts executions. The dashboard never polls through n8n. The simulator runs only when started. Before the booth, measure how many executions one document costs on the actual plan and size the bursts to fit.

## 6. Dashboard

Next.js (App Router, TypeScript) in `dashboard/`, run locally for the booth; Vercel deployment comes after the booth.

**Server routes.** The browser only talks to its own origin.
- `GET /api/offices?manager=`: scrolls Qdrant directly with the server-side Qdrant key.
- `GET /api/ask?manager=&q=&over=`: runs the four-search batch and returns per-lens hits and the fused ranking with each hit's matched line.
- `POST /api/send`, `POST /api/day/start`, `POST /api/day/stop`: call n8n webhooks with the secret header.
- `POST /api/login`: checks `DASHBOARD_PASSCODE` and sets an httpOnly, Secure, SameSite=Strict cookie holding a signed token; every other route rejects requests without it.
- Environment: `QDRANT_URL`, `QDRANT_API_KEY`, `N8N_BASE_URL`, `N8N_DASHBOARD_SECRET`, `DASHBOARD_PASSCODE`.

**Manager view** (`/`, the aisle screen; manager pills Anna and Ben):
- Latest-document band: the newest document of the manager's offices, its amount rough then corrected (the one hero figure), stages 01 to 04 with timings, and what the first read cost against what every later answer costs.
- Stat tiles: committed against budget, lines over plan (clicking filters the board), deals booked, summaries current.
- Ask the memory: one query box and the over-plan threshold. The answer shows the Keyword, Line, and Meaning hits side by side, then the fused result, with the time taken and "no model called".
- Tape: recent events from the points' documents: received, corrected, superseded, duplicate, error.
- Office cards, grouped by controller: committed against budget per category as meters (fill carries severity, track a lighter step of the same ramp), over-plan lines, deals, superseded and duplicate counts, the cached summary with its freshness, blurred while a document is being read.

**Console** (`/console`, the presenter screen):
- Send one document from the pool; start and stop the working day.
- The same latest-document band.
- "What n8n is doing": the pipeline as n8n-style nodes (three intakes, Form, Console, Working day, into Check and record, Extract text, Rough read, Vision read, Summary), each stage dropping into Rebuild and the office point, the active node lit, observed timings under each.
- The collection disk if time allows.

**Animations that show real work.** Each one starts from a state change the poll observed in Qdrant; with reduced motion each becomes an instant state change:

| Animation | Triggered by | Explains |
|---|---|---|
| Document journey: the PDF arrives from its source, n8n nodes light up, the rough read highlights the misread amount on the page, a scan line sweeps the page during the vision read, the fields fly into the office point, which sharpens | a new document, then each stage change | why n8n; stages served as they finish |
| Three lenses: the query splits into Keyword, Line, and Meaning beams that hit different offices, then fuse into one ranking | an Ask response | why Qdrant; representations mean different things |
| Cache counter: "model calls saved" and "answered from memory in N ms" count up | every Ask response and every poll | the caching |
| Amendment: the old figure is struck through and slides into the office's history; the summary rewrites itself | a document turning superseded, then a new `source_revision` | outdated data handled |
| Duplicate: the incoming document bounces off a "seen before" stamp | a duplicate row | duplicates handled |
| Money flows: deals flow in, commitments and credit notes flow between offices and categories | each sharp document | different money flows |
| Shard swap: switching manager swaps the shard; only that region's offices light | a manager switch | multi-tenancy |

Each concept gets one plain sentence on screen next to its animation.

**Behavior.** Polls every 2 seconds after the previous request settles; drops responses for a manager or query that is no longer current; three failed polls show "offline, showing last known offices". Animations never gate data. Server text renders as text. Design: Qdrant brand, as in prototype v3.

## 7. Error handling

| Failure | Behavior |
|---|---|
| Vision read fails or returns an invalid field | Row at stage -1 with the error, rough fields kept, the card stays partly blurred, the tape shows the error |
| Duplicate | Recorded as a duplicate row; the Form or console shows the original file; the tape shows it |
| Amendment arrives before the original is read | The highest version is current regardless; the original shows as superseded |
| Overlapping rebuilds of one office | Reconcile replaces an out-of-order view within 5 minutes |
| Summary call fails | The point keeps its mechanical summary; the next document or reconcile tries again |
| Dashboard loses Qdrant | The last known offices stay with an offline notice |

## 8. Verification

- Unit tests: rough read (German labels, dates, the ×1000 misread), validation of the new schema, the office view (versions, superseded, duplicates, budgets, over plan), card and lens shaping, manifest invariants, generated workflow structure, and each Code node run in the sandbox harness.
- The PDF writer: deterministic bytes, German characters, and text that `pdftotext` and n8n's Extract from File both read back.
- Live gates, in order: the OpenRouter check on one purchase commitment, one deal, and one credit note rendered by the writer (all fields, English description, amount corrected); the smoke test on a disposable `offices`-shaped collection including the over-plan filter and the four-search batch; a 10-document AI-worker burst whose resulting points match expectations computed from the `issued` rows (the burst check).
- Rehearsal: reset, seed burst, then the 60-second script three times.

## 9. Build order and cuts

Order: spec, samples and the extraction gate, pure logic, Qdrant collection and smoke, workflows and import, dashboard, live burst, rehearsal.

Cut first if time runs short: the `page` vector (if its gate fails it is cut anyway), the disk, the console's pipeline animation detail (keep the stage list), the tape, Vercel. Never cut: the three lenses, the document journey, the cache counter, the duplicate and amendment moments, tenancy.

## 10. Booth script

1. Start the working day (`ber-po-1042-v1.pdf` was sent at setup). Cards update as the AI workers' documents arrive; each amount appears rough, then corrected.
2. Send `muc-po-2041-v1.pdf` by hand: rough €12.30 becomes €12,300.00.
3. Send `ber-po-1042-v1-copy.pdf`: "Duplicate, nothing ingested", shown on the tape.
4. Send `ber-po-1042-v2.pdf`: version 1 is marked superseded, Berlin's category total changes, the summary is rewritten.
5. Ask "GPU servers for the inference launch": Keyword, Line, and Meaning answer differently; the fused answer is on top.
6. Switch from Anna to Ben: only West's offices.

Close: "Not chunks, memory. n8n does the handling, Qdrant keeps the memory. The request is on the card."

## 11. Alignment with Clelia's talk

Clelia's stage talk, *Building a Self-Healing Research Agent in n8n*, writes a human's verdict back to one Qdrant collection so an agent does not make the same mistake twice. The booth is its companion at company scale.

**The pairing, said once at the booth:** "Clelia's agent learns from corrections. This memory learns from every document. Same collection, same loop, at scale."

**Narrative arc**, borrowed from her deck and used in the README, the console captions, and the printed card:
1. Problem: documents arrive duplicated, outdated, and in German, all day long.
2. Common fixes that fail: re-reading everything costs a model call per question; chunk-and-hope loses the facts that matter.
3. The loop: one living point per office, rebuilt after every stage and every document.
4. Why Qdrant: three meanings in one request, filtered per tenant.
5. Three fewer nodes: Cloud Inference embeds inside the cluster, where her talk removed one.
6. Get it today: importable workflows, a README, Apache 2.0.

**Shared vocabulary**, used on purpose so the two read as a pair: "one collection, many lanes" (tenants as shards, three representation lanes); "doubles as an audit trail" (her "doubles as an eval set"; our superseded and duplicate history); "three fewer nodes" (her "one fewer node").

**Minimal path in the README**, before the full company setup: `01b`, `02`, and `03` alone give a builder a living point per entity, the way her repo starts from one eleven-node workflow.

**Deferred:**
- A human correction (a manager flags a wrong field or summary on a card; the rebuild applies the correction over the extraction) would make her loop literal for documents. It is built only after the core demo runs end to end.
- Renaming the repo to fit the new domain.
