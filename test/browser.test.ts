import { expect, test } from 'vitest';
import type { Config } from '../src/config.js';
import { cmdLogin } from '../src/index.js';
import { platformFor } from '../src/platforms.js';

/** Records what would have been launched. A real browser never starts in this suite. */
function fakeLauncher() {
  const launched: { dir: string; headed: boolean; url?: string }[] = [];
  let closed = 0;
  return {
    launched, closed: () => closed,
    launch: async (dir: string, opts: { headed: boolean; url?: string }) => {
      launched.push({ dir, ...opts });
      return { cdpEndpoint: 'http://127.0.0.1:9222', close: async () => { closed++; } };
    },
  };
}

const cfg = (platforms: string[]): Config =>
  ({ platforms, sender: { profileDir: '/tmp/profile' } } as Config);

test('login <platform> opens that portal login page in the persistent profile, headed', async () => {
  const f = fakeLauncher();
  let waits = 0;
  await cmdLogin('immoscout', { cfg: cfg(['immoscout', 'wggesucht']), launch: f.launch,
    waitForEnter: async () => { waits++; } });

  expect(f.launched).toEqual([
    { dir: '/tmp/profile', headed: true, url: 'https://sso.immobilienscout24.de/sso/login' },
  ]);
  expect(waits).toBe(1);         // the user logs in by hand between launch and close
  expect(f.closed()).toBe(1);    // the session is only persisted once the context closes
});

test('bare login walks the platforms enabled in config, in order', async () => {
  const f = fakeLauncher();
  await cmdLogin(undefined, { cfg: cfg(['wggesucht', 'immoscout']), launch: f.launch,
    waitForEnter: async () => {} });

  expect(f.launched.map((l) => l.url))
    .toEqual(['wggesucht', 'immoscout'].map((id) => platformFor(id)!.loginUrl));
  expect(f.launched.every((l) => l.dir === '/tmp/profile' && l.headed)).toBe(true);
  expect(f.closed()).toBe(2);
});

test('an unknown platform is a clear error and launches nothing', async () => {
  const f = fakeLauncher();
  await expect(cmdLogin('zillow', { cfg: cfg(['immoscout']), launch: f.launch,
    waitForEnter: async () => {} })).rejects.toThrow(/zillow/);
  expect(f.launched).toEqual([]);
});

// Ctrl-D on the prompt (or a closed stdin) must not leave a headed browser running forever.
test('the browser is closed even when the wait fails', async () => {
  const f = fakeLauncher();
  await expect(cmdLogin('immoscout', { cfg: cfg(['immoscout']), launch: f.launch,
    waitForEnter: async () => { throw new Error('stdin closed'); } })).rejects.toThrow('stdin closed');
  expect(f.closed()).toBe(1);
});
