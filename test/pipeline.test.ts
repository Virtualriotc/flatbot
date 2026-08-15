import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { processListing, tick } from '../src/pipeline.js';

const cfg = { hard: { maxWarmRent: 1000, minSqm: 30, minRooms: 1, maxRooms: 2, city: 'Berlin',
    districtBlocklist: [], stalenessCutoffHours: 24 }, thresholds: { apply: 75, ask: 50 },
  preferences: 'p', profile: 'longprofile', platforms: [], llm: { provider: 'claude-cli' } } as any;
const L = (patch = {}) => ({ id: 'a1', platform: 'immoscout', title: 'T', url: 'u', price: 900,
  size: 40, rooms: 2, address: 'Musterstr 1, Berlin', description: 'd', imageUrls: [],
  discoveredAt: new Date().toISOString(), ...patch });
const letter = 'Sehr geehrte Damen und Herren, '.repeat(12);
const APPLY = '{"score": 90, "reasons": "great", "scam": false}';

function deps(judgeJson: string, over: Record<string, unknown> = {}) {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fb-')), 't.sqlite');
  const db = openDb(dbPath);
  const notify = { ask: vi.fn(async () => {}), receipt: vi.fn(async () => {}), text: vi.fn(async () => {}) };
  // the judge prompt is the only one that spells out the "score" JSON key
  const llm = vi.fn(async (p: string) => (p.includes('"score"') ? judgeJson : letter));
  return { cfg: { ...cfg, dbPath, ...over }, db, llm, notify } as any;
}

/** Fredy-shaped throwaway DB; rows land at rowid 1..n in insertion order. */
function tempFredyDb(rows: Record<string, unknown>[]) {
  const path = join(mkdtempSync(join(tmpdir(), 'fb-fredy-')), 'listings.db');
  const db = new Database(path);
  db.exec('CREATE TABLE listings (id TEXT PRIMARY KEY, created_at INTEGER, provider TEXT, price INTEGER, size INTEGER, title TEXT, image_url TEXT, description TEXT, address TEXT, link TEXT, rooms INTEGER)');
  const cols = ['id', 'created_at', 'provider', 'price', 'size', 'title', 'image_url', 'description', 'address', 'link', 'rooms'];
  const ins = db.prepare(`INSERT INTO listings (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`);
  for (const r of rows) ins.run(Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  db.close();
  return path;
}
const fredyRow = (id: string) => ({ id, created_at: Date.now(), provider: 'immoscout',
  price: 900, size: 40, rooms: 2, title: 'T', link: `https://x/${id}` });

// Distillation is write-only until the judge reads the file back — this is the other half.
test('the lessons in learned.md reach the judge prompt', async () => {
  const d = deps(APPLY);
  writeFileSync(join(dirname(d.cfg.dbPath), 'learned.md'), '- only quiet streets\n');
  await processListing(d, L());
  expect(d.llm.mock.calls[0][0]).toContain('only quiet streets');
});

test('rules reject skips llm entirely', async () => {
  const d = deps('never used');
  await processListing(d, L({ price: 2000 }));
  expect(d.llm).not.toHaveBeenCalled();
  expect(d.db.getListing('a1')!.status).toBe('skipped_rules');
});

// N5. `hard.city` is free text nobody validates ("Muenchen", "Frankfurt am Main"), and a rule skip
// never reaches Telegram: a city the portal spells differently used to reject everything in silence.
test('a listing that misses the configured city is asked about, never silently skipped', async () => {
  const d = deps(APPLY);
  d.db.setMeta('mode', 'auto');
  await processListing(d, L({ address: 'Altona, Hamburg', title: '2-Zi' }));

  const row = d.db.getListing('a1')!;
  expect(row.status).toBe('asked');          // not skipped_rules, and not queued for a send
  expect(row.reasons).toContain('not in Berlin');
  expect(d.notify.ask).toHaveBeenCalledOnce();
});

test('every other rule violation still ends the listing without an LLM call', async () => {
  const d = deps('never used');
  await processListing(d, L({ address: 'Altona, Hamburg', size: 10 }));
  expect(d.llm).not.toHaveBeenCalled();
  expect(d.db.getListing('a1')!.status).toBe('skipped_rules');
});

test('apply-tier in shadow → receipt with letter stored', async () => {
  const d = deps(APPLY);
  await processListing(d, L());
  expect(d.notify.receipt).toHaveBeenCalledOnce();
  expect(d.notify.ask).not.toHaveBeenCalled();
  expect(d.db.getListing('a1')!.status).toBe('asked');
  expect(d.db.getListing('a1')!.letter).toContain('Sehr geehrte');
});

test('ask-tier → ask; judge-skip → no notify; duplicate id → no reprocess', async () => {
  const d = deps('{"score": 60, "reasons": "meh", "scam": false}');
  await processListing(d, L()); expect(d.notify.ask).toHaveBeenCalledOnce();
  const d2 = deps('{"score": 10, "reasons": "bad", "scam": false}');
  await processListing(d2, L()); expect(d2.notify.ask).not.toHaveBeenCalled();
  expect(d2.db.getListing('a1')!.status).toBe('skipped_judge');
  await processListing(d, L()); expect(d.notify.ask).toHaveBeenCalledOnce(); // still once
});

test('llm blowup marks error, does not throw', async () => {
  const d = deps('x'); d.llm = vi.fn(async () => { throw new Error('boom'); });
  await processListing(d, L());
  expect(d.db.getListing('a1')!.status).toBe('error');
  expect(d.db.getListing('a1')!.reasons).toBe('boom');
});

// Telegram is the whole UI, so a 502 from it is a routine event. It must not overwrite the
// listing with `error`: nothing retries `error`, nothing counts it, and the user never learns
// the listing existed.
test('a Telegram outage leaves the listing at asked instead of burying it as error', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const d = deps('{"score": 60, "reasons": "borderline", "scam": false}');
  d.notify.ask = vi.fn(async () => { throw new Error('502 Bad Gateway'); });

  await processListing(d, L());

  const r = d.db.getListing('a1')!;
  expect(r.status).toBe('asked');
  expect(r.score).toBe(60);
  log.mockRestore();
});

