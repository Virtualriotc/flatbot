#!/usr/bin/env node
// Stands in for the `claude` binary in sender tests: records how it was invoked, echoes canned JSON.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const i = process.argv.indexOf('--mcp-config');
if (process.env.FAKE_SENTINEL)
  appendFileSync(process.env.FAKE_SENTINEL,
    JSON.stringify(process.argv.slice(2)) + '\n' + (i > 0 ? readFileSync(process.argv[i + 1], 'utf8') : '') + '\n');

// what the child was actually handed: its working directory and the secrets it can read out of env
if (process.env.FAKE_ENV_SINK)
  writeFileSync(process.env.FAKE_ENV_SINK, JSON.stringify({ cwd: process.cwd(), env: process.env }));

// the prompt arrives on stdin (never argv — a Windows shell cannot carry a multi-line prompt)
if (process.env.FAKE_STDIN_SINK) {
  let buf = '';
  for await (const c of process.stdin) buf += c;
  writeFileSync(process.env.FAKE_STDIN_SINK, buf);
}

// A real agent writes the screenshot the prompt mandated; FAKE_SHOT is that path when it should.
if (process.env.FAKE_SHOT) writeFileSync(process.env.FAKE_SHOT, 'png');

console.log(process.env.FAKE_SEND_REPLY ??
  '{"sent": true, "confirmed": true, "paywalled": false, "screenshot": "/tmp/shot.png", "note": "Nachricht gesendet"}');

// a crash *after* the form went through must not be reported as "not sent"
if (process.env.FAKE_EXIT_CODE) process.exit(Number(process.env.FAKE_EXIT_CODE));
