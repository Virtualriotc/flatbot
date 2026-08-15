import type { Config } from './config.js';
import type { Listing } from './db.js';

/** `soft` = a doubt rather than a violation: the caller should still show it to a human. */
export type RuleResult = { pass: true } | { pass: false; reason: string; soft?: true };

/**
 * Case-insensitive whole-word match. A substring match would let "Mitte" swallow
 * "Mittenwalder Straße" and drop the listing unseen. The boundaries are Unicode-aware
 * lookarounds rather than `\b`, which is ASCII-only and would never match a term
 * ending in "ß" or starting with an umlaut.
 */
function hasWord(haystack: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);
}

/**
 * Deterministic hard constraints. Fails only on a definite violation — a `null`
 * (or unparseable) field is never a violation, the judge handles uncertainty.
 * First failed check wins.
 */
export function checkRules(l: Listing, hard: Config['hard'], now = new Date()): RuleResult {
  const fail = (reason: string): RuleResult => ({ pass: false, reason });

  if (l.price != null && l.price > hard.maxWarmRent)
    return fail(`price ${l.price} > maxWarmRent ${hard.maxWarmRent}`);

  if (l.size != null && l.size < hard.minSqm)
    return fail(`size ${l.size} < minSqm ${hard.minSqm}`);

  if (l.rooms != null && (l.rooms < hard.minRooms || l.rooms > hard.maxRooms))
    return fail(`rooms ${l.rooms} outside [${hard.minRooms}, ${hard.maxRooms}]`);

  // Geography is only checked when the listing actually carries an address — an absent field is
  // uncertainty, not a violation, and silently dropping every address-less listing would be worse
  // than letting the judge see it.
  if (l.address) {
    const hit = hard.districtBlocklist.find((d) => d && hasWord(l.address!, d));
    if (hit) return fail(`address "${l.address}" matches blocklisted district ${hit}`);

    // Portals routinely give a district-only address ("12489 Köpenick") and put the city in the
    // title, so both are searched. Leave `hard.city` empty to turn the check off entirely.
    //
    // Matched token by token, and a miss is soft. `city: Frankfurt am Main` against an address of
    // "60313 Frankfurt", or `Muenchen` against "München", is a config that would otherwise reject
    // every listing in existence — silently, since a rule skip never reaches Telegram. The city is
    // free text nobody validates, so this check must fail visibly or not at all.
    const tokens = hard.city.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
    if (tokens.length && !tokens.some((t) => hasWord(`${l.address} ${l.title}`, t)))
      return { pass: false, soft: true, reason: `address "${l.address}" is not in ${hard.city}` };
  }

  // NaN (unparseable discoveredAt) compares false, so it passes through.
  const ageHours = (now.getTime() - Date.parse(l.discoveredAt)) / 3600e3;
  if (ageHours > hard.stalenessCutoffHours)
    return fail(`listing is ${ageHours.toFixed(1)}h old > stalenessCutoffHours ${hard.stalenessCutoffHours}`);

  return { pass: true };
}
