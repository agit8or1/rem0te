# Break-glass accounts

*0.59. A runbook: what break-glass accounts are, how to set them up, and what to do when one is used.*

A break-glass account is a Platform Admin that can always sign in with its own password, authenticator code and passkey — even when single sign-on is **Required** or the provider is down. It is the way back in that does not depend on anything outside this server.

## The rules

- **At most two.** The database refuses a third (a trigger in migration 0080), whatever writes it.
- **Platform Admins only.** A CHECK in 0080 refuses the flag on anyone else, and a break-glass account cannot be demoted until the flag is cleared.
- **Both factors.** The account must have an authenticator (TOTP) **and** a passkey enrolled before it can be made break-glass.
- **A fresh confirmation** to set or clear it (`breakglass.manage` in *Settings → Confirm it is you*), audited `BREAK_GLASS_CHANGED`.
- **Exempt from SSO required**, and never suggested for linking to a provider.
- **Staff cannot be set to SSO required without one.**

## Every use is loud

Each sign-in by a break-glass account, by password with its TOTP code or by passkey:

1. writes a sealed `BREAK_GLASS_LOGIN` audit entry **before** the session is issued — if the entry cannot be written, there is no session;
2. raises a security alert (`break_glass_login`) to the security alert destinations (*Settings → Security → Technician access*);
3. emails every Platform Admin whose address is a confirmed mail recipient (*Settings → Email*).

A break-glass sign-in that nobody expected is an incident: see *What to do* below.

## Setting them up

1. Choose two people (or two sealed envelopes held by two people). Make each a Platform Admin with a long unique password.
2. Sign in as each one and enrol an authenticator and a passkey (*My Account*). A hardware security key kept with the envelope is the usual choice.
3. As another Platform Admin, **Settings → Single sign-on → Break-glass accounts → Make break-glass**, and confirm it is you.
4. Check *Access control → Platform Admins* shows the **Break-glass** badge on both.
5. Sign in once with each, on purpose, and check the alert and the email arrive. Note the date.

Do not use these accounts for daily work. Do not link them to a provider.

## Using one

1. Sign in at `/login` with the email and password, then the authenticator code (or use the passkey).
2. Do only what the emergency needs — usually lowering the SSO mode (*Settings → Single sign-on → Who must use single sign-on*) or disabling a provider.
3. Sign out. Tell the other Platform Admins what you did and why.

If the console itself is unreachable, use the recovery CLI on the server instead (see [sign-in.md](sign-in.md#recovery)): `--sso-mode optional <business id | staff>`, `--disable-sso`.

## What to do after an unexpected use

1. Treat it as a compromise of that account until shown otherwise ([incident-recovery.md](incident-recovery.md)).
2. From another Platform Admin: end its sessions (`auth-recovery.js --sign-out <email> --yes`), reset its password, remove and re-enrol its authenticator and passkey.
3. Read the audit log around the `BREAK_GLASS_LOGIN` entry: the address it came from and what was done in that session.
4. Clear and set the flag again only after the account's factors are replaced.

## Limitations

- Nothing stops a break-glass account from doing everything a Platform Admin can; it is loud, not limited.
- The email goes only to Platform Admins whose address is a confirmed mail recipient. With no mail relay, the alert and the audit entry are all there is.
