import type { Config } from './config.js';
import type { Db, ListingRow } from './db.js';
import type { Notifier } from './telegram.js';
import { platformFor, type PlatformSpec } from './platforms.js';

export type SendJob = { listing: ListingRow; letter: string; platform: PlatformSpec;
  profileDir: string; screenshotDir: string; cdpEndpoint?: string };
export type SendResult = { ok: boolean; confirmed: boolean; screenshotPath?: string;
  error?: string; paywalled?: boolean };
export type SendBackend = { name: string;
  send(job: SendJob, opts: { dryRun: boolean }): Promise<SendResult> };

export type SenderDeps = { cfg: Config; db: Db; backend: SendBackend; notify: Notifier;
  now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number;
  /** Address of the browser to drive. Rejecting means "no browser" — the send is not attempted. */
  cdpEndpoint?: () => Promise<string> };

const HOUR = 3_600_000;

/** Every bot message ends with "\n#<id>" — that trailer is the reply-mapping mechanism. */
const fallbackText = (r: ListingRow, why: string, shot?: string) =>
  [`📮 manual send needed — ${r.title} (${why})`, r.url, r.letter, shot, `#${r.id}`]
    .filter(Boolean).join('\n');

const interruptedText = (r: ListingRow) =>
  [`⚠️ interrupted mid-send — ${r.title}`,
    'It may already have gone through: check the portal before sending this by hand.',
    r.url, r.letter, `#${r.id}`].filter(Boolean).join('\n');

