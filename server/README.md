# ApplyPilot local server

Local-only Go service (Gin + SQLite, pure Go / no cgo) that the browser
extension uses for site adapters, unknown-page reports and fill audits.

- Listen: `127.0.0.1:17880` (loopback only)
- State: `server/data/auto-info.db`, pairing token `server/.token` (mode 0600)
- Module: `auto-info-server`, Go >= 1.23
- Dependencies: `github.com/gin-gonic/gin`, `modernc.org/sqlite`

## Run

```bash
cd server
go mod tidy
go build ./... && go vet ./...
go test ./...
AUTO_INFO_EXTENSION_ORIGIN=chrome-extension://<extension-id> ./auto-info-server
```

On first start the server generates a 32-byte random hex token, writes it to
`server/.token` (0600) and prints it to stdout. Restarts reuse the same token.
`AUTO_INFO_HOME` can point state at another directory. `AUTO_INFO_EXTENSION_ORIGIN`
is required and must be the exact origin shown for this extension in
`chrome://extensions`; comma-separate values when development and packaged
extension IDs both need access.

Pairing: paste the printed token into the extension sidepanel's pairing page
(one time); requests then send `Authorization: Bearer <token>`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | `{ok, version}` |
| GET | `/api/schema?domain=` | **Bearer token**; `{found, adapter, version}`; `found:false` → generic extraction |
| PUT | `/api/sites/:domain/schema` | **Bearer token**, body `{adapter, version}`, upsert |
| POST | `/api/reports` | **Bearer token**, body `{domain,url,title,html,css,jsMeta,schema,note?}` → `{reportId}` |
| GET | `/api/reports?status=new\|wip\|done` | **Bearer token**, summary rows, no html/css blobs |
| GET | `/api/reports/:id` | **Bearer token**, full row incl. `html`, `css`, `js_meta`, `schema_json` |
| PATCH | `/api/reports/:id` | **Bearer token**, body `{status}` ∈ new / wip / done |
| POST | `/api/fills` | **Bearer token**, body `{domain,url,summary}` → `{fillId}` |
| GET | `/api/stats` | **Bearer token**, `{sites, reports_by_status, fills}` |

CORS only allows no `Origin` (local curl/agent) or the exact origins configured
in `AUTO_INFO_EXTENSION_ORIGIN`; all `/api` routes require the pairing token.
`note` is accepted for the shared `ReportPayload` contract but not persisted:
the frozen three-table schema has no note column, and `schema_json` stays
schema-valid (`additionalProperties: false`).

## Quick check

```bash
TOKEN=$(cat .token)
curl -s localhost:17880/healthz
curl -s -X PUT localhost:17880/api/sites/example.com/schema \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"adapter":{"aliases":{}},"version":1}'
curl -s -H "Authorization: Bearer $TOKEN" "localhost:17880/api/schema?domain=example.com"
curl -s -H "Authorization: Bearer $TOKEN" localhost:17880/api/stats
```
