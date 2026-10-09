# Invoice Memory Implementation Plan

> **For implementers:** Execute this plan task by task using available tools and skills. Steps use checkbox (`- [ ]`) syntax for tracking. This plan does not require an unavailable execution skill.

**Goal:** Build the booth demo: invoice PDFs become one progressively sharpening Qdrant point per customer, shown on a live manager dashboard, driven by n8n Cloud workflows.

**Architecture:** Two n8n Data Tables are the source of truth; a Rebuild sub-workflow turns them into one Qdrant point per customer with three Cloud-Inference vectors, called after every processing stage. A static dashboard polls two n8n read webhooks and calls one write webhook. Python scripts in `scripts/` create the collection, hold the reference request bodies, and smoke-test them before any workflow is built; `samples/` generates the synthetic PDFs.

**Tech Stack:** n8n Cloud (Form Trigger, Data Table, Crypto, Extract from File, HTTP Request, Code, Execute Sub-workflow, Webhook, Respond to Webhook, Schedule Trigger), Qdrant Cloud with Cloud Inference, OpenRouter (HTTP), Python 3.11+ standard library for scripts (`unittest` for their tests), bash only for the headless Chrome print loop, Node (`node --test`) for the Code-node sources and the dashboard logic, headless Chrome for PDFs.

**Spec:** `docs/superpowers/specs/2026-10-09-invoice-memory-design.md`

Numbering note: the spec's "04 Dashboard API" is split here into `04 Dashboard reads` and `05 Dashboard writes` to respect the 12-node rule; purge becomes `06`. The spec's `02 Process` gets a `02b Write the narrative` sub-workflow for the same reason. The Edge stretch is a separate plan: `2026-10-09-invoice-memory-edge.md`.

## Global Constraints

- n8n Cloud. No Variables, no community nodes, no `require` in Code nodes, no filesystem, no hardcoded credential IDs, webhook IDs, or cluster URLs in exported JSON.
- Every trigger path immediately enters an Edit Fields node named `Config` (or `Config (search)`), preserving incoming JSON and declaring the values that path uses. Shared values are `QDRANT_URL`, `COLLECTION` (`customers`), `OPENROUTER_MODEL`, `PDF_ENGINE` (`native`), `WORKERS`, `MANAGERS`, and `SAMPLES_BASE_URL`.
- Credentials: `Qdrant api-key` (Header Auth, header `api-key`), `OpenRouter bearer` (Header Auth, header `Authorization`, value `Bearer <key>`).
- Qdrant collection `customers`: named vectors `summary` (384, Cosine), `digest` (96, Cosine, multivector max_sim), sparse `bm25` (idf); `sharding_method: custom`; shard keys `m_anna`, `m_ben`. Point reads and writes carry `shard_key`; collection administration does not. Every tenant lookup additionally filters `manager_id` and `customer_id` as appropriate.
- Inference models, exact strings: `sentence-transformers/all-minilm-l6-v2`, `answerdotai/answerai-colbert-small-v1`, `qdrant/bm25`.
- Point ID: SHA-256 of `<manager_id>/<customer_id>` formatted as a UUID (first 32 hex, version nibble `4`, variant nibble `8`). Deterministic; this replaces the spec's uuid5 because n8n Code nodes have no crypto; the Crypto node does the hash.
- Node names are sentences. Target 12 nodes per canvas, hard cap 15. Four sticky notes max.
- Synthetic data only. The Form has no file field.
- Latency targets: list under 300 ms, search under 500 ms, measured in n8n around the Qdrant call and returned as `latency_ms`.
- Writing in README, cards, script: American English, Oxford comma, no em dashes, Title Case headings.
- Commit after every task, ending the message with the current session's attribution lines.

### Execution Gates and Data Ownership

