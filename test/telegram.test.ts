import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import { collectStats, createBot, fmtAsk, fmtReceipt, fmtStats, listingIdFromReply } from '../src/telegram.js';
const row = { id: 'a1', title: '2-Zi Fhain', url: 'https://x/1', price: 950, size: 52, rooms: 2,
  address: 'Friedrichshain', score: 78, reasons: 'near office', status: 'asked' } as any;

const CHAT = 42;

/** A real bot with its network layer replaced: every api call is recorded, none leaves.
 *  `failMethod` makes that one api method reject the way Telegram rejects it for real. */
function harness(status = 'asked', mode?: string, failMethod?: string) {
  const db: Db = openDb(join(mkdtempSync(join(tmpdir(), 'fb-tg-')), 't.sqlite'));
  db.upsertListing({ ...row, platform: 'immoscout', description: null, imageUrls: [],
    discoveredAt: new Date().toISOString() });
  db.setDecision('a1', { status, letter: 'Anschreiben' });
  if (mode) db.setMeta('mode', mode);

  const { bot, notifier } = createBot({ telegram: { token: '1:fake', chatId: String(CHAT) } } as Config, db);
  bot.botInfo = { id: 1, is_bot: true, first_name: 'flatbot', username: 'flatbot',
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } as any;
  const sent: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    if (method === failMethod) throw new Error('Bad Request: query is too old');
    return { ok: true, result: true } as any;
  });
  return { db, bot, notifier, sent };
}

const chat = { id: CHAT, type: 'private' as const };
const command = (text: string): any => ({ update_id: 1,
  message: { message_id: 1, date: 0, chat, text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } });
const verdict = (data: string): any => ({ update_id: 2,
  callback_query: { id: 'cb1', from: { id: 7, is_bot: false, first_name: 'v' }, chat_instance: 'ci', data,
    message: { message_id: 9, date: 0, chat, text: `ask\n#a1` } } });

test('/auto and /shadow flip the mode and say so in one line', async () => {
  const h = harness();
  await h.bot.handleUpdate(command('/auto'));
  expect(h.db.getMeta('mode')).toBe('auto');
  expect(h.sent.at(-1)!.payload.text).toBe('mode: auto');

  await h.bot.handleUpdate(command('/shadow'));
  expect(h.db.getMeta('mode')).toBe('shadow');
  expect(h.sent.at(-1)!.payload.text).toBe('mode: shadow');
});

// C3(b): the sender only treats `approved` rows as sendable when they were approved after the
// flip. /shadow must clear the stamp, or a second /auto would re-open the first window's backlog.
test('/auto stamps autoSince and /shadow clears it', async () => {
  const h = harness();
  await h.bot.handleUpdate(command('/auto'));
  const first = h.db.getMeta('autoSince')!;
  expect(Number.isNaN(Date.parse(first))).toBe(false);

  await h.bot.handleUpdate(command('/shadow'));
  expect(h.db.getMeta('autoSince')).toBe(''); // senderTick reads empty and absent alike

  await h.bot.handleUpdate(command('/auto'));
  const second = h.db.getMeta('autoSince')!;
  expect(second).not.toBe('');
  expect(second >= first).toBe(true);
});

test('✅ approves in shadow mode and queues for the sender in auto mode', async () => {
  const shadow = harness('asked', 'shadow');
  await shadow.bot.handleUpdate(verdict('ok:a1'));
  expect(shadow.db.getListing('a1')!.status).toBe('approved');

  const auto = harness('asked', 'auto');
  await auto.bot.handleUpdate(verdict('ok:a1'));
  expect(auto.db.getListing('a1')!.status).toBe('queued');
});

test('❌ rejects in either mode', async () => {
  const h = harness('asked', 'auto');
  await h.bot.handleUpdate(verdict('no:a1'));
  expect(h.db.getListing('a1')!.status).toBe('rejected');
});

