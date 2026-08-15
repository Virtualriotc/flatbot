import type { Config } from './config.js';
import type { Listing } from './db.js';
import { extractJson } from './llm.js';

export type Verdict = { score: number; decision: 'apply' | 'ask' | 'skip'; reasons: string; scam: boolean };

export function buildJudgePrompt(l: Listing, cfg: Config, feedback: string[], learned?: string): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
  // omitted entirely when there is nothing distilled yet, so the model sees no empty heading
  const learnedBlock = learned?.trim() ? `LEARNED PREFERENCES (distilled from older feedback)\n${learned.trim()}\n\n` : '';
  return `You judge rental listings for one specific tenant. Be strict; applying costs reputation.

LISTING
title: ${l.title}
platform: ${l.platform}
price: ${l.price ?? '?'}
size: ${l.size ?? '?'}
rooms: ${l.rooms ?? '?'}
address: ${l.address ?? '?'}
description: ${(l.description ?? '').slice(0, 2000)}
images:
${list(l.imageUrls ?? [])}

TENANT PREFERENCES
${cfg.preferences}

HARD LIMITS (already enforced by the rules filter; repeated as a sanity check)
${list(Object.entries(cfg.hard).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') || '(none)' : v}`))}

${learnedBlock}PAST FEEDBACK FROM THE TENANT
${list(feedback)}

SCAM CHECK
flag scam=true for: price far below market, requests for money/deposit before viewing, off-platform contact, stock-photo vibes, urgency pressure

Reply with ONLY this JSON: {"score": 0-100, "reasons": "<one line>", "scam": true|false}`;
}

export function parseVerdict(raw: string, t: Config['thresholds']): Verdict {
  const o = extractJson(raw);
  // real models quote numbers ("80"); anything else is still a hard error, never a silent 0
  const n = typeof o.score === 'number' || typeof o.score === 'string' ? Number(o.score) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Verdict has no numeric score: ${raw}`);
  const score = Math.min(100, Math.max(0, n));
  const scam = o.scam === true;
  let decision: Verdict['decision'] = score >= t.apply ? 'apply' : score >= t.ask ? 'ask' : 'skip';
  if (scam && decision === 'apply') decision = 'ask'; // never auto-apply a suspected scam
  return { score, decision, reasons: String(o.reasons ?? ''), scam };
}
