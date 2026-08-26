# Rem0te Public API

RMM / PSA integration surface at `https://<your-host>/api/v1/pub/v1/*`.

## Authentication

All endpoints require an **API key** in the `Authorization` header:

```
Authorization: Bearer rk_<48-hex>
```

Keys are minted from **Administration → API Keys** in the web UI or via the
admin API `POST /api/v1/apikeys`. The raw key is shown **once** at creation;
server-side we store only a SHA-256 hash. Keys support:

- **name** — human label
- **businessId** — the business the key belongs to. **Required.** A key acts as a
  Business Owner *within that business and nowhere else*; it is never a Platform
  Admin. Keys created before v0.8.0 had no business and were revoked by migration
  `0009` — re-issue them per business.
- **scopes** — one or more of `companies:read`, `companies:write`, `users:read`,
  `users:write`, `computers:read`, `computers:write`, `sessions:read`,
  `enrollment:write`, `audit:read`
- **expiresInDays** — optional TTL (1–3650), null = never expires

Revocation is immediate. Rate-limited to 300 req/min per key.

Every route enforces its declared scope; missing scopes → HTTP 401.

## Endpoints

### System

- `GET /pub/v1/whoami` → `{ businessId, apiKeyId, scopes, timestamp }`

### Businesses

`businesses` is the current path; `companies` remains as an alias for integrations
built against v0.6/v0.7.

- `GET  /pub/v1/businesses?search=…` — scope `companies:read`
  Returns **only the key's own business.**
- `GET  /pub/v1/businesses/:id` — scope `companies:read`
  Another business's id returns 404.
- `POST /pub/v1/businesses` — scope `companies:write`
  **Always 403.** Creating a business is a platform-operator action and an API key
  is never a Platform Admin. Use the web UI.

### Users

- `GET  /pub/v1/users` — scope `users:read`
  The people in the key's business.
- `POST /pub/v1/users/invite` — scope `users:write`
  ```json
  {
    "email": "john@acme.example",
    "firstName": "John",
    "lastName": "Smith",
    "level": "BUSINESS_USER",
    "capabilities": ["computers:view", "computers:connect"]
  }
  ```
  `level` is `BUSINESS_USER` or `BUSINESS_OWNER`. Creating a **Business Owner**
  requires Platform Admin, so an API key gets 403 — it can only add Business Users.
  Omitting `capabilities` applies the defaults (`computers:view`,
  `computers:connect`). See [access-control.md](access-control.md) for the full
  capability vocabulary.

### Computers

- `GET  /pub/v1/computers?search=…&status=…&platform=…&page=1&limit=50`
  — scope `computers:read`
  Scoped to the key's business; there is no cross-business listing.
- `GET  /pub/v1/computers/:id` — scope `computers:read`
  Another business's id returns 404.

### Managed enrollment (one-command installers)

- `POST /pub/v1/enrollment/tokens` — scope `enrollment:write`
  ```json
  {
    "accessMode":       "ASSIGNED_USERS" | "COMPANY_WIDE",
    "assignedUserIds":  ["usr_..."],
    "platform":         "windows" | "linux" | "macos",
    "expiresInDays":    1,
    "description":      "RMM deployment 2026-08-25"
  }
  ```
  The token is bound to the key's own business — there is no `businessId` to pass
  and no way to mint one for a different business. Every id in `assignedUserIds`
  must be an active member of that same business or the request is rejected.

  The machine that later redeems the token cannot influence which business it
  lands in or who gets access; both are stamped from the token at mint time.
  Returns:
  ```json
  {
    "success": true,
    "data": {
      "id":         "tok_...",
      "token":      "raw-token-shown-once",
      "expiresAt":  "…",
      "install": {
        "platform": "windows",
        "url":      "https://.../api/v1/public/install/win/<token>",
        "command":  "irm https://.../api/v1/public/install/win/<token> | iex"
      }
    }
  }
  ```
  Pass the `command` to your RMM script deployer or Intune Win32-app payload.

- `GET /pub/v1/enrollment/tokens` — scope `enrollment:write` — list active tokens.

