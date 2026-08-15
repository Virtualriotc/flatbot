import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserUseBackend } from '../src/backends/browserUse.js';
import type { Config } from '../src/config.js';
import type { SendJob } from '../src/sender.js';
import type { PlatformSpec } from '../src/platforms.js';

// A stand-in for the browser-use CLI: records its argv + the task file it was handed,
// then prints whatever the test canned. Keeps the suite free of python/uv/browsers.
const STUB = `import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const i = argv.indexOf('--prompt-file');
const prompt = i >= 0 ? readFileSync(argv[i + 1], 'utf8') : '';
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /KEY$|^TELEGRAM_/.test(k)));
writeFileSync(process.env.FAKE_SENTINEL, JSON.stringify({ argv, prompt, env }));
if (process.env.FAKE_SHOT) writeFileSync(process.env.FAKE_SHOT, 'png');
console.log(process.env.FAKE_OUT ?? '');
if (process.env.FAKE_EXIT_CODE) process.exit(Number(process.env.FAKE_EXIT_CODE));
`;

const ALLOWLIST =
  'The sender agent may only fill and submit contact/message forms — never change account settings, never pay, never upload documents.';

const cfg = { llm: { provider: 'claude-cli', model: 'gemini-2.5-flash' } } as Config;

let dir: string, sentinel: string, job: SendJob;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flatbot-bu-test-'));
  sentinel = join(dir, 'spawned.json');
  writeFileSync(join(dir, 'stub.mjs'), STUB);
  process.env.FLATBOT_BROWSERUSE_BIN = 'node';
  process.env.FLATBOT_BROWSERUSE_ARGS = join(dir, 'stub.mjs');
  process.env.FAKE_SENTINEL = sentinel;
  job = {
    listing: { id: 'l1', url: 'https://immoscout.de/expose/1', platform: 'immoscout' } as any,
    letter: 'Sehr geehrte Damen und Herren, ich interessiere mich fuer die Wohnung.',
    platform: {
      id: 'immoscout', displayName: 'ImmoScout24', loginUrl: 'https://x',
      matchesUrl: () => true,
      contactInstructions: 'Klicke auf "Nachricht schreiben"',
      paywallMarkers: ['MieterPlus'],
      successMarkers: ['Nachricht gesendet'],
    } as PlatformSpec,
    profileDir: join(dir, 'profile'),
    screenshotDir: join(dir, 'shots'),
  };
});

afterEach(() => {
  for (const k of ['FLATBOT_BROWSERUSE_BIN', 'FLATBOT_BROWSERUSE_ARGS', 'FAKE_SENTINEL', 'FAKE_OUT',
    'FAKE_SHOT', 'FAKE_EXIT_CODE', 'LLM_API_KEY', 'GEMINI_API_KEY', 'MY_KEY',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])
    delete process.env[k];
});

const spawned = () => JSON.parse(readFileSync(sentinel, 'utf8')) as
  { argv: string[]; prompt: string; env: Record<string, string> };
/** The path the backend mandates in the task — the agent's echoed path is never trusted. */
const mandatedShot = () => join(dir, 'shots', 'l1.png');

test('confirmed send returns ok + the screenshot it wrote', async () => {
  process.env.FAKE_SHOT = mandatedShot();
  process.env.FAKE_OUT =
    'step 1 {"thinking": "noise"}\n{"sent": true, "confirmed": true, "paywalled": false, "screenshot": "/tmp/shot.png", "note": "ok"}';
  const res = await browserUseBackend(cfg).send(job, { dryRun: false });
  // the echoed /tmp/shot.png is discarded: only the mandated path, and only because it is on disk
  expect(res).toMatchObject({ ok: true, confirmed: true, screenshotPath: mandatedShot() });
});

test('a claimed confirmation with no screenshot on disk is sent-but-unconfirmed', async () => {
  process.env.FAKE_OUT = '{"sent": true, "confirmed": true, "screenshot": "/tmp/shot.png"}';
  const res = await browserUseBackend(cfg).send(job, { dryRun: false });
  expect(res).toMatchObject({ ok: true, confirmed: false });
  expect(res.screenshotPath).toBeUndefined();
});

test('a screenshot left over from an earlier run cannot confirm this one', async () => {
  mkdirSync(join(dir, 'shots'), { recursive: true });
  writeFileSync(mandatedShot(), 'stale png');
  process.env.FAKE_OUT = '{"sent": true, "confirmed": true}';
  const res = await browserUseBackend(cfg).send(job, { dryRun: false });
  expect(res).toMatchObject({ ok: true, confirmed: false });
  expect(existsSync(mandatedShot())).toBe(false);
});

