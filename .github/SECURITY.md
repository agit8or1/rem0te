# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/agit8or1/rem0te/security/advisories/new)
for this repository. That opens a draft advisory only you and the maintainers can see.

Please include, as far as you can:

- what the issue is, and which component it affects (API, web, installer scripts,
  launcher, deploy scripts);
- the version — see `version.json`, or **About** in the running app;
- steps to reproduce, or a proof of concept;
- what an attacker gains, and what access they need to start.

You will get an acknowledgement, and an assessment once the report has been
reproduced. If a report turns out to be a duplicate or not a vulnerability, you will
be told why rather than left waiting.

## Scope

In scope: authentication and session handling, the business isolation boundary,
capability and permission enforcement, credential storage and release, enrollment
and launcher tokens, the generated installer scripts, and the deploy and sudoers
configuration in `deploy/`.

Out of scope: vulnerabilities in RustDesk itself (report those to the
[RustDesk project](https://github.com/rustdesk/rustdesk)), and findings that require
an already-compromised server or physical access to it.

## Supported versions

Fixes land on the latest release. This project has not yet reached 1.0, and older
minor versions do not receive backported patches — upgrade to the current release.

## What this project does and does not claim

The review history in [`docs/SECURITY-AUDIT.md`](../docs/SECURITY-AUDIT.md) is an
**internal review by the project**. It is **not** an independent third-party audit,
and nothing here should be read as one.

Business isolation is covered by an automated suite
(`apps/api/scripts/e2e-business-access.mjs`) and by static invariant checks
(`scripts/check-security-invariants.mjs`), both run by CI on every push. Those are
regression tests, not a proof of correctness.
