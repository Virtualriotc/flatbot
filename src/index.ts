#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { claudeAgentBackend } from './backends/claudeAgent.js';
import { browserUseBackend } from './backends/browserUse.js';
import { launchProfile, type Profile } from './browser.js';
import { loadConfig, type Config } from './config.js';
import { openDb, type Db } from './db.js';
import { maybeDistill, readLearned } from './distill.js';
import { fetchNewListings } from './fredy.js';
import { buildJudgePrompt, parseVerdict } from './judge.js';
import { killLiveSubprocesses, runLLM } from './llm.js';
import { tick } from './pipeline.js';
import { PLATFORMS, platformFor } from './platforms.js';
import { recoverStaleSending, senderTick, type SendBackend } from './sender.js';
import { collectStats, createBot, fmtStats, type Notifier } from './telegram.js';
import { buildLetterPrompt, parseLetter } from './writer.js';

export const USAGE = `flatbot — a rental-listing triage bot

  flatbot init              interactive setup (token, chat id, preferences, config.yaml)
  flatbot login [platform]  open a portal (or every enabled one) to log in once, headed
  flatbot run               poll Fredy every 60s, judge, notify Telegram
  flatbot status            counts, mode and watermark
  flatbot dryrun <url>      re-judge one known listing with live LLM calls, write nothing
  flatbot doctor            check node, config, Fredy db, Telegram, the LLM and the send path
  flatbot chatid            print the chat id of whoever last messaged the bot
`;

/** `config.yaml` is read from the cwd, and "I ran it from the wrong directory" is the first
 *  thing a fresh install gets wrong. Every command goes through here so the error says so. */
export function loadConfigHere(dir = process.cwd()): Config {
  try {
    return loadConfig(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && String((e as Error).message).includes('config.yaml'))
      throw new Error(`No config.yaml in ${dir} — run \`flatbot init\` here, or cd to your flatbot directory.`);
    throw e;
  }
}

/** Same numbers /stats reports — via the same collector, so the two can never drift — plus the
 *  two knobs that explain a quiet bot. */
export function statusText(db: Db): string {
  const stats = collectStats(db, new Date(Date.now() - 7 * 86_400_000).toISOString());
  return [
    `mode: ${db.getMeta('mode') ?? 'shadow'}${db.getMeta('paused') === '1' ? ' (paused)' : ''}`,
    `watermark: ${db.getMeta('watermark') ?? '0'}`,
    `last 7d: ${fmtStats(stats)}`,
  ].join('\n');
}

export function buildConfigYaml(a: {
  maxWarmRent: number; minSqm: number; rooms: [number, number]; city: string;
  preferences: string; profile: string; fredyDbPath: string;
}): string {
  return stringify({
    hard: {
      maxWarmRent: a.maxWarmRent, minSqm: a.minSqm, minRooms: a.rooms[0], maxRooms: a.rooms[1],
      city: a.city, districtBlocklist: [], stalenessCutoffHours: 24,
    },
    thresholds: { apply: 75, ask: 50 },
    preferences: a.preferences,
    profile: a.profile,
    platforms: ['immoscout', 'kleinanzeigen', 'wggesucht', 'immowelt'],
    llm: { provider: 'claude-cli' },
    fredyDbPath: a.fredyDbPath,
    dbPath: './flatbot.sqlite',
  });
}

/**
 * Park the watermark at Fredy's current max rowid so the first `run` starts from *new*
 * listings. Without it, setup pays for LLM calls on the whole backlog (~150 listings).
 */
export function seedWatermark(db: Db, fredyDbPath: string): number {
  const { maxRowId } = fetchNewListings(fredyDbPath, 0);
  db.setMeta('watermark', String(maxRowId));
  return maxRowId;
}

/** Chat id from a getUpdates body — newest update wins, whatever kind it is. */
export function newestChatId(body: any): string | undefined {
  for (const u of [...(body?.result ?? [])].reverse()) {
    const id = (u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member ?? u.callback_query?.message)
      ?.chat?.id;
    if (id != null) return String(id);
  }
  return undefined;
}

// Response is structurally typed so tests can pass a plain stub instead of a real fetch.
type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ json(): Promise<any> }>;

/** A connection that is accepted and never answered would otherwise hang `doctor`, `chatid`, or
 *  — worse — a beat of the run loop, for as long as the socket stays open. */
const bounded = () => ({ signal: AbortSignal.timeout(20_000) });

