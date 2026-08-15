import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export type Config = {
  hard: { maxWarmRent: number; minSqm: number; minRooms: number; maxRooms: number;
          city: string; districtBlocklist: string[]; stalenessCutoffHours: number };
  thresholds: { apply: number; ask: number };
  preferences: string;   // free text
  profile: string;       // free text
  platforms: string[];
  llm: { provider: 'claude-cli' | 'openai-compatible'; model?: string; baseUrl?: string; apiKeyEnv?: string };
  fredyDbPath: string;
  dbPath: string;        // flatbot's own sqlite
  telegram: { token: string; chatId: string };
  // Optional so a hand-built Config (tests, shadow-only setups) disables sending outright.
  sender?: { backend: 'claude-agent' | 'browser-use'; hourlyCapPerPlatform: number;
             minDelayMinutes: number; maxDelayMinutes: number;
             profileDir: string; screenshotDir: string };
};

/** Every key a silent `undefined` would turn into "filter off" or an opaque runtime error. */
const HARD_NUMBERS = ['maxWarmRent', 'minSqm', 'minRooms', 'maxRooms', 'stalenessCutoffHours'] as const;

/**
 * A hand-edited config on a public repo: a missing or misspelled key must never mean "that filter
 * is off". `checkRules` compares against `undefined` — always false — so an absent
 * `stalenessCutoffHours` applies to week-old ads and an absent `maxWarmRent` applies at any price.
 */
function validate(raw: any): void {
  const bad: string[] = [];
  for (const k of HARD_NUMBERS)
    if (!Number.isFinite(raw?.hard?.[k])) bad.push(`hard.${k}`);
  if (raw?.hard?.districtBlocklist != null && !Array.isArray(raw.hard.districtBlocklist))
    bad.push('hard.districtBlocklist (must be a list)');
  if (typeof raw?.fredyDbPath !== 'string' || !raw.fredyDbPath.trim()) bad.push('fredyDbPath');
  const provider = raw?.llm?.provider ?? 'claude-cli';
  if (provider !== 'claude-cli' && provider !== 'openai-compatible')
    bad.push(`llm.provider (got "${provider}", expected claude-cli or openai-compatible)`);
  if (provider === 'openai-compatible') {
    if (!raw?.llm?.baseUrl) bad.push('llm.baseUrl');
    if (!raw?.llm?.model) bad.push('llm.model');
  }
  // A typo here does not disable the sender, it picks the *other* backend: anything that is not
  // exactly "browser-use" falls through to claude-agent, which then also launches a Chrome on the
  // profile directory the user meant browser-use to own.
  const backend = raw?.sender?.backend ?? 'claude-agent';
  if (backend !== 'claude-agent' && backend !== 'browser-use')
    bad.push(`sender.backend (got "${backend}", expected claude-agent or browser-use)`);
  if (bad.length)
    throw new Error(`config.yaml: missing or invalid ${bad.join(', ')} — every one of these is required`);
}

export function loadConfig(dir = process.cwd()): Config {
  const raw = parse(readFileSync(join(dir, 'config.yaml'), 'utf8'));
  validate(raw);
  const env: Record<string, string> = { ...process.env } as any;
  const envFile = join(dir, '.env');
  if (existsSync(envFile))
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      // lowercase and digits are legal in env keys, and a quoted value is a quoted value
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || m[1] in process.env) continue;
      const value = m[2].trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
      // exported, not just returned: LLM_API_KEY and friends are read off process.env downstream
      env[m[1]] = process.env[m[1]] = value;
    }
  const need = (k: string) => {
    if (!env[k]) throw new Error(`Missing ${k} in .env`);
    return env[k];
  };
  const minDelayMinutes = raw.sender?.minDelayMinutes ?? 2;
  return {
    hard: { districtBlocklist: [], ...raw.hard },
    thresholds: raw.thresholds ?? { apply: 75, ask: 50 },
    preferences: String(raw.preferences ?? ''),
    profile: String(raw.profile ?? ''),
    platforms: raw.platforms ?? [],
    llm: raw.llm ?? { provider: 'claude-cli' },
    fredyDbPath: resolve(dir, raw.fredyDbPath),
    dbPath: resolve(dir, raw.dbPath ?? './flatbot.sqlite'),
    telegram: { token: need('TELEGRAM_BOT_TOKEN'), chatId: need('TELEGRAM_CHAT_ID') },
    sender: {
      backend: raw.sender?.backend ?? 'claude-agent',
      hourlyCapPerPlatform: raw.sender?.hourlyCapPerPlatform ?? 3,
      minDelayMinutes,
      // an inverted range would mean "sleep less than the minimum" — pin both to min instead
      maxDelayMinutes: Math.max(minDelayMinutes, raw.sender?.maxDelayMinutes ?? 8),
      // both gitignored; relative paths land next to config.yaml
      profileDir: resolve(dir, raw.sender?.profileDir ?? './browser-profile'),
      screenshotDir: resolve(dir, raw.sender?.screenshotDir ?? './screenshots'),
    },
  };
}
