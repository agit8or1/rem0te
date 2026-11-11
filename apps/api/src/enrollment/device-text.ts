/**
 * Strings a device reports about itself, made inert before they reach a column
 * (0.32).
 *
 * The heartbeat and claim DTOs bound these by length only, so a machine — or
 * anyone holding its device secret — could store a hostname or OS name
 * carrying newlines, escape sequences or NULs, and every place that later
 * prints one (the console, CSV exports, audit metadata, a ticket) inherited
 * them. The inventory fields already went through `str()` in
 * EndpointInventoryService; these columns on Endpoint and RustdeskNode did
 * not. The Connect .cmd keeps its own, stricter charset (RustdeskService
 * cmdSafe) on top of this.
 *
 * Control characters and whitespace runs become one space; an empty
 * result is "not reported", never an empty name.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

export function deviceText(v: string | undefined, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const clean = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return clean || undefined;
}

/** The descriptive fields of a heartbeat or claim, through deviceText. */
export function withDeviceText<T extends { hostname?: string; platform?: string; osVersion?: string; agentVersion?: string; rustdeskVersion?: string }>(dto: T): T {
  return {
    ...dto,
    hostname: deviceText(dto.hostname, 64),
    platform: deviceText(dto.platform, 32),
    osVersion: deviceText(dto.osVersion, 64),
    agentVersion: deviceText(dto.agentVersion, 32),
    rustdeskVersion: deviceText(dto.rustdeskVersion, 32),
  };
}
