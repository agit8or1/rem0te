import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { open, type Reader, type CityResponse } from 'maxmind';
import * as fs from 'fs';

export type GeoAccuracy = 'city' | 'country';

export interface GeoLocation {
  lat: number;
  lon: number;
  city: string | null;
  region: string | null;
  country: string;
  countryName: string | null;
  /**
   * 'city'    — a specific place; the coordinates mean something.
   * 'country' — only the country was known, so these are its centroid. The
   *             point is NOT where the machine is.
   */
  accuracy: GeoAccuracy;
}

/**
 * Offline IP geolocation, backed by the DB-IP City Lite database.
 *
 * Offline on purpose: the addresses being resolved belong to customers'
 * networks, and posting them to a lookup API on every dashboard load is a
 * disclosure we would be making on their behalf. It also keeps the map working
 * when that third party is down or rate-limiting us.
 *
 * DB-IP rather than the bundled geoip-lite data, which was badly out of date —
 * it placed a Jacksonville endpoint on the US centroid because it had never
 * heard of the regional ISP. DB-IP City Lite is refreshed monthly, needs no
 * licence key, and resolved both of this deployment's endpoints correctly.
 *
 * The database is NOT in the repository (124 MB). `scripts/update-geoip.sh`
 * fetches it; a missing file degrades to "no locations" rather than failing.
 *
 * Data: DB-IP City Lite, CC BY 4.0 — https://db-ip.com. Attribution is shown
 * on the dashboard map and required by that licence.
 */
@Injectable()
export class GeoipService implements OnModuleInit {
  private readonly logger = new Logger(GeoipService.name);
  private reader: Reader<CityResponse> | null = null;
  private warned = false;

  private dbPath(): string {
    return process.env.GEOIP_DB_PATH ?? '/opt/reboot-remote/data/geoip/dbip-city-lite.mmdb';
  }

  async onModuleInit() {
    const path = this.dbPath();
    if (!fs.existsSync(path)) {
      this.logger.warn(
        `GeoIP database not found at ${path} — the dashboard map will report every ` +
        `computer as unlocatable. Run scripts/update-geoip.sh to install it.`,
      );
      return;
    }
    try {
      this.reader = await open<CityResponse>(path);
      this.logger.log(`GeoIP database loaded from ${path}`);
    } catch (e) {
      this.logger.error(`Failed to open GeoIP database: ${(e as Error).message}`);
    }
  }

  /** RFC1918 / loopback / link-local / CGNAT — never publicly geolocatable. */
  private isPrivate(ip: string): boolean {
    return (
      /^10\./.test(ip) ||
      /^192\.168\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
      /^127\./.test(ip) ||
      /^169\.254\./.test(ip) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ||
      ip === '::1' ||
      /^f[cd][0-9a-f]{2}:/i.test(ip)
    );
  }

  /**
   * Resolve an address, or null when it cannot be placed. Callers must treat
   * null as "unknown" and surface it — silently dropping unlocatable machines
   * would make the map look complete when it is not.
   */
  lookup(ip: string | null | undefined): GeoLocation | null {
    if (!ip || !this.reader) {
      if (!this.reader && !this.warned) {
        this.warned = true;
        this.logger.warn('GeoIP lookups requested but no database is loaded.');
      }
      return null;
    }
    // Endpoints behind our own proxy arrive IPv4-mapped (::ffff:1.2.3.4).
    const addr = ip.replace(/^::ffff:/i, '').trim();
    if (!addr || this.isPrivate(addr)) return null;

    let r: CityResponse | null;
    try {
      r = this.reader.get(addr);
    } catch {
      // A malformed address should not take the dashboard down with it.
      return null;
    }
    if (!r?.location) return null;

    const city = r.city?.names?.en?.trim() || null;
    const region = r.subdivisions?.[0]?.names?.en?.trim() || null;
    const country = r.country?.iso_code ?? r.registered_country?.iso_code ?? null;
    if (!country) return null;

    return {
      lat: r.location.latitude,
      lon: r.location.longitude,
      city,
      region,
      country,
      countryName: r.country?.names?.en ?? null,
      // Without a city these coordinates are a country centroid. Calling that
      // "city" would imply a precision we do not have.
      accuracy: city ? 'city' : 'country',
    };
  }
}
