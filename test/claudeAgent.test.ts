import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ALLOWED_TOOLS, buildSendPrompt, claudeAgentBackend, DENIED_TOOLS, PLAYWRIGHT_MCP_VERSION } from '../src/backends/claudeAgent.js';

const platform = {
  id: 'immoscout', displayName: 'ImmoScout24', loginUrl: 'https://www.immobilienscout24.de/',
  matchesUrl: (u: string) => u.includes('immobilienscout24'),
  contactInstructions: 'Klicke "Nachricht schreiben", Feld "Nachricht".',
  paywallMarkers: ['MieterPlus'],
  successMarkers: ['Nachricht gesendet'],
};

let dir: string;
const job = () => ({
  listing: { id: 'abc/1', url: 'https://www.immobilienscout24.de/expose/1', title: 'Helle 2-Zi' } as any,
  letter: 'Sehr geehrte Damen und Herren, LETTERBODY.',
  platform, profileDir: join(dir, 'profile'), screenshotDir: join(dir, 'shots'),
});
/** The path the backend mandates in the prompt — sanitised listing id under screenshotDir. */
const mandatedShot = () => join(dir, 'shots', 'abc_1.png');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flatbot-claude-agent-'));
  process.env.FLATBOT_CLAUDE_BIN = 'node';
  // absolute: the child is spawned in a scratch cwd, so a repo-relative stub would not resolve
  process.env.FLATBOT_CLAUDE_ARGS = resolve('test/fake-claude-send.mjs');
  process.env.FAKE_SENTINEL = join(dir, 'ran.log');
});

afterEach(() => {
  delete process.env.FLATBOT_CLAUDE_BIN;
  delete process.env.FLATBOT_CLAUDE_ARGS;
  delete process.env.FAKE_SENTINEL;
  delete process.env.FAKE_SEND_REPLY;
  delete process.env.FAKE_SHOT;
  delete process.env.FAKE_EXIT_CODE;
  delete process.env.FAKE_STDIN_SINK;
  delete process.env.FAKE_ENV_SINK;
  delete process.env.FLATBOT_CDP_ENDPOINT;
  delete process.env.FLATBOT_SEND_TIMEOUT_MS;
  rmSync(dir, { recursive: true, force: true });
});

// ---- C6: the tool grant is the containment boundary; the prompt sentence is not ----

test('the tool grant is an explicit allowlist — no wildcard, no upload, no code execution', () => {
  const tools = ALLOWED_TOOLS.split(',');
  expect(tools).toEqual([
    'mcp__playwright__browser_navigate',
    'mcp__playwright__browser_snapshot',
    'mcp__playwright__browser_click',
    'mcp__playwright__browser_type',
    'mcp__playwright__browser_select_option',
    'mcp__playwright__browser_press_key',
    'mcp__playwright__browser_wait_for',
    'mcp__playwright__browser_take_screenshot',
  ]);
  // a listing description is attacker-controlled text this agent reads while holding a real session
  for (const banned of ['*', 'browser_file_upload', 'browser_evaluate', 'browser_run_code_unsafe',
    'browser_handle_dialog', 'browser_tabs', 'browser_network_request', 'browser_pdf_save',
    'browser_set_storage_state', 'browser_cookie_set'])
    expect(ALLOWED_TOOLS).not.toContain(banned);
  // server-wide grants (`mcp__playwright`) would re-open everything the list just closed
  for (const t of tools) expect(t).toMatch(/^mcp__playwright__browser_[a-z_]+$/);
});

test('the narrowed allowlist is what actually reaches the CLI', async () => {
  await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  const argv = JSON.parse(readFileSync(join(dir, 'ran.log'), 'utf8').split('\n')[0]) as string[];
  expect(argv[argv.indexOf('--allowedTools') + 1]).toBe(ALLOWED_TOOLS);
});

// N1. `--allowedTools` only *adds* permissions: with it alone the agent still had Claude Code's
// own file and shell tools, and reading `.env` out of flatbot's cwd was proven against the real
// CLI. Containment is the three flags below, not the allowlist.
test('every built-in tool is switched off, and the rest of the MCP surface is denied by name', async () => {
  await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  const argv = JSON.parse(readFileSync(join(dir, 'ran.log'), 'utf8').split('\n')[0]) as string[];

  // `--tools ""` = no built-in tools at all. A denylist of names cannot do this job: the agent
  // routes around a named deny via whatever built-in was added since (proven with ToolSearch/Monitor).
  expect(argv[argv.indexOf('--tools') + 1]).toBe('');
  // the pinned MCP server advertises far more than the eight the form needs
  expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe(DENIED_TOOLS);
  for (const banned of ['browser_evaluate', 'browser_run_code_unsafe', 'browser_file_upload',
    'browser_handle_dialog', 'browser_tabs', 'browser_network_request', 'browser_close'])
    expect(DENIED_TOOLS).toContain(`mcp__playwright__${banned}`);
  // no allowed tool may also be denied, and no tool may be neither
  for (const t of ALLOWED_TOOLS.split(',')) expect(DENIED_TOOLS.split(',')).not.toContain(t);
  // the user's own MCP servers must not be loaded into a session that reads stranger-written text
  expect(argv).toContain('--strict-mcp-config');
});

