# Sign-in: passwords, SSO, passkeys and step-up

*SSO, passkeys and step-up were added in v0.20.*

## Password

Password sign-in always works. Nothing on this page can switch it off, so a broken SSO provider or a lost passkey never locks anyone out by itself. The exception is an account created through SSO provisioning, which has no password until one is set for it. TOTP, lockout and the tenant's *require MFA* policy apply as before.

## Single sign-on (OIDC)

**Platform → Single Sign-On** (Platform Admin). Rem0te is an OpenID Connect relying party. It uses the authorization code flow with PKCE, a `state` bound to the browser by a cookie, and a `nonce`. The ID token is verified with [openid-client](https://github.com/panva/openid-client).

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

The relying party is the web app's address: `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN`, defaulting to the host and origin of `FRONTEND_URL`. Passkeys are bound to that host name, so changing it later makes every existing passkey unusable. Browsers do not allow an IP address as an RP ID; use a host name (`localhost` in development).

## Step-up

Some actions need you to confirm it is you, even with a valid session: re-enter your password, a TOTP code, or use a passkey. The confirmation lasts 10 minutes and applies only to the sign-in it was made in.

| Action | Protects |
|---|---|
| `credential.reveal` | revealing a computer's stored RustDesk password |
| `permissions.change` | changing a user's permissions or level, approving technician access, offboarding |
| `technicians.manage` | technician assignments, groups and platform permissions |
| `sso.configure` | SSO provider changes; linking and unlinking your own SSO identity |
| `passkey.manage` | adding or removing a passkey |

All are on by default (`PlatformSettings.stepUpActions`). The API answers `403` with `code: STEP_UP_REQUIRED` and the web app prompts. Access is always checked **first**, so someone with no business doing the action is refused outright, not asked to re-authenticate.

## Recovery

If SSO or passkeys go wrong, run this on the server (it talks to the database directly and works with the API down):

```bash
cd /opt/reboot-remote/api && set -a && . ./.env && set +a
node scripts/auth-recovery.mjs --status
node scripts/auth-recovery.mjs --disable-sso --yes             # every provider off
node scripts/auth-recovery.mjs --remove-passkeys a@b.com --yes # that account's passkeys
node scripts/auth-recovery.mjs --unlink-sso a@b.com --yes      # that account's SSO links
node scripts/auth-recovery.mjs --sign-out a@b.com --yes        # end every session
```

Without `--yes` it prints what it would do and changes nothing. Every change is written to the audit log.

## Limitations

- Tested against a standards-compliant mock provider, not against any particular one (Entra ID, Google, Okta…). Provider-specific quirks, such as groups overage claims, are not handled.
- No single logout or back-channel logout: signing out of the provider does not sign you out of Rem0te, or the reverse.
- No SSO-only enforcement. Password sign-in cannot be turned off.