async function telegramApi(token: string, method: string, get: Fetcher = fetch): Promise<any> {
  const body = await (await get(`https://api.telegram.org/bot${token}/${method}`, bounded())).json();
  if (!body?.ok) throw new Error(body?.description ?? `getUpdates failed: ${JSON.stringify(body)}`);
  return body;
}

/** Token without config.yaml: `init` writes .env before the config exists. */
function envToken(dir = process.cwd()): string {
  const envFile = join(dir, '.env');
  const token = process.env.TELEGRAM_BOT_TOKEN ??
    (existsSync(envFile) ? readFileSync(envFile, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.*)$/m)?.[1].trim() : undefined);
  if (!token) throw new Error('No TELEGRAM_BOT_TOKEN in the environment or .env — run `flatbot init` first.');
  return token;
}

export const KEEPALIVE = `Keep it running after a reboot — pick your platform:

  macOS / Linux (simplest, needs pm2):
    npm i -g pm2 && pm2 start "$(which node)" --name flatbot -- $(pwd)/dist/index.js run && pm2 save && pm2 startup

  macOS (no pm2): write a launchd job at ~/Library/LaunchAgents/com.flatbot.plist
    with ProgramArguments [<node>, <this dir>/dist/index.js, run],
    WorkingDirectory <this dir>, RunAtLoad and KeepAlive true, then:
    launchctl load ~/Library/LaunchAgents/com.flatbot.plist

  Linux (no pm2): write a systemd unit at ~/.config/systemd/user/flatbot.service
    with ExecStart=<node> <this dir>/dist/index.js run,
    WorkingDirectory=<this dir>, Restart=always, then:
    systemctl --user enable --now flatbot

  Windows: schtasks /create /tn flatbot /sc onstart /tr "cmd /c cd /d <this dir> && node dist\\index.js run"

  <this dir> is your flatbot checkout, and it is not optional: flatbot reads
  config.yaml from the working directory. launchd starts agents at /, systemd
  user units at $HOME and schtasks at %SystemRoot%\\system32, so a service
  without it dies immediately with ENOENT. (pm2 records the directory you
  started it from, which is why its line does not need one.)
`;

const FREDY_STEPS = `Fredy setup (flatbot reads Fredy's db, it does not scrape):
  1. Run Fredy and create a job with your search URLs for the portals you want.
  2. Turn ON provider_details enrichment for immoscout in Fredy (job settings in the
     Fredy UI / API). Without it immoscout rows arrive with an empty description and
     the judge and the letter have almost nothing to work with.
  3. Let Fredy run once, then check flatbot with: flatbot doctor
`;

export type DoctorDeps = { dir?: string; fetch?: Fetcher; llm?: (cfg: Config['llm'], prompt: string) => Promise<string> };

/** PATH lookup without a shell — `doctor` has to work the same on every platform. */
function resolveBin(name: string): string | undefined {
  // an override (FLATBOT_BROWSERUSE_BIN, a wrapper script) is usually a path, and a path is never
  // on PATH — reporting it missing would be doctor lying about a perfectly good setup.
  if (/[/\\]/.test(name)) return existsSync(name) ? name : undefined;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of (process.env.PATH ?? '').split(delimiter))
    for (const ext of exts)
      if (d && existsSync(join(d, name + ext))) return join(d, name + ext);
  return undefined;
}

/** Where patchright's `channel: 'chrome'` looks: it drives the real Chrome, not a bundled build. */
const CHROME_PATHS: Record<string, string[]> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
};

const cdpUrl = (): string =>
  process.env.FLATBOT_CDP_ENDPOINT ?? `http://127.0.0.1:${process.env.FLATBOT_CDP_PORT ?? 9222}`;

/** Auto mode is runtime state, not config: the send-path checks only bite once it is on. */
function isAuto(cfg: Config | undefined): boolean {
  if (!cfg || !existsSync(cfg.dbPath)) return false;
  const db = openDb(cfg.dbPath);
  try {
    return db.getMeta('mode') === 'auto';
  } finally {
    db.close();
  }
}

