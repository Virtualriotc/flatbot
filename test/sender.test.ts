import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { openDb, type Db, type ListingRow } from '../src/db.js';
import { recoverStaleSending, senderTick, type SendJob, type SendResult } from '../src/sender.js';

const HOUR = 3_600_000;
const sender: NonNullable<Config['sender']> = {
  backend: 'claude-agent', hourlyCapPerPlatform: 3,
  minDelayMinutes: 2, maxDelayMinutes: 8,
  profileDir: '/tmp/profile', screenshotDir: '/tmp/shots',
};
const cfg = () => ({ sender, hard: { stalenessCutoffHours: 24 } } as Config);
const noSenderCfg = {} as Config;

/** Approvals only count from the mode flip onwards; tests that want them sendable back-date it. */
const autoSinceLongAgo = (d: Db) => d.setMeta('autoSince', new Date(Date.now() - HOUR).toISOString());
const flush = () => new Promise((r) => setTimeout(r, 0));

const URLS: Record<string, string> = {
  immoscout: 'https://www.immobilienscout24.de/expose/',
  wggesucht: 'https://www.wg-gesucht.de/wohnungen-in-Berlin.',
  zillow: 'https://www.zillow.com/homedetails/',
};

function db(): Db {
  return openDb(join(mkdtempSync(join(tmpdir(), 'fb-send-')), 't.sqlite'));
}

/** Puts one listing in the db with a given status; `age` = minutes before now for ordering. */
function put(d: Db, id: string, platform: string, status: string, age = 0, letter: string | null = `Anschreiben ${id}`) {
  d.upsertListing({
    id, platform, title: `Wohnung ${id}`, url: `${URLS[platform] ?? 'https://x/'}${id}`,
    price: 950, size: 52, rooms: 2, address: 'Friedrichshain', description: null,
    imageUrls: [], discoveredAt: new Date(Date.now() - age * 60_000).toISOString(),
  });
  d.setDecision(id, { status, ...(letter === null ? {} : { letter }) });
}

function fakes(result: SendResult | (() => Promise<SendResult>) = { ok: true, confirmed: true }) {
  const calls: { job: SendJob; dryRun: boolean }[] = [];
  const slept: number[] = [];
  const receipts: ListingRow[] = [];
  const texts: string[] = [];
  return {
    calls, slept, receipts, texts,
    deps: {
      backend: {
        name: 'fake',
        async send(job: SendJob, opts: { dryRun: boolean }) {
          calls.push({ job, dryRun: opts.dryRun });
          return typeof result === 'function' ? result() : result;
        },
      },
      notify: {
        ask: async () => {},
        receipt: async (r: ListingRow) => { receipts.push(r); },
        text: async (t: string) => { texts.push(t); },
      },
      sleep: async (ms: number) => { slept.push(ms); },
    },
  };
}

test('no-op when the config has no sender block', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  await senderTick({ cfg: noSenderCfg, db: d, ...f.deps });
  expect(f.calls).toEqual([]);
  expect(d.getListing('a1')!.status).toBe('queued');
});

test('no-op when nothing is sendable: approved stays put unless mode is auto', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'approved');
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps });
  expect(f.calls).toEqual([]);
  expect(d.getListing('a1')!.status).toBe('approved');
});

test('in auto mode approved rows send too, oldest across both statuses first', async () => {
  const d = db();
  d.setMeta('mode', 'auto');
  autoSinceLongAgo(d);
  put(d, 'q1', 'immoscout', 'queued', 10);
  put(d, 'ap', 'wggesucht', 'approved', 60);
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps });

  expect(f.calls.map((c) => c.job.listing.id)).toEqual(['ap']);
  expect(d.getListing('ap')!.status).toBe('sent');
  expect(d.getListing('q1')!.status).toBe('queued');
});

