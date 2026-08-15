import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import { makeLoop, startBeat, statusText, USAGE } from '../src/index.js';
import type { SendBackend } from '../src/sender.js';

const tempDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'flatbot-cli-')), 't.sqlite'));

/** A run-loop the beat can actually be driven through: no Fredy db, no portals, no delay. */
function loop(over: { dbPath?: string; llm?: (p: string) => Promise<string>;
  backend?: 'claude-agent' | 'browser-use'; launchFails?: boolean; alive?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-loop-'));
  const db = openDb(join(dir, 't.sqlite'));
  const cfg = {
    fredyDbPath: join(dir, 'missing.db'), dbPath: over.dbPath ?? join(dir, 't.sqlite'),
    sender: { backend: over.backend ?? 'claude-agent', hourlyCapPerPlatform: 3, minDelayMinutes: 0,
      maxDelayMinutes: 0, profileDir: join(dir, 'p'), screenshotDir: join(dir, 's') },
  } as Config;
  const sends: string[] = [];
  const endpoints: (string | undefined)[] = [];
  const backend: SendBackend = {
    name: 'fake',
    async send(job) { sends.push(job.listing.id); endpoints.push(job.cdpEndpoint); return { ok: true, confirmed: true }; },
  };
  const texts: string[] = [];
  const notify = { ask: async () => {}, receipt: async () => {}, text: async (t: string) => { texts.push(t); } };
  const llm = over.llm ?? (async () => '- lesson');

  // Stands in for the real patchright launch: a browser never starts in this suite.
  const launched: { dir: string; headed: boolean }[] = [];
  let closed = 0;
  const launch = async (d: string, opts: { headed: boolean }) => {
    if (over.launchFails) throw new Error('patchright is not installed');
    launched.push({ dir: d, ...opts });
    return { cdpEndpoint: 'http://127.0.0.1:9222', alive: async () => over.alive?.() ?? true,
      close: async () => { closed++; } };
  };

  return { dir, db, cfg, sends, endpoints, texts, launched, closed: () => closed,
    ...makeLoop({ cfg, db, notify, backend, llm, launch }) };
}

function queue(db: Db, id: string): void {
  db.upsertListing({ id, platform: 'immoscout', title: id, url: `https://www.immobilienscout24.de/expose/${id}`,
    price: 950, size: 52, rooms: 2, address: null, description: null, imageUrls: [],
    discoveredAt: new Date().toISOString() });
  db.setDecision(id, { status: 'queued', letter: 'Anschreiben' });
}

test('the loop only sends in auto mode', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const l = loop();
  queue(l.db, 'a1');

  await l.poll();
  expect(l.sends).toEqual([]);
  expect(l.db.getListing('a1')!.status).toBe('queued');

  l.db.setMeta('mode', 'auto');
  await l.poll();
  expect(l.sends).toEqual(['a1']);
  expect(l.db.getListing('a1')!.status).toBe('sent');
  vi.restoreAllMocks();
});

test('building the loop hands back listings the last run left mid-send', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-loop-'));
  const db = openDb(join(dir, 't.sqlite'));
  queue(db, 'a1');
  db.setDecision('a1', { status: 'sending' });

  const texts: string[] = [];
  makeLoop({ cfg: { fredyDbPath: join(dir, 'missing.db'), dbPath: join(dir, 't.sqlite') } as Config,
    db, notify: { ask: async () => {}, receipt: async () => {}, text: async (t: string) => { texts.push(t); } },
    llm: async () => '' });
  expect(db.getListing('a1')!.status).toBe('fallback_manual');
  await new Promise((r) => setTimeout(r, 0));
  expect(texts[0]).toMatch(/may already/i);
  vi.restoreAllMocks();
});

// The default backend attaches over CDP; nothing else in `flatbot run` ever starts that browser.
test('auto sends get a browser: launched once, reused, closed on shutdown', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const l = loop();
  l.db.setMeta('mode', 'auto');
  queue(l.db, 'a1');
  queue(l.db, 'a2');

  await l.poll();
  await l.poll();
  expect(l.sends).toEqual(['a1', 'a2']);
  expect(l.endpoints).toEqual(['http://127.0.0.1:9222', 'http://127.0.0.1:9222']);
  expect(l.launched).toEqual([{ dir: l.cfg.sender!.profileDir, headed: false }]);

  await l.shutdown();
  expect(l.closed()).toBe(1);
  vi.restoreAllMocks();
});

// N4. `browser ??= launch()` never cleared, so a browser that died after the first send left every
// later send failing on a dead address until somebody restarted flatbot.
test('a browser that died between sends is replaced, not reused', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let alive = true;
  const l = loop({ alive: () => alive });
  l.db.setMeta('mode', 'auto');
  queue(l.db, 'a1');
  queue(l.db, 'a2');

  await l.poll();
  alive = false;                 // the user quit Chrome, or it crashed
  await l.poll();

  expect(l.sends).toEqual(['a1', 'a2']);
  expect(l.launched.length).toBe(2);
  expect(l.closed()).toBe(1);    // the dead handle is closed before it is dropped
  vi.restoreAllMocks();
});