- This document is an implementation plan. External requests below are future acceptance checks, not evidence that this account has passed them. Record actual cluster version, available inference model IDs, n8n version, and test results before building the canvases.
- Data Tables manage their own numeric `id`, `createdAt`, and `updatedAt`. Use a custom string `invoice_id` for the invoice business key everywhere; never add or overwrite built-in `id`. Match invoice writes on `invoice_id`, `manager_id`, and `customer_id`; match customer writes on both tenant and slug. Bind table selections and Execute Sub-workflow references again after import, along with credentials and Config. Import seven workflows in dependency order (03, 02b, 02, 01, 04, 05, 06); activate trigger workflows only after binding.
- HTTP, Data Table, and Execute Sub-workflow outputs replace incoming JSON. Downstream fields must reference the named source node explicitly. Rebuild returns Qdrant's response, not the caller's PDF. [n8n documents that a sub-workflow returns its last node's output](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/).
- `02 Process` downloads the validated public sample URL itself. No binary crosses a sub-workflow call. Within Process, encode the downloaded PDF with [the supported binary buffer helper](https://docs.n8n.io/build/code-in-n8n/cookbook/code-node/get-the-binary-data-buffer.md), preserve its binary explicitly in that Code node, then extract text. A scanned but valid PDF with empty text proceeds normally; corrupt PDF/download errors are separate failures that must be recorded as stage -1 and rebuilt.
- Manager tabs and Form workers are synthetic selectors, not authentication. Validate manager against `MANAGERS`, sample against the committed manifest allowlist, worker against `WORKERS`, and customer against the tenant's existing rows. Reject invalid input with JSON and 400, missing customers with 404. Reject nonfinite/negative overdue thresholds and empty/overlong search strings. No public sample URL may be supplied directly by the visitor.
- No distributed lock is introduced. Submit one sample at a time and await completion during booth operation. Overlapping runs can leave a stale final Qdrant write; after all writers finish, manually run Rebuild and regenerate the narrative from current rows. Do not claim automatic convergence without a later rebuild. Run purge only while ingest, processing, and restore are stopped.
- Keep every canvas within 15 actual nodes, counting Config, validation, branch, merge, loop, and error nodes. If gates require additional nodes, extract a named helper sub-workflow and include its import/binding in README; never hide multiple nodes in one table row.

### Script Rules

Every Python file under `scripts/` follows these rules; review rejects a script that breaks one. Tasks state each script's interface and test cases, and the code lives only in the repo, so the plan cannot drift from it.

1. Python 3.11 or later, standard library only. No pip.
2. One responsibility per module. A runnable script is a thin `main(argv) -> int` that parses arguments, loads settings, wires the real adapters, calls the core, prints, and returns an exit code. Only `main` touches `sys.argv`, the environment, the clock, the filesystem, or the network.
3. Functional core, I/O shell. Functions that build request bodies, compare schemas, or judge responses take data and return data. Time arrives as an argument (`now_iso`).
4. Dependencies are passed in. Qdrant access is a `QdrantCall` and HTTP is a `Send`; only `main` builds the real ones, and tests pass fakes. No other seams: a seam exists only where a real and a fake adapter both exist.
5. Importing a module has no side effects. Entry points sit under `if __name__ == "__main__": sys.exit(main())`. No module-level mutable state.
6. Typed signatures on every public function. Settings and results are frozen dataclasses. Core code raises a specific exception (`MissingSetting`, `HttpError`, `SchemaDrift`, `SmokeFailure`, and so on); only `main` turns it into a one-line message on stderr and a nonzero exit.
7. Composition over inheritance. No class hierarchies, so substitutability holds by construction; exception types are the only subclasses.
8. Every module with logic has `scripts/test_<module>.py` (`unittest`, no network). Scripts that call live services are acceptance checks and say so in their docstring.
9. Flat imports (`from env import load_settings`). `scripts/` is not a package; each script runs as `python3 scripts/<name>.py` from any working directory, and tests run with `python3 -m unittest discover -s scripts`.
10. No `eval`, no shell-outs, no JSON built by string concatenation. Bodies are dicts, serialized once in `transport`.
11. Anything destructive is name-guarded: only the smoke script deletes a collection, and only one with its own prefix.

## Review Focus

1. A PDF whose text extraction is empty (scanned image) must still yield a point: stage 1, amount `null`, digest line with `?`, aggregates exclude it, no crash. Pinned in Task 4 (`view.test.js`, "empty regex fields").
2. The vision model returning `amount` as a formatted string (`"12.300,00 €"` or `"4,250.00"`) must coerce to a number, never reach aggregates as `NaN`. Pinned in Task 4 (`validate.test.js`, "german string amount" and "a lone separator before three digits").
3. The same customer slug under two managers must produce two different points and two different Data Table rows. Pinned in Task 4 (`ids.test.js`) and Task 6 (two seeded managers).
4. A card whose `stage` drops after a new PDF must re-blur, and a changed `latest.amount` must re-render in place. Pinned in Task 9 (`app.test.js`, "stage drop re-blurs").
5. A search with no matches must return an empty list and the dashboard must show "no matches" without dimming every card. Pinned in Task 8 (search returns `[]`) and Task 9 (`app.test.js`, "empty search").

---

### Task 1: Repo Scaffold, Shared Script Modules, and Collection Setup

**Files:**
- Done: `.gitignore` (commit `736caea`)
- Create: `.env.example`, `LICENSE` (Apache-2.0, same as Clelia's `AstraBert/n8n-discord-bot` so the two booth repos match)
- Create: `scripts/env.py`, `scripts/transport.py`, `scripts/qdrant_api.py`, `scripts/schema.py`, `scripts/setup_collection.py`
- Test: `scripts/test_env.py`, `scripts/test_transport.py`, `scripts/test_qdrant_api.py`, `scripts/test_schema.py`, `scripts/test_setup_collection.py`; then two live runs against the cluster

**Interfaces** (every later script builds on these):
- `env.py`: `parse_dotenv(text: str) -> dict[str, str]`; `load_settings(required: Iterable[str], env_file: Path = <repo>/.env, environ: Mapping[str, str] = os.environ) -> Settings`. `Settings` is a frozen dataclass with `qdrant_url`, `qdrant_api_key`, `openrouter_api_key`, `openrouter_model`, `pdf_engine` (default `native`), `n8n_base_url`. Real environment variables override the file. A missing file is fine. Missing or empty required keys raise `MissingSetting` naming all of them. URLs lose a trailing slash. A non-comment line without `=` raises `ValueError` with its line number.
- `transport.py`: `send(method: str, url: str, *, headers: Mapping[str, str] | None = None, body: Any = None, timeout: float = 30.0) -> Any`. Serializes `body` as JSON, returns the decoded JSON response, or `None` for an empty body. Non-2xx raises `HttpError` carrying `status`, decoded `body`, `method`, and `url`. Network failure, timeout, or a non-JSON 2xx body raises `TransportError`. Type alias `Send` is this signature.
- `qdrant_api.py`: `connect(settings: Settings, send: Send = transport.send) -> QdrantCall`, where `QdrantCall = Callable[[str, str, Any], Any]` is `call(method, path, body=None)`. It prefixes `settings.qdrant_url`, adds the `api-key` header, and returns the response's `result` field. `HttpError` propagates unchanged.
- `schema.py`: constants `COLLECTION = "customers"`, `SHARD_KEYS = ("m_anna", "m_ben")`, `MODELS` (`summary`, `digest`, `bm25` mapped to the three exact model strings), `PAYLOAD_INDEXES` (the nine field schemas below, in order). Pure functions: `collection_spec() -> dict` (the `PUT /collections/{name}` body); `drift(info: dict) -> list[str]` (human-readable mismatches between a `GET /collections/{name}` result and the spec, `[]` when compatible); `missing_indexes(info: dict) -> list[str]`.
- `setup_collection.py`: `ensure_collection(call: QdrantCall, name: str = COLLECTION) -> list[str]` returns the actions it took (`[]` when nothing was missing). Raises `SchemaDrift(mismatches)` before any write when an existing collection is incompatible, and again if the state read back after writing is still incomplete. `main(argv) -> int` accepts `--collection NAME`.

Payload indexes, in order: `manager_id` keyword with `is_tenant: true`; `worker_id` keyword; `customer_id` keyword; `deleted_at` datetime; `last_invoice_at` datetime; `updated_at` datetime; `stage` integer; `invoices[].status` keyword; `invoices[].amount` float.

- [x] **Step 1: Write `.env.example`**

```bash
# .env.example  (copy to .env, never commit .env)
QDRANT_URL=https://xxxx.cloud.qdrant.io:6333
QDRANT_API_KEY=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-haiku-5.5
PDF_ENGINE=native
N8N_BASE_URL=https://yourname.app.n8n.cloud
```

- [x] **Step 2: Write the failing tests** (stdlib `unittest`, no network)

`test_env.py`:
- parses `KEY=value`, skips blank lines and `#` comments, strips one pair of matching surrounding quotes, keeps `=` inside a value
- a line without `=` raises `ValueError` naming the line number
- environment overrides the file; a nonexistent file with keys in the environment works
- missing and empty required keys raise one `MissingSetting` naming every missing key
- `QDRANT_URL` and `N8N_BASE_URL` lose a trailing slash; `pdf_engine` defaults to `native`

`test_transport.py` (a stdlib `http.server` on `127.0.0.1`, ephemeral port, in a thread):
- 200 with a JSON body is decoded; the request carried the JSON body, `content-type: application/json`, and the passed headers
- 404 raises `HttpError` with `status == 404` and the decoded error body
- an empty 2xx body returns `None`
- a non-JSON 2xx body raises `TransportError`
- a refused connection raises `TransportError`

`test_qdrant_api.py` (fake `send` that records its arguments):
- calls `QDRANT_URL + path` with the `api-key` header and the given body, returns `result`
- `HttpError` from `send` propagates unchanged

`test_schema.py`:
- `collection_spec()` has `summary` 384 Cosine, `digest` 96 Cosine with `max_sim`, sparse `bm25` with `idf`, `sharding_method: custom`
- `drift()` of an info dict shaped like Qdrant's `GET /collections/{name}` result for the spec is `[]`
- `drift()` reports, one line each: wrong size, wrong distance, missing multivector comparator, missing sparse modifier, sharding not custom, an existing index with the wrong `data_type`, `manager_id` without `is_tenant`
- `missing_indexes()` lists absent fields in `PAYLOAD_INDEXES` order

`test_setup_collection.py` (an in-memory fake `QdrantCall` that stores collections, shard keys, and indexes, and records every call):
- empty cluster: creates the collection, both shard keys, and nine indexes, returning those actions; a second run returns `[]` and makes only reads
- compatible collection missing one shard key and one index: creates exactly those two
- drifted collection: raises `SchemaDrift` listing the mismatches, makes no write
- a non-404 `HttpError` on the first read propagates (an auth failure is not a missing collection)
- a fake that ignores `sharding_method` on create: the read-back raises `SchemaDrift`

- [x] **Step 3: Run the tests, verify they fail**

Run: `python3 -m unittest discover -s scripts`
Expected: every test module errors with `ModuleNotFoundError`.

- [x] **Step 4: Implement the five modules**

`ensure_collection` runs in this order: read the collection (404 means create it from `collection_spec()`); compare with `drift()` and stop on any mismatch; read `GET /collections/{name}/shards` and create each missing key with `PUT /collections/{name}/shards`; create each of `missing_indexes()` with `PUT /collections/{name}/index?wait=true`; read the collection and shard keys back and raise `SchemaDrift` unless drift, missing indexes, and missing keys are all empty. `main` prints each action, then `customers ok: custom sharding, shard keys m_anna m_ben, 9 indexes`.

- [x] **Step 5: Run the tests, verify they pass**

Run: `python3 -m unittest discover -s scripts`
Expected: `OK`.

- [x] **Step 6: Run against the cluster twice** (first live write; confirm before running)

Run: `python3 scripts/setup_collection.py && python3 scripts/setup_collection.py`
Expected: the first run prints the collection, two shard keys, and nine indexes as created, then the `ok` line; the second run prints only the `ok` line.

The shard listing follows [Qdrant's list-shard-keys response](https://api.qdrant.tech/api-reference/distributed/list-shard-keys). If the cluster rejects `sharding_method: custom`, stop: the payload-only fallback removes `shard_key` from every body in `bodies.py` and every workflow, keeps every tenant payload filter, is noted in the README, and cuts the Edge plan. An authentication or permission failure is not evidence that sharding is unavailable.

- [x] **Step 7: Commit**

```bash
curl -sSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE
git add .env.example LICENSE scripts
git commit -m "feat(scripts): settings, transport, collection schema, and idempotent setup"
```

---

### Task 2: Reference Request Bodies and the Smoke Test

**Files:**
- Create: `scripts/bodies.py`, `scripts/smoke.py`, `scripts/test_bodies.py`, `scripts/test_smoke.py`
- Test: unit tests, then `python3 scripts/smoke.py` against the cluster

**Interfaces:**
- `bodies.py` is the source of truth for every Qdrant request shape. Tasks 6, 8, and 11 rebuild these bodies in n8n expressions and must produce the same JSON; `python3 scripts/bodies.py` prints each one with sample arguments for comparison. Pure functions, each returning a dict:
  - `upsert(manager: str, point_id: str, payload: dict, texts: Mapping[str, str]) -> dict`: one point, three inference vectors using `schema.MODELS`
  - `live_scroll(manager: str, overdue_gte: float | None = None, limit: int = 50) -> dict`: tenant match, `is_empty deleted_at`, ordered by `last_invoice_at` desc; adds the nested `invoices` filter (status overdue and amount `gte`) only when `overdue_gte is not None`, so `0` is a real threshold
  - `removed_scroll(manager: str, limit: int = 50) -> dict`: tenant match, `must_not is_empty deleted_at`
  - `customer_scroll(manager: str, customer: str) -> dict`: one point by tenant and slug, full payload
  - `hybrid_query(manager: str, text: str, now_iso: str, limit: int = 5) -> dict`: the spec section 11 request, `with_payload: ["customer_id", "invoices"]`
  - `purge(manager: str, customer: str, cutoff_iso: str) -> dict`: delete filter on `manager_id`, `customer_id`, and `deleted_at` range `lt` cutoff
- `smoke.py` (acceptance script): `smoke_collection_name(now_iso: str, suffix: str) -> str` returns `invoice_memory_smoke_<yyyymmddHHMMSS>_<suffix>`; `fixture_points(now_iso: str) -> list[Fixture]` returns frozen `Fixture(manager, point_id, payload, texts)` values, and `with_deleted_at(fixture, iso_or_none) -> Fixture` returns a copy with the tombstone set or cleared; `run_smoke(call: QdrantCall, collection: str, now_iso: str) -> list[str]` returns the names of passed checks or raises `SmokeFailure(check, detail)`; `drop_smoke_collection(call, name)` raises `ValueError` for any name without the smoke prefix, including `customers`. `main` always drops the collection in `finally`.

Fixtures:
- `m_anna/smoke`: one overdue invoice of 12300.00, items "Hetzner servers"
- `m_anna/decoy`: an overdue invoice of 500.00 and a paid invoice of 20000.00 (each condition holds on a different invoice, so the nested filter must reject it)
- `m_ben/smoke`: the same slug under the other manager, an overdue invoice of 15000.00

Checks, in order:
1. `setup`: `ensure_collection(call, collection)` creates the disposable collection with the production schema; no fixture slug exists yet
2. `upsert`: all three fixtures upsert with inference (`wait=true`)
3. `nested`: `live_scroll("m_anna", 10000)` returns exactly `smoke`; the decoy is excluded
4. `tenant`: `live_scroll("m_ben")` returns only `m_ben` points
5. `hybrid`: `hybrid_query("m_anna", "servers", now)` ranks `smoke` first and returns only `m_anna` points
6. `soft_delete`: re-upserting `m_anna/smoke` with `deleted_at` 40 days ago removes it from `live_scroll` and adds it to `removed_scroll`
7. `restore`: re-upserting it without `deleted_at` brings it back with no `deleted_at` in the payload
8. `purge`: after a second soft delete, `purge("m_anna", "smoke", <now minus 30 days>)` deletes it; `m_anna/decoy` and `m_ben/smoke` survive

- [x] **Step 1: Write the failing tests**

`test_bodies.py`:
- `hybrid_query("m_anna", "servers", "2026-10-14T00:00:00Z")` equals the spec section 11 exhibit, apart from `with_payload`
- every builder that takes a manager sets `shard_key` to it and filters `manager_id` on it
- `live_scroll` without a threshold has no `nested` condition; with `0` it has one with `gte: 0`
- `removed_scroll` puts `is_empty deleted_at` under `must_not`
- `purge` filters `manager_id`, `customer_id`, and `deleted_at` `lt` the cutoff, and nothing broader
- `upsert` uses the three exact model strings from `schema.MODELS`

`test_smoke.py`:
- `smoke_collection_name` matches `^invoice_memory_smoke_\d{14}_\w+$`
- `drop_smoke_collection` raises for `customers` and for an unprefixed name, without calling Qdrant
- fixture point ids are distinct, fixed, valid UUIDs
- the decoy has an overdue invoice and an invoice of at least 10000, never both on one invoice

- [x] **Step 2: Run, verify they fail; implement `bodies.py` and `smoke.py`; run, verify they pass**

Run: `python3 -m unittest discover -s scripts`
Expected: failures first, then `OK`.

- [x] **Step 3: Run the smoke test against the cluster**

Run: `python3 scripts/smoke.py`
Expected: eight `ok <check>` lines, then `SMOKE PASSED`; the smoke collection is gone afterwards (`GET /collections` lists no `invoice_memory_smoke_` name). Failure modes and what to change: `upsert` rejects an inference model, so check the cluster's Inference tab and change the string in `schema.MODELS`; `hybrid` rejects `nearest` inside `prefetch`, so move the inference object to `"query": {"text": ..., "model": ...}` per the error message and update `bodies.hybrid_query` and spec section 11; `nested` fails, so check that the `invoices[].status` index exists.

- [x] **Step 4: Commit**

```bash
git add scripts/bodies.py scripts/smoke.py scripts/test_bodies.py scripts/test_smoke.py
git commit -m "test(scripts): reference request bodies and a disposable-collection smoke test"
```

---

### Task 3: OpenRouter PDF Gate

**Files:**
- Create: `scripts/openrouter_check.py`, `scripts/test_openrouter_check.py`
- Test: unit tests, then one live call with a synthetic sample

**Interfaces:**
- `REQUIRED_FIELDS`: `invoice_no`, `date`, `due_date`, `amount`, `vendor`, `customer_name`, `status`, `line_items_summary`
- `extraction_body(pdf: bytes, model: str, engine: str) -> dict`: the exact body Task 7's vision node sends (temperature 0, `max_tokens` 400, `response_format` a strict `json_schema` from `invoice_schema()` with all eight fields required, `amount` a number, and `status` an enum, the `file-parser` plugin with the engine, the system prompt, and the PDF as a base64 data URL)
- `parse_reply(response: dict) -> dict`: returns the extracted fields; raises `ExtractionError` when there are no choices, the content is not bare JSON (a fenced code block fails, as it would in n8n's `JSON.parse`), or fields are missing (naming all of them)
- `require_synthetic(path: Path, samples_dir: Path) -> Path`: raises `ValueError` unless the resolved path is a PDF inside `samples/`, so no real invoice is ever sent
- `main(argv)`: `python3 scripts/openrouter_check.py samples/acme-001.pdf` sends with the `Authorization: Bearer` header and a 35 s timeout, prints the fields as JSON and `latency_ms` measured with `time.monotonic`

- [x] **Step 1: Write the failing tests** for each interface line above: the body's model, temperature, strict schema (all eight fields required, no extras, a fresh copy per body), plugin engine, data URL decoding back to the input bytes, and all eight field names in the system prompt; `parse_reply` on a good reply, no choices, fenced JSON, and two missing fields; `require_synthetic` on a sample, a path outside `samples/`, and a `..` escape.

- [x] **Step 2: Run, verify they fail; implement; run, verify they pass**

Run: `python3 -m unittest discover -s scripts`

- [x] **Step 3: Run with a synthetic fixture** (after Task 5 produces the samples)

Run: `python3 scripts/openrouter_check.py samples/acme-001.pdf`
Expected: the eight fields with `amount` 12300 and `latency_ms` under 30000. If the model rejects `file` input, open `https://openrouter.ai/models`, pick the cheapest mid-tier model that lists PDF input and `response_format`, set it in `.env`, rerun. If none works, set `PDF_ENGINE=pdf-text` in `.env` (text extraction instead of vision) and strike the word "vision" from `booth/script.md` in Task 13.

Result on 2026-10-09 with `anthropic/claude-haiku-5.5`, engine `native`: `acme-001.pdf` read as 12300 in 13.5 s and `beta-001.pdf` as 18750 in 8.7 s, both German-format totals. With `response_format: json_object` alone the model wrapped its JSON in a code fence, which n8n's `JSON.parse` would reject; the strict `json_schema` returns bare JSON.

- [x] **Step 4: Commit**

```bash
git add scripts/openrouter_check.py scripts/test_openrouter_check.py
git commit -m "test(openrouter): PDF input and JSON mode gate for the pinned model"
```

---

### Task 4: Code-Node Sources with Node Tests

**Files:**
- Create: `workflows/code/ids.js`, `coarse.js`, `validate.js`, `view.js`, `cards.js`, `match.js`, one `*.test.js` beside each, and `paste.test.js`
- Test: `node --test workflows/code/*.test.js`

**Interfaces** (CommonJS exports for the tests; each n8n Code node pastes the file without its `module.exports` line and calls the function):
- `ids.js`: `uuidFromHex(hex: string): string` throws unless given at least 32 hex characters; `resolveUpload(sampleFile, workerId, workers): {customer_id, worker_id, manager_id}` throws `no customer slug` or `unknown worker` (own keys only)
- `coarse.js`: `coarseRead(text): {invoice_no, date, due_date, amount: number|null, vendor}`, deliberately wrong on German number format
- `validate.js`: `toNumber(v): number` (the later of `,` and `.` is the decimal point; a lone separator before exactly three digits, or a repeated one, is a thousands separator; nothing numeric is `NaN`, never 0); `validateFields(obj)` returns exactly the eight contract fields with a numeric `amount` and a lowercased `status`, and throws on a missing field, nonnumeric amount, unknown status, or non-ISO date
- `view.js`: `computeView(customer, invoiceRows, nowIso): {payload, texts: {summary, digest, bm25}}`; `payload.source_revision` fingerprints the rows and a narrative is used only when its revision matches, every invoice is sharp, and none is pending
- `cards.js`: `shapeCards(points, workers): Card[]` and `splitRemoved(cards): {cards, removed}` with `purge_at` 30 days after `deleted_at`
- `match.js`: `pickMatchedLine(q, invoices): string|null`

The sources live only in the repo; the tests below are the contract.

- [x] **Step 1: Write the tests first**

- `ids.test.js`: UUID shape (version 4, variant 8), determinism, different input gives a different id; short, non-hex, and missing input throw; slug and manager from `Acme-001.pdf`; unknown worker and a file with no slug throw.
- `coarse.test.js`: the English sample parses every field; the German total reads as 12.3 (the booth moment); empty or missing text gives all nulls.
- `validate.test.js`: `12.300,00 €` and `4,250.00`; `12,300`, `12.300`, and `12,300 EUR` are 12300; `12.5`, `12,5`, and `-3,50` keep decimals; `1.234.567,89`, `1,234,567.89`, and `1,234,567`; empty, null, and words are `NaN`; summary trimmed to 120; extra model keys dropped; ` Overdue ` normalized; bad status, missing vendor, nonnumeric amount, and a non-ISO due date throw.
- `view.test.js`: coarse rows use regex fields and sharp rows use LLM fields, with stage, pending, counts, open and overdue sums, `latest` (with `id`), `last_invoice_at`, and the digest line; empty regex fields still yield a point (Review Focus 1); an error row counts as coarse, not pending; a fresh narrative is used and stale, late, or changed-row narratives are not; the revision ignores row order; `deleted_at` is carried; zero rows give an empty valid view.
- `cards.test.js`: rung 3 with a fresh narrative, rung follows stage otherwise, unknown worker falls back to its id, `latest.id` survives, `purge_at` is 30 days on.
- `match.test.js`: best overlapping line, no overlap, missing invoices, short tokens ignored.
- `paste.test.js`: each file, with `module.exports` removed, runs in a bare `vm` context with no `require` and defines its functions; all six pasted into one context do not clash.

- [x] **Step 2: Run the tests, verify they fail**

Run: `node --test workflows/code/*.test.js`
Expected: every file fails with `Cannot find module`.

- [x] **Step 3: Write the implementations**

- [x] **Step 4: Run the tests, verify they pass**

Run: `node --test workflows/code/*.test.js`
Expected: `pass 40`, `fail 0`.

- [x] **Step 5: Commit**

```bash
git add workflows/code
git commit -m "feat(code): pure functions for n8n Code nodes with node tests"
```

---

### Task 5: Synthetic Invoices

**Files:**
- Create: `samples/gen.py`, `samples/test_gen.py`, `samples/print.sh`
- Generated: `samples/html/*.html` (ignored), `samples/manifest.json`, `samples/*.pdf` (committed: the Form downloads them from the repo's raw URL)
- Test: `python3 -m unittest discover -s samples`

**Interfaces** (`gen.py` follows the Script Rules: pure core, thin `main`, no side effects on import):
- `CUSTOMERS`: slug to `(worker_id, display name)`; `INVOICES`: 14 frozen `Invoice` values; `BOOTH_DATE = "2026-10-14"`
- `money(amount, number_format) -> str`: `12.300,00 €` for `de`, `4,250.00 EUR` for `en`
- `render_html(invoice) -> str`: one page with every value HTML-escaped; labels stay English (`Invoice No:`, `Date:`, `Due date:`, `From:`, `Total:`) so the coarse regex can find them, while German invoices get the `RECHNUNG` title and German numbers
- `build() -> (pages, manifest)`: 13 pages (the duplicate is copied as a PDF, not rendered) and 14 manifest rows `{file, worker_id, customer, invoice_no, expected_amount, status, items, format[, duplicate_of]}`. The Form dropdown in Task 7 lists the `file` values; Task 12 checks ingest against `expected_amount` and `status`.
- `print.sh`: prints each page with headless Chrome, stops if a PDF comes out empty, copies `beta-003.pdf` to `beta-004.pdf` so their bytes match

Data rule: every printed status agrees with its due date on `BOOTH_DATE`, so a model that reasons from dates and one that reads the printed status give the same answer. The plan's original data broke this for `beta-002` (due 10-12, open) and `delta-001` (due 10-02, open); their due dates moved to 10-26 and 10-30, and no status or amount changed.

- [x] **Step 1: Write the tests** (`samples/test_gen.py`, no files written)
- corpus shape: 14 unique files, 2 German, 6 customers, 4 workers
- exactly one duplicate, `beta-004` of `beta-003`, identical apart from the file name
- every file name starts with its customer slug and a hyphen (`resolveUpload` depends on it)
- overdue at 10000 or more hits exactly acme and beta
- among Anna's workers, `servers` hits {acme}, `consulting` {beta}, `licenses` {acme, gamma}
- statuses agree with due dates on `BOOTH_DATE`
- 13 pages, each with its invoice number, due date, customer name, and formatted total; the German pages show `12.300,00 €` and `18.750,00 €` under `RECHNUNG`; markup in a field is escaped
- `money` in both formats

- [x] **Step 2: Run, verify they fail; implement `gen.py`; run, verify they pass**

Run: `python3 -m unittest discover -s samples`
Expected: `ModuleNotFoundError` first, then `OK` (11 tests).

- [x] **Step 3: Print the PDFs**

Run: `python3 samples/gen.py && samples/print.sh`
Expected: `wrote 13 pages and 14 manifest rows`, `14`, then two identical SHA-256 lines for `beta-003.pdf` and `beta-004.pdf`.

- [x] **Step 4: Read the printed PDFs back**

Run `coarseRead` from Task 4 over `pdftotext` output for all 14 PDFs (n8n's extractor differs, so this is a layout check, not proof of n8n behavior). Expected: every invoice number, both dates, and the vendor parse; English totals are exact; the German totals read 12.3 and 18.75 (the booth moment). Then complete Task 3 Step 3 against `samples/acme-001.pdf`.

- [x] **Step 5: Commit**

```bash
git add samples/gen.py samples/test_gen.py samples/print.sh samples/manifest.json samples/*.pdf
git commit -m "feat(samples): 14 synthetic invoice PDFs, two in German number format, one byte-identical duplicate"
```

---

### Task 6: Data Tables and Workflow 03 Rebuild Point

**Files:**
- Create in n8n Cloud: Data Tables `invoices`, `customers`; workflow `03 Rebuild point`
- Export: `workflows/03-rebuild-point.json`
- Create: `scripts/check_point.py`, `scripts/test_check_point.py`
- Test: unit tests, then `scripts/check_point.py` against a hand-seeded customer

**Interfaces:**
- Consumes: `computeView`, `uuidFromHex` from Task 4 (pasted).
- Produces: sub-workflow `03 Rebuild point` with inputs `customer_id` (string), `manager_id` (string); on completion the Qdrant point for that customer reflects the Data Tables. Every later workflow calls it with exactly those two inputs.

- [ ] **Step 1: Create the Data Tables in the n8n project** (UI, Data tables tab)

`invoices`: custom columns `invoice_id` string, `customer_id` string, `worker_id` string, `manager_id` string, `pdf_hash` string, `filename` string, `text` string, `stage` number, `regex_fields` string, `llm_fields` string, `error` string, `received_at` dateTime.

`customers`: columns `customer_id` string, `worker_id` string, `manager_id` string, `name` string, `deleted_at` dateTime, `narrative` string, `narrative_at` dateTime, `narrative_revision` string.

Seed two rows by hand in `customers`: (`acme`, `w_tom`, `m_anna`, `Acme GmbH`) and (`acme`, `w_jules`, `m_ben`, `Acme GmbH`). Seed one row in `invoices` for each: invoice_id `inv_seed_a` / `inv_seed_b`, stage `1`, `regex_fields` = `{"invoice_no":"INV-4711","amount":12.3,"status":"open"}`, `text` = `seed`, `received_at` = now.

- [ ] **Step 2: Write `scripts/check_point.py`** test-first (the point check for this and later tasks)

Interface:
- `get_path(payload: dict, path: str) -> Any`: dot path where integer segments index lists (`latest.amount`, `invoices.0.error`); a missing segment raises `KeyError` naming the path
- `parse_expectation(text: str) -> tuple[str, Any]`: splits on the first `=`; the value parses as JSON, falling back to the raw string (`stage=1` gives `1`, `worker_id=w_tom` gives `"w_tom"`)
- `failures(payload: dict, expects: Mapping[str, Any], present: Iterable[str], absent: Iterable[str]) -> list[str]`: one line per unmet expectation, `[]` when all hold
- `main(argv)`: `python3 scripts/check_point.py MANAGER CUSTOMER [--show a,b] [--expect path=value]... [--present path]... [--absent path]...` reads the point with `bodies.customer_scroll`. With no flags it prints the payload as JSON. `--show` prints `path=value` pairs on one line. Exit 0 when every expectation holds (prints `ok`), 1 with each failure printed, 2 with `no point for MANAGER/CUSTOMER`.

Tests: `get_path` on nested dicts, list indexes, and a missing path; `parse_expectation` on integer, float, string, and a value containing `=`; `failures` on a matching payload, a wrong value, and `present`/`absent` both ways.

Run: `python3 -m unittest discover -s scripts`, then `python3 scripts/check_point.py m_anna acme`
Expected: `OK`, then `no point for m_anna/acme` with exit 2 (the workflow doesn't exist yet).

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

Code node 6 builds the same JSON as `bodies.upsert` (compare with `python3 scripts/bodies.py`). Paste `workflows/code/ids.js` and `view.js` whole, each without its `module.exports` line (the helpers inside them are needed), then:

```js
const cfg = $('Config').first().json;
const customers = $('Load the customer row').all().map(i => i.json).filter(r => r.customer_id);
const invoices = $('Load all invoice rows').all().map(i => i.json).filter(r => r.invoice_id);
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

Run: `python3 scripts/check_point.py m_anna acme --expect stage=1 --expect latest.amount=12.3 --expect worker_id=w_tom`
Run: `python3 scripts/check_point.py m_ben acme --expect worker_id=w_jules`
Expected: both print `ok`. Two points exist for slug `acme` (Review Focus 3).

- [ ] **Step 5: Export and scrub**

Download the workflow JSON to `workflows/03-rebuild-point.json`. Open it and confirm: no `"id"` inside any `credentials` block that is an instance-specific id (keep only `"name"`), no cluster URL except in the `Config` node (set its value to `https://REPLACE.cloud.qdrant.io:6333`). Pin the trigger's test input before export so an importer sees items.

Run: `grep -c 'cloud.qdrant.io' workflows/03-rebuild-point.json`
Expected: `1`.

- [ ] **Step 6: Commit**

```bash
git add workflows/03-rebuild-point.json scripts/check_point.py scripts/test_check_point.py
git commit -m "feat(n8n): 03 Rebuild point sub-workflow; point check script"
```

---

### Task 7: Workflows 01 Ingest, 02 Process, 02b Write the Narrative

**Files:**
- Create in n8n Cloud: `01 Ingest`, `02 Process`, `02b Write the narrative`
- Export: `workflows/01-ingest.json`, `workflows/02-process.json`, `workflows/02b-narrative.json`
- Test: Form submission, then `scripts/check_point.py` polled

**Interfaces:**
- Consumes: `03 Rebuild point` (inputs `customer_id`, `manager_id`); `resolveUpload`, `coarseRead`, `validateFields` from Task 4; OpenRouter body from Task 3; `samples/manifest.json` file names.
- Produces: a public Form URL (the QR); `02 Process` inputs `invoice_id`, `customer_id`, `manager_id`, `sample_url` (JSON only); `02b` inputs `customer_id`, `manager_id`.

- [ ] **Step 1: Build `02b Write the narrative`** (sub-workflow, 10 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | When Executed by Another Workflow | Fields: `customer_id`, `manager_id` |
| 2 | Config | `QDRANT_URL`, `COLLECTION`, `OPENROUTER_MODEL`. Include other input fields: on |
| 3 | Hash the point id | Crypto SHA256 of `={{ $json.manager_id }}/{{ $json.customer_id }}` → `idhash` |
| 4 | Format the point id | Code: paste `ids.js` (without `module.exports`); `return [{json:{id:uuidFromHex($json.idhash), ...$('Config').first().json}}];` |
| 5 | Read the point | HTTP POST to Config Qdrant collection `/points`, body `={{ JSON.stringify({shard_key:$json.manager_id, ids:[$json.id], with_payload:true}) }}`, Header Auth Qdrant |
| 6 | Prepare the narrative snapshot | Code: `const cfg = $('Config').first().json; const p = $json.result?.[0]?.payload; if (!p || p.manager_id !== cfg.manager_id || p.customer_id !== cfg.customer_id) throw new Error('missing tenant point'); if (p.stage !== 2 || p.pending_count !== 0) return []; return [{json:{payload:p}}];` |
| 7 | Ask for three sentences | HTTP Request POST `https://openrouter.ai/api/v1/chat/completions`, Header Auth `OpenRouter bearer`, body: see below |
| 8 | Keep only the narrative | Code: `const c = JSON.parse($json.choices[0].message.content); if (typeof c.narrative !== 'string' || c.narrative.length < 20) throw new Error('bad narrative'); return [{json:{narrative: c.narrative.slice(0,600), at: new Date().toISOString(), revision: $('Prepare the narrative snapshot').first().json.payload.source_revision}}];` |
| 9 | Save the narrative | Data Table `customers`, Update rows where `customer_id` equals and `manager_id` equals (from Config); set `narrative` from `$json.narrative`, `narrative_at` from `$json.at`, `narrative_revision` from `$json.revision` |
| 10 | Rebuild the point | Execute Sub-workflow `03 Rebuild point`, wait on, inputs `customer_id`, `manager_id` from Config |

Node 7 body (JSON expression):

```js
={{ JSON.stringify({
  model: $('Config').first().json.OPENROUTER_MODEL, temperature: 0, max_tokens: 300,
  response_format: { type: 'json_schema', json_schema: { name: 'narrative', strict: true, schema: {
    type: 'object', additionalProperties: false, required: ['narrative'],
    properties: { narrative: { type: 'string' } } } } },
  messages: [
    { role: 'system', content: 'You write for a manager. Three plain sentences about this customer: what is open, what is overdue, what changed most recently. No bullet points. Return JSON only: {"narrative": "..."}' },
    { role: 'user', content: 'Aggregates: ' + JSON.stringify((({invoice_count,open_amount,overdue_count,overdue_amount,last_invoice_at}) => ({invoice_count,open_amount,overdue_count,overdue_amount,last_invoice_at}))($json.payload)) + '\nInvoices:\n' + $json.payload.invoices.map(i => `${i.invoice_no} | ${i.date} | ${i.amount} EUR | due ${i.due_date} | ${i.status} | ${i.items}`).join('\n') }
  ]}) }}
```

Node 7 settings: Timeout 20000 ms, Retry on fail 1. Node 8 settings: On Error → Stop workflow (a bad narrative leaves the point at rung 2, by design).

The snapshot revision is captured before the model call and stored with its narrative. Rebuild uses it only if current rows still have the identical revision and every invoice is sharp; a completion timestamp cannot make an old snapshot fresh. Test both a newly arrived invoice and a coarse-to-sharp transition while a narrative is in flight.

- [ ] **Step 2: Build `02 Process`** (sub-workflow, 15 nodes, the cap)

| # | Node | Settings |
|---|---|---|
| 1 | When Executed by Another Workflow | Fields: `invoice_id`, `customer_id`, `manager_id`, `sample_url` |
| 2 | Config | `OPENROUTER_MODEL`, `PDF_ENGINE`. Include other input fields: on |
| 3 | Show the point as received | Execute Sub-workflow `03 Rebuild point`, wait on, `customer_id`, `manager_id` |
| 4 | Download the PDF for processing | HTTP Request GET `={{ $('Config').first().json.sample_url }}`, response File, binary `data`; validate URL against Config's sample base and allowlist before requesting |
| 5 | Read the PDF as base64 | Code: `const item = $input.first(); const buffer = await this.helpers.getBinaryDataBuffer(0, 'data'); return [{json:{b64: buffer.toString('base64')}, binary: item.binary}];` |
| 6 | Pull the text out of the PDF | Extract from File, operation PDF, binary `data`; empty text is valid |
| 7 | Coarse read with regex | Code: paste `coarse.js` (without `module.exports`); `const text = $json.text || ''; return [{json:{regex_fields: JSON.stringify(coarseRead(text)), text}}];` |
| 8 | Update the row: stage 1 | Data Table `invoices`, Update where `invoice_id` equals `={{ $('Config').first().json.invoice_id }}`: `stage` = 1, `regex_fields`, `text` |
| 9 | Show the coarse view | Execute Sub-workflow `03 Rebuild point` |
| 10 | Ask the vision model to read the PDF | HTTP Request POST OpenRouter, Header Auth `OpenRouter bearer`, Timeout 30000, Retry 1, On Error: Continue (using error output). Body below |
| 11 | Validate the fields | Code: paste `validate.js` (without `module.exports`); `const c = JSON.parse($json.choices[0].message.content); return [{json:{llm_fields: JSON.stringify(validateFields(c))}}];` On Error: Continue (using error output) |
| 12 | Update the row: stage 2 | Data Table `invoices` Update where `invoice_id` equals: `stage` = 2, `llm_fields` |
| 13 | Update the row: stage -1 | Data Table `invoices` Update where `invoice_id` equals: `stage` = -1, `error` = `={{ $json.error ? ($json.error.message || JSON.stringify($json.error)) : 'vision failed' }}`. Connected from the error outputs of 10 and 11 |
| 14 | Show the sharp view | Execute Sub-workflow `03 Rebuild point`. Connected from 12 and from 13 |
| 15 | Write the narrative if ready | Execute Sub-workflow `02b Write the narrative`, wait on, mapping tenant and customer from Config; 02b's snapshot gate returns no items unless every invoice is sharp |

Node 10 body (JSON expression):

```js
={{ JSON.stringify({
  model: $('Config').first().json.OPENROUTER_MODEL, temperature: 0, max_tokens: 400,
  response_format: { type: 'json_schema', json_schema: { name: 'invoice', strict: true, schema: {
    type: 'object', additionalProperties: false,
    required: ['invoice_no', 'date', 'due_date', 'amount', 'vendor', 'customer_name', 'status', 'line_items_summary'],
    properties: {
      invoice_no: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' },
      due_date: { type: 'string', description: 'YYYY-MM-DD' }, amount: { type: 'number', description: 'total in EUR' },
      vendor: { type: 'string' }, customer_name: { type: 'string' },
      status: { type: 'string', enum: ['open', 'paid', 'overdue'] },
      line_items_summary: { type: 'string', description: 'max 12 words' } } } } },
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

Renumber the original rows 7 through 13 as 8 through 14 after inserting the download and extraction steps; there are 15 actual nodes including the final narrative call. All Rebuild and invoice update inputs reference Config explicitly, with tenant and customer conditions on invoice updates. Route download, encoding, and extraction error outputs to `Update the row: stage -1` as well. Persist errors as terminal failures, not pending; use separate successful stage-2 output data to avoid reading an unexecuted node. Do not add an IF based on another node's execution flag.

- [ ] **Step 3: Build `01 Ingest`** (12 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | Pick an invoice | Form Trigger. Title "Send an invoice (synthetic data only)". Fields: `sample` dropdown with the 14 file names from `samples/manifest.json`; `worker` dropdown `w_tom`, `w_lena`, `w_jules`, `w_mia`. Respond: Using Form node |
| 2 | Config | `QDRANT_URL`, `COLLECTION`, `SAMPLES_BASE_URL` = `https://raw.githubusercontent.com/<org>/n8n-invoice-memory/main/samples`, `WORKERS` = `{"w_tom":{"manager_id":"m_anna","name":"Tom"},"w_lena":{"manager_id":"m_anna","name":"Lena"},"w_jules":{"manager_id":"m_ben","name":"Jules"},"w_mia":{"manager_id":"m_ben","name":"Mia"}}`, `MANAGERS` = `{"m_anna":"Anna","m_ben":"Ben"}`. Include other input fields: on |
| 3 | Download the chosen sample | HTTP Request GET `={{ $json.SAMPLES_BASE_URL }}/{{ $json.sample }}`, Response format: File, output binary `data` |
| 4 | Hash the PDF | Crypto, Hash SHA256, Binary File: on, binary property `data`, property name `pdf_hash` |
| 5 | Seen this hash before? | Data Table `invoices` Get where `pdf_hash` equals `={{ $json.pdf_hash }}`. Always output data: on |
| 6 | Is it a duplicate? | If: `={{ !!$json.invoice_id }}` |
| 7 | Say it is a duplicate | Form (Form Ending). Completion title "Duplicate", message `=That's {{ $('Seen this hash before?').first().json.filename }} again (hash match). Nothing ingested.` |
| 8 | Resolve the customer and manager | Code: paste `ids.js` (without `module.exports`); `const cfg = $('Config').first().json; const r = resolveUpload(cfg.sample, cfg.worker, JSON.parse(cfg.WORKERS)); const id = 'inv_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); return [{json:{...r, invoice_id: id, sample_url: cfg.SAMPLES_BASE_URL + '/' + cfg.sample, filename: cfg.sample, pdf_hash: $('Hash the PDF').first().json.pdf_hash, received_at: new Date().toISOString().replace(/\.\d{3}Z$/,'Z')}}];` |
| 9 | Upsert the customer row | Data Table `customers`, Insert or Update (match on `customer_id` and `manager_id`): `worker_id`, `name` = `={{ $json.customer_id.charAt(0).toUpperCase() + $json.customer_id.slice(1) }}` only on insert if the node supports it, otherwise set it every time |
| 10 | Append the invoice row | Data Table `invoices`, Insert: `invoice_id` = invoice_id, `customer_id`, `worker_id`, `manager_id`, `pdf_hash`, `filename`, `stage` = 0, `text` = '', `regex_fields` = '{}', `llm_fields` = '{}', `error` = '', `received_at` |
| 11 | Process in the background | Execute Sub-workflow `02 Process`, **Wait for Sub-Workflow Completion: off**, inputs `invoice_id`, `customer_id`, `manager_id`, `sample_url` from `Resolve the customer and manager`; no binary input |
| 12 | Say it was received | Form (Form Ending). Title "Received", message "Watch the dashboard. Rough in two seconds, sharp in thirty." |

Connections: 6 true → 7; 6 false → 8 → 9 → 10 → 11 → 12. Add a 13th node after 10, **disabled**: Google Drive, Upload file, binary `data`, named `Keep the PDF for accounting retention`, with its own sticky "Disabled. Swap for your storage. The PDF outlives a GDPR removal of the searchable record." Sticky on the Form: "No file field on purpose. Samples download from the repo. To accept uploads, add a File field and delete node 3."

Before downloading, validate sample and worker and resolve the tenant. Scope duplicate lookup to `pdf_hash` AND `manager_id` AND `customer_id`, deriving tenant/customer from validated Config rather than a Data Table result. Duplicate means a matching `invoice_id`, not built-in row `id`. Add a validation Code node after Config (14 nodes including the disabled storage example), then renumber. All customer and invoice mappings after Data Table nodes explicitly reference `Resolve the customer and manager`; preserve existing customer narrative, deletion state, and display name. Customer ownership stays with the first worker for this booth corpus. Null is the empty dateTime value, never an empty string. The disabled storage example must reattach the original download binary before enabling it.

- [ ] **Step 4: Test the happy path**

Activate `01 Ingest`. Open the Form URL. Pick `acme-001.pdf`, worker `w_tom`, submit. Note the time.

Run every 5 s for up to 60 s:
`python3 scripts/check_point.py m_anna acme --show stage,pending_count,latest.amount,summary_stage`
Expected sequence: `stage=0 pending_count=1 latest.amount=null summary_stage=1` within 3 s → `stage=1 pending_count=1 latest.amount=12.3 summary_stage=1` within 6 s → `stage=2 pending_count=0 latest.amount=12300 summary_stage=1` within 40 s → `summary_stage=3` a few seconds later. The amount flips from 12.3 to 12300 (the booth moment).

- [ ] **Step 5: Test the duplicate path**

Submit `beta-003.pdf` with `w_tom`, wait 40 s, then submit `beta-004.pdf` with `w_tom`.
Expected: the second submission ends on the "Duplicate" page naming `beta-003.pdf`; `python3 scripts/check_point.py m_anna beta --expect invoice_count=1` prints `ok`.

- [ ] **Step 6: Test the error path**

Temporarily set `Config.OPENROUTER_MODEL` in `02 Process` to `nonexistent/model`, submit `gamma-001.pdf` with `w_lena`.
Expected within 20 s: `python3 scripts/check_point.py m_anna gamma --show stage,invoices.0.error` prints `stage=1` and a non-empty error; the execution list shows `02 Process` finished, not crashed. Restore the model. Delete the gamma rows from both Data Tables and rerun `gamma-001.pdf` so the corpus is clean.

- [ ] **Step 7: Export, scrub, commit**

Export the three workflows, scrub as in Task 6 (no credential ids, `Config` URLs set to placeholders, trigger test data pinned).

```bash
git add workflows/01-ingest.json workflows/02-process.json workflows/02b-narrative.json
git commit -m "feat(n8n): ingest, staged processing, and narrative workflows"
```

---

### Task 8: Workflow 04 Dashboard Reads

**Files:**
- Create in n8n Cloud: `04 Dashboard reads`
- Export: `workflows/04-dashboard-reads.json`
- Create: `scripts/reads_check.py`, `scripts/test_reads_check.py`
- Test: unit tests, then `scripts/reads_check.py` against the two webhooks

**Interfaces:**
- Consumes: `shapeCards`, `splitRemoved`, `pickMatchedLine` from Task 4; `bodies.live_scroll`, `bodies.removed_scroll`, and `bodies.hybrid_query` from Task 2.
- Produces: `GET <N8N_BASE_URL>/webhook/customers?manager=m_anna[&overdue_gte=10000]` → `{cards: Card[], removed: Removed[], latency_ms}`; `GET <N8N_BASE_URL>/webhook/search?manager=m_anna&q=servers` → `{results: [{customer_id, score, matched_line}], latency_ms}`. Task 9 depends on exactly these shapes.

- [ ] **Step 1: Build the list path** (6 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | List this manager's customers | Webhook GET, path `customers`, Respond: Using Respond to Webhook node. Options: Allowed Origins `*` |
| 2 | Config | `QDRANT_URL`, `COLLECTION`, `WORKERS`, `MANAGERS`, `qdrant_started_at` = `={{ Date.now() }}`. Include other input fields: on |
| 3 | Scroll live customers | HTTP Request POST `.../points/scroll`, Header Auth `Qdrant api-key`. Body below. Settings: Include response headers and status: off |
| 4 | Scroll removed customers | same, body differs by one condition (below) |
| 5 | Shape the cards | Code, paste `cards.js` (without `module.exports`); body below |
| 6 | Respond with cards | Respond to Webhook, JSON, `={{ $json }}`, header `Access-Control-Allow-Origin: *` |

Node 3 body:

```js
={{ (() => { const c = $('Config').first().json; const qs = $('List this manager\'s customers').first().json.query;
  const must = [ { key: 'manager_id', match: { value: qs.manager } }, { is_empty: { key: 'deleted_at' } } ];
  if (qs.overdue_gte) must.push({ nested: { key: 'invoices', filter: { must: [ { key: 'status', match: { value: 'overdue' } }, { key: 'amount', range: { gte: Number(qs.overdue_gte) } } ] } } });
  return JSON.stringify({ shard_key: qs.manager, limit: 50, with_payload: true, order_by: { key: 'last_invoice_at', direction: 'desc' }, filter: { must } });
})() }}
```

Nodes 3 and 4 must produce the same JSON as `bodies.live_scroll` and `bodies.removed_scroll` (compare with `python3 scripts/bodies.py`).

Node 4 body: same, but `must` is `[ { key: 'manager_id', match: { value: qs.manager } } ]` and `must_not: [ { is_empty: { key: 'deleted_at' } } ]` and no nested condition.

Node 5 body (after the pasted functions):

```js
const workers = JSON.parse($('Config').first().json.WORKERS);
const live = $('Scroll live customers').first().json.result.points;
const gone = $('Scroll removed customers').first().json.result.points;
const { cards } = splitRemoved(shapeCards(live, workers));
const { removed } = splitRemoved(shapeCards(gone, workers));
return [{ json: { cards, removed, latency_ms: Date.now() - $('Config').first().json.qdrant_started_at } }];
```

- [ ] **Step 2: Build the search path** (5 nodes)

| # | Node | Settings |
|---|---|---|
| 7 | Search three vectors in one request | Webhook GET, path `search`, Respond: Using Respond to Webhook node |
| 8 | Config (search) | Edit Fields, same values as node 2 |
| 9 | Run the hybrid query | HTTP Request POST `.../points/query`, Header Auth. Body: `bodies.hybrid_query` rebuilt as an IIFE like node 3, with `qs.manager`, `qs.q`, and `new Date().toISOString()` as its arguments |
| 10 | Pick the matched line | Code, paste `match.js` (without `module.exports`); `const r = $json.result.points; const q = $('Search three vectors in one request').first().json.query.q; return [{json:{results: r.map(p => ({customer_id: p.payload.customer_id, score: +p.score.toFixed(4), matched_line: pickMatchedLine(q, p.payload.invoices)})).filter(p => p.matched_line !== null), latency_ms: Date.now() - $('Config (search)').first().json.qdrant_started_at}}];` |
| 11 | Respond with matches | Respond to Webhook, JSON, CORS header as node 6 |

Sticky (one, over node 9): "Eight primitives, one request. Tenant filter, is_empty, bm25, ColBERT multivector, dense, inference ×3, RRF, decay formula."

- [ ] **Step 3: Test**

Write `scripts/reads_check.py` test-first. Its pure judges take decoded responses and return failure lines (`[]` on success), and `main` fetches through `transport.send` (catching `HttpError` where a 400 is the expected answer):

- `list_failures(resp, must_include: set[str], max_latency_ms: int)`: envelope has `cards`, `removed`, `latency_ms`; card ids include the expected set; latency within budget
- `filter_failures(resp, expected: set[str])`: card ids equal the expected set exactly
- `isolation_failures(results, tenant_ids: set[str])`: every search hit is one of that manager's live cards
- `search_failures(resp, first: str, term: str, max_latency_ms: int)`: first hit is `first`, its matched line contains the term, latency within budget
- `no_match_failures(resp)`: `results == []`

Tests feed each judge a passing response and one failing response per rule. Then activate the workflow and, with the corpus from Task 7 (at least acme and beta under m_anna):

Run: `python3 scripts/reads_check.py`
Expected: `ok` for each of `list` (acme and beta, under 300 ms), `filter` (`overdue_gte=10000` gives exactly acme and beta), `tenant` (m_ben has no card with worker Tom), `search` (`servers` ranks acme first, under 500 ms), `no-match` (`zebra unicorn` gives `[]`), `isolation` (m_ben's `servers` hits are all m_ben cards), and `validation` (unknown manager, `overdue_gte=-1`, `overdue_gte=abc`, and blank `q` each return 400), then `READS OK`. Timing uses wall milliseconds from the path's Config timestamp through Qdrant response shaping, including Cloud transport and inference.

Config captures `qdrant_started_at = Date.now()` immediately before each Qdrant path, and shaping computes wall elapsed milliseconds. Qdrant `time` is server processing time and must not be presented as Cloud call latency. Add a validation Code node to each read path (13 actual nodes total), before its HTTP request; Config includes `MANAGERS`. Preserve two independent Config references. Search maps candidates to matched lines and returns only rows with a non-null matched line, preserving hybrid rank order. This is an explicit lexical admission rule for the booth exhibit, not a general semantic relevance threshold; a positive RRF score cannot establish relevance. Filter the mapped `results` before response and compute search latency from `Config (search).qdrant_started_at`. Limit 50 is a booth-corpus bound; fail the corpus check if it is exceeded or implement proper ordered-scroll pagination before expanding scope.

- [ ] **Step 4: Export, scrub, commit**

```bash
git add workflows/04-dashboard-reads.json scripts/reads_check.py scripts/test_reads_check.py
git commit -m "feat(n8n): dashboard read webhooks: list with nested filter, hybrid search"
```

---

### Task 9: Dashboard Page

**Files:**
- Create: `dashboard/app.js`, `dashboard/app.test.js`, `dashboard/index.html`, `dashboard/chime.wav`.
- Test: `node --test dashboard/*.test.js` and browser checks below.

**Interfaces:**
- Consumes Task 8 read envelopes `{cards, removed, latency_ms}` and `{results, latency_ms}`, and Task 10's POST `/customers/remove` and `/customers/restore` endpoints with `{manager, customer}`. Capture the action separately to select its allowlisted path.
- `app.js` exports pure helpers in CommonJS for Node tests and as browser globals: `blurFor`, `diffCards`, `applySearch`, `fmtEUR`, plus the request-context and rung-timer helpers described below. Export injectable controller logic to test request ordering without a browser.
- `index.html` is served on `http://localhost:8000`, loads `app.js`, and contains the DOM/controller wiring. No keys in the page. Validate and persist an HTTP(S) n8n base URL; canceled/empty input keeps setup visible and starts no requests.

- [ ] **Step 1: Write meaningful dashboard tests**

Use `node:test` and controllable deferred fetch promises plus an injected clock. Cover:

1. Blur is 14/5/0 px at stages 0/1/2; invalid/errored stages stay visibly coarse. Amount changes and rung drops are detected. New cards and initial hydration never chime.
2. `fmtEUR(12300)` is `€12,300.00`, `fmtEUR(12.3)` is `€12.30`; null, empty, and nonfinite values are `?`, never `NaN` or a invented zero.
3. Search results already admitted by Task 8 are hits regardless of score sign or absent snippet; do not use `score > 0` as a relevance threshold. Intersect result IDs with the displayed live cards. No displayed hits means `noMatches: true`, no rings, and no dimmed cards. Clearing the query means inactive search, distinct from an active query with zero hits.
4. Resolve an old Anna list/search/write after switching to Ben: neither cards, removed tray, highlights, errors, failure counts, timers, nor latency badges change in Ben. Switching back cannot revive the obsolete result. Repeat with a changed overdue filter, changed query, and cleared query.
5. Rapid polls are single-flight per context. A context switch aborts obsolete reads and starts the current read promptly. Old finally blocks cannot clear a newer request's busy flag or schedule a duplicate timer. A delayed search response cannot overwrite a later query or a cleared search.
6. HTTP 4xx/5xx, malformed JSON, and invalid envelopes are errors. Search failure keeps current cards/tray and shows an error, not a fabricated no-match state. Write failure preserves state, re-enables the control, and shows the action error. A failed request and an abort are distinct; only current list failures count toward the offline banner.
7. A successful poll while search is active recomputes highlights/dimming from cached results against the new cards. Filtering or clearing search preserves the most recent removed tray. New cards, a new latest invoice ID, or a rung drop start/reset timers; a visible climb freezes every newly crossed rung once, including jumps 0→2/3. Equal rung polls do not restart them. Zero seconds renders as `0.0s`. Initial ready cards show unknown elapsed times rather than fabricated zero-duration progress.
8. An invoice/customer/matched line containing `<img onerror=...>`, quotes, or HTML markup renders as literal text. An action queued on Anna captures Anna/customer at click time; double clicks issue one write.

- [ ] **Step 2: Run tests and verify they fail for missing implementation**

Run `node --test dashboard/*.test.js`; expect missing `app.js`/exports before implementation.

- [ ] **Step 3: Implement helpers and request controller**

Keep immutable last accepted `cards`, `removed`, and cached search results separate from presentation. Scope state by a monotonically increasing context generation (manager, filter, and later Edge source). Search also owns a query sequence. Capture generation, manager, filter, source, query, and customer before each request; commit response/error/latency only if its context is still current. Use `AbortController` to cancel old reads, plus sequence/generation checks since cancellation can race with completion. A write is not undone by aborting the browser; capture its target context, never update another context, and refresh the current context after it settles.

Read polling uses a self-scheduling `setTimeout` two seconds after settlement, never `setInterval`. Use one in-flight list per generation; coalesce same-context immediate refreshes into one follow-up. Manager/filter changes clear cards/tray/highlights/timers/errors immediately, invalidate old reads, and request the new context. Keep the query text across a manager switch, but rerun it for that manager; never reuse another manager's hits. Debounce search by 200 ms, invalidate synchronously on every keystroke (including clear), URL-encode all query fields with `URLSearchParams`, and show pending/error states distinctly. While a query is pending, remove prior-query rings. Active search and overdue filter compose by intersecting search results with filtered live cards. Rerun active search on the polling cadence without overlapping searches; retain accepted results during same-query refreshes, then recompute presentation after every accepted list/search response.

The fetch wrapper checks `response.ok` before parsing, validates the envelope and field types, measures browser RTT separately, and applies a bounded request timeout (for example 10 seconds) so hung reads cannot stop polling. Clear timeout handles in `finally`. A real current list failure increments the counter; a success resets it; three failures show `offline · showing last known cards`. Abort/stale responses do not count. Search/write errors have their own visible messages and do not replace the offline state. The latency badge labels the backend's metric honestly and records the operation whose current response it displays; never substitute browser RTT for backend `latency_ms`.

Timer state is stored for the full current list context, keyed by customer and latest invoice ID (Task 8 must expose `latest.id`). Rung drops or changed IDs begin an observation epoch using the injected monotonic clock. When rungs climb, persist the timer object and freeze each crossed rung at the observed elapsed duration; repeated polls keep frozen values. Initial hydration has no known start time: leave existing lit-rung durations blank. Chime only for observed upward transitions after baseline, once per accepted transition; mute starts checked and playback rejection is handled. Polling may skip intermediate stages, so chimes/times reflect observations, not guaranteed backend stage timings. Hide stale narrative unless the card's current rung is 3.

- [ ] **Step 4: Implement the HTML surface and safe rendering**

Dark grid, manager tabs, search input, numeric overdue input, latency badge, offline/action/search messages, mute toggle, and removed tray. Each live card shows name, worker, open amount, invoice/pending/overdue counts, latest invoice and its rough/sharp state, rung ladder, observed timers, current narrative, optional matched line, and Remove. The tray shows name, purge date, and Restore independently of search/filter results. Keep action controls unblurred and clickable; apply blur to the card's content region. Group by worker as specified. Validate the overdue value as a finite nonnegative number; blank clears it, invalid input makes no request and shows a validation message.

Build DOM nodes with `createElement`, `textContent`, and `dataset`; do not interpolate server/config values into `innerHTML`, inline handlers, CSS, or HTML attributes. Delegate action events with `closest('button[data-act]')`. Disable the selected action while its POST is pending; validate the JSON `{ok: true}` response and restore controls on failure. Preserve cards/tray until successful write refresh; do not optimistically pretend a failed remove/restore succeeded. Clean up polling/debounce/timeouts and abort reads on page teardown. Edge source-switch integration follows the separate stretch plan and must use this same generation mechanism.

Generate three short ascending tones with Python stdlib `wave` (or use a short licensed chime), then run `node --test dashboard/*.test.js` and expect zero failures.

- [ ] **Step 5: Manual browser checks**

Serve `python3 -m http.server 8000 -d dashboard`. Verify canceled setup, valid setup, manager switching while reads are delayed, rapid search typing then clearing, filter changes during an in-flight poll, and unavailable/500 webhooks. Existing cards survive a same-context outage; other-manager cards never flash during a switch. Search `servers` highlights matching visible cards; `zebra unicorn` shows no matches with no dimming; clear retains the removed tray. With the filter set, hits outside it cannot hide the no-match indicator.

Reset/reseed the designated synthetic demo rows per Task 7, then select its reserved live sample using the appropriate worker. If using `delta-001.pdf` with `w_jules`, clear delta first so it is not a duplicate. Observe blur and sharpening, frozen timers, and chimes only for stages observed after baseline. To rehearse the German amount correction, reset synthetic acme data using the documented reset procedure, then pick `acme-001.pdf` in the Form. Exercise successful/failed remove and restore, including switching manager while a write is pending. DevTools slow network and a mocked failed response make the races reproducible. Confirm untrusted sample names/snippets render literally and controls stay usable while content is blurred.

- [ ] **Step 6: Export/review and commit during implementation**

Run the dashboard tests and manual checks, then commit the dashboard files using the repository's attribution convention. This document review itself creates no implementation files or commits.

---

### Task 10: Workflow 05 Dashboard Writes

**Files:**
- Create in n8n Cloud: `05 Dashboard writes`
- Export: `workflows/05-dashboard-writes.json`
- Create: `scripts/writes_check.py`, `scripts/test_writes_check.py`
- Test: unit tests, then `scripts/writes_check.py` against the webhooks and the point

**Interfaces:**
- Consumes: `03 Rebuild point`.
- Produces: POST `/webhook/customers/remove` and `/webhook/customers/restore`, body `{manager, customer}`; success `{ok:true,purge_at}`.

- [ ] **Step 1: Build** (11 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | Remove a customer | Webhook POST customers/remove, Respond node, Allowed Origins * |
| 2 | Config (remove) | Preserve JSON; MANAGERS, QDRANT_URL, COLLECTION, action=remove |
| 3 | Restore a customer | Webhook POST customers/restore, Respond node, Allowed Origins * |
| 4 | Config (restore) | Preserve JSON; same values, action=restore |
| 5 | Validate the write identity | Both Config nodes connect here. Require body manager in MANAGERS and nonempty customer; emit manager_id, customer_id, action; invalid input returns 400 |
| 6 | Load this customer's tombstone | Data Table customers Get by manager_id AND customer_id from validated node; Always Output Data; missing row returns 404 |
| 7 | Decide the new deleted_at | Use validated action. Remove preserves existing tombstone or sets current ISO; restore sets null. Emit full ISO purge_at = deleted_at + 30 days or null |
| 8 | Set or clear deleted_at | Data Table customers Update by both validated keys; null clears dateTime |
| 9 | Rebuild the point | Execute 03, wait on; explicitly map both keys from validation |
| 10 | Respond | Successful rebuild only: JSON ok:true, purge_at from decision node, CORS headers |
| 11 | Respond to invalid writes | Respond JSON with 400/404/failure status; validation/missing-row/error paths terminate here |

- [ ] **Step 2: Test**

Write `scripts/writes_check.py` test-first. Pure judges (`write_failures(resp)` for `{ok: true, purge_at}`, `tray_failures(list_resp, customer)` for hidden-from-cards and present-in-tray with `purge_at`, and the `check_point.failures` already built) are unit-tested; `main` drives the sequence and restores `m_anna/acme` in `finally`, so a failed run leaves the corpus as it found it:

1. remove `m_anna/acme`: response ok with an ISO `purge_at`; the point has `deleted_at`; the list hides acme and the tray shows it
2. remove it again: `deleted_at` is unchanged (the first tombstone holds)
3. if `m_ben/acme` exists (the Task 6 seed), it is still live (same slug, other tenant)
4. restore: the point has no `deleted_at` and acme is back in the cards
5. unknown manager returns 400; unknown customer returns 404

Run: `python3 scripts/writes_check.py`
Expected: `ok` per step, then `WRITES OK`. In the browser (Task 9), Remove on acme moves it to the tray within 2 s, Restore brings it back.

Add Config and a validation/customer lookup before the update (under 15 actual nodes). Map an explicit action from each webhook, validate manager/customer, and return 400/404 for invalid/missing inputs. Use ISO deleted_at for remove, null for restore, and full ISO purge_at; do not strip then append Z. Repeated remove preserves the first tombstone. Rebuild inputs reference validated tenant/customer explicitly. Return a failure response if rebuild fails, preserving table state for retry. Test same-slug cross-manager isolation and browser JSON POST preflight; add OPTIONS response only if the live n8n gate proves necessary.

- [ ] **Step 3: Export, scrub, commit**

```bash
git add workflows/05-dashboard-writes.json scripts/writes_check.py scripts/test_writes_check.py
git commit -m "feat(n8n): remove and restore webhooks with soft delete"
```

---

### Task 11: Workflow 06 Purge

**Files:**
- Create in n8n Cloud: `06 Purge`
- Export: `workflows/06-purge.json`
- Test: manual run with a backdated row

**Interfaces:**
- Consumes: Qdrant delete-by-filter body from Task 2 step 5.

- [ ] **Step 1: Build** (per-customer snapshot and loop; maximum 15 nodes)

| # | Node | Settings |
|---|---|---|
| 1 | Every night at three | Schedule Trigger, daily 03:00 |
| 2 | Config | `QDRANT_URL`, `COLLECTION`, `MANAGERS` |
| 3 | Load removed customer rows | Data Table customers Get all rows with non-null deleted_at; Always Output Data on |
| 4 | Capture eligible identities | Code: calculate cutoff once; filter valid deleted_at strictly earlier than cutoff, manager in Config MANAGERS; emit each `{manager_id,customer_id,deleted_at,cutoff}`; empty input returns `[]` |
| 5 | Purge one customer at a time | Loop Over Items, batch size 1; all deletes reference the current loop item, never `.first()` over all candidates |
| 6 | Delete this expired point | HTTP POST `points/delete?wait=true`, body equal to `bodies.purge` for the loop item (shard_key, filter must manager_id + customer_id + datetime deleted_at range `{lt: cutoff}`); assert HTTP success and Qdrant status ok |
| 7 | Delete this customer's invoice rows | Data Table invoices Delete where manager_id AND customer_id match captured loop identity; Always Output Data on |
| 8 | Delete this expired customer row | Data Table customers Delete where manager_id AND customer_id AND deleted_at equal captured values; Always Output Data on; loop back to 5 |

Sticky: "Never run live at the booth. One sentence: purged at 30 days, PDFs stay in storage for tax retention."

The snapshot precedes every delete, so no deletion output is used to recover identity. Stop ingest, processing, and restore before a purge run; this is not a transactional concurrent purge design. On any failed point deletion, retain table rows and stop. If a later delete fails, rerun with the same tombstoned customer: point and invoice deletes are idempotent, and customer is deleted last. Test two eligible customers in different managers, same slug in the other tenant surviving, a recent tombstone surviving, an empty candidate set, and an injected HTTP failure retaining source rows. The schedule's timezone must explicitly be Europe/Berlin.

- [ ] **Step 2: Test**

Create a throwaway customer by hand in the `customers` table: `zombie`, `w_tom`, `m_anna`, `deleted_at` = 40 days ago; run `03 Rebuild point` for it once so a point exists (add one invoice row too). Run `06 Purge` manually.

Run: `python3 scripts/check_point.py m_anna zombie` → Expected: `no point for m_anna/zombie`, exit 2. The two tables no longer contain `zombie`. `python3 scripts/check_point.py m_anna acme --show customer_id` → prints `customer_id=acme`.

- [ ] **Step 3: Export, scrub, commit**

```bash
git add workflows/06-purge.json
git commit -m "feat(n8n): nightly purge of soft-deleted customers after 30 days"
```

---

### Task 12: Full Corpus Ingest and Rehearsal Checks

**Files:**
- Create: `scripts/corpus_check.py`, `scripts/test_corpus_check.py`
- Test: unit tests, then the script against the live endpoints

- [ ] **Step 1: Reset and ingest**

Delete all rows in both Data Tables (UI). Recreate the collection: delete `customers` in the Qdrant Cloud console, then run `python3 scripts/setup_collection.py`. Submit the 13 unique samples through the Form, 40 s apart, with the worker from `samples/manifest.json`. Skip `beta-004.pdf` for the corpus (it's the live duplicate moment).

- [ ] **Step 2: Write `scripts/corpus_check.py`** test-first

Interface:
- `expected_corpus(manifest: list[dict]) -> dict[str, list[dict]]`: manifest rows grouped by customer, duplicates (`duplicate_of`) dropped
- `corpus_failures(expected, lists: Mapping[str, dict], overdue: dict, searches: Mapping[str, dict]) -> list[str]`: every failure, not just the first. `lists` maps manager to its `/customers` response, `overdue` is m_anna's `overdue_gte=10000` response, and `searches` maps each term to its `/search` response. Rules: the customer set equals the manifest's; per customer `invoice_count` matches, `stage == 2`, `rung == 3`, `pending_count == 0`, and `open_amount` is within 0.01 of the manifest's non-paid sum; m_anna holds acme, beta, gamma and m_ben holds delta, eps, zeta; the filter returns exactly acme and beta; `servers` hits {acme}, `consulting` hits {beta}, `licenses` hits {acme, gamma}, each under 500 ms.
- `main(argv)`: reads `samples/manifest.json`, fetches the endpoints with `transport.send`, prints each failure, and ends with `CORPUS OK` or exit 1.

Tests: a response set built from a small manifest passes; a wrong `open_amount`, a missing customer, a customer under the wrong manager, a wrong search set, and slow search latency each produce exactly one failure line naming the customer or term.

- [ ] **Step 3: Run**

Run: `python3 -m unittest discover -s scripts && python3 scripts/corpus_check.py`
Expected: `OK`, then `CORPUS OK`. A failing `open_amount` means the vision model misread one invoice: open that invoice's row, read `llm_fields`, and fix extraction and retry against unchanged fixture amounts; never change the PDF ground truth to match a wrong model result. A failing search term means line items need a more distinctive word; edit `gen.py`, regenerate, re-ingest that customer.

Full-corpus mode ingests 13 unique PDFs from the 14 files, then runs this checker. Live mode is a separate seed: after full validation, while processing is stopped, clear acme's invoice rows and rebuild with acme-002/acme-003 only, reserving acme-001 for the new-PDF correction moment. Reset to that seed before every rehearsal. Received_at makes the submitted acme-001 the latest card invoice. Keep beta-003 present and beta-004 reserved for the duplicate moment. Never run full-corpus expectations against the live seed; keep same-slug tenancy fixtures separate as well.

- [ ] **Step 4: Commit**

```bash
git add scripts/corpus_check.py scripts/test_corpus_check.py
git commit -m "test: full corpus check against the dashboard endpoints"
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

## How It Works
<five sentences: Form → log → staged rebuild → one point → dashboard; same section order as Clelia's repo so the two read as a pair>

## Eight Primitives, One Request

<the exact JSON from spec section 11 and the eight-row table under it>

## Requirements
Qdrant Cloud cluster with Inference enabled, n8n Cloud (1.105 or later, Data Tables), an OpenRouter key, Chrome for printing samples, Python 3.11 or later (standard library only) for the scripts, Node 18 or later to run the Code-node and dashboard tests.

## Setup in Three Steps

1. Create a free Qdrant Cloud cluster with Inference enabled. Copy `.env.example` to `.env`, fill it in, run `python3 scripts/setup_collection.py`, then `python3 scripts/smoke.py`.
2. In n8n Cloud create two credentials: `Qdrant api-key` (Header Auth, header `api-key`) and `OpenRouter bearer` (Header Auth, header `Authorization`, value `Bearer <key>`). Create the two Data Tables as listed in `docs/superpowers/specs/2026-10-09-invoice-memory-design.md`, section 4.
3. Import the seven JSON files from `workflows/` (Workflows → Import from File), reassign the two credentials on each HTTP Request node, open the `Start here` sticky in `01 Ingest`, set the `Config` values, activate trigger workflows after rebinding Data Tables and sub-workflow references. Open `dashboard/index.html` from any static server and enter your n8n base URL.

## What Each Workflow Does
<one line each for 01, 02, 02b, 03, 04, 05, 06>

## What Leaves Your Canvas
<the six feature one-liners from spec section 12>

## Why Not the Qdrant Vector Store Node
<the one sentence from spec section 12>

## Known Limits
- Coarse stage reads German number formats wrong on purpose. The vision stage fixes it.
- Concurrent uploads can leave a stale final view. Serialize booth submissions; rebuild after all overlapping writers finish.
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
git commit -m "docs: README with the one-request exhibit, booth script, printed cards"
```

---

### Task 14: Rehearsal and Recording Insurance

**Files:**
- Create: `booth/rehearsal.md` (timings log), `booth/insurance.mp4` (not committed; add to `.gitignore`)

- [ ] **Step 1: Three timed runs of the 60 s script.** Record start-to-finish seconds and the stage timers from the dashboard for each run in `booth/rehearsal.md`. If any run exceeds 75 s, cut the restore moment first, then the overdue filter, per the spec's cut order.

- [ ] **Step 2: Warm-up checklist** at the top of `booth/rehearsal.md`: `python3 -m unittest discover -s scripts` passes, `python3 scripts/smoke.py` passes, `python3 scripts/corpus_check.py` passes, one warm-up Form submission done, dashboard open on both screens with the chime unmuted on the presenter side, Qdrant Cloud dashboard tab open on the acme point with `deleted_at` scrolled to the top, phone hotspot tested.

- [ ] **Step 3: Record the full flow** with QuickTime screen recording, save as `booth/insurance.mp4`, bind it to a keyboard shortcut (Automator Quick Action or a Dock alias) and test the shortcut once.

- [ ] **Step 4: Commit**

```bash
echo 'booth/insurance.mp4' >> .gitignore
git add .gitignore booth/rehearsal.md
git commit -m "docs: rehearsal timings and warm-up checklist"
```