test('sends the oldest queued listing, one per tick, and books it as sent', async () => {
  const d = db();
  put(d, 'new', 'immoscout', 'queued', 5);
  put(d, 'old', 'immoscout', 'queued', 60);
  const f = fakes({ ok: true, confirmed: true, screenshotPath: '/tmp/shots/old.png' });
  await senderTick({ cfg: cfg(), db: d, ...f.deps, random: () => 0.5 });

  expect(f.calls.length).toBe(1);
  const { job, dryRun } = f.calls[0];
  expect(dryRun).toBe(false);
  expect(job.listing.id).toBe('old');
  expect(job.letter).toBe('Anschreiben old');
  expect(job.platform.id).toBe('immoscout');
  expect(job.profileDir).toBe('/tmp/profile');
  expect(job.screenshotDir).toBe('/tmp/shots');
  expect(d.getListing('old')!.status).toBe('sent');
  expect(d.getListing('new')!.status).toBe('queued');
  expect(f.receipts.map((r) => [r.id, r.status])).toEqual([['old', 'sent']]);
  expect(f.texts).toEqual([]);
});

test('waits a random delay inside the configured minute bounds', async () => {
  for (const [rnd, ms] of [[0, 2 * 60_000], [0.5, 5 * 60_000], [1, 8 * 60_000]] as const) {
    const d = db(); put(d, 'a1', 'immoscout', 'queued');
    const f = fakes();
    await senderTick({ cfg: cfg(), db: d, ...f.deps, random: () => rnd });
    expect(f.slept).toEqual([ms]);
  }
});

test('respects the hourly per-platform cap and lets another platform through', async () => {
  const d = db();
  for (const i of [1, 2, 3]) put(d, `s${i}`, 'immoscout', 'sent');
  put(d, 'is', 'immoscout', 'queued', 60);
  put(d, 'wg', 'wggesucht', 'queued', 30);
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps });

  expect(f.calls.map((c) => c.job.listing.id)).toEqual(['wg']);
  expect(d.getListing('is')!.status).toBe('queued');
});

test('a fully capped queue sends nothing and leaves it queued', async () => {
  const d = db();
  for (const i of [1, 2, 3]) put(d, `s${i}`, 'immoscout', 'sent');
  put(d, 'is', 'immoscout', 'queued');
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps });
  expect(f.calls).toEqual([]);
  expect(f.slept).toEqual([]);
  expect(d.getListing('is')!.status).toBe('queued');
});

test('sends older than an hour do not count against the cap', async () => {
  const d = db();
  for (const i of [1, 2, 3]) put(d, `s${i}`, 'immoscout', 'sent');
  put(d, 'is', 'immoscout', 'queued');
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps, now: () => Date.now() + 2 * HOUR });
  expect(f.calls.map((c) => c.job.listing.id)).toEqual(['is']);
});

test('unknown platform falls back to manual with letter and link', async () => {
  const d = db(); put(d, 'z1', 'zillow', 'queued');
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps });

  expect(f.calls).toEqual([]);
  expect(d.getListing('z1')!.status).toBe('fallback_manual');
  expect(f.texts.length).toBe(1);
  expect(f.texts[0]).toContain('Anschreiben z1');
  expect(f.texts[0]).toContain('https://www.zillow.com/homedetails/z1');
  expect(f.texts[0]).toContain('#z1');
});

test('a queued listing with no letter is never sent blank', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued', 0, null);
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps });
  expect(f.calls).toEqual([]);
  expect(d.getListing('a1')!.status).toBe('fallback_manual');
});

test('a paywall hands the listing back to the human', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes({ ok: false, confirmed: false, paywalled: true, screenshotPath: '/tmp/shots/a1.png' });
  await senderTick({ cfg: cfg(), db: d, ...f.deps });

  expect(d.getListing('a1')!.status).toBe('fallback_manual');
  expect(f.receipts).toEqual([]);
  expect(f.texts[0]).toContain('Anschreiben a1');
  expect(f.texts[0]).toContain('/tmp/shots/a1.png');
});

test('an ok-but-unconfirmed send is booked sent with a check-the-screenshot note', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes({ ok: true, confirmed: false, screenshotPath: '/tmp/shots/a1.png' });
  await senderTick({ cfg: cfg(), db: d, ...f.deps });

  expect(d.getListing('a1')!.status).toBe('sent');
  expect(f.texts.length).toBe(1);
  expect(f.texts[0]).toContain('unconfirmed');
  expect(f.texts[0]).toContain('/tmp/shots/a1.png');
  expect(f.texts[0]).toContain('#a1');
  expect(f.texts[0]).not.toContain('manual send needed');
});

