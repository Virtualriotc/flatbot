import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { buildConfigYaml, cmdInit, doctor, KEEPALIVE, newestChatId, seedWatermark } from '../src/index.js';

const ARGS = {
  maxWarmRent: 900, minSqm: 35, rooms: [1, 2] as [number, number], city: 'Berlin',
  preferences: 'balcony nice-to-have\nnear office', profile: 'engineer, non-smoker',
  fredyDbPath: '../fredy/db/listings.db',
};

/** A Fredy-shaped db with n rows at rowid 1..n. */
function tempFredyDb(n: number): string {
  const path = join(mkdtempSync(join(tmpdir(), 'flatbot-init-fredy-')), 'listings.db');
  const db = new Database(path);
  db.exec('CREATE TABLE listings (id TEXT PRIMARY KEY, created_at INTEGER, provider TEXT, link TEXT, title TEXT)');
  const ins = db.prepare('INSERT INTO listings VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= n; i++) ins.run(`l${i}`, Date.now(), 'immoscout', `https://x/${i}`, `flat ${i}`);
  db.close();
  return path;
}

/** A ready-to-load project dir: config.yaml + .env + a Fredy db with `rows` listings. */
function tempProject(rows = 3, fredyPath?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-init-'));
  writeFileSync(join(dir, 'config.yaml'), buildConfigYaml({ ...ARGS, fredyDbPath: fredyPath ?? tempFredyDb(rows) }));
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID=4242\n');
  return dir;
}

test('buildConfigYaml emits loadable config with free text intact', () => {
  const y = buildConfigYaml(ARGS);
  const c = parse(y);
  expect(c.hard.maxWarmRent).toBe(900);
  expect(c.preferences).toContain('balcony');
  expect(c.llm.provider).toBe('claude-cli');
});

// The real contract is loadConfig(), not YAML.parse: it is what `run` uses.
test('buildConfigYaml round-trips through loadConfig', () => {
  const dir = tempProject();
  const cfg = loadConfig(dir);
  expect(cfg.hard).toMatchObject({ maxWarmRent: 900, minSqm: 35, minRooms: 1, maxRooms: 2, city: 'Berlin' });
  expect(cfg.hard.districtBlocklist).toEqual([]);
  expect(cfg.hard.stalenessCutoffHours).toBeGreaterThan(0);
  expect(cfg.preferences).toContain('near office'); // second line survived
  expect(cfg.profile).toContain('non-smoker');
  expect(cfg.platforms.length).toBeGreaterThan(0);
  expect(cfg.telegram).toEqual({ token: '123:abc', chatId: '4242' });
});

// Without this, the first `run` LLM-processes Fredy's whole backlog (~150 listings).
test('seedWatermark parks the watermark at the current max rowid', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'flatbot-wm-')), 't.sqlite'));
  expect(seedWatermark(db, tempFredyDb(7))).toBe(7);
  expect(db.getMeta('watermark')).toBe('7');
  db.close();
});

test('seedWatermark on an empty Fredy db stays at 0', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'flatbot-wm2-')), 't.sqlite'));
  expect(seedWatermark(db, tempFredyDb(0))).toBe(0);
  db.close();
});

test('newestChatId takes the newest update and handles the empty case', () => {
  const upd = (id: number, chat: number) => ({ update_id: id, message: { chat: { id: chat } } });
  expect(newestChatId({ ok: true, result: [upd(1, 111), upd(2, 222)] })).toBe('222');
  expect(newestChatId({ ok: true, result: [{ update_id: 3, my_chat_member: { chat: { id: -100 } } }] })).toBe('-100');
  expect(newestChatId({ ok: true, result: [] })).toBeUndefined();
  expect(newestChatId({})).toBeUndefined();
});

const okFetch = async () => ({ json: async () => ({ ok: true, result: { username: 'flatbot' } }) });
const okLlm = async () => 'pong\n';

const line = (r: { lines: string[] }, name: string): string => r.lines.find((l) => l.includes(`${name}:`))!;

test('doctor: all green with a healthy project', async () => {
  const r = await doctor({ dir: tempProject(3), fetch: okFetch, llm: okLlm });
  expect(r.ok).toBe(true);
  expect(r.lines.some((l) => l.startsWith('❌'))).toBe(false);
  expect(r.lines.join('\n')).toContain('3 rows');
});

test('doctor: a missing Fredy db is a ❌, not a crash', async () => {
  const r = await doctor({ dir: tempProject(3, '/nope/listings.db'), fetch: okFetch, llm: okLlm });
  expect(r.ok).toBe(false);
  expect(r.lines.filter((l) => l.startsWith('❌'))).toHaveLength(1);
});

// `doctor` printed six green ticks on a machine where auto mode could not send a single thing.
test('doctor: the auto-mode checks are skipped in shadow and run once mode is auto', async () => {
  const dir = tempProject(1);
  const shadow = await doctor({ dir, fetch: okFetch, llm: okLlm });
  for (const name of ['chrome', 'cdp endpoint', 'sender tooling', 'portal sessions'])
    expect(line(shadow, name)).toContain('skipped');
  expect(shadow.ok).toBe(true);

  const db = openDb(loadConfig(dir).dbPath);
  db.setMeta('mode', 'auto');
  db.close();

  const auto = await doctor({ dir, fetch: okFetch, llm: okLlm });
  expect(line(auto, 'portal sessions')).toMatch(/^❌/);
  expect(line(auto, 'portal sessions')).toContain('flatbot login');
  expect(auto.ok).toBe(false);
  expect(line(auto, 'cdp endpoint')).not.toContain('skipped');
  expect(line(auto, 'sender tooling')).not.toContain('skipped');
});