/** Every check runs even after an earlier one fails — one pass should show every problem. */
export async function doctor(deps: DoctorDeps = {}): Promise<{ lines: string[]; ok: boolean }> {
  const dir = deps.dir ?? process.cwd();
  const get = deps.fetch ?? fetch;
  const llm = deps.llm ?? runLLM;
  const lines: string[] = [];
  let ok = true;
  // A check that returns a "skipped …" line is neither green nor a failure: shadow mode does
  // not need a browser, and reporting one as broken would train the user to ignore doctor.
  const check = async (name: string, fn: () => string | Promise<string>) => {
    try {
      const line = await fn();
      lines.push(`${line.startsWith('skipped') ? '⏭️' : '✅'} ${name}: ${line}`);
    } catch (e) {
      ok = false;
      lines.push(`❌ ${name}: ${(e as Error).message}`);
    }
  };

  await check('node >= 22', () => {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`have ${process.versions.node}`);
    return process.versions.node;
  });

  let cfg: Config | undefined;
  await check('config', () => {
    cfg = loadConfigHere(dir);
    return `${cfg.platforms.length} platforms, thresholds ${cfg.thresholds.apply}/${cfg.thresholds.ask}`;
  });
  const need = (): Config => {
    if (!cfg) throw new Error('skipped — config did not load');
    return cfg;
  };

  await check('fredy db', () => {
    const path = need().fredyDbPath;
    try {
      return `${fetchNewListings(path, 0).listings.length} rows at ${path}`;
    } catch (e) {
      throw new Error(`cannot read ${path} (${(e as Error).message}) — point fredyDbPath in config.yaml at Fredy's listings.db`);
    }
  });
  await check('flatbot db dir', () => {
    const parent = dirname(need().dbPath);
    mkdirSync(parent, { recursive: true });
    return parent;
  });
  await check('telegram', async () => `@${(await telegramApi(need().telegram.token, 'getMe', get)).result?.username}`);
  await check('llm', async () => {
    try {
      const reply = await llm(need().llm, 'Reply with the word pong');
      if (!/pong/i.test(reply)) throw new Error(`no "pong" in reply: ${reply.slice(0, 80)}`);
      return 'pong';
    } catch (e) {
      const fix = need().llm.provider === 'claude-cli'
        ? 'run `claude -p hi` by hand — the CLI has to be installed and logged in'
        : 'check llm.baseUrl, llm.model and the API key env var';
      throw new Error(`${(e as Error).message} — ${fix}`);
    }
  });

  // Everything below is what `/auto` needs and shadow mode does not.
  const auto = isAuto(cfg);
  const skip = 'skipped — shadow mode; needed once you send /auto';

  await check('chrome', () => {
    if (!auto) return skip;
    const found = (CHROME_PATHS[process.platform] ?? []).find(existsSync)
      ?? resolveBin('google-chrome') ?? resolveBin('chrome');
    if (!found) throw new Error('no Google Chrome found — install it from https://google.com/chrome; the stealth browser drives the real one');
    return found;
  });

  await check('cdp endpoint', async () => {
    if (!auto) return skip;
    try {
      const v = await (await get(`${cdpUrl()}/json/version`, bounded())).json();
      // flatbot only ever drives a browser it started itself, so this is either its own running
      // browser (fine) or something in the way of the next `flatbot run` (not fine, and loud then).
      return `${cdpUrl()} — ${v?.Browser ?? 'reachable'}; if that is not flatbot's own browser, \`flatbot run\` will refuse the port`;
    } catch {
      return `${cdpUrl()} — idle; \`flatbot run\` starts its own browser on the first send`;
    }
  });

  await check('sender tooling', () => {
    if (!auto) return skip;
    const backend = need().sender?.backend ?? 'claude-agent';
    // `uvx` on PATH is not a working browser-use setup: flatbot invokes the CLI with
    // --prompt-file/--user-data-dir/--model and browser-use's own CLI takes none of them, so
    // without a wrapper every send fails at runtime with a bare CLI error. Fail here instead.
    if (backend === 'browser-use' && !process.env.FLATBOT_BROWSERUSE_BIN)
      throw new Error('sender.backend is browser-use but FLATBOT_BROWSERUSE_BIN is unset — the published browser-use CLI does not accept flatbot\'s --prompt-file/--user-data-dir/--model, so every send would fail. Point it at a wrapper script (docs/deploy-laptop.md), or use the claude-agent backend.');
    const bins = backend === 'browser-use'
      ? [process.env.FLATBOT_BROWSERUSE_BIN!]
      : [process.env.FLATBOT_CLAUDE_BIN ?? 'claude', 'npx'];
    const missing = bins.filter((b) => !resolveBin(b));
    if (missing.length)
      throw new Error(`not on PATH: ${missing.join(', ')} — the ${backend} backend spawns them for every send`);
    return `${backend} → ${bins.join(', ')}`;
  });

  await check('portal sessions', () => {
    if (!auto) return skip;
    const profileDir = need().sender?.profileDir;
    if (!profileDir || !existsSync(profileDir) || !readdirSync(profileDir).length)
      throw new Error(`no browser profile at ${profileDir} — run \`flatbot login\` once per portal so the sender is logged in`);
    return profileDir;
  });

  return { lines, ok };
}

