# Scan API (public, API key) — C3 backend

Two endpoints let a caller start a posture scan for a tenant and follow it until it
finishes. They need **no login (JWT)**: the caller sends the tenant id and the
**ispm-worker's API key**. The C3 backend does not store or check the key itself —
it forwards it to the ispm-worker, which validates it against its `SCAN_API_TOKEN`.

| # | Method | Path (on the C3 backend) | Purpose |
|---|--------|--------------------------|---------|
| 1 | `POST` | `/api/v1/scans`          | Start a scan of one tenant → returns `job_id` |
| 2 | `GET`  | `/api/v1/scans/{job_id}` | Status of that scan job (poll until finished) |

Code: `internal/modules/posture/scan/scan_public.go` (handlers),
`scan_client.go` (call to the worker). Mounted in `cmd/api-server/main.go`
as `PublicModules` (no JWT middleware).

---

## How a request flows

```
Caller (Postman / UI)                C3 backend (:8080)                     ispm-worker (ENGINE_HEALTH_PORT, e.g. :8090)
─────────────────────                ──────────────────                     ────────────────────────────────────────────
POST /api/v1/scans
  X-API-Key: <key>          ──►  checks: rate limit, no query string,
  {"tenant_id":"<uuid>"}         JSON body, key present, tenant_id is a UUID
                                     │
                                     └─► POST {WORKER_URL}/api/v1/scans
                                           Authorization: Bearer <key>     ──►  key == SCAN_API_TOKEN ?   (else 401)
                                           {"tenant_id":"<uuid>",                tenant in nhi_global.tenants ? (else 404)
                                            "requested_by":"api-key"}            starts the scan in background
                                     ◄──────────────────────────────────────── 202 {"data":{job...},"status_url":...}
◄── 202 {"data":{"job_id":"…","already_running":false}}
```

The key is sent to the worker as `Authorization: Bearer <key>` — exactly the format
the worker's `scanapi.go` expects. The C3 backend's own `WORKER_SCAN_TOKEN` is **not**
used by these two endpoints (it is used only by the login-based Sync route
`POST /api/v1/ispm/scans`).

> **The API key you send must be equal to the worker's `SCAN_API_TOKEN`.**

---

## Authentication — where to put the API key

The backend looks for the key in this order (first one found wins):

1. Header `X-API-Key: <key>` ← **recommended**
2. Header `Authorization: Bearer <key>`
3. Field `"api_key"` in the JSON body (POST only)

Rules: 1–256 printable ASCII characters, no spaces. A key in the URL
(`?api_key=…`, `?key=…`, `?token=…`) is **refused** with 400 — URLs end up in logs.

---

## 1. Start a scan — `POST /api/v1/scans`

### Request

| Part | Value |
|------|-------|
| URL | `http://<c3-host>:8080/api/v1/scans` |
| Headers | `X-API-Key: <worker SCAN_API_TOKEN>`<br>`Content-Type: application/json` |
| Query string | none allowed |
| Body max size | 4 KB |

**Body fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenant_id` | string (UUID) | **yes** | Tenant to scan. Must exist in the worker DB's `nhi_global.tenants`. Case-insensitive (sent lower-cased). |
| `requested_by` | string | no | Label shown in the worker's job (max 100 chars). Default `"api-key"`. |
| `api_key` | string | no | Only if you do not send the key in a header. |

Any other field → 400 (unknown fields are rejected).

**Example body**

```json
{
  "tenant_id": "de300000-0000-4000-8000-000000000001",
  "requested_by": "bala@acme"
}
```

### Responses

**202 Accepted — a new scan was started**

```json
{
  "data": {
    "job_id": "1e86dec7-4b7a-4c1e-9a43-0c2f5d1b9e10",
    "already_running": false
  }
}
```

**200 OK — this tenant is already being scanned** (no second scan is started; the running job is returned)

```json
{
  "data": {
    "job_id": "1e86dec7-4b7a-4c1e-9a43-0c2f5d1b9e10",
    "already_running": true
  }
}
```

Keep the `job_id` and call endpoint 2 with it.

---

## 2. Scan job status — `GET /api/v1/scans/{job_id}`

### Request

| Part | Value |
|------|-------|
| URL | `http://<c3-host>:8080/api/v1/scans/{job_id}` |
| Headers | `X-API-Key: <worker SCAN_API_TOKEN>` (or `Authorization: Bearer <key>`) |
| Body | none |
| Query string | none allowed |

