import { afterEach, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killLiveSubprocesses, runLLM, extractJson, runSubprocess } from '../src/llm.js';

const saved = { ...process.env };
afterEach(() => {
  // env set by a test must not leak into the next one (or into another file's suite)
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.unstubAllGlobals();
});

test('claude-cli provider returns stub stdout', async () => {
  process.env.FLATBOT_CLAUDE_BIN = 'node';
  process.env.FLATBOT_CLAUDE_ARGS = 'test/fake-claude.mjs';
  const out = await runLLM({ provider: 'claude-cli' }, 'hello');
  expect(out).toContain('"score": 80');
});

test('the prompt reaches the claude CLI (stdin, never a shell-quoted argv)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-llm-'));
  process.env.FLATBOT_CLAUDE_BIN = 'node';
  process.env.FLATBOT_CLAUDE_ARGS = 'test/fake-claude.mjs';
  process.env.FAKE_STDIN_SINK = join(dir, 'stdin.txt');
  await runLLM({ provider: 'claude-cli' }, 'JUDGE THIS "quoted" & piped\nsecond line');
  expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toBe('JUDGE THIS "quoted" & piped\nsecond line');
  rmSync(dir, { recursive: true, force: true });
});

test('a claude-cli failure throws instead of returning empty text', async () => {
  process.env.FLATBOT_CLAUDE_BIN = join(tmpdir(), 'definitely-not-a-binary-flatbot');
  process.env.FLATBOT_CLAUDE_ARGS = '--version';
  await expect(runLLM({ provider: 'claude-cli' }, 'hi')).rejects.toThrow();
});

test('extractJson finds embedded object', () => {
  expect(extractJson('bla {"a": {"b": 1}} bla').a.b).toBe(1);
});

test('extractJson resumes after a brace group that is not JSON', () => {
  // an LLM prose preamble containing braces used to make the real object unreachable
  expect(extractJson('note {not json at all} then {"score": 80}').score).toBe(80);
  expect(extractJson('{ bad } { "a": 1 } { "b": 2 }').a).toBe(1);
});

test('extractJson throws with context on garbage', () => {
  expect(() => extractJson('no json here')).toThrow(/no json here/);
});

// ---- openai-compatible branch (half of runLLM, previously unexercised) ----

const okBody = { choices: [{ message: { content: 'HELLO FROM THE API' } }] };
const fakeFetch = (body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) =>
  vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => init.text ?? '',
  })) as any;

const oa = { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini' } as const;

test('openai-compatible posts the prompt and returns the message content', async () => {
  const f = fakeFetch(okBody);
  vi.stubGlobal('fetch', f);
  process.env.LLM_API_KEY = 'secret-key';
  expect(await runLLM({ ...oa }, 'PROMPTTEXT')).toBe('HELLO FROM THE API');

  const [url, init] = f.mock.calls[0];
  expect(url).toBe('https://api.example.com/v1/chat/completions');
  expect(init.headers.authorization).toBe('Bearer secret-key');
  expect(JSON.parse(init.body)).toEqual({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'PROMPTTEXT' }] });
});

test('openai-compatible reads the key from llm.apiKeyEnv when set', async () => {
  const f = fakeFetch(okBody);
  vi.stubGlobal('fetch', f);
  process.env.LLM_API_KEY = 'wrong';
  process.env.MY_OWN_KEY = 'right';
  await runLLM({ ...oa, apiKeyEnv: 'MY_OWN_KEY' }, 'p');
  expect(f.mock.calls[0][1].headers.authorization).toBe('Bearer right');
});

test('openai-compatible aborts instead of hanging forever', async () => {
  const f = fakeFetch(okBody);
  vi.stubGlobal('fetch', f);
  await runLLM({ ...oa }, 'p');
  const signal = f.mock.calls[0][1].signal as AbortSignal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal.aborted).toBe(false);
});

test('openai-compatible surfaces an HTTP error with the body', async () => {
  vi.stubGlobal('fetch', fakeFetch({}, { ok: false, status: 429, text: 'slow down' }));
  await expect(runLLM({ ...oa }, 'p')).rejects.toThrow(/429.*slow down/s);
});

test('openai-compatible rejects a reply with no content instead of returning undefined', async () => {
  vi.stubGlobal('fetch', fakeFetch({ choices: [] }));
  await expect(runLLM({ ...oa }, 'p')).rejects.toThrow(/no content/);
});

// ---- runSubprocess: the shared spawn seam both send backends stand on ----

test('runSubprocess returns stdout even when the child exits non-zero', async () => {
  const r = await runSubprocess('node', ['-e', 'console.log("RESULT"); process.exit(7)'], { timeoutMs: 30_000 });
  expect(r.stdout).toContain('RESULT');
  expect(r.error).toBeTruthy();
});

// N8. `detached` is what makes the group-kill work, and it is also why Ctrl-C stops reaching a
// send in flight: the child is in its own process group. Shutdown has to signal it explicitly.
test('a live child is killed by the shutdown path, not left behind', async () => {
  const running = runSubprocess('node', ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 150));
  killLiveSubprocesses();
  const { error } = await running;
  expect(error).toBeTruthy();

  // a finished child is off the list: shutdown must not signal a pid somebody else now owns
  await runSubprocess('node', ['-e', 'process.exit(0)'], { timeoutMs: 30_000 });
  expect(() => killLiveSubprocesses()).not.toThrow();
});

test('a timed-out child cannot leave its grandchildren running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flatbot-kill-'));
  const marker = join(dir, 'grandchild-survived.txt');
  // parent spawns a grandchild (as `claude` spawns npx -> playwright-mcp -> chrome) and hangs
  const script = `const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e','setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"alive"),700)'],{stdio:'ignore'});
    setTimeout(()=>{},60000);`;
  writeFileSync(join(dir, 'parent.cjs'), script);

  const r = await runSubprocess('node', [join(dir, 'parent.cjs')], { timeoutMs: 150 });
  expect(r.error).toBeTruthy();
  await new Promise((res) => setTimeout(res, 1200));
  expect(existsSync(marker)).toBe(false); // grandchild never got to write it: the group was killed
  rmSync(dir, { recursive: true, force: true });
});