test('the child runs in a scratch directory, not the checkout that holds .env', async () => {
  process.env.FAKE_ENV_SINK = join(dir, 'env.json');
  await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  const { cwd } = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')) as { cwd: string };
  expect(cwd).not.toBe(process.cwd());
  expect(existsSync(join(cwd, 'ran.log'))).toBe(false);   // an empty scratch dir, not the test dir
});

test('the bot credentials and the LLM key never reach the send agent', async () => {
  process.env.FAKE_ENV_SINK = join(dir, 'env.json');
  process.env.TELEGRAM_BOT_TOKEN = 'secret-token';
  process.env.TELEGRAM_CHAT_ID = '4711';
  process.env.LLM_API_KEY = 'secret-key';
  try {
    await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.LLM_API_KEY;
  }
  const { env } = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')) as { env: Record<string, string> };
  expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  expect(env.TELEGRAM_CHAT_ID).toBeUndefined();
  expect(env.LLM_API_KEY).toBeUndefined();
  expect(env.PATH).toBeTruthy();   // the rest of the environment is still there
});

test('the MCP server writes only into the screenshot directory', async () => {
  await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  const mcp = JSON.parse(readFileSync(join(dir, 'ran.log'), 'utf8').split('\n')[1]) as any;
  const args = mcp.mcpServers.playwright.args as string[];
  // the server refuses file writes outside its output dir and its cwd — and its cwd is now scratch
  expect(args[args.indexOf('--output-dir') + 1]).toBe(join(dir, 'shots'));
});

test('prompt carries the allowlist verbatim, the listing, the letter and both marker sets', () => {
  const p = buildSendPrompt(job() as any, '/shots/abc_1.png');
  expect(p).toContain(
    'The sender agent may only fill and submit contact/message forms — never change account settings, never pay, never upload documents.');
  for (const s of ['https://www.immobilienscout24.de/expose/1', 'LETTERBODY.', 'Nachricht schreiben',
    'MieterPlus', 'Nachricht gesendet', '/shots/abc_1.png']) expect(p).toContain(s);
});

test('letter block is fenced with a fresh random nonce on both fence lines', () => {
  const p = buildSendPrompt(job() as any, '/shots/abc_1.png');
  const nonce = p.match(/<<<MESSAGE-([0-9a-f]{16})\n/)?.[1];
  expect(nonce).toBeTruthy();
  // opening fence, closing fence, and the "everything between" warning all name the same nonce
  expect(p.split(`MESSAGE-${nonce}`)).toHaveLength(4);
  expect(p).toContain(`<<<MESSAGE-${nonce}\nSehr geehrte Damen und Herren, LETTERBODY.\nMESSAGE-${nonce}\n`);

  const q = buildSendPrompt(job() as any, '/shots/abc_1.png');
  expect(q.match(/<<<MESSAGE-([0-9a-f]{16})\n/)?.[1]).not.toBe(nonce);
});