test('the letter is fenced with a fresh per-send nonce, not a breakable ---', async () => {
  process.env.FAKE_OUT = '{"sent": true, "confirmed": true}';
  await browserUseBackend(cfg).send(job, { dryRun: false });
  const first = spawned().prompt;
  const nonce = first.match(/MESSAGE-([0-9a-f]{16})/)?.[1];
  expect(nonce).toBeTruthy();
  expect(first).toContain(`<<<MESSAGE-${nonce}\n${job.letter}\nMESSAGE-${nonce}\n`);

  await browserUseBackend(cfg).send(job, { dryRun: false });
  expect(spawned().prompt.match(/MESSAGE-([0-9a-f]{16})/)?.[1]).not.toBe(nonce);
});

test('result JSON on stdout is honoured even when the CLI exits non-zero', async () => {
  process.env.FAKE_SHOT = mandatedShot();
  process.env.FAKE_EXIT_CODE = '1';
  process.env.FAKE_OUT = '{"sent": true, "confirmed": true, "note": "ok"}';
  const res = await browserUseBackend(cfg).send(job, { dryRun: false });
  expect(res).toMatchObject({ ok: true, confirmed: true, screenshotPath: mandatedShot() });
});

test('a pretty-printed multi-line result is read, not treated as a crash', async () => {
  process.env.FAKE_OUT = 'INFO starting\n{\n  "sent": true,\n  "confirmed": false,\n  "note": "n"\n}\n';
  const res = await browserUseBackend(cfg).send(job, { dryRun: false });
  expect(res).toMatchObject({ ok: true, confirmed: false });
});

test('the configured key is passed under its own name, never cross-assigned to a vendor', async () => {
  process.env.FAKE_OUT = '{"sent": true, "confirmed": true}';
  process.env.MY_KEY = 'openrouter-secret';
  const openai = { llm: { provider: 'openai-compatible', model: 'gpt-4o-mini', apiKeyEnv: 'MY_KEY' } } as Config;
  await browserUseBackend(openai).send(job, { dryRun: false });
  // an OpenAI/OpenRouter key must not be handed to a Gemini endpoint
  expect(spawned().env.GEMINI_API_KEY).toBeUndefined();
  expect(spawned().env.MY_KEY).toBe('openrouter-secret');
});

test('the telegram credentials are kept out of the third-party agent', async () => {
  process.env.FAKE_OUT = '{"sent": true, "confirmed": true}';
  process.env.TELEGRAM_BOT_TOKEN = 'bot:secret';
  process.env.TELEGRAM_CHAT_ID = '42';
  await browserUseBackend(cfg).send(job, { dryRun: false });
  expect(spawned().env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  expect(spawned().env.TELEGRAM_CHAT_ID).toBeUndefined();
});

test('llm.apiKeyEnv reaches browser-use for the gemini default', async () => {
  process.env.FAKE_OUT = '{"sent": true, "confirmed": true}';
  process.env.MY_KEY = 'gemini-secret';
  const gem = { llm: { provider: 'openai-compatible', model: 'gemini-2.5-flash', apiKeyEnv: 'MY_KEY' } } as Config;
  await browserUseBackend(gem).send(job, { dryRun: false });
  expect(spawned().env.GEMINI_API_KEY).toBe('gemini-secret');
});

test('task file carries the allowlist verbatim, the letter and the markers', async () => {
  process.env.FAKE_OUT = '{"sent": true, "confirmed": true}';
  await browserUseBackend(cfg).send(job, { dryRun: false });
  const { argv, prompt } = spawned();
  expect(prompt).toContain(ALLOWLIST);
  expect(prompt).toContain(job.letter);
  expect(prompt).toContain('MieterPlus');
  expect(prompt).toContain('Nachricht gesendet');
  expect(prompt).toContain(join(job.screenshotDir, 'l1.png'));
  expect(argv).toEqual(expect.arrayContaining(['--user-data-dir', job.profileDir, '--model', 'gemini-2.5-flash']));
});

test('paywalled run reports paywalled without ok', async () => {
  process.env.FAKE_OUT = '{"sent": false, "confirmed": false, "paywalled": true, "note": "MieterPlus wall"}';
  const res = await browserUseBackend(cfg).send(job, { dryRun: false });
  expect(res).toMatchObject({ ok: false, confirmed: false, paywalled: true });
  expect(res.error).toContain('MieterPlus');
});

test('garbage output fails without throwing', async () => {
  process.env.FAKE_OUT = 'browser-use crashed, no json here';
  const res = await browserUseBackend(cfg).send(job, { dryRun: false });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/no result JSON/i);
});

test('dry run spawns nothing', async () => {
  const res = await browserUseBackend(cfg).send(job, { dryRun: true });
  expect(res).toEqual({ ok: true, confirmed: false });
  expect(existsSync(sentinel)).toBe(false);
});

test('missing binary reports not installed instead of throwing', async () => {
  process.env.FLATBOT_BROWSERUSE_BIN = join(dir, 'definitely-not-a-binary');
  const res = await browserUseBackend(cfg).send(job, { dryRun: false });
  expect(res).toMatchObject({ ok: false, confirmed: false });
  expect(res.error).toMatch(/^browser-use not installed/);
});
