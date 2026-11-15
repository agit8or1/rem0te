#!/usr/bin/env node
// Writes a GeoIP City database for the docs demo stack, holding exactly the
// addresses prisma/_docs-demo-data.ts gives its computers, each placed in the
// city that business is in. Usage:
//
//   node apps/api/scripts/docs-geoip-fixture.mjs /path/to/docs-geoip.mmdb
//
// and run the demo API with GEOIP_DB_PATH pointing at it. Without it the demo
// API either reads this host's own GeoIP file (GeoipService falls back to the
// production path) or, given a path that does not exist, places nothing, and
// the dashboard map and the client map are empty.
//
// Nothing under apps/api/src imports this or the writer (§54).
import { writeCityMmdb } from './lib/mmdb-fixture.mjs';

const out = process.argv[2];
if (!out) { console.error('usage: docs-geoip-fixture.mjs OUT.mmdb'); process.exit(2); }

const place = (ip, city, region, regionCode, lat, lon) =>
  ({ cidr: `${ip}/32`, city, region, regionCode, country: 'US', countryName: 'United States', lat, lon });

const entries = [
  place('184.41.65.179', 'Portland', 'Oregon', 'OR', 45.5152, -122.6784),       // Northwind Dental
  place('56.173.218.124', 'Seattle', 'Washington', 'WA', 47.6062, -122.3321),   // Cascade Accounting
  place('99.92.21.167', 'Tacoma', 'Washington', 'WA', 47.2529, -122.4443),      // Harbor Logistics
  place('69.128.60.131', 'Bend', 'Oregon', 'OR', 44.0582, -121.3153),           // Cedar Ridge Veterinary
  place('168.156.157.53', 'Olympia', 'Washington', 'WA', 47.0379, -122.9007),   // Puget Sound Legal
  place('76.135.254.231', 'Everett', 'Washington', 'WA', 47.979, -122.2021),    // Alder Creek Fabrication
  place('168.225.185.124', 'Boise', 'Idaho', 'ID', 43.615, -116.2023),          // HARB-DEPOT-BOI
  place('134.5.102.86', 'Denver', 'Colorado', 'CO', 39.7392, -104.9903),        // CASC-CPA-REMOTE
  place('76.121.35.117', 'Spokane', 'Washington', 'WA', 47.6588, -117.426),     // HARB-DEPOT-SPO
  place('73.67.160.81', 'Eugene', 'Oregon', 'OR', 44.0521, -123.0868),          // NWD-BILLING-RMT
];

console.log(writeCityMmdb(out, entries));
