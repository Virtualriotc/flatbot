import { spawn } from 'node:child_process';
import type { Config } from './config.js';

/** Windows cmd quoting: `""` is a literal quote to both cmd.exe and the CRT argv parser. */
const winQuote = (s: string) => `"${s.replace(/"/g, '""')}"`;

const MAX_OUTPUT = 10e6;

/**
 * Every child currently running, so shutdown can reach them. `detached` is what makes the timeout
 * group-kill work, and it is also what stops the terminal's Ctrl-C from reaching a send in flight:
 * the child is in its own process group, so SIGINT never gets there and `claude` → `npx` → Chrome
 * outlive the process that started them.
 */
const live = new Set<() => void>();

/** Terminate whatever is running, process group and all. Called from the run loop's shutdown. */
export function killLiveSubprocesses(): void {
  for (const kill of live) kill();
}

/**
 * The one place flatbot spawns anything. Three properties every caller depends on:
 *
 * - **stdout survives a non-zero exit.** A send that submitted the form and then crashed on
 *   teardown must not be reported as a failure — that costs a duplicate application.
 * - **The whole process group dies on timeout.** `claude` spawns `npx` spawns `@playwright/mcp`
 *   spawns Chrome; signalling only the direct child leaks a browser per hung send.
 * - **`cwd` is the child's whole file surface.** An agent that reads stranger-written text must not
 *   be started in the directory holding `.env` and the database (see backends/claudeAgent.ts).
 * - **Free text goes in on stdin, never argv.** On Windows an npm-installed CLI is a `.cmd` shim
 *   that cannot be spawned without a shell, and Node does not escape args behind `shell`
 *   (DEP0190) — so the command line is built and quoted here, and carries no attacker-influenced
 *   text at all.
 *
 * `spawn`, not `execFile`: execFile drops `detached`, which is the whole process-group mechanism.
 */
export async function runSubprocess(
  bin: string,
  args: string[],
  opts: { stdin?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ stdout: string; error?: Error }> {
  const win = process.platform === 'win32';
  const child = spawn(
    win ? [bin, ...args].map(winQuote).join(' ') : bin,
    win ? [] : args,                 // no args behind `shell` → no DEP0190, no injection seam
    { env: opts.env, cwd: opts.cwd, shell: win, detached: !win },
  );
  child.stdin.on('error', () => {}); // the child may exit before it reads the prompt (EPIPE)
  child.stdin.end(opts.stdin ?? '');

  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
  child.stderr.on('data', (d: string) => { if (stderr.length < 4000) stderr += d; });

  let timedOut = false;
  // negative pid = the whole group, i.e. npx and the MCP server and its Chrome, not just `claude`.
  // TERM first so a browser can close its profile cleanly, KILL for whatever ignores it.
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (!win && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch { /* already gone */ }
  };
  let escalate: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    signal('SIGTERM');
    escalate = setTimeout(() => signal('SIGKILL'), 5_000).unref();
  }, opts.timeoutMs);

  const kill = () => signal('SIGTERM');
  live.add(kill);

  return new Promise((resolve) => {
    const done = (error?: Error) => {
      live.delete(kill);
      clearTimeout(timer);
      clearTimeout(escalate);
      resolve({ stdout, error });
    };
    child.on('error', done);         // ENOENT and friends keep their .code for callers
    child.on('close', (code, signal) => done(
      timedOut ? new Error(`${bin} timed out after ${opts.timeoutMs}ms`)
        : code === 0 ? undefined
          : new Error(`${bin} exited with ${signal ?? `code ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`),
    ));
  });
}

/** Run one prompt through the configured provider and return the raw reply text. */
export async function runLLM(cfg: Config['llm'], prompt: string): Promise<string> {
  if (cfg.provider === 'claude-cli') {
    // FLATBOT_CLAUDE_BIN/ARGS exist solely so tests and `doctor` can stub the binary.
    const bin = process.env.FLATBOT_CLAUDE_BIN ?? 'claude';
    const args = process.env.FLATBOT_CLAUDE_ARGS ? [process.env.FLATBOT_CLAUDE_ARGS] : ['-p'];
    // `claude -p` with no prompt argument reads the prompt from stdin (verified against CLI 2.1.233).
    const { stdout, error } = await runSubprocess(bin, args, { stdin: prompt, timeoutMs: 180_000 });
    if (error) throw error;
    return stdout;
  }
  const key = process.env[cfg.apiKeyEnv ?? 'LLM_API_KEY'];
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }] }),
    // a provider that accepts the connection and never answers would hang the whole run loop
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error(`LLM reply had no content: ${JSON.stringify(body)}`);
  return content;
}

/**
 * First balanced {...} in the text that parses as JSON. Throws with the raw text on failure.
 * ponytail: restarts at the next `{` after a failed group — O(n²) on adversarial input, fine for
 * LLM replies; cap the scan if that ever stops being true.
 */
export function extractJson(s: string): any {
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (escaped) escaped = false;
      else if (inString) {
        if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          break; // not JSON after all — try the next opening brace
        }
      }
    }
  }
  throw new Error(`No parseable JSON object in LLM output: ${s}`);
}
