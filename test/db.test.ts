import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb, type Listing } from '../src/db.js';

const L: Listing = { id: 'a1', platform: 'immoscout', title: '2-Zi Fhain', url: 'https://x/1',
  price: 950, size: 52, rooms: 2, address: 'Friedrichshain', description: 'schön',
  imageUrls: ['https://x/i.jpg'], discoveredAt: new Date().toISOString() };

function db() { return openDb(join(mkdtempSync(join(tmpdir(), 'fb-')), 't.sqlite')); }

test('upsert + decision + read back', () => {
  const d = db();
  d.upsertListing(L);
  d.setDecision('a1', { status: 'asked', score: 80, reasons: 'fits', scam: false });
  const row = d.getListing('a1')!;
  expect(row.status).toBe('asked'); expect(row.score).toBe(80); expect(row.imageUrls).toEqual(['https://x/i.jpg']);
  expect(d.findByUrl('https://x/1')!.id).toBe('a1');
});

test('upsert same id twice does not duplicate or reset status', () => {
  const d = db(); d.upsertListing(L); d.setDecision('a1', { status: 'asked' }); d.upsertListing(L);
  expect(d.getListing('a1')!.status).toBe('asked');
});

// C1's mechanism: the sender must be able to tell "leased it" from "wrote nothing".
test('setDecision and setStatusNote report whether they matched a row', () => {
  const d = db(); d.upsertListing(L);
  expect(d.setDecision('a1', { status: 'asked' })).toBe(1);
  expect(d.setDecision('nope', { status: 'asked' })).toBe(0);
  expect(d.setStatusNote('a1', 'viewing booked')).toBe(1);
  expect(d.setStatusNote('nope', 'viewing booked')).toBe(0);
});

// N2. Two `flatbot run` processes on one db (pm2 restart overlap, a second terminal) both read the
// row as `queued` and, without a status precondition, both leased it — two real applications.
test('a lease with an expected status is won by exactly one of two processes', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fb-lease-')), 't.sqlite');
  const a = openDb(path);
  const b = openDb(path);           // a second process on the same file
  a.upsertListing(L);
  a.setDecision('a1', { status: 'queued' });

  // both read `queued` before either writes, which is the whole race
  expect(a.getListing('a1')!.status).toBe('queued');
  expect(b.getListing('a1')!.status).toBe('queued');

  expect(a.setDecision('a1', { status: 'sending' }, 'queued')).toBe(1);
  expect(b.setDecision('a1', { status: 'sending' }, 'queued')).toBe(0);
  expect(a.getListing('a1')!.status).toBe('sending');
  a.close(); b.close();
});

test('an unconditional setDecision still writes whatever the status is', () => {
  const d = db(); d.upsertListing(L);
  d.setDecision('a1', { status: 'sending' });
  expect(d.setDecision('a1', { status: 'sent' })).toBe(1);
  expect(d.setDecision('a1', { status: 'sent' }, 'queued')).toBe(0);   // and the guard still bites
});

// discovered_at is compared lexicographically (ordering, stats windows): offset forms sort wrong.
test('discoveredAt is normalised to ISO on the way in', () => {
  const d = db();
  d.upsertListing({ ...L, id: 'b1', discoveredAt: '2026-08-15T09:00:00+02:00' });
  expect(d.getListing('b1')!.discoveredAt).toBe('2026-08-15T07:00:00.000Z');
  // an unparseable value is kept verbatim rather than crashing the ingest
  d.upsertListing({ ...L, id: 'b2', discoveredAt: 'not a date' });
  expect(d.getListing('b2')!.discoveredAt).toBe('not a date');
});

// The hourly cap must key off the send, not off "the last time anything touched this row".
test('countSentSince ignores writes that happen after the send', async () => {
  const d = db(); d.upsertListing(L);
  d.setDecision('a1', { status: 'sent' });
  await new Promise((r) => setTimeout(r, 5));
  const since = new Date().toISOString();
  d.setStatusNote('a1', 'landlord replied');
  expect(d.countSentSince('immoscout', since)).toBe(0);
  expect(d.countSentSince('immoscout', new Date(Date.now() - 3600e3).toISOString())).toBe(1);
});

test('feedback + meta + stats', () => {
  const d = db(); d.upsertListing(L); d.setDecision('a1', { status: 'asked' });
  d.addFeedback('a1', 'too far east'); d.addFeedback(null, 'prefer altbau');
  expect(d.recentFeedback(5)).toEqual(['prefer altbau', 'too far east']);
  d.setMeta('watermark', '42'); expect(d.getMeta('watermark')).toBe('42');
  const s = d.stats(new Date(Date.now() - 3600e3).toISOString());
  expect(s.found).toBe(1); expect(s.asked).toBe(1);
});
