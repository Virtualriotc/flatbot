/**
 * The one stealth browser both send backends drive: a persistent profile (the portal sessions
 * the user logged into once) plus the CDP endpoint the backends attach to.
 * patchright is imported dynamically so the rest of flatbot — and its tests — run without it.
 */
export type Profile = { cdpEndpoint: string; alive(): Promise<boolean>; close(): Promise<void> };

/** Fixed port so FLATBOT_CDP_ENDPOINT's default matches. ponytail: a second flatbot on the same
 *  machine needs FLATBOT_CDP_PORT set; pick a free port only if that ever actually happens. */
const port = (): number => Number(process.env.FLATBOT_CDP_PORT ?? 9222);

/** Is a CDP browser answering there? Bounded, because a socket that accepts and never replies
 *  would otherwise hang the whole poll loop. */
export async function cdpAlive(endpoint: string): Promise<boolean> {
  try {
    return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(3_000) })).ok;
  } catch {
    return false;
  }
}

export async function launchProfile(
  profileDir: string,
  opts: { headed: boolean; url?: string },
): Promise<Profile> {
  let chromium;
  try {
    ({ chromium } = await import('patchright'));
  } catch (e) {
    throw new Error(`patchright is not installed — run \`npm install\` in the flatbot directory (${String(e)})`);
  }

  const p = port();
  const endpoint = `http://127.0.0.1:${p}`;
  // Chrome does not fail when the debugging port is already bound — it logs and carries on. Whoever
  // holds it (your own debug Chrome, a Chrome orphaned by an earlier crash) would then be the
  // browser the send agent drives, on somebody else's logged-in session. Refuse instead.
  if (await cdpAlive(endpoint))
    throw new Error(`something is already listening on ${endpoint} — flatbot will not drive a browser it did not start. Close it, or set FLATBOT_CDP_PORT to a free port.`);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: !opts.headed,
    channel: 'chrome',        // patchright's stealth wants real Chrome, not a bundled build
    viewport: null,
    args: [`--remote-debugging-port=${p}`],
  });
  // …and the mirror image: a Chrome that came up without the port is a browser the backend can
  // never attach to, which used to surface as every send failing with a bare connect error.
  for (let i = 0; !(await cdpAlive(endpoint)); i++)
    if (i >= 10) {
      await ctx.close().catch(() => {});
      throw new Error(`Chrome started but nothing answers ${endpoint} — the browser the sender attaches to never came up.`);
    } else await new Promise((r) => setTimeout(r, 300));

  if (opts.url) await (ctx.pages()[0] ?? (await ctx.newPage())).goto(opts.url);

  return { cdpEndpoint: endpoint, alive: () => cdpAlive(endpoint), close: () => ctx.close() };
}
