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
- **scopes** — one or more of `companies:read`, `companies:write`, `users:read`,
  `users:write`, `computers:read`, `computers:write`, `sessions:read`,
  `enrollment:write`, `audit:read`
- **expiresInDays** — optional TTL (1–3650), null = never expires

Revocation is immediate. Rate-limited to 300 req/min per key.

Every route enforces its declared scope; missing scopes → HTTP 401.

## Endpoints

### System

- `GET /pub/v1/whoami` → `{ tenantId, apiKeyId, scopes, timestamp }`

### Companies

- `GET  /pub/v1/companies?search=…` — scope `companies:read`
- `GET  /pub/v1/companies/:id` — scope `companies:read`
- `POST /pub/v1/companies` — scope `companies:write`
  ```json
  { "name": "ACME Manufacturing", "email": "…", "phone": "…", "city": "…", "country": "…" }
  ```

### Users

- `GET  /pub/v1/users` — scope `users:read`
- `POST /pub/v1/users/invite` — scope `users:write`
  ```json
  { "email": "john@acme.example", "roleType": "TECHNICIAN", "customerId": "cust_..." }
  ```
  Valid `roleType` values: `PLATFORM_ADMIN`, `TENANT_OWNER`, `TENANT_ADMIN`,
  `TECHNICIAN`, `BILLING_ADMIN`, `READ_ONLY`, `CUSTOMER`.

### Computers

- `GET  /pub/v1/computers?search=…&customerId=…&status=…&platform=…&page=1&limit=50`
  — scope `computers:read`
- `GET  /pub/v1/computers/:id` — scope `computers:read`

### Managed enrollment (one-command installers)

- `POST /pub/v1/enrollment/tokens` — scope `enrollment:write`
  ```json
  {
    "customerId":       "cust_...",
    "accessMode":       "ASSIGNED_USERS" | "COMPANY_WIDE",
    "assignedUserIds":  ["usr_..."],
    "platform":         "windows" | "linux" | "macos",
    "expiresInDays":    1,
    "description":      "RMM deployment 2026-08-25"
  }
  ```
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

# Create a company
curl -sX POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  https://remote.example/api/v1/pub/v1/companies \
  -d '{"name":"ACME Manufacturing","country":"US"}'

# Mint a Windows install command for a specific user
curl -sX POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  https://remote.example/api/v1/pub/v1/enrollment/tokens \
  -d '{"customerId":"cust_...", "assignedUserIds":["usr_..."], "platform":"windows"}'
```

## Security notes

- Every request is tenant-isolated by the API key.
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