// N12. "check screenshot" with no path and no file is an instruction the reader cannot follow —
// and no screenshot is exactly the case that produces an unconfirmed send in the first place.
test('an unconfirmed send with no screenshot says where to look instead', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes({ ok: true, confirmed: false });
  await senderTick({ cfg: cfg(), db: d, ...f.deps });

  expect(d.getListing('a1')!.status).toBe('sent');
  expect(f.texts[0]).toContain('unconfirmed');
  expect(f.texts[0]).toContain('/tmp/shots');     // sender.screenshotDir, the place to look
  expect(f.texts[0]).toMatch(/check the portal/i);
});

test('a thrown backend error marks the listing failed and reports it', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes(async () => { throw new Error('CDP connect refused'); });
  await senderTick({ cfg: cfg(), db: d, ...f.deps });

  expect(d.getListing('a1')!.status).toBe('failed');
  expect(f.receipts).toEqual([]);
  expect(f.texts[0]).toContain('CDP connect refused');
  expect(f.texts[0]).toContain('#a1');
});

test('a non-Error throw is still reported with its text', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes(async () => { throw 'CDP socket closed'; });
  await senderTick({ cfg: cfg(), db: d, ...f.deps });

  expect(d.getListing('a1')!.status).toBe('failed');
  expect(f.texts[0]).toContain('CDP socket closed');
  expect(f.texts[0]).not.toContain('undefined');
});

test('a status change during the delay cancels the send', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  await senderTick({
    cfg: cfg(), db: d, ...f.deps,
    sleep: async () => { d.setDecision('a1', { status: 'rejected' }); },
  });

  expect(f.calls).toEqual([]);
  expect(d.getListing('a1')!.status).toBe('rejected');
  expect(f.texts).toEqual([]);
  expect(f.receipts).toEqual([]);
});

test('pausing during the delay cancels the send and leaves the row queued', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  await senderTick({
    cfg: cfg(), db: d, ...f.deps,
    sleep: async () => { d.setMeta('paused', '1'); },
  });

  expect(f.calls).toEqual([]);
  expect(d.getListing('a1')!.status).toBe('queued');
  expect(f.texts).toEqual([]);
});

// The delay is minutes long and the run loop ticks every 60s: without a lease the same listing
// gets picked again and again, and the landlord gets four copies of the same letter.
test('the listing is leased before the delay, so a second tick cannot take it', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  const second = fakes();
  await senderTick({
    cfg: cfg(), db: d, ...f.deps,
    sleep: async () => {
      expect(d.getListing('a1')!.status).toBe('pending_send');
      await senderTick({ cfg: cfg(), db: d, ...second.deps });
    },
  });

  expect(second.calls).toEqual([]);
  expect(f.calls.map((c) => c.job.listing.id)).toEqual(['a1']);
  expect(d.getListing('a1')!.status).toBe('sent');
});

test('leaving auto mode during the delay cancels the send and returns the row to queued', async () => {
  const d = db(); d.setMeta('mode', 'auto'); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  await senderTick({
    cfg: cfg(), db: d, ...f.deps,
    sleep: async () => { d.setMeta('mode', 'shadow'); },
  });

  expect(f.calls).toEqual([]);
  expect(d.getListing('a1')!.status).toBe('queued');
  expect(f.texts).toEqual([]);
});

// N3. Two lease states, because a restart during the 2-8 minute delay must not raise the alarm
// that is reserved for "the form may be in flight".
test('the delay is served under its own status, and `sending` starts at the backend call', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  let atSend: string | undefined;
  await senderTick({
    cfg: cfg(), db: d,
    ...f.deps,
    backend: { name: 'fake', async send(job) { atSend = d.getListing(job.listing.id)!.status; return { ok: true, confirmed: true }; } },
    sleep: async () => { expect(d.getListing('a1')!.status).toBe('pending_send'); },
  });
  expect(atSend).toBe('sending');
  expect(d.getListing('a1')!.status).toBe('sent');
});