// browser-use launches its own Chrome from the same profile dir — a second one would fight it.
test('the browser-use backend gets no flatbot-launched browser', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const l = loop({ backend: 'browser-use' });
  l.db.setMeta('mode', 'auto');
  queue(l.db, 'a1');

  await l.poll();
  expect(l.sends).toEqual(['a1']);
  expect(l.launched).toEqual([]);
  expect(l.endpoints).toEqual([undefined]);
  vi.restoreAllMocks();
});

test('a browser that will not start says so once and leaves the listing sendable', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const l = loop({ launchFails: true });
  l.db.setMeta('mode', 'auto');
  queue(l.db, 'a1');

  await l.poll();
  await l.poll();
  expect(l.sends).toEqual([]);
  expect(l.db.getListing('a1')!.status).toBe('queued');
  expect(l.texts.length).toBe(1); // one warning per process, not one per beat
  expect(l.texts[0]).toMatch(/chrome/i);
  vi.restoreAllMocks();
});

// A beat runs long (a send sleeps 2-8 min inside it): setInterval would stack them up.
test('the beat re-arms only after the previous one finishes', async () => {
  let running = 0; let overlap = 0; let beats = 0;
  const stop = startBeat(async () => {
    beats++;
    if (running) overlap++;
    running++;
    await new Promise((r) => setTimeout(r, 5));
    running--;
  }, 1);

  await new Promise((r) => setTimeout(r, 40));
  stop();
  expect(overlap).toBe(0);
  expect(beats).toBeGreaterThan(1);

  const settled = beats;
  await new Promise((r) => setTimeout(r, 20));
  expect(beats).toBe(settled); // stop() really stops it
});

// N13. Re-arming after the beat is what stops them overlapping — and what makes one beat that
// never resolves the end of polling, while Telegram happily keeps answering commands.
test('a beat that never finishes does not stop the loop for good', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let beats = 0;
  const stop = startBeat(async () => { beats++; await new Promise(() => {}); }, 1, 5);
  await new Promise((r) => setTimeout(r, 60));
  stop();
  expect(beats).toBeGreaterThan(1);
  vi.restoreAllMocks();
});

test('a throwing beat is logged, not fatal, and the next one still runs', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let beats = 0;
  const stop = startBeat(async () => { beats++; throw new Error('boom'); }, 1);
  await new Promise((r) => setTimeout(r, 20));
  stop();
  expect(beats).toBeGreaterThan(1);
  vi.restoreAllMocks();
});

test('the beat distills feedback, and a distillation that cannot write does not break it', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const ok = loop();
  for (let i = 0; i < 21; i++) ok.db.addFeedback(null, `note ${i}`);
  await ok.poll();
  expect(existsSync(join(ok.dir, 'learned.md'))).toBe(true);

  const broken = loop({ dbPath: '/nonexistent-dir-flatbot/t.sqlite' });
  for (let i = 0; i < 21; i++) broken.db.addFeedback(null, `note ${i}`);
  await expect(broken.poll()).resolves.toBeUndefined();
  expect(broken.db.getMeta('lastDistillAt')).toBeUndefined();
  vi.restoreAllMocks();
});

test('statusText shows counts and mode', () => {
  const db = tempDb();
  db.setMeta('mode', 'shadow');
  const s = statusText(db);
  expect(s).toContain('shadow');
  expect(s).toMatch(/found/i);
  db.close();
});

// Unset mode is shadow (same default the pipeline uses), and the watermark must be visible:
// "why did it stop finding things" is answered by that number.
test('statusText defaults to shadow, shows watermark and pause state', () => {
  const db = tempDb();
  expect(statusText(db)).toContain('shadow');
  db.setMeta('mode', 'auto');
  db.setMeta('watermark', '4211');
  db.setMeta('paused', '1');
  const s = statusText(db);
  expect(s).toContain('auto');
  expect(s).toContain('4211');
  expect(s).toMatch(/paused/i);
  db.close();
});

test('statusText counts the last-7d listings', () => {
  const db = tempDb();
  const now = new Date().toISOString();
  db.upsertListing({ id: 'a', platform: 'immoscout', title: 't', url: 'u', price: null, size: null,
    rooms: null, address: null, description: null, imageUrls: [], discoveredAt: now });
  db.setDecision('a', { status: 'asked' });
  expect(statusText(db)).toContain('found 1');
  expect(statusText(db)).toContain('asked 1');
  db.close();
});

test('usage lists every command', () => {
  for (const c of ['run', 'status', 'dryrun', 'init', 'login', 'doctor', 'chatid']) expect(USAGE).toContain(c);
});

// Importing must not start the bot, open a db, or exit: main() only runs as the real entry point.
test('importing the module runs no CLI (no config.yaml here)', async () => {
  const mod = await import('../src/index.js');
  expect(typeof mod.statusText).toBe('function');
});
