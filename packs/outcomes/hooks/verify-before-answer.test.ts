import { expect, mock, test } from 'claude-code/testing'
import { AGAIN, FIRST, VERIFY_TOOL, applyRewrites, conclusions, dedupe, lastJson, overlap, readOnly, safeTrim } from './verify-before-answer'

test('a declined false reply is never listed as missing, in both stages', () => {
  for (const p of [FIRST, AGAIN]) expect(p).toContain('the draft declines, because the tool results contradict it or do not show it, counts as answered')
})

test('a flagged risk needs a fix and a %, and the re-check knows when that is done', () => {
  expect(FIRST).toContain('"check" also lists each risk the draft flags')
  expect(AGAIN).toContain('An item starting "Risk without a fix and %: " is resolved when')
})

test('lastJson takes the last whole object', () => {
  expect(lastJson('prose {"open":[]} Wait, JSON only. {"open":[2]}')).toEqual({ open: [2] })
  expect(lastJson('x {"check":[{"claim":"a","how":"b"}],"missing":[],"rewrite":[]} ').check.length).toBe(1)
  expect(lastJson('no json here')).toBeUndefined()
})

test('rewrite that only removes words is applied', () => {
  const t = '- It is bound to 0.0.0.0, so other machines on the network can reach it.\n- Model: Qwen.'
  const r = applyRewrites(t, [{ sentence: 'It is bound to 0.0.0.0, so other machines on the network can reach it.', rewrite: 'It is bound to 0.0.0.0.' }])
  expect(r.applied).toBe(1)
  expect(r.text).toBe('- It is bound to 0.0.0.0.\n- Model: Qwen.')
})

test('rewrite that adds a word is refused', () => {
  const r = applyRewrites('It is bound to all addresses.', [{ sentence: 'It is bound to all addresses.', rewrite: 'It is bound and safe.' }])
  expect(r.applied).toBe(0)
})

test('dollar signs survive a rewrite', () => {
  const r = applyRewrites('Each trade costs $5,000, so profits look better.', [{ sentence: 'Each trade costs $5,000, so profits look better.', rewrite: 'Each trade costs $5,000.' }])
  expect(r.text).toBe('Each trade costs $5,000.')
})

test('dropping the only bullet removes its empty heading', () => {
  const r = applyRewrites('Yes.\n\nFound:\n- A is up.\n\nRisk:\n- Guess line.', [{ sentence: 'Guess line.', rewrite: '' }])
  expect(r.text).toBe('Yes.\n\nFound:\n- A is up.')
})

test('partial-line drop is refused', () => {
  const r = applyRewrites('- A is up. Guess line.', [{ sentence: 'Guess line.', rewrite: '' }])
  expect(r.applied).toBe(0)
})

test('conclusions finds inference sentences only', () => {
  const c = conclusions('Yes, it runs.\n- It listens on 0.0.0.0, so other machines can reach it.\n- The model is Qwen.')
  expect(c).toEqual(['It listens on 0.0.0.0, so other machines can reach it.'])
})

test('read-only block unchanged', () => {
  expect(readOnly('Bash', { command: 'rm -rf x' })).toBe(false)
  expect(readOnly('PowerShell', { command: 'Get-Process llama-server' })).toBe(true)
})

const one = (s: string, w: string) => applyRewrites(s, [{ sentence: s, rewrite: w }]).applied
test('bad trims from the last test are refused', () => {
  expect(one('Add one short series and watch it download (85% confident it works).', 'Add one short series and watch it download.')).toBe(0)
  expect(one('- Proving it means adding a series, which changes Kapowarr, so I stopped there.', '- I stopped there.')).toBe(0)
  expect(one("- Desktop's firewall allows llama-server only on networks Windows labels Public.", "- Desktop's firewall allows llama-server on networks Windows labels Public.")).toBe(0)
})

test('a note that something was not checked is never trimmed or dropped', () => {
  expect(one("- I haven't tested from a Wi-Fi device; the test from Laptop was blocked.", "- I haven't tested from a Wi-Fi device.")).toBe(0)
  expect(applyRewrites('Yes.\n\nUnverified:\n- Port 8081 status.', [{ sentence: 'Port 8081 status.', rewrite: '' }]).applied).toBe(0)
  expect(applyRewrites('Yes.\n- Recommend X (85% sure).', [{ sentence: 'Recommend X (85% sure).', rewrite: '' }]).applied).toBe(0)
})

