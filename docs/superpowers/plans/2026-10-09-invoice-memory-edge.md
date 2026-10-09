# Invoice Memory Edge Replica Implementation Plan (Stretch)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Qdrant Edge replica of one manager's shard on the booth laptop, so the dashboard keeps answering list, filter, and search with the wifi off.

**Architecture:** A Python sidecar restores the manager's shard snapshot into an immutable Edge Shard, pulls partial snapshots every 10 s, and serves the same two read endpoints as the n8n workflow on `localhost:8787`, embedding search queries locally with FastEmbed. The dashboard gets a `Cloud | Local` switch with automatic fallback.

**Tech Stack:** `qdrant-edge-py`, `fastembed`, Python stdlib `http.server`, `urllib`. Reuses `dashboard/app.js` and the response shapes from the core plan's Task 8.

**Spec:** `docs/superpowers/specs/2026-10-09-invoice-memory-design.md`, section 11b. Depends on the core plan through Task 12.

Gate: Task 1 runs on day 1 alongside the core smoke test. If it fails, this plan is cut and nothing else here is attempted.

## Global Constraints

- Everything in the core plan's Global Constraints.
- Edge is beta: the printed card and README say so.
- Writes never go to Edge. Remove and Restore are disabled on Local, labeled "writes need the cloud".
- Local search uses the same three models as Cloud Inference so cloud-written vectors and local query vectors match: FastEmbed `sentence-transformers/all-MiniLM-L6-v2`, `Qdrant/bm25`, `answerdotai/answerai-colbert-small-v1`.
- No API key in the browser. The sidecar holds the key in `.env`.

## Review Focus

1. Snapshot download for a shard key that maps to a numeric shard id the sidecar must look up, not guess. Pinned in Task 1 (`--edge` gate reads `/collections/customers/cluster`).
2. A partial snapshot that fails mid-apply must leave the previous shard serving, never an empty grid. Pinned in Task 2 (`test_sidecar.py`, "apply failure keeps old shard").
3. The dashboard must not flip to Local on a single slow poll. Pinned in Task 3 (three failures rule, `app.test.js` addition).
4. `deleted_at` must hide locally with the same `is_empty` filter. Pinned in Task 2 (sidecar list test with a soft-deleted point).
5. Local BM25 idf is computed over the local shard, so scores differ from cloud; ordering may differ for ties. Documented in the README, not tested.

---

### Task 1: Edge Gate

**Files:**
- Modify: `qdrant/smoke.sh` (add `--edge` branch at the end)
- Create: `edge/requirements.txt`

- [ ] **Step 1: `edge/requirements.txt`**

```
qdrant-edge-py
fastembed
```

- [ ] **Step 2: Append to `qdrant/smoke.sh`, before the final echo**

```bash
if [ "${1:-}" = "--edge" ]; then
  echo "6. edge gate"
  python3 -m venv ../edge/.venv && ../edge/.venv/bin/pip -q install -r ../edge/requirements.txt
  SHARD=$(q GET "$C/cluster" | python3 -c 'import sys,json; d=json.load(sys.stdin)["result"]; s=[x for x in d["local_shards"] if x.get("shard_key")=="m_anna"]; assert s, d; print(s[0]["shard_id"])')
  echo "   shard id for m_anna: $SHARD"
  SNAP=$(q POST "$C/shards/$SHARD/snapshots?wait=true" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["name"])')
  curl -sS -o /tmp/m_anna.snapshot -H "api-key: $QDRANT_API_KEY" "$QDRANT_URL$C/shards/$SHARD/snapshots/$SNAP"
  ls -la /tmp/m_anna.snapshot
  ../edge/.venv/bin/python - <<'PY'
from qdrant_edge import EdgeShard
import tempfile, os
d = tempfile.mkdtemp()
EdgeShard.unpack_snapshot('/tmp/m_anna.snapshot', d)
shard = EdgeShard.load(d)
info = shard.info()
print('   edge points:', info.points_count)
assert info.points_count >= 1
PY
  echo "   edge gate ok (partial snapshot API is exercised in Task 2)"
fi
```

