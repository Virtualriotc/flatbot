import { expect, test } from 'vitest';
import { PLATFORMS, platformFor } from '../src/platforms.js';

const exposeUrls: Record<string, string> = {
  immoscout: 'https://www.immobilienscout24.de/expose/123456789',
  kleinanzeigen: 'https://www.kleinanzeigen.de/s-anzeige/2-zi-wohnung-friedrichshain/2098765432-203-1234',
  wggesucht: 'https://www.wg-gesucht.de/wohnungen-in-Berlin-Friedrichshain.9876543.html',
  immowelt: 'https://www.immowelt.de/expose/2ab3cd4',
};

test('covers exactly the four configured portals', () => {
  expect(PLATFORMS.map((p) => p.id)).toEqual(['immoscout', 'kleinanzeigen', 'wggesucht', 'immowelt']);
});

test('platformFor resolves by id and by listing url', () => {
  for (const [id, url] of Object.entries(exposeUrls)) {
    expect(platformFor(id)?.id).toBe(id);
    expect(platformFor(url)?.id).toBe(id);
  }
});

test('kleinanzeigen still answers to its legacy ebay domain', () => {
  expect(platformFor('https://www.ebay-kleinanzeigen.de/s-anzeige/x/123-203-1')?.id).toBe('kleinanzeigen');
});

test('unknown id, foreign host and garbage resolve to undefined', () => {
  expect(platformFor('zillow')).toBeUndefined();
  expect(platformFor('https://www.zillow.com/homedetails/1')).toBeUndefined();
  expect(platformFor('not a url at all')).toBeUndefined();
  // a lookalike host must not match by substring
  expect(platformFor('https://immowelt.de.evil.example/expose/1')).toBeUndefined();
});

test('every spec carries the guidance the send agent needs', () => {
  for (const p of PLATFORMS) {
    expect(p.displayName).toBeTruthy();
    expect(p.loginUrl).toMatch(/^https:\/\//);
    expect(p.contactInstructions.trim().length).toBeGreaterThan(80);
    expect(p.paywallMarkers.length).toBeGreaterThan(0);
    expect(p.successMarkers.length).toBeGreaterThan(0);
    expect(p.matchesUrl(p.loginUrl)).toBe(true);
  }
});

test('immoscout knows the MieterPlus paywall', () => {
  expect(platformFor('immoscout')!.paywallMarkers.some((m) => /mieterplus/i.test(m))).toBe(true);
});