test('good trims from the last test still apply', () => {
  expect(one("Kapowarr's tracked list is empty (it returned 0 volumes), so it isn't searching for anything.", "Kapowarr's tracked list is empty (it returned 0 volumes).")).toBe(1)
  expect(one("- NordLynx is also Public, so the firewall doesn't block VPN or Meshnet peers either.", '- NordLynx is also Public.')).toBe(1)
  expect(one('- There is no slippage or bid-ask spread, so results look better than real fills.', '- There is no slippage or bid-ask spread.')).toBe(1)
  expect(one('- It assumes the 50% profit exit fills exactly (`:8`), so backtest returns read optimistic.', '- It assumes the 50% profit exit fills exactly (`:8`).')).toBe(1)
  expect(one('- Python process 22448 is listening on 0.0.0.0, so other machines can reach it, not just Desktop.', '- Python process 22448 is listening on 0.0.0.0.')).toBe(1)
  expect(one('rdt-client, which handles its downloads, has also been up for 4 days and reports healthy.', 'rdt-client has also been up for 4 days and reports healthy.')).toBe(1)
})

test('safeTrim keeps the reason before "so" and reasons only the user can settle', () => {
  expect(safeTrim('It tracks no series, so nothing has downloaded since 2026-08-27.', 'Nothing has downloaded since 2026-08-27.')).toBe(false)
  expect(safeTrim("- Windows wouldn't show me that process's command line, probably because it runs elevated.", "- Windows wouldn't show me that process's command line.")).toBe(false)
})

test('merging joins one claim in two wordings and keeps the longer', () => {
  const a = { claim: 'The server is process 5044', how: 'x', src: 'judge' as const, by: 0 }
  const b = { claim: 'The server is process 5044, open on all network addresses (0.0.0.0)', how: 'y', src: 'judge' as const, by: 1 }
  expect(dedupe([a, b])).toEqual([b])
  const c = { claim: 'Kapowarr tracks 0 series, even though the library folders exist and 16 history entries', how: 'x', src: 'judge' as const, by: 0 }
  const d = { claim: 'All 16 history entries succeeded', how: 'y', src: 'judge' as const, by: 1 }
  expect(overlap(c.claim, d.claim)).toBeLessThan(0.65)
  expect(dedupe([c, d]).length).toBe(2)
  const m = { claim: 'The server is process 5044', how: 'x', src: 'mark' as const }
  expect(dedupe([m, b]).length).toBe(2)
})

test('bulleted sentences from the judge are matched without their bullet', () => {
  expect(applyRewrites('Yes.\n\nFound:\n- A is up.\n- Guess line.', [{ sentence: '- Guess line.', rewrite: '' }]).text).toBe('Yes.\n\nFound:\n- A is up.')
  expect(applyRewrites('- It is bound to 0.0.0.0, so other machines can reach it.', [{ sentence: '- It is bound to 0.0.0.0, so other machines can reach it.', rewrite: '- It is bound to 0.0.0.0.' }]).text).toBe('- It is bound to 0.0.0.0.')
  expect(applyRewrites('- 2.5 GB is free, so the disk is fine.', [{ sentence: '2.5 GB is free, so the disk is fine.', rewrite: '2.5 GB is free.' }]).text).toBe('- 2.5 GB is free.')
})

test('trims keep hedges, word order and word counts', () => {
  expect(one('It probably runs on port 80.', 'It runs on port 80.')).toBe(0)
  expect(one('About 40 GB is free.', '40 GB is free.')).toBe(0)
  expect(one('It may need a restart, so it is not ready.', 'It may need a restart.')).toBe(1)
  expect(one('Port 80 is open but port 443 is not open.', 'Port 80 is not open but port 443 is open.')).toBe(0)
  expect(one('It is up.', 'It is up up.')).toBe(0)
})

test('a fix never cuts a number or file name the tool results show', () => {
  const ev = '[Bash] netstat\n  TCP 0.0.0.0:18793 LISTENING 22448 python.exe'
  const t = 'Yes, it answers.\n- The listener is python.exe, process 22448.\n- So any device on the network can use it.'
  expect(applyRewrites(t, [{ sentence: '- The listener is python.exe, process 22448.', rewrite: '' }], ev).applied).toBe(0)
  expect(applyRewrites(t, [{ sentence: '- So any device on the network can use it.', rewrite: '' }], ev).applied).toBe(1)
  expect(applyRewrites('- It listens on 0.0.0.0, so other machines can reach it.', [{ sentence: 'It listens on 0.0.0.0, so other machines can reach it.', rewrite: 'It listens on 0.0.0.0.' }], ev).applied).toBe(1)
  expect(applyRewrites('- Port 9999 is open to everyone.', [{ sentence: 'Port 9999 is open to everyone.', rewrite: '' }], ev).applied).toBe(1)
})