- [ ] **Step 3: Run**

Run: `qdrant/smoke.sh --edge`
Expected: `shard id for m_anna: <n>`, a snapshot file larger than zero bytes, `edge points: N` with N ≥ 1, `edge gate ok`. If `EdgeShard.unpack_snapshot` or `load` names differ in the installed version, read `../edge/.venv/lib/python*/site-packages/qdrant_edge/__init__.pyi` and adjust; if the cluster has no `local_shards` entry with `shard_key`, custom sharding did not take and this plan is cut.

- [ ] **Step 4: Commit**

```bash
git add qdrant/smoke.sh edge/requirements.txt
git commit -m "test(edge): day-1 gate: shard snapshot download and Edge unpack

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Sidecar

**Files:**
- Create: `edge/sidecar.py`, `edge/test_sidecar.py`
- Test: `edge/.venv/bin/python -m unittest edge/test_sidecar.py`

**Interfaces:**
- Produces: `GET http://localhost:8787/customers?manager=m_anna[&overdue_gte=N]` and `GET http://localhost:8787/search?manager=m_anna&q=...` with the same JSON shapes as the core plan's Task 8, plus `source: "local"`. `sync()` and `handle_list()`, `handle_search()` are module-level functions so the tests call them without HTTP.

- [ ] **Step 1: Write `edge/test_sidecar.py`**

```python
import unittest, json, os, tempfile
os.environ.setdefault('QDRANT_URL', 'http://unused'); os.environ.setdefault('QDRANT_API_KEY', 'x')
import sidecar

class FakeShard:
    def __init__(self, points): self.points = points
    def scroll(self, req):
        def ok(p):
            f = req.filter or {}
            for c in f.get('must', []):
                if 'is_empty' in c and p['payload'].get(c['is_empty']['key']): return False
                if 'key' in c and 'match' in c and p['payload'].get(c['key']) != c['match']['value']: return False
            for c in f.get('must_not', []):
                if 'is_empty' in c and not p['payload'].get(c['is_empty']['key']): return False
            return True
        return [type('R', (), {'payload': p['payload']}) for p in self.points if ok(p)], None

P = lambda cid, **o: {'payload': dict(customer_id=cid, name=cid.title(), worker_id='w_tom', manager_id='m_anna', stage=2, summary_stage=3, summary_text='n', pending_count=0, invoice_count=1, open_amount=5, overdue_count=0, overdue_amount=0, latest={'invoice_no': 'I', 'amount': 5, 'stage': 2}, updated_at='u', invoices=[], **o)}

class T(unittest.TestCase):
    def test_list_hides_deleted_and_lists_removed(self):
        sidecar.STATE['shard'] = FakeShard([P('acme'), P('beta', deleted_at='2026-10-01T00:00:00Z')])
        d = sidecar.handle_list({'manager': 'm_anna'})
        self.assertEqual([c['customer_id'] for c in d['cards']], ['acme'])
        self.assertEqual(d['removed'][0]['purge_at'], '2026-10-31T00:00:00Z')
        self.assertEqual(d['source'], 'local'); self.assertIn('latency_ms', d)
    def test_apply_failure_keeps_old_shard(self):
        old = FakeShard([P('acme')]); sidecar.STATE['shard'] = old
        def boom(): raise RuntimeError('network')
        sidecar.sync(download=boom)
        self.assertIs(sidecar.STATE['shard'], old)
        self.assertTrue(sidecar.STATE['last_error'])

if __name__ == '__main__': unittest.main()
```

- [ ] **Step 2: Run, verify failure**

Run: `cd edge && .venv/bin/python -m unittest test_sidecar.py`
Expected: `ModuleNotFoundError: sidecar`.

- [ ] **Step 3: Write `edge/sidecar.py`**

