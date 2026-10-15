import { test, expect, mock } from 'claude-code/testing'
import { uncountedClaim } from './inventory-gate'
import { pastedSource, unsupported, value } from './source-fidelity'

const JD = `<pasted_content id="a1">Director, Model Risk Management. Base salary range $180,000 - $220,000.
Hybrid, 3 days in office. Requires 10+ years in model validation. Posted 2026-10-01.</pasted_content>`

function world(on: any, toolText = 'ok') {
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  mock.clock(on, { now: Date.UTC(2026, 9, 8, 12) })
  on('fs.write', () => ({ value: undefined }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', () => ({ result: { ok: true } as any, text: toolText }))
  on('classic.Stop', () => ({}))
}

// ---- source-fidelity ----

test('source-fidelity matches figures the way people write them', () => {
  expect(value('$185k')).toBe(185000)
  expect(value('180,000')).toBe(180000)
  expect(value('2.5 million')).toBe(2500000)
  expect(value('20%')).toBe(20)
  expect(unsupported('The range is $180k to $220,000, posted 2026-10-01, 10+ years.', JD)).toEqual([])
  expect(unsupported('The bonus is 20% and it starts in 2027.', JD)).toEqual(['20%', '2027'])
  expect(unsupported('Total pay is $250,000, before tax.', JD)).toEqual(['$250,000'])
  expect(pastedSource(JD, 1500)).toContain('Director, Model Risk')
  expect(pastedSource('short question', 1500)).toBeUndefined()
  expect(pastedSource('x'.repeat(1600), 1500)).toHaveLength(1600)
})

test('source-fidelity sends back figures the document never stated', async ($, on) => {
  world(on)
  await $.prompt.submit({ text: `Summarise this role:\n${JD}`, origin: { kind: 'composer' } } as any)
  const r: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Pays $180k-$220k plus a 25% bonus.' } as any)
  expect(String(r.block)).toContain('[source-fidelity]')
  expect(String(r.block)).toContain('25%')
  const again: any = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'Pays $180k-$220k plus a 25% bonus.' } as any)
  expect(again.block).toBeUndefined()
})

test('source-fidelity accepts figures a tool returned and stays out of plain prompts', async ($, on) => {
  world(on, 'Glassdoor: typical bonus 25%')
  await $.prompt.submit({ text: `Summarise this role:\n${JD}`, origin: { kind: 'composer' } } as any)
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'bonus' } as any)
  const r: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Pays $180k-$220k plus a 25% bonus.' } as any)
  expect(r.block).toBeUndefined()
  await $.prompt.submit({ text: 'what is 2 + 2?', origin: { kind: 'composer' } } as any)
  const plain: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'It is 4, as of 2026.' } as any)
  expect(plain.block).toBeUndefined()
})

test('source-fidelity reads the transcript, so a reload mid-session forgets nothing', async ($, on) => {
  const lines = [
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'a portfolio of ~1,200 active models' }] } },
    { type: 'attachment', attachment: { type: 'hook_additional_context', content: 'The floor is $200K' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'I guessed a 35% bonus' }] } },
    { type: 'user', message: { content: 'Stop hook feedback: [source-fidelity] ... figures: $290' } },
  ].map(l => JSON.stringify(l)).join('\n')
  world(on)
  on('fs.read', () => ({ value: lines }))
  await $.prompt.submit({ text: `Draft a note:\n${JD}`, origin: { kind: 'composer' } } as any)
  const ok: any = await $.classic.Stop({ stop_hook_active: false, transcript_path: 'C:/t.jsonl', last_assistant_message: 'You ran ~1,200 models; your floor is $200k.' } as any)
  expect(ok.block).toBeUndefined()
  const bad: any = await $.classic.Stop({ stop_hook_active: false, transcript_path: 'C:/t.jsonl', last_assistant_message: 'Expect a 35% bonus and $290k base.' } as any)
  expect(String(bad.block)).toContain('35%')
  expect(String(bad.block)).toContain('$290k')
})

// ---- inventory-gate ----

test('inventory-gate wants a count behind a full-coverage claim', () => {
  expect(uncountedClaim('I reviewed everything and found no issues.')).toBe(true)
  expect(uncountedClaim('Checked all of the hooks; none fire twice.')).toBe(true)
  expect(uncountedClaim('I reviewed all 14 files and found no issues.')).toBe(false)
  expect(uncountedClaim('Checked 25 of 25 guardrails: every one has a test.')).toBe(false)
  expect(uncountedClaim("I'll check every file next.")).toBe(false)
  expect(uncountedClaim('The tests pass.')).toBe(false)
})

test('inventory-gate sends back an uncounted claim', { options: { sourceFidelity: false } }, async ($, on) => {
  world(on)
  const r: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Audited every repo; all clean.' } as any)
  expect(String(r.block)).toContain('[inventory-gate]')
  const ok: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Audited 9 of 9 repos; all clean.' } as any)
  expect(ok.block).toBeUndefined()
})

test('source-fidelity lets through a figure labelled as the writer\'s own', () => {
  expect(unsupported('I am 65% sure this works (my estimate).', 'nothing here')).toEqual([])
  expect(unsupported('By my math, 69% of replies ran long.', 'nothing here')).toEqual([])
  expect(unsupported('The fee is 65%.', 'nothing here')).toEqual(['65%'])
  expect(unsupported('Skip long projects for now (80% confident).', 'nothing here')).toEqual([])
  expect(unsupported('Confidence: 90%, up from before.', 'nothing here')).toEqual([])
})

test('source-fidelity remembers figures from earlier turns', async ($, on) => {
  world(on, 'Business plan: about $20K in the first half of 2027')
  await $.prompt.submit({ text: 'read my plan', origin: { kind: 'composer' } } as any)
  await $.tool.call({ tool: 'Read', file_path: 'plan.md' } as any)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Read it.' } as any)
  await $.prompt.submit({ text: `Compare this role to my plan:\n${JD}`, origin: { kind: 'composer' } } as any)
  const r: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'The role pays $180k; your plan expects $20K in 2027.' } as any)
  expect(r.block).toBeUndefined()
  const made: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Your plan expects $35K.' } as any)
  expect(String(made.block)).toContain('$35K')
})