test('a restart while a listing is still waiting out the delay just requeues it, no alarm', async () => {
  const d = db();
  put(d, 'wait', 'immoscout', 'pending_send');
  put(d, 'flight', 'wggesucht', 'sending');
  const f = fakes();
  expect(recoverStaleSending(d, f.deps.notify)).toBe(1);   // only the one that may have been sent
  expect(d.getListing('wait')!.status).toBe('queued');
  expect(d.getListing('flight')!.status).toBe('fallback_manual');

  await flush();
  expect(f.texts.length).toBe(1);
  expect(f.texts[0]).toContain('#flight');
});

// A crash between the lease and the send strands the row in `sending` — and the form may already
// have gone through. flatbot never re-tries a send by itself, so those go to the human.
test('rows interrupted mid-send are handed back, never returned to the queue', async () => {
  const d = db();
  put(d, 'a1', 'immoscout', 'sending');
  put(d, 'a2', 'wggesucht', 'sending');
  put(d, 'ok', 'immoscout', 'sent');
  const f = fakes();
  expect(recoverStaleSending(d, f.deps.notify)).toBe(2);
  expect([d.getListing('a1')!.status, d.getListing('a2')!.status])
    .toEqual(['fallback_manual', 'fallback_manual']);
  expect(d.getListing('ok')!.status).toBe('sent');
  expect(recoverStaleSending(d)).toBe(0);

  await flush();
  expect(f.texts.length).toBe(2);
  expect(f.texts[0]).toMatch(/may already/i);
  expect(f.texts[0]).toContain('#a1');
});

test('a telegram outage never reaches the run loop, and the status still lands', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes(async () => { throw new Error('CDP connect refused'); });
  f.deps.notify.text = async () => { throw new Error('telegram 502'); };

  await expect(senderTick({ cfg: cfg(), db: d, ...f.deps })).resolves.toBeUndefined();
  expect(d.getListing('a1')!.status).toBe('failed');
  vi.restoreAllMocks();
});

// A lease you failed to acquire is not yours: without this, a locked db meant the row stayed
// `queued`, the post-sleep guard still passed, and every tick sent the same listing again.
test('a lease write that does not land aborts the send instead of re-sending forever', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  const locked: Db = { ...d, setDecision: () => { throw new Error('database is locked'); } };

  for (let i = 0; i < 4; i++)
    await expect(senderTick({ cfg: cfg(), db: locked, ...f.deps })).resolves.toBeUndefined();

  expect(f.calls).toEqual([]);
  expect(f.receipts).toEqual([]);
  expect(d.getListing('a1')!.status).toBe('queued');
  vi.restoreAllMocks();
});

// N2. A second `flatbot run` on the same db (pm2 restart overlap, a second terminal) leases the row
// between this tick's read and its own write. Without a status precondition both processes send.
test('a row leased by another process between the read and the lease is not sent', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  // countSentSince runs while the candidate is being picked — i.e. after the read, before the lease
  const raced: Db = {
    ...d,
    countSentSince: (p, since) => {
      d.setDecision('a1', { status: 'sending' });   // the other process gets there first
      return d.countSentSince(p, since);
    },
  };
  await senderTick({ cfg: cfg(), db: raced, ...f.deps });

  expect(f.calls).toEqual([]);
  expect(f.slept).toEqual([]);
  expect(d.getListing('a1')!.status).toBe('sending');   // still the other process's lease
});

test('a lease that matches no row (deleted mid-flight) sends nothing', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  const noRows: Db = { ...d, setDecision: () => 0 };
  await senderTick({ cfg: cfg(), db: noRows, ...f.deps });
  expect(f.calls).toEqual([]);
});

