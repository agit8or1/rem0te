#!/usr/bin/env node
// rustdesk-asset.mjs tag RELEASE.json            → VERSION=x.y.z
// rustdesk-asset.mjs asset RELEASE.json VERSION API_BASE → SHA256=… URL=…
//
// Reads a GitHub release document for RustDesk (the same API the portal's
// rustdesk-release.ts reads) and picks the Windows x86_64 client: its
// download URL and the SHA-256 GitHub publishes for it. The download is only
// ever from RustDesk's own release on github.com — or, when API_BASE is a
// loopback test server, from that same server — and a release with no
// published digest is refused rather than trusted on first download.
import { readFileSync } from 'node:fs';

const [cmd, file, version, apiBase] = process.argv.slice(2);
const doc = (() => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } })();
const fail = (m) => { console.error(m); process.exit(1); };
if (!doc) fail('the release document is not JSON');
const TAG_RE = /^\d+\.\d+\.\d+$/;

if (cmd === 'tag') {
  const tag = String(doc.tag_name ?? '').replace(/^v/, '');
  if (!TAG_RE.test(tag)) fail(`the latest RustDesk release tag "${String(doc.tag_name ?? '').slice(0, 40)}" is not x.y.z`);
  console.log(`VERSION=${tag}`);
} else if (cmd === 'asset') {
  if (!TAG_RE.test(version ?? '')) fail('bad version');
  const name = `rustdesk-${version}-x86_64.exe`;
  const a = (doc.assets ?? []).find((x) => x?.name === name);
  if (!a) fail(`RustDesk ${version} has no ${name}`);
  const sha = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest ?? ''))?.[1];
  if (!sha) fail(`GitHub publishes no SHA-256 digest for ${name}; refusing to sign a build nothing vouches for`);
  const url = String(a.browser_download_url ?? '');
  const loop = /^http:\/\/127\.0\.0\.1:\d{2,5}\//.exec(apiBase ?? '')?.[0];
  const allowed = loop ? url.startsWith(loop) : url === `https://github.com/rustdesk/rustdesk/releases/download/${version}/${name}`;
  if (!allowed) fail(`unexpected download URL for ${name}: ${url.slice(0, 200)}`);
  console.log(`SHA256=${sha}`);
  console.log(`URL=${url}`);
} else {
  fail('usage: rustdesk-asset.mjs tag FILE | asset FILE VERSION API_BASE');
}