// The buttons stay on old messages forever; tapping one must never re-open a decided listing
// (worst case: re-queueing something already sent, i.e. a duplicate application).
test('the buttons are inert once the listing is past deciding', async () => {
  for (const status of ['queued', 'sending', 'sent', 'failed', 'fallback_manual', 'rejected']) {
    const h = harness(status, 'auto');
    await h.bot.handleUpdate(verdict('ok:a1'));
    expect(h.db.getListing('a1')!.status).toBe(status);
    const answer = h.sent.find((s) => s.method === 'answerCallbackQuery')!;
    expect(answer.payload.text).toBe(`already ${status}`);
  }
});

test('a real send receipt has no verdict buttons; a shadow receipt keeps them', async () => {
  const h = harness('sent');
  await h.notifier.receipt({ ...row, status: 'sent' });
  expect(h.sent.at(-1)!.payload.reply_markup).toBeUndefined();
  expect(h.sent.at(-1)!.payload.text).toContain('Sent —');

  await h.notifier.receipt({ ...row, status: 'asked' });
  expect(h.sent.at(-1)!.payload.reply_markup).toBeDefined();
});

test('notifier.text sends free text, buttonless, to the owner chat', async () => {
  const h = harness();
  await h.notifier.text('📮 manual send needed\n#a1');
  expect(h.sent.at(-1)!.payload).toMatchObject({ chat_id: String(CHAT), text: '📮 manual send needed\n#a1' });
  expect(h.sent.at(-1)!.payload.reply_markup).toBeUndefined();
});

test('ask is one terse block ending in #id', () => {
  const m = fmtAsk(row);
  expect(m).toContain('78'); expect(m).toContain('950'); expect(m).toContain('https://x/1');
  expect(m.endsWith('#a1')).toBe(true); expect(m.split('\n').length).toBeLessThanOrEqual(4);
});

test('receipt marks shadow, but a real send is labelled sent', () => {
  expect(fmtReceipt(row)).toContain('shadow');
  const done = fmtReceipt({ ...row, status: 'sent' });
  expect(done).toContain('Sent —');
  expect(done).not.toContain('shadow');
  expect(done.endsWith('#a1')).toBe(true);
});

test('reply mapping parses trailer', () => {
  expect(listingIdFromReply('anything\n#a1')).toBe('a1');
  expect(listingIdFromReply('no trailer')).toBeNull();
  expect(listingIdFromReply(undefined)).toBeNull();
});

test('stats is one line with every count', () => {
  const s = fmtStats({ found: 12, asked: 5, approved: 2, skipped: 7 });
  expect(s.split('\n')).toHaveLength(1);
  for (const n of ['12', '5', '2', '7']) expect(s).toContain(n);
});

// In auto mode the only number that says whether the bot is doing its job is how many
// applications actually went out; db.stats() has no bucket for it.
test('stats reports sends, manual fallbacks and failures', () => {
  const s = fmtStats({ found: 12, asked: 5, approved: 2, skipped: 7, sent: 3, fallback: 1, failed: 2 });
  expect(s.split('\n')).toHaveLength(1);
  expect(s).toMatch(/sent 3/);
  expect(s).toMatch(/manual 1/);
  expect(s).toMatch(/failed 2/);
});

test('collectStats counts the send outcomes inside the window and nothing outside it', () => {
  const db: Db = openDb(join(mkdtempSync(join(tmpdir(), 'fb-stats-')), 't.sqlite'));
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const add = (id: string, status: string, ageDays = 0) => {
    db.upsertListing({ ...row, id, platform: 'immoscout', description: null, imageUrls: [],
      discoveredAt: new Date(Date.now() - ageDays * 86_400_000).toISOString() });
    db.setDecision(id, { status });
  };
  add('s1', 'sent'); add('s2', 'sent'); add('f1', 'fallback_manual'); add('x1', 'failed');
  add('a1', 'asked'); add('old', 'sent', 30);

  const s = collectStats(db, since);
  expect(s).toMatchObject({ sent: 2, fallback: 1, failed: 1, asked: 1 });
  expect(fmtStats(s)).toContain('sent 2');
});

