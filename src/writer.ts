import type { Listing } from './db.js';
import type { Config } from './config.js';

export function buildLetterPrompt(l: Listing, cfg: Config): string {
  const fields: [string, unknown][] = [
    ['Title', l.title], ['Platform', l.platform], ['Warm rent (EUR)', l.price],
    ['Size (sqm)', l.size], ['Rooms', l.rooms], ['Address', l.address],
    ['URL', l.url], ['Description', l.description?.slice(0, 2000)],
  ];
  const listing = fields
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  return `You write rental application letters (Anschreiben) in German for one specific applicant.

LISTING
${listing}

APPLICANT PROFILE (the only source of facts about the applicant)
${cfg.profile}

RULES
- Write a German Anschreiben of 120-180 words for this listing.
- Address the landlord or agency by name only if that name appears in the listing text above; otherwise open with "Sehr geehrte Damen und Herren".
- Reference 1-2 concrete specifics of THIS flat.
- Applicant facts come ONLY from the profile above. If a fact is not in the profile, do not claim it; never invent income figures, job titles, or documents.
- Close by offering documents (Schufa, Gehaltsnachweise) on request.
- Sign with the applicant's name from the profile.

OUTPUT
Plain text only. No subject line, no markdown, no placeholders like [Name].`;
}

/**
 * Shape checks only: fences, quotes, placeholder brackets, length. The spec's "writer output
 * checked for numbers/claims not in profile" (§Risks) is NOT implemented — a fuzzy fact-checker
 * over free German prose is its own project. Known limitation: the profile-only rule in the prompt
 * is the sole guard against an invented income figure. (M6)
 */
export function parseLetter(raw: string): string {
  // A fenced block wins over everything around it: `claude -p` writes "Here is the letter:" before
  // the fence and a remark after it, and in auto mode that preamble is submitted to a landlord.
  const fenced = raw.match(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```/);
  let text = (fenced ? fenced[1] : raw)
    .trim()
    .replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '')   // half-open fence (truncated reply)
    .replace(/\r?\n?```$/, '')
    .trim();
  if (/^"[\s\S]*"$/.test(text) || /^'[\s\S]*'$/.test(text)) text = text.slice(1, -1).trim();
  if (/\[[^\]]*\]/.test(text)) throw new Error('letter contains placeholder brackets');
  if (text.length < 200) throw new Error(`letter too short (${text.length} chars)`);
  return text;
}
