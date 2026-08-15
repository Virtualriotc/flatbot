import { expect, test } from 'vitest';
import { checkRules } from '../src/rules.js';
import type { Listing } from '../src/db.js';

const hard = { maxWarmRent: 1000, minSqm: 30, minRooms: 1, maxRooms: 2, city: 'Berlin',
  districtBlocklist: ['Marzahn'], stalenessCutoffHours: 24 };
const base: Listing = { id: 'x', platform: 'p', title: 't', url: 'u', price: 900, size: 40, rooms: 2,
  address: 'Friedrichshain, Berlin', description: null, imageUrls: [], discoveredAt: new Date().toISOString() };
const cases: [string, Partial<typeof base>, boolean][] = [
  ['ok', {}, true],
  ['too expensive', { price: 1001 }, false],
  ['too small', { size: 29 }, false],
  ['too many rooms', { rooms: 3 }, false],
  ['blocklisted district', { address: 'Marzahn-Hellersdorf' }, false],
  ['null price passes', { price: null }, true],
  ['stale', { discoveredAt: new Date(Date.now() - 25 * 3600e3).toISOString() }, false],
];
for (const [name, patch, pass] of cases)
  test(name, () => expect(checkRules({ ...base, ...patch }, hard).pass).toBe(pass));

test('blocklist match is case-insensitive', () => {
  expect(checkRules({ ...base, address: 'marzahn, berlin' }, hard).pass).toBe(false);
});

test('null size, rooms, address and unparseable discoveredAt all pass', () => {
  const l = { ...base, size: null, rooms: null, address: null, discoveredAt: 'not-a-date' };
  expect(checkRules(l, hard).pass).toBe(true);
});

test('empty string in blocklist does not block everything', () => {
  expect(checkRules(base, { ...hard, districtBlocklist: [''] }).pass).toBe(true);
});

// A substring match makes the blocklist a trap: one blocked district silently eats every street
// whose name starts with it, and the listing vanishes into skipped_rules unseen.
test('blocklist matches whole words, so "Mitte" does not swallow "Mittenwalder Straße"', () => {
  const h = { ...hard, districtBlocklist: ['Mitte'] };
  expect(checkRules({ ...base, address: 'Mittenwalder Straße 5, Berlin' }, h).pass).toBe(true);
  expect(checkRules({ ...base, address: 'Berlin-Mitte' }, h).pass).toBe(false);
});

test('a blocklist term ending in ß still matches', () => {
  const h = { ...hard, districtBlocklist: ['Karl-Marx-Straße'] };
  expect(checkRules({ ...base, address: 'Karl-Marx-Straße 12, Berlin' }, h).pass).toBe(false);
});

// hard.city was collected, stored and shown to the judge as "already enforced" while nothing
// enforced it; a widened Fredy search would push out-of-city listings all the way to a send.
test('city is enforced against the address', () => {
  expect(checkRules({ ...base, address: 'Altona, Hamburg', title: '2-Zi Wohnung' }, hard).pass).toBe(false);
  expect(checkRules({ ...base, address: 'Altona, Hamburg', title: '2-Zi' }, hard).reason)
    .toContain('not in Berlin');
});

// Real Fredy rows carry a district-only address ("12489 Köpenick") with the city in the title.
test('city found in the title rescues a district-only address', () => {
  const l = { ...base, address: '12489 Köpenick', title: 'Student Housing in Berlin Adlershof' };
  expect(checkRules(l, hard).pass).toBe(true);
});

// A whole-phrase match rejected every listing for anyone whose city has more than one word: the
// portal writes "60313 Frankfurt", never "Frankfurt am Main".
test('a multi-word city matches on any of its own words', () => {
  const h = { ...hard, city: 'Frankfurt am Main' };
  expect(checkRules({ ...base, address: '60313 Frankfurt', title: '2-Zi' }, h).pass).toBe(true);
  expect(checkRules({ ...base, address: 'Altona, Hamburg', title: '2-Zi' }, h).pass).toBe(false);
});

// A city the portal spells differently (Muenchen/München) is a config mistake, not a listing
// property — it must reach a human instead of silently dropping everything.
test('a city miss is soft; every other violation is hard', () => {
  const miss = checkRules({ ...base, address: 'Altona, Hamburg', title: '2-Zi' }, hard);
  expect(miss).toMatchObject({ pass: false, soft: true });
  expect(checkRules({ ...base, price: 5000 }, hard)).toMatchObject({ pass: false });
  expect((checkRules({ ...base, price: 5000 }, hard) as any).soft).toBeUndefined();
});

test('no address means no city check — an absent field never drops the listing', () => {
  expect(checkRules({ ...base, address: null, title: 'Wohnung in Hamburg' }, hard).pass).toBe(true);
});

test('an empty city turns the check off', () => {
  expect(checkRules({ ...base, address: 'Altona, Hamburg', title: '2-Zi' }, { ...hard, city: '' }).pass).toBe(true);
});

test('first failed check wins and reason names the check and values', () => {
  const r = checkRules({ ...base, price: 1500, size: 10 }, hard);
  expect(r).toEqual({ pass: false, reason: 'price 1500 > maxWarmRent 1000' });
});

test('now is injectable for staleness', () => {
  const discoveredAt = '2026-08-15T00:00:00.000Z';
  expect(checkRules({ ...base, discoveredAt }, hard, new Date('2026-08-15T23:00:00.000Z')).pass).toBe(true);
  expect(checkRules({ ...base, discoveredAt }, hard, new Date('2026-08-16T01:00:00.000Z')).pass).toBe(false);
});
