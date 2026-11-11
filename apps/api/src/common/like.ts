/**
 * Escape LIKE / ILIKE metacharacters (Postgres' default escape is backslash).
 *
 * Prisma's `contains` becomes `ILIKE '%' || value || '%'` with the value
 * spliced in as is, so without this a search for `%` or `_` matches every row
 * and a `DOMAIN\user` backslash escapes the next character. Every `contains`
 * that carries text a person typed goes through here: global search
 * (search/query.ts), GET /businesses, GET /endpoints and the device list.
 */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
