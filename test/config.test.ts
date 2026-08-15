import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

// loadConfig exports .env into process.env (that is how LLM_API_KEY reaches the LLM layer),
// so each test has to start from a clean slate or the first .env in the file wins for all of them.
afterEach(() => {
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LLM_API_KEY', 'my_lower_key', 'OPENAI_API_KEY2'])
    delete process.env[k];
});

/**
 * config.example.yaml with top-level keys replaced. Merged as objects, not appended as text:
 * appending re-declares a key the example already has, and yaml rejects duplicate keys.
 */
function tmpConfigDir(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-'));
  const example = parse(readFileSync('config.example.yaml', 'utf8'));
  writeFileSync(join(dir, 'config.yaml'), stringify({ ...example, ...overrides }));
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=tok\nTELEGRAM_CHAT_ID=123\n');
  return dir;
}

test('loads config.yaml and .env', () => {
  const cfg = loadConfig(tmpConfigDir());
  expect(cfg.hard.maxWarmRent).toBe(1000);
  expect(cfg.telegram).toEqual({ token: 'tok', chatId: '123' });
  expect(cfg.llm.provider).toBe('claude-cli');
});

test('the example sender block matches the built-in defaults, both dirs under the config dir', () => {
  const dir = tmpConfigDir();
  expect(loadConfig(dir).sender).toEqual({
    backend: 'claude-agent', hourlyCapPerPlatform: 3, minDelayMinutes: 2, maxDelayMinutes: 8,
    profileDir: join(dir, 'browser-profile'), screenshotDir: join(dir, 'screenshots'),
  });
});

test('config.yaml overrides the sender block; relative dirs resolve, absolute ones stay', () => {
  const dir = tmpConfigDir({
    sender: { backend: 'browser-use', hourlyCapPerPlatform: 1, minDelayMinutes: 3,
      maxDelayMinutes: 9, profileDir: './prof', screenshotDir: '/var/shots' },
  });
  expect(loadConfig(dir).sender).toEqual({
    backend: 'browser-use', hourlyCapPerPlatform: 1, minDelayMinutes: 3, maxDelayMinutes: 9,
    profileDir: join(dir, 'prof'), screenshotDir: '/var/shots',
  });
});

test('an inverted delay range clamps to the minimum', () => {
  const s = loadConfig(tmpConfigDir({ sender: { minDelayMinutes: 5, maxDelayMinutes: 1 } })).sender!;
  expect([s.minDelayMinutes, s.maxDelayMinutes]).toEqual([5, 5]);
});

// ---- I7 / publish-I11: a key that is missing or misspelled silently disables its filter ----

test.each([
  ['maxWarmRent', 'hard.maxWarmRent'],
  ['minSqm', 'hard.minSqm'],
  ['minRooms', 'hard.minRooms'],
  ['maxRooms', 'hard.maxRooms'],
  ['stalenessCutoffHours', 'hard.stalenessCutoffHours'],
])('a missing hard.%s is reported by name, not silently ignored', (key, named) => {
  const hard = { maxWarmRent: 1000, minSqm: 30, minRooms: 1, maxRooms: 2, city: 'Berlin',
    districtBlocklist: [], stalenessCutoffHours: 24 } as Record<string, unknown>;
  delete hard[key];
  expect(() => loadConfig(tmpConfigDir({ hard }))).toThrow(named);
});

test('a misspelled hard block disables every filter, so it is refused by name', () => {
  expect(() => loadConfig(tmpConfigDir({ hard: undefined, hardd: {} }))).toThrow(/hard\.maxWarmRent/);
});

test('a non-numeric hard value is refused (a quoted rent silently compares false)', () => {
  expect(() => loadConfig(tmpConfigDir({
    hard: { maxWarmRent: 'tausend', minSqm: 30, minRooms: 1, maxRooms: 2, city: 'B',
      districtBlocklist: [], stalenessCutoffHours: 24 },
  }))).toThrow(/hard\.maxWarmRent/);
});

test('a districtBlocklist that is not a list is refused (it would throw at filter time)', () => {
  expect(() => loadConfig(tmpConfigDir({
    hard: { maxWarmRent: 1000, minSqm: 30, minRooms: 1, maxRooms: 2, city: 'B',
      districtBlocklist: 'Mitte', stalenessCutoffHours: 24 },
  }))).toThrow(/districtBlocklist/);
});

test('a missing fredyDbPath names the key instead of throwing a raw TypeError', () => {
  expect(() => loadConfig(tmpConfigDir({ fredyDbPath: undefined }))).toThrow(/fredyDbPath/);
});

test('an unknown llm.provider is refused with the accepted values', () => {
  expect(() => loadConfig(tmpConfigDir({ llm: { provider: 'anthropic-api' } })))
    .toThrow(/llm\.provider.*claude-cli.*openai-compatible/s);
});

// A typo does not disable the sender, it silently picks the other backend — and claude-agent then
// also launches a Chrome on the profile directory browser-use was meant to own.
test('a misspelled sender.backend is refused instead of falling through to claude-agent', () => {
  expect(() => loadConfig(tmpConfigDir({ sender: { backend: 'browseruse' } })))
    .toThrow(/sender\.backend.*claude-agent.*browser-use/s);
  expect(loadConfig(tmpConfigDir({ sender: { backend: 'browser-use' } })).sender!.backend).toBe('browser-use');
});

test('openai-compatible without baseUrl/model is refused before the first fetch', () => {
  expect(() => loadConfig(tmpConfigDir({ llm: { provider: 'openai-compatible' } })))
    .toThrow(/llm\.baseUrl.*llm\.model|llm\.model.*llm\.baseUrl/s);
  expect(loadConfig(tmpConfigDir({
    llm: { provider: 'openai-compatible', baseUrl: 'https://x/v1', model: 'gpt-4o-mini' },
  })).llm.model).toBe('gpt-4o-mini');
});

// ---- M5: the .env parser ----

test('.env keys with digits or lowercase are read, and quoted values are unquoted', () => {
  const dir = tmpConfigDir();
  writeFileSync(join(dir, '.env'),
    'TELEGRAM_BOT_TOKEN="123:abc-DEF"\nTELEGRAM_CHAT_ID=42\nOPENAI_API_KEY2=k2\nmy_lower_key=v\n');
  const cfg = loadConfig(dir);
  expect(cfg.telegram).toEqual({ token: '123:abc-DEF', chatId: '42' });
  expect(process.env.OPENAI_API_KEY2).toBe('k2');
  expect(process.env.my_lower_key).toBe('v');
});

test('.env reaches the LLM layer: the key is in process.env after loading', () => {
  const dir = tmpConfigDir();
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\nLLM_API_KEY=sk-from-dotenv\n');
  loadConfig(dir);
  expect(process.env.LLM_API_KEY).toBe('sk-from-dotenv'); // llm.ts reads it from there, not from Config
});

test('throws a clear error when telegram token missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-'));
  cpSync('config.example.yaml', join(dir, 'config.yaml'));
  expect(() => loadConfig(dir)).toThrow(/TELEGRAM_BOT_TOKEN/);
});