## Curl example

```bash
KEY='rk_...'                                                   # from Admin → API Keys

# Whoami
curl -s -H "Authorization: Bearer $KEY" \
  https://remote.example/api/v1/pub/v1/whoami

# The key's own business
curl -s -H "Authorization: Bearer $KEY" \
  https://remote.example/api/v1/pub/v1/businesses

# Mint a Windows install command for a specific user
curl -sX POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  https://remote.example/api/v1/pub/v1/enrollment/tokens \
  -d '{"assignedUserIds":["usr_..."], "platform":"windows"}'
```

## Response shapes

Every response is wrapped in `{ "success": true, "data": ... }`. **What sits
under `data` is not uniform**, and this trips integrators up:

| Route | `data` is |
| --- | --- |
| `GET /pub/v1/whoami` | *no `data` wrapper* — fields are at the top level |
| `GET /pub/v1/businesses` | an **array** of businesses |
| `GET /pub/v1/users` | an **array** of memberships |
| `GET /pub/v1/enrollment/tokens` | an **array** of tokens |
| `GET /pub/v1/computers` | an **object**: `{ endpoints, total, page, limit, pages }` |

Only `computers` is paginated, and only it nests its array under a key. Treat
`data.endpoints` as the list there and `data` as the list everywhere else.

### whoami

```json
{
  "success": true,
  "businessId": "cmtaiwkcv000rza3semyybks5",
  "apiKeyId": "cmtaj6l5g0007rjrpd756sliz",
  "scopes": ["companies:read", "computers:read", "users:read", "enrollment:write"],
  "timestamp": "2026-08-26T20:13:11.632Z"
}
```

Note there is no `data` key here — read `businessId` and `scopes` directly. This
is the cheapest call for verifying a key works and discovering what it may do.

### businesses

```json
{
  "success": true,
  "data": [
    {
      "id": "cmtaiwkcv000rza3semyybks5",
      "name": "Cascade Accounting",
      "code": "CASC",
      "email": "it@casc.example.com",
      "city": "Seattle",
      "state": "WA",
      "country": "US",
      "isActive": true,
      "quickConnectEnabled": true,
      "createdAt": "2026-08-26T20:05:12.079Z",
      "_count": { "endpoints": 3, "sites": 0 }
    }
  ]
}
```

Always exactly one element — the key's own business. Use `_count.endpoints` for
a machine count instead of listing computers just to count them.

### computers

```json
{
  "success": true,
  "data": {
    "endpoints": [
      {
        "id": "cmtaiwkdb0017za3stnccaho1",
        "name": "BACKOFFICE-01",
        "hostname": "BACKOFFICE-01",
        "status": "OFFLINE",
        "platform": "Windows",
        "osVersion": "Microsoft Windows NT 10.0.26100.0",
        "ipAddress": "203.0.113.26",
        "isOnline": false,
        "isManaged": true,
        "lastSeenAt": "2026-08-24T20:05:12.095Z",
        "accessMode": "ASSIGNED_USERS",
        "customerId": "cmtaiwkcv000rza3semyybks5",
        "rustdeskNode": {
          "rustdeskId": "145925926",
          "lastSeenAt": "2026-08-24T20:05:12.095Z",
          "hasPassword": true
        },
        "tags": [],
        "aliases": []
      }
    ],
    "total": 3, "page": 1, "limit": 50, "pages": 1
  }
}
```

Two things worth knowing:

- **The RustDesk ID is nested under `rustdeskNode`**, not on the endpoint. A
  machine that has not completed enrolment has `rustdeskNode: null`.
- **The password is never returned.** `hasPassword` tells you whether one is
  stored; the credential itself is not exposed through this API at all.

`status` is the administrative state (`ACTIVE`, `OFFLINE`, `ARCHIVED`,
`PENDING_ENROLLMENT`); `isOnline` is liveness from the agent heartbeat. They can
disagree — an `ACTIVE` machine that stopped checking in is `isOnline: false`.

### users

`data` is an array of *memberships*, each wrapping the person under `user`:

```json
{
  "success": true,
  "data": [
    {
      "id": "cmtaiwkcy000uza3saz93v5jm",
      "userId": "cmtaiwkcw000sza3shgvnvoy9",
      "customerId": "cmtaiwkcv000rza3semyybks5",
      "isActive": true,
      "capabilities": [],
      "role": { "name": "Business Owner" },
      "user": {
        "id": "cmtaiwkcw000sza3shgvnvoy9",
        "email": "owner@casc.example.com",
        "firstName": "Dana",
        "lastName": "Cascade",
        "jobTitle": "IT Manager",
        "status": "ACTIVE"
      }
    }
  ]
}
```

An empty `capabilities` array means the role defaults apply, not that the person
has none.

## Errors

Errors share one envelope:

```json
{
  "success": false,
  "statusCode": 401,
  "code": "UNAUTHORIZED",
  "message": "Missing required scopes: companies:write",
  "path": "/api/v1/pub/v1/companies",
  "timestamp": "2026-08-26T20:13:11.836Z"
}
```

| Situation | Status | `message` |
| --- | --- | --- |
| No or malformed `Authorization` header | 401 | `Missing or malformed API key` |
| Revoked, expired or unknown key | 401 | `Missing or malformed API key` |
| Key lacks the route's scope | **401** | `Missing required scopes: <list>` |
| Action needs Platform Admin | 403 | varies |
| Id belongs to another business | 404 | `Not found` |
| Over 300 req/min | 429 | rate limit |

**A missing scope returns 401, not 403.** Branch on `message`, or check
`whoami` first — retrying a 401 as if the key were invalid will not help.

## Worked example: sync computers into an RMM

Verified against a live instance; only ids and hostnames are anonymised.

```bash
KEY='rk_...'
HOST='https://remote.example'

# 1. Confirm the key works and see what it may do.
curl -s -H "Authorization: Bearer $KEY" "$HOST/api/v1/pub/v1/whoami"

# 2. Page through the computers. Only this route paginates.
page=1
while :; do
  body=$(curl -s -H "Authorization: Bearer $KEY" \
    "$HOST/api/v1/pub/v1/computers?page=$page&limit=50")
  echo "$body" | jq -r '.data.endpoints[]
    | [.name, .rustdeskNode.rustdeskId // "not-enrolled", .isOnline, .lastSeenAt]
    | @tsv'
  pages=$(echo "$body" | jq -r '.data.pages')
  [ "$page" -ge "$pages" ] && break
  page=$((page + 1))
done

# 3. Mint a Windows install command for a new machine.
curl -sX POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  "$HOST/api/v1/pub/v1/enrollment/tokens" \
  -d '{"platform":"windows","accessMode":"COMPANY_WIDE","expiresInDays":1,
       "description":"RMM rollout"}' \
  | jq -r '.data.install.command'
```

Step 3 prints a one-liner to hand to your deployment tool. The token is
single-use and carries the business and access rules with it, so the machine
running it cannot choose which business it joins.

Polling guidance: `lastSeenAt` only moves every 3 minutes (the agent heartbeat),
so polling faster than that gains nothing and will hit the 300 req/min limit on
any fleet of size.

## Security notes

- Every request is confined to the key's business by the same
  `AccessControlService` scope rule that governs interactive sessions — there is
  no separate code path for API keys.
- Enrollment tokens are single-use and expire in 24h by default. The endpoint
  that redeems the token **cannot** influence which company / user gets access
  — those are stamped on the token at mint time.
- Bearer tokens must be transmitted over HTTPS. Keys are hashed at rest
  (SHA-256); the raw value is only returned to the caller at creation.
- Rate limit: 300 req/min/key.
- All key issuance and revocation is audited (`API_KEY_CREATED`, `API_KEY_REVOKED`).

## Regression test

`apps/api/scripts/e2e-public-api.mjs` walks the full API-key flow (mint → whoami
→ list → create → mint enrollment → scope-enforcement → revoke → verify
revocation blocks). Run with `DATABASE_URL=... node apps/api/scripts/e2e-public-api.mjs`.