export type InitDeps = { dir?: string; ask?: (q: string, dflt?: string) => Promise<string>;
  log?: (line: string) => void; fetch?: Fetcher };

export async function cmdInit(deps: InitDeps = {}): Promise<void> {
  const dir = deps.dir ?? process.cwd();
  const log = deps.log ?? console.log;
  const get = deps.fetch ?? fetch;

  // Re-running init on a tuned install would wipe preferences and re-park the watermark,
  // silently skipping every listing collected since.
  if (existsSync(join(dir, 'config.yaml')))
    throw new Error(`config.yaml already exists in ${dir} — init would overwrite it and re-park the watermark.
Edit config.yaml directly, or move it aside first if you really do want to start over.`);

  const rl = deps.ask ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  const ask = deps.ask ?? (async (q: string, dflt = ''): Promise<string> =>
    (await rl!.question(dflt ? `${q} [${dflt}]: ` : `${q}: `)).trim() || dflt);
  const askNum = async (q: string): Promise<number> => {
    for (;;) {
      const n = Number(await ask(q));
      if (Number.isFinite(n)) return n;
      log('  numbers only, please.');
    }
  };
  try {
    log('\nflatbot setup\n\n1. Telegram bot: open @BotFather, send /newbot, follow the prompts.');
    const token = await ask('Paste the bot token here');
    // Written before the chat-id step so the documented `flatbot chatid` fallback works *now*.
    writeFileSync(join(dir, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`);

    log('\n2. Open a chat with your new bot and send it any message ("hi").');
    await ask('   Press enter when you have done that');
    let chatId: string | undefined;
    try {
      chatId = newestChatId(await telegramApi(token, 'getUpdates', get));
    } catch (e) {
      // A typo'd token 401s here. Without this the wizard blames Telegram for a typo.
      log(`   Telegram rejected that token: ${(e as Error).message}`);
    }
    if (chatId) log(`   Found chat id ${chatId}.`);
    else chatId = await ask('   No chat id yet. Type your chat id manually (or fix the token and re-run init)');
    writeFileSync(join(dir, '.env'), `TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_CHAT_ID=${chatId}\n`);

    log('\n3. What are you looking for?');
    const maxWarmRent = await askNum('   Max warm rent in EUR');
    const minSqm = await askNum('   Minimum size in m²');
    const rooms: [number, number] = [await askNum('   Minimum rooms'), await askNum('   Maximum rooms')];
    const city = await ask('   City');
    const preferences = await ask("   Describe what you want, like you'd tell a friend");
    const profile = await ask('   Describe yourself as a tenant — job, income situation, pets, smoker?');

    let fredyDbPath = '';
    while (!fredyDbPath) {
      const p = await ask("\n4. Path to Fredy's listings db", '../fredy/db/listings.db');
      if (existsSync(join(dir, p))) fredyDbPath = p;
      else log(`   No file at ${join(dir, p)} — check the path.`);
    }

    writeFileSync(join(dir, 'config.yaml'),
      buildConfigYaml({ maxWarmRent, minSqm, rooms, city, preferences, profile, fredyDbPath }));
    const cfg = loadConfig(dir);
    const db = openDb(cfg.dbPath);
    // Start from now: without this the first run judges Fredy's entire backlog.
    const wm = seedWatermark(db, cfg.fredyDbPath);
    db.close();

    log(`\nWrote config.yaml and .env. Watermark parked at Fredy row ${wm} — only new listings from here.\n`);
    log(FREDY_STEPS);
    log(KEEPALIVE);
  } finally {
    rl?.close();
  }
}

export type LoopDeps = { cfg: Config; db: Db; notify: Notifier;
  llm: (prompt: string) => Promise<string>; backend?: SendBackend;
  launch?: (dir: string, opts: { headed: boolean }) => Promise<Profile> };

/**
 * One beat of `flatbot run`: poll and judge, then — in auto mode only — one send, then the
 * weekly distillation. Every stage is caught: a dead portal, backend or disk must not stop the
 * interval. Building it also settles the leases the previous process died holding.
 * `shutdown` closes the browser the sends were driven through.
 */
export function makeLoop(d: LoopDeps): { poll: () => Promise<void>; shutdown: () => Promise<void> } {
  const stale = recoverStaleSending(d.db, d.notify);
  if (stale) console.error(`${stale} listing(s) were interrupted mid-send — handed back for a manual check`);

  // A send waits 2-8 minutes while the loop keeps ticking every 60s; without this the beats
  // would overlap and the pacing the delay exists for would be gone.
  let sending = false;
  const oops = (what: string) => (e: unknown) => console.error(`${what} failed: ${String(e)}`);

  // claude-agent attaches over CDP to a browser somebody else has to keep alive — nothing did,
  // so every auto send failed. Launch it lazily (first send only), reuse it, close it on exit.
  // browser-use launches its own from the same profile dir, so a second one would fight it.
  const launch = d.launch ?? launchProfile;
  const wantsCdp = !!d.cfg.sender && d.cfg.sender.backend !== 'browser-use';
  let browser: Profile | undefined;
  let warned = false;
  const cdpEndpoint = async (): Promise<string> => {
    // A browser that died since the last send (crash, user quit, OOM) is a handle that never
    // clears itself: without this every later send fails on a dead address until flatbot restarts.
    if (browser && !(await browser.alive())) {
      const dead = browser;
      browser = undefined;
      await dead.close().catch(() => {});
    }
    try {
      browser ??= await launch(d.cfg.sender!.profileDir, { headed: false });
    } catch (e) {
      if (!warned) { // one message per process, not one per beat
        warned = true;
        void d.notify.text(`⚠️ auto mode cannot send: no browser to drive.\n${(e as Error).message}\n` +
          'Install Google Chrome (the stealth browser drives the real one) and restart flatbot. ' +
          'Nothing was sent; the listings are still queued.').catch(() => {});
      }
      throw e;
    }
    return browser.cdpEndpoint;
  };

  const poll = async (): Promise<void> => {
    await tick(d).catch(oops('tick'));
    if (d.backend && !sending && d.db.getMeta('mode') === 'auto') {
      sending = true;
      await senderTick({ cfg: d.cfg, db: d.db, backend: d.backend, notify: d.notify,
        ...(wantsCdp ? { cdpEndpoint } : {}) })
        .catch(oops('sender'))
        .finally(() => { sending = false; });
    }
    await maybeDistill(d).catch(oops('distillation'));
  };

  const shutdown = async (): Promise<void> => {
    // A send in flight is in its own process group (that is what makes the timeout kill work), so
    // Ctrl-C never reaches it: without this, `claude` → `npx @playwright/mcp` → Chrome outlive us.
    killLiveSubprocesses();
    const b = browser;
    browser = undefined;
    await b?.close().catch(oops('browser close'));
  };
  return { poll, shutdown };
}

/**
 * Re-arms only once the beat finishes. `setInterval` would stack them: a beat routinely runs
 * longer than the interval (two LLM calls each for several listings, or a 2-8 minute send delay),
 * and overlapping beats re-judge the same listings and race each other's status writes.
 *
 * Which makes one beat that never resolves fatal: polling stops for good while Telegram keeps
 * answering commands, the most confusing possible failure. Subprocesses and fetches are all
 * bounded now, but `launchPersistentContext` is not, so the watchdog stops waiting after
 * `timeoutMs` and lets the next beat start. Comfortably longer than the 2-8 minute send delay a
 * healthy beat spends asleep.
 */
export function startBeat(poll: () => Promise<void>, ms = 60_000, timeoutMs = 20 * 60_000): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const beat = async (): Promise<void> => {
    // the catch is attached to poll()'s own promise, so a beat we walked away from cannot come
    // back later as an unhandled rejection
    const running = poll().catch((e) => console.error(`beat failed: ${String(e)}`));
    let watchdog: NodeJS.Timeout | undefined;
    await Promise.race([running, new Promise<void>((r) => {
      watchdog = setTimeout(() => {
        console.error(`beat still running after ${timeoutMs}ms — starting the next one anyway`);
        r();
      }, timeoutMs);
    })]);
    clearTimeout(watchdog);
    if (!stopped) timer = setTimeout(() => void beat(), ms);
  };
  void beat();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function cmdRun(): void {
  const cfg = loadConfigHere();
  const db = openDb(cfg.dbPath);
  const { bot, notifier } = createBot(cfg, db);
  // long-polls forever; awaiting it would block the ticker, but an unhandled rejection out of
  // grammY's default error handler would take the whole process down with it.
  bot.start().catch((e) => console.error(`telegram polling stopped: ${String(e)}`));

  const backend = cfg.sender &&
    (cfg.sender.backend === 'browser-use' ? browserUseBackend(cfg) : claudeAgentBackend(cfg));
  const { poll, shutdown } = makeLoop({ cfg, db, notify: notifier, llm: (p) => runLLM(cfg.llm, p), backend });
  const stopBeat = startBeat(poll);

  // systemd stops services with SIGTERM; without it the browser this process launched leaks.
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      stopBeat();
      void (async () => {
        await bot.stop().catch(() => {});
        await shutdown();
        db.close();
        process.exit(0);
      })();
    });
  console.log(`flatbot running — ${statusText(db)}`);
}

export type LoginDeps = {
  cfg: Config;
  launch: (dir: string, opts: { headed: boolean; url?: string }) => Promise<{ close(): Promise<void> }>;
  waitForEnter: () => Promise<void>;
  log?: (line: string) => void;
};

/**
 * One-time login per portal: a headed browser on the shared profile, the user types their
 * password, and the cookies stay in profileDir for every later headless send.
 */
export async function cmdLogin(platform: string | undefined, deps: LoginDeps): Promise<void> {
  const { cfg, launch, waitForEnter, log = console.log } = deps;
  const specs = platform
    ? [platformFor(platform) ?? raise(`Unknown platform ${platform} — try one of: ${PLATFORMS.map((p) => p.id).join(', ')}`)]
    : (cfg.platforms.length ? cfg.platforms : PLATFORMS.map((p) => p.id)).map(platformFor).filter((p) => !!p);
  const profileDir = cfg.sender?.profileDir ?? './browser-profile';

  for (const spec of specs) {
    log(`\n${spec.displayName}: opening ${spec.loginUrl}`);
    const session = await launch(profileDir, { headed: true, url: spec.loginUrl });
    try {
      log('   log in, then press Enter here.');
      await waitForEnter();
    } finally {
      await session.close(); // the profile is only written out when the context closes
    }
  }
  log(`\nSessions saved in ${profileDir}.`);
}

function raise(msg: string): never {
  throw new Error(msg);
}

async function cmdDryrun(url: string): Promise<void> {
  const cfg = loadConfigHere();
  const db = openDb(cfg.dbPath);
  try {
    const row = db.findByUrl(url);
    if (!row) {
      console.error(`No listing with url ${url} in ${cfg.dbPath} — dryrun only re-judges listings flatbot already saw.`);
      process.exitCode = 1;
      return;
    }
    const verdict = parseVerdict(
      await runLLM(cfg.llm, buildJudgePrompt(row, cfg, db.recentFeedback(20), readLearned(cfg))),
      cfg.thresholds,
    );
    console.log(`${row.title}\n${row.url}\n`);
    console.log(`score ${verdict.score} → ${verdict.decision}${verdict.scam ? ' (possible scam)' : ''}\n${verdict.reasons}\n`);
    if (verdict.decision === 'skip') return;
    console.log(parseLetter(await runLLM(cfg.llm, buildLetterPrompt(row, cfg))));
  } finally {
    db.close(); // nothing above writes: a dryrun must not move the real run's state
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case 'run':
      return cmdRun();
    case 'status': {
      const db = openDb(loadConfigHere().dbPath);
      console.log(statusText(db));
      db.close();
      return;
    }
    case 'init':
      return cmdInit();
    case 'login':
      return cmdLogin(arg, {
        cfg: loadConfigHere(),
        launch: launchProfile,
        waitForEnter: async () => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try { await rl.question(''); } finally { rl.close(); }
        },
      });
    case 'doctor': {
      const { lines, ok } = await doctor();
      console.log(lines.join('\n'));
      if (!ok) process.exitCode = 1;
      return;
    }
    case 'chatid': {
      const id = newestChatId(await telegramApi(envToken(), 'getUpdates'));
      if (id) console.log(id);
      else {
        console.error('No chat id yet — message your bot once, then run this again.');
        process.exitCode = 1;
      }
      return;
    }
    case 'dryrun':
      if (!arg) {
        console.error('usage: flatbot dryrun <url>');
        process.exitCode = 1;
        return;
      }
      return cmdDryrun(arg);
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

/** Only run as the actual CLI entry — importing this file (tests) must have no side effects. */
function isEntryPoint(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint())
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