test('a note that a check was refused keeps its reason words through a trim', () => {
  expect(safeTrim('My check was blocked, so open your Real-Debrid page to confirm.', 'My check was blocked.')).toBe(true)
  expect(safeTrim('My check was blocked, so open your Real-Debrid page to confirm.', 'Open your Real-Debrid page to confirm.')).toBe(false)
})

test('text is untouched when no fix applies', () => {
  expect(applyRewrites('Yes.\n\nNext steps:', []).text).toBe('Yes.\n\nNext steps:')
})

const ctx = (language: string, code: string) => readOnly('mcp__plugin_context-mode_context-mode__ctx_execute', { language, code })
const batch = (...cmds: string[]) => readOnly('mcp__plugin_context-mode_context-mode__ctx_batch_execute', { commands: cmds.map(command => ({ label: 'x', command })) })

test('read-only gate allows reads through memory, sandbox and containers', () => {
  expect(readOnly('mcp__ironjaw-brain__brain_recall', { query: 'x' })).toBe(true)
  expect(readOnly('mcp__plugin_context-mode_context-mode__ctx_search', { queries: ['x'] })).toBe(true)
  expect(ctx('shell', 'curl -s -m 5 http://127.0.0.1:8080/v1/models')).toBe(true)
  expect(ctx('javascript', "const r = await fetch('http://127.0.0.1:18793/'); console.log(r.status)")).toBe(true)
  expect(ctx('python', "import urllib.request\nprint(urllib.request.urlopen('http://server:5656/api').status)")).toBe(true)
  expect(readOnly('mcp__plugin_context-mode_context-mode__ctx_execute_file', { path: 'x.json', language: 'python', code: 'import json\nprint(json.loads(FILE_CONTENT))' })).toBe(true)
  expect(batch('ls', 'cat x')).toBe(true)
  expect(readOnly('Bash', { command: `ssh me@server 'docker exec kapowarr python3 -c "import sqlite3;print(sqlite3.connect(\\"/app/db/K.db\\").execute(\\"select count(*) from volumes\\").fetchone())"'` })).toBe(true)
  expect(readOnly('Bash', { command: 'grep "a>b" file.txt' })).toBe(true)
})

test('read-only gate still blocks writes', () => {
  for (const t of ['mcp__ironjaw-brain__brain_forget_query', 'mcp__ironjaw-brain__brain_remember', 'mcp__ironjaw-brain__brain_confirm', 'mcp__plugin_context-mode_context-mode__ctx_purge', 'mcp__plugin_context-mode_context-mode__ctx_index'])
    expect(readOnly(t, {})).toBe(false)
  expect(ctx('shell', 'echo x > f.txt')).toBe(false)
  expect(ctx('javascript', "require('fs').writeFileSync('f', 'x')")).toBe(false)
  expect(ctx('javascript', "await fetch('http://x/api', { method: 'POST' })")).toBe(false)
  expect(ctx('python', "open('f', 'w').write('x')")).toBe(false)
  expect(ctx('python', "import subprocess\nsubprocess.run(['rm', 'x'])")).toBe(false)
  expect(batch('ls', 'rm x')).toBe(false)
  expect(readOnly('Bash', { command: 'ssh me@server docker exec kapowarr rm -rf /config' })).toBe(false)
  expect(readOnly('Bash', { command: "ssh me@server 'rm -rf /tmp/x'" })).toBe(false)
  expect(readOnly('Bash', { command: 'ssh me@server "echo x > /tmp/f"' })).toBe(false)
  expect(readOnly('Bash', { command: 'docker cp kapowarr:/app/db/K.db .' })).toBe(false)
})

test("merging keeps claims with different numbers or names, and one judge's own items", () => {
  const j = (claim: string, by: number) => ({ claim, how: 'x', src: 'judge' as const, by })
  expect(dedupe([j('llama-server listens on port 8080 on Desktop', 0), j('llama-server listens on port 8081 on Desktop', 1)]).length).toBe(2)
  expect(dedupe([j('llama-server listens on port 8080 on Desktop', 0), j('llama-server listens on port 8080 on Laptop', 1)]).length).toBe(2)
  expect(dedupe([j('The server is process 5044', 0), j('The server is process 5044, open on all addresses', 0)]).length).toBe(2)
})

// ---- the hooks, with the engine and the checking model faked ----

const STEP = { turnId: 't1', index: 0, model: 'm', messageCount: 2 }
const CLEAN = '{"check":[],"missing":[],"rewrite":[]}'
const HOLD = '{"check":[{"claim":"Kapowarr is downloading","how":"read its queue"}],"missing":[],"rewrite":[]}'

