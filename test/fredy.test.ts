import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fetchNewListings, mapRow } from '../src/fredy.js';

type Case = { tableRow: Record<string, unknown>; expected: Record<string, unknown> };
const cases: Case[] = JSON.parse(readFileSync('test/fixtures/fredy-rows.json', 'utf8'));

// The fixtures are the contract: real rows captured from a live Fredy DB (docs/fredy-schema.md).
for (const [i, c] of cases.entries())
  test(`maps real fredy row ${i} (${c.tableRow.provider})`, () => {
    expect(mapRow(c.tableRow, String(c.tableRow.provider))).toEqual(c.expected);
  });

// Fredy's raw provider id is camelCase ("wgGesucht"); config.example.yaml lists platforms
// lowercase ("wggesucht"). Without this the platform filter drops every wg-gesucht listing.
test('platform id is lowercased', () => {
  expect(mapRow(cases[1].tableRow, 'wgGesucht').platform).toBe('wggesucht');
  expect(mapRow(cases[0].tableRow, 'kleinanzeigen').platform).toBe('kleinanzeigen');
});

test('number extraction: "1.050,50 €" -> 1050.5, missing -> null', () => {
  const r = mapRow({ ...cases[0].tableRow, price: '1.050,50 €', size: null }, 'immoscout');
  expect(r.price).toBe(1050.5);
  expect(r.size).toBeNull();
});

test('number extraction: string units, absent keys, junk', () => {
  const r = mapRow({ ...cases[0].tableRow, price: '950 €', size: '52,5 m²', rooms: '2 Zimmer' }, 'immoscout');
  expect([r.price, r.size, r.rooms]).toEqual([950, 52.5, 2]);
  const bare = mapRow({ id: 'x', link: 'u', title: 't', created_at: 0 }, 'immoscout');
  expect([bare.price, bare.size, bare.rooms, bare.address, bare.description]).toEqual([null, null, null, null, null]);
  expect(mapRow({ ...cases[0].tableRow, price: 'k.A.' }, 'immoscout').price).toBeNull();
});

test('image_url maps to a 0- or 1-element array', () => {
  expect(mapRow(cases[2].tableRow, 'immoscout').imageUrls).toEqual([]); // real immoscout row: image_url null
  expect(mapRow(cases[0].tableRow, 'kleinanzeigen').imageUrls).toEqual([cases[0].tableRow.image_url]);
});

/** Builds a throwaway Fredy-shaped DB. Rows land at rowid 1..n in insertion order. */
function tempFredyDb(rows: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-fredy-'));
  const path = join(dir, 'listings.db');
  const db = new Database(path);
  db.exec('CREATE TABLE listings (id TEXT PRIMARY KEY, created_at INTEGER, provider TEXT, price INTEGER, size INTEGER, title TEXT, image_url TEXT, description TEXT, address TEXT, link TEXT, rooms INTEGER)');
  const cols = ['id', 'created_at', 'provider', 'price', 'size', 'title', 'image_url', 'description', 'address', 'link', 'rooms'];
  const ins = db.prepare(`INSERT INTO listings (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`);
  for (const r of rows) ins.run(Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('fetchNewListings: rowid watermark, ascending, exclusive, no rewind', () => {
  const rows = cases.map((c) => c.tableRow);
  const { path, cleanup } = tempFredyDb(rows);

  const all = fetchNewListings(path, 0);
  expect(all.listings.map((l) => l.id)).toEqual(rows.map((r) => r.id));
  expect(all.maxRowId).toBe(rows.length);

  // exclusive: the row at the watermark is not re-emitted
  const after = fetchNewListings(path, 1);
  expect(after.listings.map((l) => l.id)).toEqual(rows.slice(1).map((r) => r.id));
  expect(after.maxRowId).toBe(rows.length);

  // nothing new -> watermark held, never rewound
  const none = fetchNewListings(path, rows.length);
  expect(none.listings).toEqual([]);
  expect(none.maxRowId).toBe(rows.length);

  cleanup();
});

// Regression: Fredy writes a whole provider batch inside one millisecond (134/135 live rows
// shared a created_at), so a created_at watermark drops all but one row of each batch.
test('fetchNewListings: rows sharing created_at are ALL returned and maxRowId advances', () => {
  const shared = 1786787362568;
  const batch = [0, 1, 2].map((i) => ({ ...cases[0].tableRow, id: `same-ms-${i}`, created_at: shared }));
  const { path, cleanup } = tempFredyDb(batch);

  const all = fetchNewListings(path, 0);
  expect(all.listings.map((l) => l.id)).toEqual(['same-ms-0', 'same-ms-1', 'same-ms-2']);
  expect(all.maxRowId).toBe(3);
  // identical timestamps: proof a created_at watermark would have collapsed these to one
  expect(new Set(all.listings.map((l) => l.discoveredAt)).size).toBe(1);

  // resuming mid-batch still advances by rowid, not by timestamp
  const rest = fetchNewListings(path, 1);
  expect(rest.listings.map((l) => l.id)).toEqual(['same-ms-1', 'same-ms-2']);
  expect(rest.maxRowId).toBe(3);

  cleanup();
});