// `uvx` on PATH said nothing about whether a browser-use send could work: flatbot invokes the CLI
// with flags browser-use's own CLI does not take, so doctor green-lit a setup that fails every send.
test('doctor: browser-use without a wrapper binary is a setup-time failure', async () => {
  const dir = tempProject(1);
  writeFileSync(join(dir, 'config.yaml'),
    `${readFileSync(join(dir, 'config.yaml'), 'utf8')}\nsender:\n  backend: browser-use\n`);
  const db = openDb(loadConfig(dir).dbPath);
  db.setMeta('mode', 'auto');
  db.close();
  delete process.env.FLATBOT_BROWSERUSE_BIN;

  const r = await doctor({ dir, fetch: okFetch, llm: okLlm });
  expect(line(r, 'sender tooling')).toMatch(/^❌/);
  expect(line(r, 'sender tooling')).toContain('FLATBOT_BROWSERUSE_BIN');
  expect(r.ok).toBe(false);

  // a wrapper is a path, not something on PATH — doctor must not report a real one as missing
  process.env.FLATBOT_BROWSERUSE_BIN = join(dir, 'config.yaml');
  try {
    expect(line(await doctor({ dir, fetch: okFetch, llm: okLlm }), 'sender tooling')).toMatch(/^✅/);
  } finally {
    delete process.env.FLATBOT_BROWSERUSE_BIN;
  }
});

// The two failures a new user actually hits must say what to do, and name the path.
test('doctor: a wrong fredyDbPath names the path and the key to fix', async () => {
  const r = await doctor({ dir: tempProject(3, '/nope/listings.db'), fetch: okFetch, llm: okLlm });
  expect(line(r, 'fredy db')).toContain('/nope/listings.db');
  expect(line(r, 'fredy db')).toContain('fredyDbPath');
});

test('doctor: a dead claude CLI tells the user what to run', async () => {
  const r = await doctor({
    dir: tempProject(1), fetch: okFetch,
    llm: async () => { throw new Error('spawn claude ENOENT'); },
  });
  expect(line(r, 'llm')).toContain('spawn claude ENOENT');
  expect(line(r, 'llm')).toContain('claude -p');
});

test('doctor: a missing config.yaml says where to run init', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-noconf-'));
  const r = await doctor({ dir, fetch: okFetch, llm: okLlm });
  expect(line(r, 'config')).toContain('flatbot init');
  expect(line(r, 'config')).toContain(dir);
  expect(line(r, 'config')).not.toMatch(/ENOENT/);
});

test('doctor: telegram and llm failures each fail their own check', async () => {
  const dir = tempProject(1);
  const bad = await doctor({
    dir,
    fetch: async () => ({ json: async () => ({ ok: false, description: 'Unauthorized' }) }),
    llm: async () => 'I am not going to say it',
  });
  expect(bad.ok).toBe(false);
  expect(bad.lines.filter((l) => l.startsWith('❌'))).toHaveLength(2);
  expect(bad.lines.join('\n')).toContain('Unauthorized');
});

test('doctor: no config.yaml fails config and every check that needs it', async () => {
  const r = await doctor({ dir: mkdtempSync(join(tmpdir(), 'flatbot-empty-')), fetch: okFetch, llm: okLlm });
  expect(r.ok).toBe(false);
  expect(r.lines.filter((l) => l.startsWith('✅'))).toHaveLength(1); // only the node check
});

// Re-running init on a tuned install used to wipe preferences and re-park the watermark.
test('init refuses to overwrite an existing config.yaml', async () => {
  const dir = tempProject(1);
  const before = readFileSync(join(dir, 'config.yaml'), 'utf8');
  await expect(cmdInit({ dir })).rejects.toThrow(/config\.yaml already exists/);
  expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before);
});

test('init reports a rejected token instead of blaming Telegram, and .env exists by then', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-init-fresh-'));
  const fredy = tempFredyDb(2);
  const answers = ['999:bad', '', '4242', '900', '35', '1', '2', 'Berlin', 'balcony', 'engineer',
    relative(dir, fredy)];
  const logs: string[] = [];
  let i = 0;
  let envAtChatIdStep = '';

  await cmdInit({
    dir,
    log: (s) => logs.push(s),
    ask: async (q: string) => {
      // `flatbot chatid` is the documented fallback at exactly this moment — it needs the .env.
      if (/chat id/i.test(q)) envAtChatIdStep = readFileSync(join(dir, '.env'), 'utf8');
      return answers[i++];
    },
    fetch: async () => ({ json: async () => ({ ok: false, description: 'Unauthorized' }) }),
  });

  expect(logs.join('\n')).toContain('Unauthorized');
  expect(envAtChatIdStep).toContain('TELEGRAM_BOT_TOKEN=999:bad');
  expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('TELEGRAM_CHAT_ID=4242');
  expect(loadConfig(dir).hard.maxWarmRent).toBe(900);
});

test('keep-alive snippets cover all four supervisors', () => {
  for (const s of ['pm2', 'launchd', 'systemd', 'schtasks']) expect(KEEPALIVE).toContain(s);
});