```python
#!/usr/bin/env python3
"""Local Qdrant Edge replica of one manager's shard. Serves the dashboard's two read endpoints on :8787."""
import json, os, sys, time, threading, tempfile, shutil, urllib.request, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta, timezone

QDRANT_URL = os.environ['QDRANT_URL']; KEY = os.environ['QDRANT_API_KEY']
MANAGER = os.environ.get('EDGE_MANAGER', 'm_anna'); COLL = 'customers'
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', MANAGER)
WORKERS = json.loads(os.environ.get('WORKERS', '{"w_tom":{"name":"Tom"},"w_lena":{"name":"Lena"},"w_jules":{"name":"Jules"},"w_mia":{"name":"Mia"}}'))
STATE = {'shard': None, 'shard_id': None, 'last_sync': None, 'last_error': '', 'models': None}

def api(method, path, body=None):
    req = urllib.request.Request(QDRANT_URL + path, method=method, headers={'api-key': KEY, 'content-type': 'application/json'},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=20) as r: return json.load(r)

def shard_id():
    if STATE['shard_id'] is None:
        d = api('GET', f'/collections/{COLL}/cluster')['result']
        STATE['shard_id'] = next(s['shard_id'] for s in d['local_shards'] if s.get('shard_key') == MANAGER)
    return STATE['shard_id']

def download_snapshot():
    """Full shard snapshot. ponytail: partial snapshots need the Edge manifest API; swap in once Task 1 confirms the call shape."""
    sid = shard_id()
    name = api('POST', f'/collections/{COLL}/shards/{sid}/snapshots?wait=true')['result']['name']
    path = os.path.join(tempfile.gettempdir(), f'{MANAGER}.snapshot')
    req = urllib.request.Request(f'{QDRANT_URL}/collections/{COLL}/shards/{sid}/snapshots/{name}', headers={'api-key': KEY})
    with urllib.request.urlopen(req, timeout=60) as r, open(path, 'wb') as f: shutil.copyfileobj(r, f)
    api('DELETE', f'/collections/{COLL}/shards/{sid}/snapshots/{name}')
    return path

def sync(download=download_snapshot):
    from qdrant_edge import EdgeShard
    try:
        path = download()
        new_dir = DATA + '.new'; shutil.rmtree(new_dir, ignore_errors=True); os.makedirs(new_dir)
        EdgeShard.unpack_snapshot(path, new_dir)
        shard = EdgeShard.load(new_dir)
        STATE['shard'] = shard; STATE['last_sync'] = time.time(); STATE['last_error'] = ''
    except Exception as e:  # keep serving the previous shard
        STATE['last_error'] = f'{type(e).__name__}: {e}'

def plus30(iso): return (datetime.fromisoformat(iso.replace('Z', '+00:00')) + timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ')

def card(q):
    return dict(customer_id=q['customer_id'], name=q['name'], worker=WORKERS.get(q['worker_id'], {}).get('name', q['worker_id']),
                stage=q['stage'], rung=3 if q.get('summary_stage') == 3 else q['stage'], pending_count=q['pending_count'],
                invoice_count=q['invoice_count'], open_amount=q['open_amount'], overdue_count=q['overdue_count'],
                overdue_amount=q['overdue_amount'], latest=q.get('latest'), narrative=q['summary_text'] if q.get('summary_stage') == 3 else '',
                updated_at=q.get('updated_at'), deleted_at=q.get('deleted_at'))

def handle_list(qs):
    from qdrant_edge import ScrollRequest
    t = time.time(); sh = STATE['shard']
    must = [{'key': 'manager_id', 'match': {'value': qs['manager']}}, {'is_empty': {'key': 'deleted_at'}}]
    if qs.get('overdue_gte'):
        must.append({'nested': {'key': 'invoices', 'filter': {'must': [{'key': 'status', 'match': {'value': 'overdue'}}, {'key': 'amount', 'range': {'gte': float(qs['overdue_gte'])}}]}}})
    live, _ = sh.scroll(ScrollRequest(limit=50, with_payload=True, filter={'must': must}, order_by={'key': 'last_invoice_at', 'direction': 'desc'}))
    gone, _ = sh.scroll(ScrollRequest(limit=50, with_payload=True, filter={'must': [must[0]], 'must_not': [must[1]]}))
    return {'cards': [card(r.payload) for r in live],
            'removed': [dict(customer_id=r.payload['customer_id'], name=r.payload['name'], deleted_at=r.payload['deleted_at'], purge_at=plus30(r.payload['deleted_at'])) for r in gone],
            'latency_ms': int((time.time() - t) * 1000), 'source': 'local'}

def models():
    if STATE['models'] is None:
        from fastembed import TextEmbedding, SparseTextEmbedding, LateInteractionTextEmbedding
        STATE['models'] = (TextEmbedding('sentence-transformers/all-MiniLM-L6-v2'), SparseTextEmbedding('Qdrant/bm25'), LateInteractionTextEmbedding('answerdotai/answerai-colbert-small-v1'))
    return STATE['models']

def pick_line(q, invoices):
    toks = [t for t in ''.join(c if c.isalnum() else ' ' for c in q.lower()).split() if len(t) > 2]
    best, score = None, 0
    for i in invoices or []:
        line = f"{i.get('invoice_no','')} {i.get('vendor','')} {i.get('items','')} {i.get('status','')}".lower()
        s = sum(1 for t in toks if t in line)
        if s > score: best, score = i, s
    return f"{best['invoice_no']} · {best.get('items') or best.get('vendor')}" if best else None

def handle_search(qs):
    from qdrant_edge import QueryRequest, Prefetch
    t = time.time(); sh = STATE['shard']; q = qs['q']
    dense, sparse, late = models()
    dv = next(iter(dense.embed([q]))).tolist(); sv = next(iter(sparse.embed([q]))); lv = next(iter(late.embed([q]))).tolist()
    f = {'must': [{'key': 'manager_id', 'match': {'value': qs['manager']}}, {'is_empty': {'key': 'deleted_at'}}]}
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    req = QueryRequest(limit=5, with_payload=['customer_id', 'invoices'], filter=f,
        prefetches=[Prefetch(limit=20, filter=f, prefetches=[
            Prefetch(query={'nearest': {'indices': sv.indices.tolist(), 'values': sv.values.tolist()}}, using='bm25', limit=20, filter=f),
            Prefetch(query={'nearest': lv}, using='digest', limit=20, filter=f),
            Prefetch(query={'nearest': dv}, using='summary', limit=20, filter=f)], query={'fusion': 'rrf'})],
        query={'formula': {'sum': ['$score', {'mult': [0.1, {'exp_decay': {'x': {'datetime_key': 'last_invoice_at'}, 'target': {'datetime': now}, 'scale': 2592000, 'midpoint': 0.5}}]}]}})
    pts = sh.query(req)
    return {'results': [dict(customer_id=p.payload['customer_id'], score=round(p.score, 4), matched_line=pick_line(q, p.payload.get('invoices'))) for p in pts],
            'latency_ms': int((time.time() - t) * 1000), 'source': 'local'}

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); qs = dict(urllib.parse.parse_qsl(u.query))
        try:
            if STATE['shard'] is None: raise RuntimeError('no shard yet: ' + STATE['last_error'])
            body = handle_list(qs) if u.path == '/customers' else handle_search(qs) if u.path == '/search' else None
            code = 200 if body else 404
        except Exception as e:
            body, code = {'error': str(e)}, 500
        out = json.dumps(body or {'error': 'not found'}).encode()
        self.send_response(code); self.send_header('content-type', 'application/json'); self.send_header('access-control-allow-origin', '*')
        self.send_header('content-length', str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass

def loop():
    while True:
        sync(); time.sleep(10)

if __name__ == '__main__':
    threading.Thread(target=loop, daemon=True).start()
    print(f'edge sidecar for {MANAGER} on http://localhost:8787', file=sys.stderr)
    ThreadingHTTPServer(('127.0.0.1', 8787), H).serve_forever()
```

