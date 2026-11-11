# Sign-in: passwords, SSO, passkeys and step-up

*SSO, passkeys and step-up were added in v0.20.*

## Password

Password sign-in always works. Nothing on this page can switch it off, so a broken SSO provider or a lost passkey never locks anyone out by itself. The exception is an account created through SSO provisioning, which has no password until one is set for it. TOTP, lockout and the tenant's *require MFA* policy apply as before.

## Single sign-on (OIDC)

**Settings → Single sign-on** (Platform Admin). Rem0te is an OpenID Connect relying party. It uses the authorization code flow with PKCE, a `state` bound to the browser by a cookie, and a `nonce`. The ID token is verified with [openid-client](https://github.com/panva/openid-client).

### Setting up a provider

1. At the provider, register a web application whose redirect URI is the one shown on the page:
   `https://<your server>/api/v1/auth/sso/callback`. It must match exactly.
2. In Rem0te, add the provider: the **issuer** exactly as the provider publishes it (`iss`), the client ID, the client secret if the client is confidential, and the redirect URI. The secret is stored encrypted and never shown again.
3. **Test discovery**: Rem0te fetches the provider's metadata and reports its endpoints and PKCE support.
4. **Enable** it. A new provider is always created disabled.

The issuer cannot be changed later. Linked accounts are keyed by it, so add a new provider instead.

Only HTTPS issuers are accepted. `OIDC_ALLOW_INSECURE_LOOPBACK=true` relaxes that for `127.0.0.1`/`localhost`, and is for development only.

### How accounts are matched

**By issuer and subject (`sub`) only. Never by email.** Matching by email would let anyone who controls a provider, or a provider that lets users edit their own email, sign in as any account by naming its address. So an identity reaches an account in one of two ways:

- **Linking.** A signed-in person goes to **My Account → Single sign-on → Link** (needs step-up), signs in at the provider, and that identity is attached to their account. One identity per provider per account. An identity already linked to someone else is refused.
- **Provisioning**, only if the provider has *Create accounts* turned on. An unknown identity with a **verified** email that no Rem0te account uses gets a **new** account. That account has no business and no permissions unless a **group mapping** matches: a value in the provider's groups claim, mapped to exactly one business with exactly the listed capabilities, as a Business User. Provisioning never creates an owner or an admin. If the email already belongs to an account, sign-in is refused with a message to sign in by password and link instead.

After the provider, the rest of sign-in is the same as for a password: account status, lockout, and **TOTP, if the account has it** or the tenant requires it. SSO does not skip Rem0te's own second factor.

## Passkeys

**My Account → Passkeys.** A passkey is a WebAuthn credential on a phone, computer or security key. Rem0te requires **user verification** (biometric or PIN) on every use, so a passkey sign-in counts as multi-factor on its own and skips TOTP.

- Challenges are stored on the server and single-use.
- A signature counter that goes backwards (a cloned authenticator) is refused.
- Adding or removing a passkey needs step-up (`passkey.manage`).

The relying party is the web app's address: `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN`, defaulting to the host and origin of the server's [public address](setup.md#public-address) (*Settings → General*, else `FRONTEND_URL`). Passkeys are bound to that host name, so changing it later makes every existing passkey unusable, unless `WEBAUTHN_RP_ID` pins it. Browsers do not allow an IP address as an RP ID; use a host name (`localhost` in development).

## Step-up

Some actions need you to confirm it is you, even with a valid session: re-enter your password, a TOTP code, or use a passkey. The confirmation lasts 10 minutes and applies only to the sign-in it was made in.

**With an authenticator enrolled, the password alone is not accepted (0.30.1).** Use the authenticator code or a passkey; the API answers `401 TOTP_REQUIRED` to a password, and the dialog offers only the code. Otherwise a stolen session plus a known password would be enough.

**A session remembers whether its sign-in passed a second factor.** A sign-in that went through the authenticator, or a passkey sign-in, is MFA-verified; a password or SSO sign-in by someone with no authenticator is not. Revealing a computer's password needs an MFA-verified session from anyone who has an authenticator, so a session that began before the authenticator was enrolled must sign in again (`403 MFA_REQUIRED`).

| Action | Protects |
|---|---|
| `credential.reveal` | revealing a computer's stored RustDesk password, and any Connect that releases it (the launcher grant or the Connect script) |
| `permissions.change` | changing a user's permissions or level, approving technician access, offboarding |
| `technicians.manage` | technician assignments, groups and platform permissions |
| `sso.configure` | SSO provider changes; linking and unlinking your own SSO identity |
| `passkey.manage` | adding or removing a passkey |
| `platform.configure` | changing the server's public address (*Settings → General*) |

All are on by default (`PlatformSettings.stepUpActions`). The API answers `403` with `code: STEP_UP_REQUIRED` and the web app prompts. Access is always checked **first**, so someone with no business doing the action is refused outright, not asked to re-authenticate.

## Recovery

If SSO, passkeys or the [public address](setup.md#public-address) go wrong, run this on the server. It talks to the database directly and works with the API down. The environment file is readable only by root, so start a root shell with it loaded:

```bash
sudo bash -c 'set -a; . /etc/reboot-remote/api.env; set +a; cd /opt/reboot-remote/api && exec bash'
node dist/cli/auth-recovery.js --status
node dist/cli/auth-recovery.js --disable-sso --yes             # every provider off
node dist/cli/auth-recovery.js --remove-passkeys a@b.com --yes # that account's passkeys
node dist/cli/auth-recovery.js --unlink-sso a@b.com --yes      # that account's SSO links
node dist/cli/auth-recovery.js --sign-out a@b.com --yes        # end every session
node dist/cli/auth-recovery.js --clear-public-url --yes        # back to FRONTEND_URL / PUBLIC_API_URL
```

Without `--yes` it prints what it would do and changes nothing. Every change is written to the audit log.

0.20.0 documented this as `node scripts/auth-recovery.mjs`, but `scripts/` is not part of a deployed server; from 0.21.0 the tool is compiled into `dist/`.

## Limitations

- Tested against a standards-compliant mock provider, not against any particular one (Entra ID, Google, Okta…). Provider-specific quirks, such as groups overage claims, are not handled.
- No single logout or back-channel logout: signing out of the provider does not sign you out of Rem0te, or the reverse.
- No SSO-only enforcement. Password sign-in cannot be turned off.
