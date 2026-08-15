import { expect, test } from 'vitest';
import { buildLetterPrompt, parseLetter } from '../src/writer.js';

test('prompt carries profile, flat specifics, no-invention rule', () => {
  const p = buildLetterPrompt({ title: 'Helle 2-Zi Altbau', description: 'Balkon Süd' } as any,
    { profile: 'PROFILETEXT' } as any);
  for (const s of ['PROFILETEXT', 'Helle 2-Zi Altbau', 'not in the profile']) expect(p).toContain(s);
});

const body = 'Sehr geehrte Damen und Herren, '.repeat(12);

test('parseLetter strips fences and rejects placeholders', () => {
  expect(parseLetter('```\n' + body + '\n```')).toMatch(/^Sehr/);
  expect(() => parseLetter('Hallo [Vermieter], kurz.')).toThrow();
});

test('an LLM preamble and afterword never reach the landlord', () => {
  // `claude -p` routinely writes "Here is the letter:" before the fence and a closing remark after
  const out = parseLetter(`Here is the Anschreiben you asked for:\n\n\`\`\`text\n${body}\n\`\`\`\n\nLet me know if you want it shorter.`);
  expect(out).toMatch(/^Sehr geehrte/);
  expect(out).not.toMatch(/Here is|Let me know|```/);
});

test('an unfenced letter is left exactly as written', () => {
  expect(parseLetter(body)).toBe(body.trim());
});