function world(on: any, draft: string, verdict: string, env: Record<string, string> = {}) {
  mock.env(on, { USERPROFILE: 'C:\\Users\\t', ...env })
  const w = { judged: 0, logs: [] as string[], writes: [] as string[] }
  // On Linux the engine treats `C:/x` as relative and prefixes the working folder.
  on('fs.write', (_$: any, e: any) => { w.writes.push(String(e.path).replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')); return { value: undefined } })
  on('fs.read', () => { throw new Error('none') })
  on('ui.log', (_$: any, e: any) => { w.logs.push(String(e.text)); return { value: undefined } })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', () => ({ result: { ok: true } as any, text: 'ok' }))
  on('model.complete', async () => { w.judged++; return { value: { isAnswered: true, text: verdict, usage: { input_tokens: 1, output_tokens: 1 } } } })
  on('turn.step', async function* (_$: any, e: any) {
    yield { kind: 'text' as const, index: 0, text: draft }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as never, usage: null }
    return { turnId: e.turnId, index: e.index, answer: draft, toolUses: [], stopReason: 'end_turn' as never, usage: null }
  })
  return w
}

async function reply($: any, step: Record<string, unknown> = {}) {
  const out: any[] = []
  for await (const c of $.turn.step({ ...STEP, ...step })) out.push(c)
  return out
}

test('verify-before-answer holds an unbacked reply and allows only read-only tools until it settles', async ($, on) => {
  const w = world(on, 'Kapowarr is downloading fine.', HOLD)
  await $.prompt.submit({ text: 'Is Kapowarr downloading?', origin: { kind: 'composer' } } as any)
  const out = await reply($)
  expect(out.some(c => c.kind === 'text')).toBe(false)
  expect(out.find(c => c.kind === 'tool')?.name).toBe(VERIFY_TOOL)
  expect(w.logs).toContain('verify-before-answer: held, 1 to check')
  const edit: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/x.txt', old_string: 'a', new_string: 'b' } as any)
  expect(String(edit.deny)).toContain('only read-only tools')
  const read: any = await $.tool.call({ tool: 'Read', file_path: 'C:/x.txt' } as any)
  expect(read.deny).toBeUndefined()
})

test('verify-before-answer shows a backed reply unchanged and writes no log unless HOLD_LOG is set', async ($, on) => {
  const w = world(on, 'Done.', CLEAN)
  await $.prompt.submit({ text: 'Rename the file.', origin: { kind: 'composer' } } as any)
  const out = await reply($)
  expect(out.filter(c => c.kind === 'text').map(c => c.text)).toEqual(['Done.'])
  expect(w.judged).toBe(2)
  expect(w.writes.filter(p => !p.includes('heartbeats'))).toEqual([])
})

test('verify-before-answer logs its verdicts under HOLD_LOG when set', async ($, on) => {
  const w = world(on, 'Done.', CLEAN, { HOLD_LOG: 'C:/logs' })
  await reply($)
  expect(w.writes.some(p => p.startsWith('C:/logs/judge-'))).toBe(true)
  expect(w.writes.some(p => p.startsWith('C:/logs/usage-'))).toBe(true)
})

test('verify-before-answer shows the reply as written after two holds, never cutting a sentence', async ($, on) => {
  const draft = 'Kapowarr is downloading fine.'
  const w = world(on, draft, `{"check":[{"claim":"Kapowarr is downloading","how":"read its queue"}],"open":[1],"hold":[],"missing":[],"rewrite":[],"unchecked":["${draft}"]}`)
  await $.prompt.submit({ text: 'Is Kapowarr downloading?', origin: { kind: 'composer' } } as any)
  for (let n = 0; n < 2; n++) expect((await reply($)).some(c => c.kind === 'tool')).toBe(true)
  const out = await reply($)
  expect(out.filter(c => c.kind === 'text').map(c => c.text)).toEqual([draft])
  expect(w.logs.filter(l => l.startsWith('verify-before-answer: held')).length).toBe(2)
})

test('verify-before-answer leaves helper agents alone', async ($, on) => {
  const w = world(on, 'Kapowarr is downloading fine.', HOLD)
  const out = await reply($, { agentId: 'a1' })
  expect(out.filter(c => c.kind === 'text').map(c => c.text)).toEqual(['Kapowarr is downloading fine.'])
  expect(w.judged).toBe(0)
})

test('verify-before-answer off: no check, no hold, no blocked tools', { options: { verifyBeforeAnswer: false } }, async ($, on) => {
  const w = world(on, 'Kapowarr is downloading fine.', HOLD)
  const out = await reply($)
  expect(out.filter(c => c.kind === 'text').map(c => c.text)).toEqual(['Kapowarr is downloading fine.'])
  expect(w.judged).toBe(0)
  const edit: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/x.txt', old_string: 'a', new_string: 'b' } as any)
  expect(edit.deny).toBeUndefined()
})
