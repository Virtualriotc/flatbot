import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import type { Db } from './db.js';

const WEEK = 7 * 86_400_000;
const KEEP_VERBATIM = 20; // the newest N stay in the judge prompt untouched
const HEADER =
  '<!-- Written by flatbot from your older feedback. Yours to keep: edit or delete this file\n' +
  '     freely, flatbot only overwrites it on the next weekly distillation. -->\n\n';

/** learned.md lives next to the config, which is where dbPath is resolved from. */
function learnedPath(cfg: Config): string {
  return join(dirname(cfg.dbPath), 'learned.md');
}

/** Distilled lessons for the judge prompt, header stripped. undefined if absent or blank. */
export function readLearned(cfg: Config): string | undefined {
  let text: string;
  try {
    text = readFileSync(learnedPath(cfg), 'utf8');
  } catch {
    return undefined; // no file yet, or the user deleted it — both fine
  }
  const body = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  return body || undefined;
}

function buildDistillPrompt(older: string[]): string {
  return `These are older notes a tenant wrote about rental listings they were shown, newest first.
Compress them into at most 10 short bullet lessons a listing judge should remember.
Keep concrete preferences and dealbreakers; drop one-off remarks and anything contradicted by a newer note.

NOTES
${older.map((t) => `- ${t}`).join('\n')}

Reply with ONLY the bullets, one per line, starting with "- ".`;
}

/**
 * Weekly: compress everything older than the newest 20 feedback memos into learned.md.
 * Returns whether it ran. A failing LLM is a no-op, not an error — the next tick retries.
 */
export async function maybeDistill(deps: {
  cfg: Config; db: Db; llm: (p: string) => Promise<string>; now?: () => number;
}): Promise<boolean> {
  const { cfg, db, llm, now = Date.now } = deps;
  const last = Number(db.getMeta('lastDistillAt')) || 0;
  if (now() - last < WEEK) return false;

  const all = db.allFeedback();
  if (all.length <= KEEP_VERBATIM) return false;

  let lessons: string;
  try {
    lessons = await llm(buildDistillPrompt(all.slice(KEEP_VERBATIM)));
  } catch (e) {
    console.error(`distillation failed: ${(e as Error).message}`);
    return false;
  }

  // A blank reply is a failed call that did not throw — writing it would blank the file the
  // judge reads and stamp the meta, costing a week before the next attempt.
  if (!lessons.trim()) return false;

  writeFileSync(learnedPath(cfg), HEADER + lessons.trim() + '\n');
  db.setMeta('lastDistillAt', String(now()));
  return true;
}
