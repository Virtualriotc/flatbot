import Database from 'better-sqlite3';

export { type Listing } from './db.js';
import { type Listing } from './db.js';

/**
 * Fredy already stores price/size/rooms as numbers (docs/fredy-schema.md), but providers
 * change; accept German-formatted strings too ("1.050,50 €" -> 1050.5, "52 m²" -> 52).
 */
export function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/\./g, '').replace(',', '.').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

export function mapRow(row: Record<string, unknown>, platform: string): Listing {
  const image = str(row.image_url);
  return {
    id: String(row.id),
    // Fredy's raw provider ids are camelCase ("wgGesucht"); flatbot's config uses lowercase.
    platform: platform.toLowerCase(),
    title: String(row.title ?? ''),
    url: String(row.link ?? ''),
    price: num(row.price),
    size: num(row.size),
    rooms: num(row.rooms),
    address: str(row.address),
    description: str(row.description), // null for immoscout unless Fredy detail-fetch is on
    imageUrls: image ? [image] : [],   // Fredy keeps one image per listing, not a gallery
    discoveredAt: new Date(Number(row.created_at)).toISOString(),
  };
}

/**
 * Reads Fredy's DB read-only. Watermark is `rowid` (unique, strictly monotonic), exclusive.
 * NOT `created_at`: Fredy writes a whole provider batch inside the same millisecond, so
 * 134 of 135 live rows shared a `created_at` with another row — a timestamp watermark
 * silently drops ~95% of a batch. `rowid` is not in `SELECT *`, so it is aliased explicitly.
 */
export function fetchNewListings(
  fredyDbPath: string,
  afterRowId: number,
): { listings: Listing[]; maxRowId: number } {
  const db = new Database(fredyDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare('SELECT rowid AS rowid, * FROM listings WHERE rowid > ? ORDER BY rowid ASC')
      .all(afterRowId) as Record<string, unknown>[];
    return {
      listings: rows.map((r) => mapRow(r, String(r.provider ?? ''))),
      maxRowId: rows.length ? Number(rows[rows.length - 1].rowid) : afterRowId,
    };
  } finally {
    db.close();
  }
}
