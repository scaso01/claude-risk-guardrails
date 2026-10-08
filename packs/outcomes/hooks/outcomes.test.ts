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