// The mirror image of the lease: the application is already with the landlord, so the row must
// leave the sendable set whatever happens, and the human must hear "sent", not "please send".
test('a send whose `sent` write keeps failing ends up manual, not sendable again', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes({ ok: true, confirmed: true, screenshotPath: '/tmp/shots/a1.png' });
  const flaky: Db = {
    ...d,
    setDecision: (id, dec) => {
      if (dec.status === 'sent') throw new Error('database is locked');
      return d.setDecision(id, dec);
    },
  };

  await senderTick({ cfg: cfg(), db: flaky, ...f.deps });
  expect(f.calls.length).toBe(1);
  expect(d.getListing('a1')!.status).toBe('fallback_manual');
  expect(f.receipts).toEqual([]);
  expect(f.texts[0]).toMatch(/do not send again/i);
  expect(f.texts[0]).not.toMatch(/manual send needed/);

  await senderTick({ cfg: cfg(), db: flaky, ...f.deps });
  expect(f.calls.length).toBe(1); // and no later tick picks it up
  vi.restoreAllMocks();
});

// stalenessCutoffHours was only applied at discovery, so a two-week-old approval sent as readily
// as this morning's. Re-checked here because everything between is asynchronous.
test('a listing past the staleness cutoff is handed back instead of sent', async () => {
  const d = db(); put(d, 'old', 'immoscout', 'queued', 14 * 24 * 60);
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps });

  expect(f.calls).toEqual([]);
  expect(f.slept).toEqual([]);
  expect(d.getListing('old')!.status).toBe('fallback_manual');
  expect(f.texts[0]).toContain('stalenessCutoffHours');
});

// The documented onboarding builds a pile of shadow-mode ✅ rows. One `/auto` used to send them all.
test('one /auto does not drain the shadow-mode approval backlog', async () => {
  const d = db();
  for (const i of [1, 2, 3]) put(d, `ap${i}`, 'immoscout', 'approved', i);
  d.setMeta('mode', 'auto');
  const f = fakes();

  // the first auto tick stamps the flip; nothing approved before it is eligible
  await senderTick({ cfg: cfg(), db: d, ...f.deps, now: () => Date.now() + 60_000 });
  await senderTick({ cfg: cfg(), db: d, ...f.deps, now: () => Date.now() + 60_000 });

  expect(f.calls).toEqual([]);
  expect(d.getMeta('autoSince')).toBeTruthy();
  expect([1, 2, 3].map((i) => d.getListing(`ap${i}`)!.status)).toEqual(['approved', 'approved', 'approved']);
});

test('an approval made after the flip still sends', async () => {
  const d = db();
  d.setMeta('mode', 'auto');
  autoSinceLongAgo(d);
  put(d, 'ap', 'immoscout', 'approved', 1);
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps });
  expect(f.calls.map((c) => c.job.listing.id)).toEqual(['ap']);
});

// C3 keys off the status, so the pause path must not rewrite the provenance away.
test('pausing during the delay restores the status the row had, not always `queued`', async () => {
  const d = db();
  d.setMeta('mode', 'auto');
  autoSinceLongAgo(d);
  put(d, 'ap', 'immoscout', 'approved');
  const f = fakes();
  await senderTick({
    cfg: cfg(), db: d, ...f.deps,
    sleep: async () => { d.setMeta('paused', '1'); },
  });

  expect(f.calls).toEqual([]);
  expect(d.getListing('ap')!.status).toBe('approved');
});

// The default backend attaches over CDP: the run loop owns the browser, the job carries its address.
test('the send job carries the cdp endpoint the run loop supplies', async () => {
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  await senderTick({ cfg: cfg(), db: d, ...f.deps, cdpEndpoint: async () => 'http://127.0.0.1:9333' });
  expect(f.calls[0].job.cdpEndpoint).toBe('http://127.0.0.1:9333');
});

test('no browser to drive means the listing keeps its place, not a permanent failure', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const d = db(); put(d, 'a1', 'immoscout', 'queued');
  const f = fakes();
  await senderTick({
    cfg: cfg(), db: d, ...f.deps,
    cdpEndpoint: async () => { throw new Error('patchright is not installed'); },
  });

  expect(f.calls).toEqual([]);
  expect(d.getListing('a1')!.status).toBe('queued');
  vi.restoreAllMocks();
});