`job_id`: the value returned by endpoint 1 (letters, digits, `_ . -`, max 64 chars).

### Response — 200 OK

The worker's job object, relayed as-is inside `data`:

```json
{
  "data": {
    "job_id": "1e86dec7-4b7a-4c1e-9a43-0c2f5d1b9e10",
    "scope": "tenant",
    "source": "api",
    "requested_by": "bala@acme",
    "status": "COMPLETED",
    "requested_at": "2026-10-23T10:55:20Z",
    "started_at": "2026-10-23T10:55:20Z",
    "finished_at": "2026-10-23T10:56:02Z",
    "tenants": [
      {
        "tenant_id": "de300000-0000-4000-8000-000000000001",
        "db_name": "tenant_demo",
        "status": "COMPLETED",
        "scan_id": "7c0a6c1e-2f43-4d55-8a31-8e2b1f0b6d21",
        "scan_status": "COMPLETED",
        "new_findings": 3,
        "resolved_findings": 1,
        "open_findings": 445,
        "started_at": "2026-10-23T10:55:20Z",
        "finished_at": "2026-10-23T10:56:02Z"
      }
    ]
  }
}
```

**Job `status`:** `QUEUED` → `RUNNING` → one of
`COMPLETED` | `PARTIAL` (some tenants failed/skipped) | `FAILED` | `SKIPPED`.

**Per tenant `status`:** `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED` (see `error`),
`SKIPPED` (already being scanned by another job). `scan_id` is the row in that
tenant's `ispm_scan_history`.

Poll every 3–5 seconds until `status` is no longer `QUEUED` / `RUNNING`.

> Jobs live in the worker's memory (last 200). After the worker restarts, old
> `job_id`s answer 404.

---

## Errors (both endpoints)

All errors use the same body:

```json
{ "error": { "code": "invalid_parameter", "message": "tenant_id must be a UUID", "field": "tenant_id" } }
```

| HTTP | `code` | When |
|------|--------|------|
| 400 | `invalid_parameter` | Body is not JSON / has unknown fields / over 4 KB (`field: "body"`); `tenant_id` missing or not a UUID; any query parameter (API key in URL gets its own message); bad `job_id`; worker answered 400 |
| 401 | `unauthorized` | No key sent, or the **worker** rejected the key (it is not equal to `SCAN_API_TOKEN`). Response has `WWW-Authenticate: Bearer realm="ispm-scan"` |
| 404 | `not_found` | POST: tenant not in the worker's `nhi_global.tenants`. GET: unknown `job_id` (or worker restarted) |
| 429 | `rate_limited` | More than 30 requests/minute from one client IP. See `Retry-After` header (seconds) |
| 502 | `scan_unavailable` | Worker not reachable / no answer within the timeout / bad answer. **Check the C3 terminal log** for the real reason |
| 503 | `scan_unavailable` | `WORKER_URL` is not set in the C3 `.env` |

Order of checks on POST: worker configured (503) → rate limit (429) → no query (400)
→ body (400) → API key present (401) → `tenant_id` (400) → call worker.

### Reading a 502 in the C3 log

| Log text | Meaning | Fix |
|----------|---------|-----|
| `context deadline exceeded (Client.Timeout exceeded while awaiting headers)` | No answer from `WORKER_URL` within `NHI_WORKER_TIMEOUT_SECONDS` (10 s) | Worker not running, wrong host/port, firewall, or Wi‑Fi isolation. Test: `Test-NetConnection <worker-ip> -Port <port>` must say `TcpTestSucceeded : True` |
| `connectex: No connection could be made…` / `connection refused` | Host reachable, nothing listening on that port | Start the worker; check `ENGINE_HEALTH_PORT` |
| `404 … is not the worker's answer (wrong WORKER_URL?)` | `WORKER_URL` points at some other server | Point it to the ispm-worker |

---

## Configuration

### C3 backend `.env`

