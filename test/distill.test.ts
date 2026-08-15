import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import { maybeDistill, readLearned } from '../src/distill.js';

const DAY = 86_400_000;

/** A db + a Config whose dbPath sits in a fresh temp "config dir"; `n` feedback memos. */
function setup(n: number) {
  const dir = mkdtempSync(join(tmpdir(), 'fb-distill-'));
  const cfg = { dbPath: join(dir, 't.sqlite') } as Config;
  const db = openDb(cfg.dbPath);
  for (let i = 1; i <= n; i++) db.addFeedback(null, `fb-${String(i).padStart(2, '0')}`);
  return { dir, cfg, db, learned: join(dir, 'learned.md') };
}

function llmSpy(reply: string | Error) {
  const prompts: string[] = [];
  const llm = async (p: string) => {
    prompts.push(p);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { prompts, llm };
}

test('skips when there are 20 or fewer feedback rows', async () => {
  const { cfg, db, learned } = setup(20);
  const { llm, prompts } = llmSpy('- lesson');
  expect(await maybeDistill({ cfg, db, llm })).toBe(false);
  expect(prompts).toEqual([]);
  expect(existsSync(learned)).toBe(false);
  expect(db.getMeta('lastDistillAt')).toBeUndefined();
});

test('skips when the last distillation is less than 7 days old', async () => {
  const { cfg, db, learned } = setup(25);
  const now = Date.now();
  db.setMeta('lastDistillAt', String(now - 6 * DAY));
  const { llm, prompts } = llmSpy('- lesson');
  expect(await maybeDistill({ cfg, db, llm, now: () => now })).toBe(false);
  expect(prompts).toEqual([]);
  expect(existsSync(learned)).toBe(false);
  expect(db.getMeta('lastDistillAt')).toBe(String(now - 6 * DAY));
});

test('runs when never distilled and more than 20 rows: writes learned.md and stamps meta', async () => {
  const { cfg, db, learned } = setup(25);
  const now = Date.now();
  const { llm, prompts } = llmSpy('- prefers Altbau\n- no ground floor');
  expect(await maybeDistill({ cfg, db, llm, now: () => now })).toBe(true);

  // only the feedback older than the newest 20 goes into the prompt
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('fb-01');
  expect(prompts[0]).toContain('fb-05');
  expect(prompts[0]).not.toContain('fb-25');

  const text = readFileSync(learned, 'utf8');
  expect(text).toMatch(/edit or delete/i);
  expect(text).toContain('- prefers Altbau');
  expect(db.getMeta('lastDistillAt')).toBe(String(now));
});

// The newest 20 memos are already in every judge prompt verbatim; distilling them too would
// double-count them and let a stale summary outvote what the user said yesterday.
test('the newest 20 memos are excluded from the prompt, older ones are not', async () => {
  const { cfg, db } = setup(25);
  const { llm, prompts } = llmSpy('- lesson');
  expect(await maybeDistill({ cfg, db, llm })).toBe(true);

  for (const kept of ['fb-01', 'fb-02', 'fb-03', 'fb-04', 'fb-05']) expect(prompts[0]).toContain(kept);
  for (let i = 6; i <= 25; i++) expect(prompts[0]).not.toContain(`fb-${String(i).padStart(2, '0')}`);
});

test('a blank LLM reply writes nothing and leaves the stamp alone, so the next tick retries', async () => {
  const { cfg, db, learned } = setup(25);
  const { llm } = llmSpy('  \n \n');
  expect(await maybeDistill({ cfg, db, llm })).toBe(false);
  expect(existsSync(learned)).toBe(false);
  expect(db.getMeta('lastDistillAt')).toBeUndefined();
});

test('runs again once the stamp is older than 7 days, overwriting the file', async () => {
  const { cfg, db, learned } = setup(25);
  const now = Date.now();
  db.setMeta('lastDistillAt', String(now - 8 * DAY));
  writeFileSync(learned, 'stale content');
  const { llm } = llmSpy('- fresh lesson');
  expect(await maybeDistill({ cfg, db, llm, now: () => now })).toBe(true);
  const text = readFileSync(learned, 'utf8');
  expect(text).toContain('- fresh lesson');
  expect(text).not.toContain('stale content');
});

test('LLM failure leaves meta and learned.md untouched and does not throw', async () => {
  const { cfg, db, learned } = setup(25);
  const { llm } = llmSpy(new Error('llm down'));
  expect(await maybeDistill({ cfg, db, llm })).toBe(false);
  expect(existsSync(learned)).toBe(false);
  expect(db.getMeta('lastDistillAt')).toBeUndefined();
});

test('readLearned: undefined when absent or blank, header stripped when present', async () => {
  const { cfg, db, learned } = setup(25);
  expect(readLearned(cfg)).toBeUndefined();

  const { llm } = llmSpy('- prefers Altbau');
  await maybeDistill({ cfg, db, llm });
  const out = readLearned(cfg)!;
  expect(out).toContain('- prefers Altbau');
  expect(out).not.toMatch(/edit or delete/i);
  expect(dirname(learned)).toBe(dirname(cfg.dbPath)); // lives next to the config/db

  writeFileSync(learned, '   \n');
  expect(readLearned(cfg)).toBeUndefined();
});

test('reads a hand-written learned.md the user wrote themselves', () => {
  const { cfg, learned } = setup(0);
  writeFileSync(learned, '- only quiet streets\n');
  expect(readLearned(cfg)).toBe('- only quiet streets');
});

test('db.allFeedback returns every memo newest first', () => {
  const { db } = setup(3);
  expect((db as Db).allFeedback()).toEqual(['fb-03', 'fb-02', 'fb-01']);
});
