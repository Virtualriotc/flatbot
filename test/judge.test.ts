import { expect, test } from 'vitest';
import { buildJudgePrompt, parseVerdict } from '../src/judge.js';
const t = { apply: 75, ask: 50 };

test('derives decision from score', () => {
  expect(parseVerdict('{"score": 80, "reasons": "r", "scam": false}', t).decision).toBe('apply');
  expect(parseVerdict('{"score": 60, "reasons": "r", "scam": false}', t).decision).toBe('ask');
  expect(parseVerdict('{"score": 10, "reasons": "r", "scam": false}', t).decision).toBe('skip');
});

test('scam never auto-applies', () => {
  expect(parseVerdict('{"score": 95, "reasons": "cheap!", "scam": true}', t).decision).toBe('ask');
});

test('clamps out-of-range score', () => {
  expect(parseVerdict('{"score": 140, "reasons": "", "scam": false}', t).score).toBe(100);
});

test('a quoted score is a score — real models quote numbers', () => {
  expect(parseVerdict('{"score": "80", "reasons": "r", "scam": false}', t))
    .toMatchObject({ score: 80, decision: 'apply' });
});

test('a missing or unparseable score is still a hard error, never a silent 0', () => {
  for (const raw of ['{"reasons": "r"}', '{"score": "hoch"}', '{"score": null}', '{"score": {}}'])
    expect(() => parseVerdict(raw, t)).toThrow(/numeric score/);
});

const listing = { id: 'x', platform: 'immoscout', title: 'T', url: 'u', price: 900,
  size: 40, rooms: 2, address: 'Xberg', description: 'D', imageUrls: [], discoveredAt: '2026-08-15' } as any;
const cfg = { preferences: 'PREFTEXT', hard: { maxWarmRent: 1000 }, thresholds: t } as any;

test('prompt contains preferences, feedback, listing and JSON instruction', () => {
  const p = buildJudgePrompt(listing, cfg, ['no Marzahn']);
  for (const s of ['PREFTEXT', 'no Marzahn', 'T', '"score"']) expect(p).toContain(s);
  expect(p).not.toContain('LEARNED PREFERENCES'); // 3-arg callers unchanged
});

test('learned preferences appear only when passed, above the verbatim feedback', () => {
  const p = buildJudgePrompt(listing, cfg, ['no Marzahn'], '- prefers Altbau');
  expect(p).toContain('LEARNED PREFERENCES');
  expect(p).toContain('- prefers Altbau');
  expect(p).toContain('no Marzahn');
  expect(p.indexOf('LEARNED PREFERENCES')).toBeLessThan(p.indexOf('PAST FEEDBACK'));
  expect(buildJudgePrompt(listing, cfg, ['no Marzahn'], '')).not.toContain('LEARNED PREFERENCES');
});