/** Runs one db write or Telegram send; a failing one is logged, never thrown at the run loop. */
async function safe(what: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[sender] ${what}: ${String(e)}`);
  }
}

/**
 * Rows leased with `sending` when the process died may or may not have reached the landlord.
 * flatbot never re-tries a send by itself, so they go to the human with a warning — putting them
 * back in the queue would put a second copy of the same application in an inbox.
 *
 * `pending_send` is the other half of that lease: the row was claimed, but the process died while
 * it was still waiting out the 2-8 minute delay, so no backend was ever invoked and nothing can
 * have reached anyone. Those are simply requeued. Without the distinction, every laptop sleep or
 * service restart mid-delay raised the "it may already have gone through" alarm on a listing
 * nothing had touched — and an alarm that cries wolf is how the real one gets ignored.
 *
 * Returns the number handed to the human. Call once at startup, before the loop.
 */
export function recoverStaleSending(db: Db, notify?: Notifier): number {
  const requeued = db.listByStatus('pending_send');
  for (const r of requeued) db.setDecision(r.id, { status: 'queued' }, 'pending_send');
  if (requeued.length)
    console.error(`${requeued.length} listing(s) were still waiting out the send delay — requeued`);

  const stale = db.listByStatus('sending');
  for (const r of stale) {
    db.setDecision(r.id, { status: 'fallback_manual' });
    void safe('notify', () => notify?.text(interruptedText(r)));
  }
  return stale.length;
}

/**
 * Sends at most one queued listing per call: oldest first, skipping platforms that already hit
 * their hourly cap, after a random human-ish delay. Never throws — a broken send is a status
 * change plus a Telegram line, so the run loop keeps going.
 */
export async function senderTick(deps: SenderDeps): Promise<void> {
  await safe('tick', () => tick(deps));
}

async function tick(deps: SenderDeps): Promise<void> {
  const { cfg, db, backend, notify } = deps;
  const s = cfg.sender;
  if (!s) return; // no sender block configured → sending is off

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  // `approved` is a shadow-mode ✅. Those only become sendable once auto mode is on, and only if
  // the approval came after the flip — otherwise one `/auto` drains the whole shadow-run backlog.
  // The stamp is written here so senderTick is sufficient on its own; the /auto handler may also
  // set it (earlier, and therefore more precisely) without changing anything here.
  const mode = db.getMeta('mode');
  if (mode === 'auto' && !db.getMeta('autoSince')) db.setMeta('autoSince', new Date(now()).toISOString());
  const autoSince = mode === 'auto' ? db.getMeta('autoSince') : undefined;

  // ponytail: one COUNT per candidate; group the counts in SQL if the queue ever grows.
  const since = new Date(now() - HOUR).toISOString();
  const row = [
    ...db.listByStatus('queued'),
    ...(autoSince ? db.listByStatus('approved').filter((r) => r.updatedAt >= autoSince) : []),
  ]
    .sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt) || a.id.localeCompare(b.id))
    .find((r) => db.countSentSince(r.platform, since) < s.hourlyCapPerPlatform);
  if (!row) return; // nothing sendable, or every candidate platform is capped this hour

  const setStatus = (status: string) =>
    safe(`db ${status} ${row.id}`, () => db.setDecision(row.id, { status }));
  const handBack = async (why: string, shot?: string) => {
    await setStatus('fallback_manual');
    await safe('notify', () => notify.text(fallbackText(row, why, shot)));
  };

  const platform = platformFor(row.platform) ?? platformFor(row.url);
  if (!platform) return handBack(`unknown platform ${row.platform}`);
  if (!row.letter?.trim()) return handBack('no letter written');

  // Staleness is checked at discovery, but a listing can sit in the queue (or in an approval
  // backlog) for days before it gets here. Applying to a two-week-old ad is the embarrassment.
  const cutoff = cfg.hard?.stalenessCutoffHours ?? Infinity;
  const ageHours = (now() - Date.parse(row.discoveredAt)) / HOUR;
  if (ageHours > cutoff)
    return handBack(`discovered ${ageHours.toFixed(0)}h ago > stalenessCutoffHours ${cutoff}`);

  // Lease it before the sleep: the run loop ticks every 60s while this waits minutes, and a leased
  // row is in neither candidate list, so no other tick (or restart) can send it twice. The
  // precondition is what makes that true across *processes* too — two `flatbot run`s (a pm2
  // restart overlapping, a second terminal) otherwise both read `queued` and both send.
  // This is the one write allowed to fail loudly — proceeding on a lease we did not take is how
  // one application becomes four, because every later guard would still see the pre-lease status.
  const lease = (status: string, from: string): boolean => {
    try {
      return db.setDecision(row.id, { status }, from) > 0;
    } catch (e) {
      console.error(`[sender] lease ${row.id}: ${String(e)}`);
      return false;
    }
  };
  // `pending_send`, not `sending`: nothing has been submitted while the delay runs, and a crash in
  // here must be recoverable without warning the human about a send that never happened.
  if (!lease('pending_send', row.status)) return;

  await sleep((s.minDelayMinutes + random() * (s.maxDelayMinutes - s.minDelayMinutes)) * 60_000);

  // The operator can reject the row, pause, or leave auto mode inside that delay. A status they
  // set wins untouched; a pause or a mode flip gives the row back exactly as it was found.
  if (db.getListing(row.id)?.status !== 'pending_send') return;
  if (db.getMeta('paused') === '1' || db.getMeta('mode') !== mode) return setStatus(row.status);

  // The default backend drives a browser the run loop owns. No browser, no send — but the
  // listing keeps its place rather than being burned while Chrome is missing.
  let cdpEndpoint: string | undefined;
  if (deps.cdpEndpoint) {
    cdpEndpoint = await deps.cdpEndpoint().catch((e) => {
      console.error(`[sender] no browser to drive: ${String(e)}`);
      return undefined;
    });
    if (!cdpEndpoint) return setStatus(row.status);
  }

  // From here the form may reach the landlord, so the row moves to the status `recoverStaleSending`
  // treats as "may already have gone through". Conditional again: the delay was long.
  if (!lease('sending', 'pending_send')) return;

  let res: SendResult;
  try {
    res = await backend.send(
      { listing: row, letter: row.letter, platform, profileDir: s.profileDir,
        screenshotDir: s.screenshotDir, ...(cdpEndpoint ? { cdpEndpoint } : {}) },
      { dryRun: false },
    );
  } catch (e) {
    await setStatus('failed');
    await safe('notify', () => notify.text(`⚠️ send failed — ${row.title}\n${String(e)}\n#${row.id}`));
    return;
  }

  // A paywall or a failed send never reached the landlord → the human takes over.
  if (!res.ok || res.paywalled) {
    return handBack(res.paywalled ? 'paywalled' : res.error ?? 'send not ok', res.screenshotPath);
  }
  // Past this line the landlord has the application, so the row must leave the sendable set
  // whatever the database does. better-sqlite3 already waits out a busy db before throwing,
  // so the retries need no delay of their own.
  let booked = false;
  for (let i = 0; i < 3 && !booked; i++)
    try {
      booked = db.setDecision(row.id, { status: 'sent' }) > 0;
    } catch (e) {
      console.error(`[sender] db sent ${row.id}: ${String(e)}`);
    }
  if (!booked) {
    await setStatus('fallback_manual'); // out of the sendable set even if `sent` will not stick
    return safe('notify', () => notify.text(
      [`⚠️ sent — ${row.title} — but flatbot could not record it. Do NOT send again; check the portal.`,
        row.url, res.screenshotPath, `#${row.id}`].filter(Boolean).join('\n'),
    ));
  }

  // ok but unconfirmed: the form probably went through, so book it as sent and flag the doubt.
  // Re-sending by hand would risk a duplicate application, which reads far worse than one check.
  if (res.confirmed) return safe('notify', () => notify.receipt({ ...row, status: 'sent' }));
  // "check screenshot" is useless without something to check: when the agent saved none, say where
  // it should have been, so the instruction names a place rather than a file that is not there.
  const doubt = res.screenshotPath
    ? 'unconfirmed — check the screenshot'
    : `unconfirmed — no screenshot in ${s.screenshotDir}; check the portal`;
  await safe('notify', () => notify.text(
    [`✅ sent — ${row.title} (${doubt})`, row.url, res.screenshotPath, `#${row.id}`]
      .filter(Boolean).join('\n'),
  ));
}