// C4: grammY's default handler stops polling and rethrows, the rejection escapes bot.start(),
// and the unconfirmed update is redelivered straight back into the same crash on restart.
test('a failing Telegram call is contained instead of killing the bot', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const h = harness('asked', 'auto', 'answerCallbackQuery');

  // handleUpdates is what the polling loop calls, and the only place bot.catch is consulted.
  await expect(h.bot.handleUpdates([verdict('ok:a1')])).resolves.toBeUndefined();

  expect(log).toHaveBeenCalled();
  expect(h.db.getListing('a1')!.status).toBe('queued'); // the decision still landed
  log.mockRestore();
});

// I14: the chat-id lockout is the reason a leaked bot token alone is not a working bot.
test('an update from another chat is ignored entirely', async () => {
  const h = harness('asked', 'auto');
  const other = { id: 999, type: 'private' as const };
  await h.bot.handleUpdate({ update_id: 3, message: { message_id: 1, date: 0, chat: other,
    text: '/auto', entities: [{ type: 'bot_command', offset: 0, length: 5 }] } } as any);
  await h.bot.handleUpdate({ update_id: 4, callback_query: { id: 'cb2',
    from: { id: 7, is_bot: false, first_name: 'v' }, chat_instance: 'ci', data: 'ok:a1',
    message: { message_id: 9, date: 0, chat: other, text: 'ask\n#a1' } } } as any);

  expect(h.sent).toHaveLength(0);
  expect(h.db.getMeta('mode')).toBe('auto');            // /auto from the stranger changed nothing
  expect(h.db.getListing('a1')!.status).toBe('asked');  // and ✅ did not queue a real application
});

test('an update with no chat at all is dropped', async () => {
  const h = harness();
  await h.bot.handleUpdate({ update_id: 5, callback_query: { id: 'cb3',
    from: { id: 7, is_bot: false, first_name: 'v' }, chat_instance: 'ci', data: 'ok:a1' } } as any);
  expect(h.sent).toHaveLength(0);
  expect(h.db.getListing('a1')!.status).toBe('asked');
});

test('the configured chat still works', async () => {
  const h = harness();
  await h.bot.handleUpdate(command('/pause'));
  expect(h.db.getMeta('paused')).toBe('1');
  expect(h.sent.at(-1)!.payload.text).toBe('paused');
});

test('/status on an unknown id says so instead of swallowing the note', async () => {
  const h = harness();
  await h.bot.handleUpdate(command('/status nope viewing friday'));
  expect(h.sent.at(-1)!.payload.text).not.toContain('noted');
  expect(h.sent.at(-1)!.payload.text).toContain('nope');

  await h.bot.handleUpdate(command('/status a1 viewing friday'));
  expect(h.sent.at(-1)!.payload.text).toBe('noted #a1');
  expect(h.db.getListing('a1')!.statusNote).toBe('viewing friday');
});

test('the keyboard is taken away once a verdict is recorded', async () => {
  const h = harness('asked', 'shadow');
  await h.bot.handleUpdate(verdict('ok:a1'));
  const edit = h.sent.find((s) => s.method === 'editMessageReplyMarkup');
  expect(edit).toBeDefined();
  expect(edit!.payload.reply_markup).toBeUndefined();
  expect(edit!.payload.message_id).toBe(9);
});

// /start is the first message a new user sends, and the text handler drops anything with a "/".
test('/start and /help answer with the real commands', async () => {
  for (const cmd of ['/start', '/help']) {
    const h = harness();
    await h.bot.handleUpdate(command(cmd));
    const text = h.sent.at(-1)!.payload.text as string;
    for (const c of ['/stats', '/pause', '/resume', '/auto', '/shadow', '/status']) expect(text).toContain(c);
  }
});
