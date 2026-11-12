/**
 * The device side of chat, as a 0.34 signed agent's chat host speaks it
 * (chat protocol 1; tools/windows-installer internal/chat/client.go until 0.36
 * replaced it with the tray host, but 0.34 agents in the field still speak
 * it): the device-authenticated
 * routes POST /enrollment/chat/poll and /enrollment/chat/reply, and the
 * heartbeat, each carrying the computer's RustDesk ID and device secret.
 *
 * Shared by e2e-chat.mjs (0.34) and apps/web/scripts/e2e-ui.mjs (0.35), so the
 * browser suite drives the same simulated computer the API suite proves.
 *
 *   const dev = chatDevice(req);   // req(method, path, { body }) → { status, body, data }
 *   await dev.poll(ep, { delivered: [id], noWait: true });
 *
 * `ep` is { rid, secret, hostname, platform }. Passing `secret` explicitly
 * (or null for the heartbeat) tests a wrong or missing one.
 */
import { randomBytes } from 'node:crypto';

export function chatDevice(req) {
  const poll = (ep, body = {}, secret = ep.secret) => req('POST', '/enrollment/chat/poll', { body: { rustdeskId: ep.rid, agentSecret: secret, ...body } });
  const reply = (ep, conversationId, text, clientId = randomBytes(12).toString('hex'), secret = ep.secret) =>
    req('POST', '/enrollment/chat/reply', { body: { rustdeskId: ep.rid, agentSecret: secret, conversationId, clientId, text } });
  const heartbeat = (ep, extra = {}, secret = ep.secret) => req('POST', '/enrollment/heartbeat', { body: { rustdeskId: ep.rid, ...(secret ? { agentSecret: secret } : {}), hostname: ep.hostname, platform: ep.platform, ...extra } });
  return { poll, reply, heartbeat };
}