test('auto mode: apply-tier → queued with no ask; ask-tier still asks', async () => {
  const d = deps(APPLY);
  d.db.setMeta('mode', 'auto');
  await processListing(d, L());
  expect(d.db.getListing('a1')!.status).toBe('queued');
  expect(d.notify.ask).not.toHaveBeenCalled();
  expect(d.notify.receipt).not.toHaveBeenCalled();
  expect(d.db.getListing('a1')!.letter).toContain('Sehr geehrte');

  const d2 = deps('{"score": 60, "reasons": "meh", "scam": false}');
  d2.db.setMeta('mode', 'auto');
  await processListing(d2, L());
  expect(d2.db.getListing('a1')!.status).toBe('asked');
  expect(d2.notify.ask).toHaveBeenCalledOnce();
});

test('scam is never queued, even in auto mode, and the warning reaches the reasons', async () => {
  const d = deps('{"score": 95, "reasons": "too cheap", "scam": true}');
  d.db.setMeta('mode', 'auto');
  await processListing(d, L());
  const r = d.db.getListing('a1')!;
  expect(r.status).toBe('asked');
  expect(r.scam).toBe(1);
  expect(r.reasons).toMatch(/scam/i);
  expect(d.notify.ask).toHaveBeenCalledOnce();
});

test('platform not enabled → skipped_rules naming the platform, no llm', async () => {
  const d = deps(APPLY, { platforms: ['immoscout'] });
  await processListing(d, L({ platform: 'kleinanzeigen' }));
  expect(d.llm).not.toHaveBeenCalled();
  const r = d.db.getListing('a1')!;
  expect(r.status).toBe('skipped_rules');
  expect(r.reasons).toContain('kleinanzeigen');
  // empty platforms list means "no filter", not "block everything"
  const d2 = deps(APPLY);
  await processListing(d2, L({ platform: 'kleinanzeigen' }));
  expect(d2.db.getListing('a1')!.status).toBe('asked');
});

test('unusable letter → ask still goes out, letter left empty', async () => {
  const d = deps('{"score": 60, "reasons": "meh", "scam": false}');
  d.llm = vi.fn(async (p: string) => (p.includes('"score"') ? '{"score": 60, "reasons": "meh", "scam": false}' : 'zu kurz'));
  await processListing(d, L());
  expect(d.notify.ask).toHaveBeenCalledOnce();
  const r = d.db.getListing('a1')!;
  expect(r.status).toBe('asked');
  expect(r.letter).toBeNull();
});

// A queued listing with no letter is unsendable and nothing notifies on the queued path,
// so it would silently vanish. Auto mode must fall back to asking.
test('auto mode: no letter → asked + ask, never queued', async () => {
  const d = deps(APPLY);
  d.db.setMeta('mode', 'auto');
  d.llm = vi.fn(async (p: string) => {
    if (p.includes('"score"')) return APPLY;
    throw new Error('letter llm down');
  });
  await processListing(d, L());
  const r = d.db.getListing('a1')!;
  expect(r.status).toBe('asked');
  expect(r.letter).toBeNull();
  expect(d.notify.ask).toHaveBeenCalledOnce();
});

// The dedupe guard skips non-'new' only: a row a crash left at 'new' must still be picked up.
test('a listing left at status new is reprocessed', async () => {
  const d = deps(APPLY);
  d.db.upsertListing(L());
  expect(d.db.getListing('a1')!.status).toBe('new');
  await processListing(d, L());
  expect(d.db.getListing('a1')!.status).toBe('asked');
  expect(d.notify.receipt).toHaveBeenCalledOnce();
});

test('tick: processes the batch and advances the watermark only after it', async () => {
  const d = deps(APPLY, { fredyDbPath: tempFredyDb([fredyRow('f1'), fredyRow('f2')]) });
  await tick(d);
  expect(d.notify.receipt).toHaveBeenCalledTimes(2);
  expect(d.db.getListing('f1')!.status).toBe('asked');
  expect(d.db.getMeta('watermark')).toBe('2');

  await tick(d); // nothing new: no reprocessing, watermark held
  expect(d.notify.receipt).toHaveBeenCalledTimes(2);
  expect(d.db.getMeta('watermark')).toBe('2');
});

test('tick: paused does nothing; unreadable fredy db does not throw or advance', async () => {
  const d = deps(APPLY, { fredyDbPath: tempFredyDb([fredyRow('f1')]) });
  d.db.setMeta('paused', '1');
  await tick(d);
  expect(d.llm).not.toHaveBeenCalled();
  expect(d.db.getMeta('watermark')).toBeUndefined();

  const d2 = deps(APPLY, { fredyDbPath: join(tmpdir(), 'flatbot-does-not-exist.db') });
  await tick(d2);
  expect(d2.db.getMeta('watermark')).toBeUndefined();
});
