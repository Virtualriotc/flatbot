import type { Config } from './config.js';
import type { Db, Listing } from './db.js';
import { readLearned } from './distill.js';
import { fetchNewListings } from './fredy.js';
import { buildJudgePrompt, parseVerdict } from './judge.js';
import { checkRules } from './rules.js';
import type { Notifier } from './telegram.js';
import { buildLetterPrompt, parseLetter } from './writer.js';

export type Deps = { cfg: Config; db: Db; llm: (prompt: string) => Promise<string>; notify: Notifier };

/**
 * One listing, end to end. Never throws: anything unexpected lands as status `error`
 * so a single bad listing cannot stop the batch.
 */
export async function processListing(deps: Deps, l: Listing): Promise<void> {
  const { cfg, db, llm, notify } = deps;
  try {
    const seen = db.getListing(l.id);
    if (seen && seen.status !== 'new') return; // already decided on a previous tick
    db.upsertListing(l);

    // An empty `platforms` list means "no filter" — config.example.yaml enables all four.
    if (cfg.platforms.length && !cfg.platforms.includes(l.platform)) {
      db.setDecision(l.id, { status: 'skipped_rules', reasons: `platform ${l.platform} not enabled` });
      return;
    }

    const rules = checkRules(l, cfg.hard);
    // A city miss is a doubt, not a violation — `hard.city` is free text nobody validates, and a
    // spelling the portal does not use ("Muenchen" for "München") would otherwise reject every
    // listing there is, in silence. Doubts go to the judge and always to a human, never to the
    // sender. Every other rule is a real violation and still ends the listing here.
    const cityDoubt = !rules.pass && rules.soft ? rules.reason : undefined;
    if (!rules.pass && !cityDoubt) {
      db.setDecision(l.id, { status: 'skipped_rules', reasons: rules.reason });
      return;
    }

    // learned.md is the distillation's output; read it here or the weekly compression is write-only.
    const prompt = buildJudgePrompt(l, cfg, db.recentFeedback(20), readLearned(cfg));
    const verdict = parseVerdict(await llm(prompt), cfg.thresholds);
    if (verdict.decision === 'skip') {
      db.setDecision(l.id, { status: 'skipped_judge', score: verdict.score, reasons: verdict.reasons, scam: verdict.scam });
      return;
    }

    // A missing letter is not fatal: the ask still goes out, just without a draft.
    let letter: string | undefined;
    try {
      letter = parseLetter(await llm(buildLetterPrompt(l, cfg)));
    } catch (e) {
      console.error(`letter failed for ${l.id}: ${(e as Error).message}`);
    }

    // meta `mode` unset = shadow. `queued` is auto mode's hand-off to the sender (P2).
    // parseVerdict already downgrades a scam apply to ask; the !scam guard is belt-and-braces
    // so no suspected scam can ever be sent without a human seeing it.
    // No letter => never queue: the sender has nothing to send and nothing notifies on the
    // queued path, so the listing would silently vanish. Fall back to asking.
    const auto = db.getMeta('mode') === 'auto';
    const queued = auto && !cityDoubt && verdict.decision === 'apply' && !verdict.scam && letter !== undefined;
    const scored = verdict.scam ? `possible scam — ${verdict.reasons}` : verdict.reasons;
    const reasons = cityDoubt ? `⚠️ ${cityDoubt} — check the address; ${scored}` : scored;
    db.setDecision(l.id, { status: queued ? 'queued' : 'asked', score: verdict.score, reasons, scam: verdict.scam, letter });
    if (queued) return;

    const row = db.getListing(l.id)!;
    // The receipt is shadow mode's "would apply" note. In auto mode the only apply that
    // reaches this line is one we could not queue, so it goes out as an ask for a human.
    // A Telegram blip (502, 429, no network) must not fall through to the `error` handler below:
    // the listing was legitimately judged and asked about, and `error` is a black hole — nothing
    // retries it, nothing counts it, and the buttons would be dead. Leave the row at `asked`.
    try {
      await (verdict.decision === 'apply' && !auto ? notify.receipt(row) : notify.ask(row));
    } catch (e) {
      console.error(`notify failed for ${l.id} (left as ${row.status}): ${(e as Error).message}`);
    }
  } catch (e) {
    db.setDecision(l.id, { status: 'error', reasons: (e as Error).message });
  }
}

/** One poll of Fredy: everything newer than the watermark, serially. */
export async function tick(deps: Deps): Promise<void> {
  const { cfg, db } = deps;
  if (db.getMeta('paused') === '1') return;

  const after = Number(db.getMeta('watermark') ?? 0);
  let batch;
  try {
    batch = fetchNewListings(cfg.fredyDbPath, after);
  } catch (e) {
    // ponytail: one unreadable row aborts the whole fetch. The watermark holds, so the batch
    // is retried next tick; per-row recovery only if a poison row ever actually wedges a run.
    console.error(`fetchNewListings failed: ${(e as Error).message}`);
    return;
  }

  for (const l of batch.listings) await processListing(deps, l);
  // after the batch, never mid-way: a crash re-reads the batch instead of losing it
  if (batch.maxRowId > after) db.setMeta('watermark', String(batch.maxRowId));
}