```env
# Where the ispm-worker's scan API listens (its ENGINE_HEALTH_PORT).
# Same machine:    http://127.0.0.1:8090
# Other machine:   http://192.168.0.170:8090   (port must be open in that machine's firewall)
WORKER_URL=http://127.0.0.1:8090

# Used ONLY by the login-based Sync route (POST /api/v1/ispm/scans).
# The public /api/v1/scans endpoints use the key the caller sends.
# Keep it equal to the worker's SCAN_API_TOKEN.
WORKER_SCAN_TOKEN=<same value as the worker's SCAN_API_TOKEN>

# Optional: seconds to wait for the worker (1–120, default 10)
NHI_WORKER_TIMEOUT_SECONDS=10
```

(`NHI_WORKER_URL` / `NHI_WORKER_SCAN_TOKEN` are accepted as aliases.)
`WORKER_URL` must **not** point at the C3 backend's own port (8080) — the server
refuses to start if it does.

### ispm-worker `.env` (scan API part)

```env
ENGINE_HEALTH_PORT=8090        # scan API port (C3 already uses 8080)
SCAN_API_ENABLED=true
SCAN_API_TOKEN=<long random secret>   # callers send this as the API key
ENGINE_SCAN_INTERVAL=0         # 0 = scans only through the API (optional)
ENGINE_RUN_ON_START=false      # optional: no full scan at startup
LOG_FILE=                      # empty = logs in the terminal (easier to debug)
```

Plus the worker's `DB_*` settings; the tenant must be a row in
`nhi_global.tenants` (`tenant_id`, `db_name`) of that database.

---

## Testing

### Postman

**Start a scan**

1. Method `POST`, URL `http://<c3-host>:8080/api/v1/scans`
2. Tab **Headers**: add `X-API-Key` = `<worker SCAN_API_TOKEN>`
   (`Content-Type: application/json` is added automatically by step 3).
3. Tab **Body** → `raw` → `JSON`:
   ```json
   { "tenant_id": "de300000-0000-4000-8000-000000000001" }
   ```
4. Tab **Params**: must be empty. Tab **Authorization**: `No Auth`
   (or `Bearer Token` with the key instead of step 2).
5. Send → expect **202** with `data.job_id`.
6. Optional — tab **Scripts → Post-response**, to reuse the id:
   ```js
   pm.collectionVariables.set("job_id", pm.response.json().data.job_id);
   ```

**Poll the job**

1. Method `GET`, URL `http://<c3-host>:8080/api/v1/scans/{{job_id}}`
2. Header `X-API-Key` = same key. No body.
3. Send every few seconds until `data.status` is `COMPLETED` (or `PARTIAL` / `FAILED`).

Set Postman **Settings → General → Request timeout** to `0` (or above 15 000 ms)
so Postman does not give up before the backend answers.

### PowerShell (Windows)

```powershell
$h = @{ "X-API-Key" = "<worker SCAN_API_TOKEN>" }
$b = '{"tenant_id":"de300000-0000-4000-8000-000000000001"}'
$r = Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/v1/scans -Headers $h -ContentType "application/json" -Body $b
$r.data.job_id
Invoke-RestMethod -Uri ("http://localhost:8080/api/v1/scans/" + $r.data.job_id) -Headers $h
```

### curl (Git Bash / Linux)

```bash
curl -X POST http://localhost:8080/api/v1/scans \
  -H "X-API-Key: $SCAN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"tenant_id":"de300000-0000-4000-8000-000000000001"}'

curl http://localhost:8080/api/v1/scans/<job_id> -H "X-API-Key: $SCAN_API_TOKEN"
```

### Check the worker directly (bypasses C3)

```powershell
curl.exe http://<worker-host>:8090/health        # {"status":"ok"}
curl.exe http://<worker-host>:8090/ready         # {"status":"ready"} = DB reachable
```

---

## Security notes

- Anyone holding the worker key can start scans and read any job through these
  endpoints; the key is the only check. Share it only with trusted callers.
- The key is never logged by C3 and never accepted in the URL.
- 30 requests per minute per client IP (protects the worker and slows key guessing).
- `GET /api/v1/scans/{job_id}` does not check which tenant the job belongs to —
  the worker looks jobs up by id only.
- Keep the worker port internal (LAN / cluster only).

## Related: login-based Sync route

For the dashboard UI (user JWT, no API key): `POST /api/v1/ispm/scans` (no body —
tenant comes from the JWT; roles analyst/manager/admin) and
`GET /api/v1/ispm/scans/{job_id}`. These use `WORKER_SCAN_TOKEN` from the C3 `.env`.
