#!/usr/bin/env node
// echoes a canned reply so tests never touch a real LLM
import { writeFileSync } from 'node:fs';

// the prompt arrives on stdin (never argv — a Windows shell cannot carry a multi-line prompt)
if (process.env.FAKE_STDIN_SINK) {
  let buf = '';
  for await (const c of process.stdin) buf += c;
  writeFileSync(process.env.FAKE_STDIN_SINK, buf);
}

console.log(process.env.FAKE_REPLY ?? `noise before {"score": 80, "decision": "apply", "reasons": "fits", "scam": false} noise after`);
