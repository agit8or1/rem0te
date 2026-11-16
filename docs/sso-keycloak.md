# Single sign-on with Keycloak

*0.59 "Agit8or Identity P0". **Not yet run against a real Keycloak.** Everything Rem0te does here is proven against a mock OpenID provider (`apps/api/scripts/e2e-sso-identity.mjs`). The Keycloak steps below follow Keycloak 26's documentation and have not been tried on this server. Check each one before relying on it.*

This is the setup for trusting a self-hosted Keycloak as the sign-in provider. The general rules are in [sign-in.md](sign-in.md); this page is the Keycloak side and what to type into Rem0te.

## What Rem0te needs from Keycloak

| | Why |
|---|---|
| Authorization code flow with **PKCE (S256)** | Rem0te always sends a PKCE challenge, a `state` bound to the browser and a `nonce`. |
| A **confidential** client, preferably **private_key_jwt** | No shared secret to leak; Rem0te holds the private key sealed. |
| **Back-channel logout** | Signing out of Keycloak ends the Rem0te session at once. |
| `acr` mapped to **levels of authentication** | Rem0te decides password / MFA / passkey from `acr`, corroborated by `amr`. |
| `amr` in the ID token | Without it, an `acr` above password is lowered to password. |
| `auth_time` in the ID token | A step-up without it is refused. |
| Optionally, the **organization** claim | To admit only one Keycloak organization. |

## 1. The client

In the realm, **Clients → Create client**, type OpenID Connect.

- **Client ID**: anything, e.g. `rem0te`. Type it into Rem0te.
- **Client authentication: On** (confidential). **Standard flow: On.** Direct access grants, implicit flow, service accounts: **Off**.
- **Valid redirect URIs**: exactly `https://<your server>/api/v1/auth/sso/callback` (Rem0te shows it on the provider form).
- **Valid post logout redirect URIs**: `https://<your server>/login?signed_out=1`, or what you set as the provider's post-logout redirect.
- **Advanced → Proof Key for Code Exchange Code Challenge Method: S256.** This makes Keycloak *require* PKCE for this client.

## 2. Client authentication: private_key_jwt

1. In Rem0te, add the provider with the client secret first (or none), then on its card under **Trust and sign-out** choose **Generate key**. Rem0te creates a P-256 key; the private half is sealed in the database and never shown.
2. In Keycloak, **Clients → rem0te → Credentials → Client Authenticator: Signed JWT**, signature algorithm **ES256**.
3. **Keys** tab: **Use JWKS URL: On**, and the JWKS URL Rem0te shows: `https://<your server>/api/v1/auth/sso/<provider id>/jwks.json`. (Or switch it off and import the file from **Download public JWKS**.)
4. Back in Rem0te, set **Token authentication** to **private_key_jwt**. Sign in once to check, then remove the client secret from both sides.

*Replace key* makes a new key with a new `kid`. With the JWKS URL, Keycloak picks it up on its next fetch; with an imported file, import the new one first.

## 3. Back-channel logout

**Clients → rem0te → Settings → Logout settings**:

- **Front channel logout: Off.**
- **Backchannel logout URL**: `https://<your server>/api/v1/auth/sso/backchannel-logout`.
- **Backchannel logout session required: On** (Keycloak puts the `sid` in the logout token, and in the ID token).

Rem0te checks the token's signature against the realm's JWKS, the issuer, the audience (your client ID), `iat` within five minutes, the back-channel event, that there is no `nonce`, and that its `jti` was not seen before. It ends every Rem0te session of the account and answers 200; anything else is 400 with no reason given. The Rem0te server must be reachable from Keycloak for this.

Signing out in Rem0te also signs out at Keycloak (RP-initiated logout, with `id_token_hint`).

## 4. Levels: ACR to LoA

Keycloak's step-up authentication maps `acr` values to *levels of authentication* (LoA).

1. **Realm settings → General → ACR to LoA Mapping** (or per client, **Advanced → ACR to LoA Mapping**): for example `1` → 1, `2` → 2, `3` → 3. Using the numbers themselves as `acr` values keeps it simple.
2. **Authentication → Flows**: copy *browser* and build the conditional levels (*Condition - Level of Authentication*): level 1 username and password; level 2 adds OTP; level 3 a WebAuthn passkey (*WebAuthn Passwordless Authenticator*). Bind the copy as the browser flow.
3. Make sure the ID token carries `amr`: add Keycloak's **Authentication Method Reference (AMR)** mapper to the client's dedicated scope, and give each authenticator a reference value in its configuration — `pwd` for the password, `otp` for OTP, `hwk` for WebAuthn. *Which Keycloak versions emit `amr`, and how, has not been checked here.*
4. In Rem0te, on the provider's card: **acr for password** `1`, **acr for MFA** `2`, **acr for passkey** `3`.

Rem0te asks a step-up with `acr_values=<the MFA or passkey value>`, `max_age=0` and `prompt=login`, and then checks that the ID token's `acr` **and** `amr` say so, that `auth_time` is after the round trip began, and that the identity is the one linked to the signed-in account.

Then decide what to trust (all off by default):

- **Count the provider's MFA as Rem0te's second factor** — Rem0te stops asking its own TOTP after a level-2 sign-in.
- **Trust the provider's passkeys as phishing-resistant** — a level-3 step-up counts as a passkey for the few actions that require one.
- **Let Platform Admins sign in through this provider** — and then only at level 3.

## 5. Organization (optional)

With Keycloak 26 **organizations**, add the `organization` client scope to the client (as a default scope). The ID token then carries an `organization` claim. In Rem0te, set **Organization** to the organization's alias, or to its id when the claim's mapper includes ids. A sign-in whose token does not name it is refused (`org_mismatch`). The organization is only a gate: it grants no business, role or capability.

## 6. Who must use it

Once everyone is linked (**Settings → Single sign-on** shows the unlinked count per business), set a business to **Required**. Before that, set up two [break-glass accounts](break-glass.md). If Keycloak is down while a business is required, lower it from the server:

```bash
node dist/cli/auth-recovery.js --sso-mode optional <business id> --yes
```

## Checklist

- [ ] PKCE S256 required on the client
- [ ] Signed JWT (ES256) with Rem0te's JWKS URL; client secret removed
- [ ] Back-channel logout URL set, session required on; front channel off
- [ ] Post-logout redirect URI registered
- [ ] ACR to LoA mapping and the conditional browser flow; `amr` in the ID token
- [ ] acr values entered in Rem0te; *Test discovery* shows back-channel logout and private_key_jwt
- [ ] A real sign-in, a step-up, a sign-out at Keycloak (ends the Rem0te session) and a sign-out in Rem0te (ends the Keycloak session) each tried once
- [ ] Two break-glass accounts before anything is set to Required