test('confirmed send returns ok + screenshot and invokes claude with mcp config over CDP', async () => {
  process.env.FLATBOT_CDP_ENDPOINT = 'http://127.0.0.1:9333';
  process.env.FAKE_SHOT = mandatedShot();
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  expect(res).toMatchObject({ ok: true, confirmed: true, screenshotPath: mandatedShot() });

  const log = readFileSync(join(dir, 'ran.log'), 'utf8');
  expect(log).toContain('--output-format');
  expect(log).toContain('--mcp-config');
  expect(log).toContain('http://127.0.0.1:9333');   // generated Playwright-MCP config attaches to the CDP endpoint
  expect(log).toContain('playwright');
  // headless `claude -p` auto-denies non-read-only MCP tools without an explicit allow rule
  expect(log).toContain('--allowedTools');
  expect(log).toContain('mcp__playwright__browser_click');
  // pinned, never @latest
  expect(log).toContain(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`);
  expect(log).not.toContain('@playwright/mcp@latest');
});

test('job.cdpEndpoint wins over the env fallback', async () => {
  process.env.FLATBOT_CDP_ENDPOINT = 'http://127.0.0.1:9333';
  await claudeAgentBackend({} as any).send({ ...job(), cdpEndpoint: 'http://127.0.0.1:9444' } as any, { dryRun: false });
  const log = readFileSync(join(dir, 'ran.log'), 'utf8');
  expect(log).toContain('http://127.0.0.1:9444');
  expect(log).not.toContain('http://127.0.0.1:9333');
});

// ---- publish-I3: "confirmed" is what the docs promise — success marker AND a screenshot on disk ----

test('a self-reported confirmation with no screenshot on disk is sent-but-unconfirmed', async () => {
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  // ok, so the sender books it as sent (re-sending by hand would duplicate the application),
  // but unconfirmed, so the operator is told to go and look
  expect(res).toMatchObject({ ok: true, confirmed: false });
  expect(res.screenshotPath).toBeUndefined();
});

test('a screenshot left over from an earlier run cannot confirm this one', async () => {
  mkdirSync(join(dir, 'shots'), { recursive: true });
  writeFileSync(mandatedShot(), 'stale png from the previous attempt');
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  expect(res).toMatchObject({ ok: true, confirmed: false });
  expect(res.screenshotPath).toBeUndefined();
  expect(existsSync(mandatedShot())).toBe(false); // removed before spawning, never re-created
});

// ---- I2: a send that succeeded and then crashed on teardown is still a send ----

test('result JSON on stdout is honoured even when the CLI exits non-zero', async () => {
  process.env.FAKE_SHOT = mandatedShot();
  process.env.FAKE_EXIT_CODE = '1';
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  expect(res).toMatchObject({ ok: true, confirmed: true, screenshotPath: mandatedShot() });
});

test('a non-zero exit with no usable output is an error, not a claimed send', async () => {
  process.env.FAKE_EXIT_CODE = '1';
  process.env.FAKE_SEND_REPLY = 'segfault';
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  expect(res).toMatchObject({ ok: false, confirmed: false });
  expect(res.error).toBeTruthy();
});

test('the send prompt reaches the agent on stdin, not on a command line', async () => {
  process.env.FAKE_STDIN_SINK = join(dir, 'stdin.txt');
  await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  const seen = readFileSync(join(dir, 'stdin.txt'), 'utf8');
  expect(seen).toContain('LETTERBODY.');
  expect(seen).toContain('https://www.immobilienscout24.de/expose/1');
});

test('paywalled run reports paywalled and not ok', async () => {
  process.env.FAKE_SEND_REPLY = '{"sent": false, "confirmed": false, "paywalled": true, "note": "MieterPlus wall"}';
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  expect(res).toMatchObject({ ok: false, confirmed: false, paywalled: true });
  expect(res.error).toContain('MieterPlus');
});

test('claude --output-format json envelope is unwrapped before parsing', async () => {
  process.env.FAKE_SHOT = mandatedShot();
  process.env.FAKE_SEND_REPLY = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'done: {"sent": true, "confirmed": true, "screenshot": "/tmp/env.png"}',
  });
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  // the echoed /tmp/env.png is discarded in favour of the mandated path that exists on disk
  expect(res).toMatchObject({ ok: true, confirmed: true, screenshotPath: mandatedShot() });
});

test('garbage output is an error, never a claimed send', async () => {
  process.env.FAKE_SEND_REPLY = 'I could not find the form, sorry';
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  expect(res.ok).toBe(false);
  expect(res.confirmed).toBe(false);
  expect(res.error).toContain('could not find the form');
});

test('agent says sent without confirmation -> not ok', async () => {
  process.env.FAKE_SEND_REPLY = '{"sent": true, "confirmed": false, "note": "no confirmation text"}';
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: false });
  expect(res).toMatchObject({ ok: false, confirmed: false });
});

test('unusable screenshot dir returns an error instead of throwing', async () => {
  writeFileSync(join(dir, 'blocker'), '');
  const res = await claudeAgentBackend({} as any)
    .send({ ...job(), screenshotDir: join(dir, 'blocker', 'shots') } as any, { dryRun: false });
  expect(res).toMatchObject({ ok: false, confirmed: false });
  expect(res.error).toBeTruthy();
  expect(existsSync(join(dir, 'ran.log'))).toBe(false);   // nothing spawned
});

test('dry run spawns nothing', async () => {
  const res = await claudeAgentBackend({} as any).send(job() as any, { dryRun: true });
  expect(res).toMatchObject({ ok: true, confirmed: false });
  expect(existsSync(join(dir, 'ran.log'))).toBe(false);
});