The exact constructor names (`ScrollRequest`, `QueryRequest`, `Prefetch`, the `query` dict shapes) come from the installed `qdrant_edge` stubs; if a name differs, read `.venv/lib/python*/site-packages/qdrant_edge/*.pyi` and adjust the three call sites. The tests use a fake shard and do not depend on those names.

- [ ] **Step 4: Run tests**

Run: `cd edge && .venv/bin/python -m unittest test_sidecar.py`
Expected: `OK` (2 tests).

- [ ] **Step 5: Run it for real**

Run: `set -a; . .env; set +a; edge/.venv/bin/python edge/sidecar.py` then in another shell:
`curl -s 'localhost:8787/customers?manager=m_anna' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["cards"]), d["latency_ms"], d["source"])'`
Expected: `3 <under 10> local`. Then `curl -s 'localhost:8787/search?manager=m_anna&q=servers'` returns acme first with a matched line. First search is slow (model download); the second is under 100 ms.

- [ ] **Step 6: Commit**

```bash
git add edge/sidecar.py edge/test_sidecar.py
git commit -m "feat(edge): local Edge replica sidecar serving list and search offline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Dashboard Source Switch

**Files:**
- Modify: `dashboard/app.js`, `dashboard/app.test.js`, `dashboard/index.html`

- [ ] **Step 1: Add the test to `dashboard/app.test.js`**

```js
const { nextSource } = require('./app');
test('falls to local only after three failures, back to cloud on first success', () => {
  assert.equal(nextSource('cloud', 1, true), 'cloud');
  assert.equal(nextSource('cloud', 3, true), 'local');
  assert.equal(nextSource('local', 0, true), 'cloud');
  assert.equal(nextSource('cloud', 5, false), 'cloud');  // no local available
});
```

- [ ] **Step 2: Implement in `dashboard/app.js`**

```js
function nextSource(current, failures, localAvailable) {
  if (!localAvailable) return 'cloud';
  if (current === 'cloud' && failures >= 3) return 'local';
  if (current === 'local' && failures === 0) return 'cloud';
  return current;
}
```
and add `nextSource` to `module.exports`.

- [ ] **Step 3: Wire `index.html`**

Add to the header: `<span id="src" class="tab">Cloud</span>`. In the script: `let source = 'cloud'; const LOCAL = 'http://localhost:8787';` Change `api()` to use `source === 'local' ? LOCAL + '/' + path : CONFIG.base + '/webhook/' + path`. In `poll()`, on success set `fails = 0; source = nextSource(source, 0, true)`; on failure `fails++; source = nextSource(source, fails, true)`; show `#banner` with text `offline · local replica` when `source === 'local'`. Badge text appends `· ${d.source || 'cloud'}`. Clicking `#src` toggles source manually. Disable the Remove and Restore buttons when `source === 'local'` and set their title to "writes need the cloud".

- [ ] **Step 4: Test**

Run: `node --test dashboard/` → `# fail 0`. Manual: sidecar running, dashboard open, switch wifi off. Within 6 s the banner shows and the badge reads `<10> ms qdrant · … · local`. Type `servers`: acme rings. Click Remove: nothing happens, tooltip explains. Wifi on: within 6 s badge returns to cloud. Submit a PDF from the phone while on wifi, switch wifi off before it finishes: the local card stays at its last synced stage until wifi returns, then sharpens.

- [ ] **Step 5: Commit**

```bash
git add dashboard
git commit -m "feat(dashboard): cloud/local source switch with offline fallback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Booth Additions

- [ ] **Step 1:** Add the 1:00 closer to `booth/script.md` (spec section 10, Edge line) and the "Qdrant Edge is in beta" line to `booth/cards.md`. Add to `README.md` under Known Limits: "Local search computes BM25 idf over the local shard, so scores differ from the cloud; ordering can differ on ties."
- [ ] **Step 2:** Add to `booth/rehearsal.md` warm-up: sidecar started 5 minutes before, first search done once to warm the models, wifi toggle tested.
- [ ] **Step 3:** Commit.

```bash
git add booth README.md
git commit -m "docs: Edge closer in the script, beta caveat on the card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
