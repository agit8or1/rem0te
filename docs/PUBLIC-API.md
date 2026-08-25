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
