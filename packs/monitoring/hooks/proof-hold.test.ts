import { test, expect, mock } from 'claude-code/testing'
import { HOLD_TOOL } from './reply-policy'
import { holdNotes } from './policy'

const OPTS = { options: { replyPolicy: true, proofCheck: true, replyPolicyLogDir: '/logs' } }
const GOOD = '- The repo is clean (git status: "nothing to commit")'
const BAD = '- It holds two stashes (git stash list: "stash@{1}: WIP")'
const BAD2 = '- It has three remotes (git remote: "origin upstream fork")'
const reply = (...facts: string[]) => `The repo is clean.\n\nFacts found:\n${facts.join('\n')}\n\nOutstanding issues:\n1. Push it?\n   - My pick: yes, 90% sure. Push?`

/** The engine, faked: each model step answers the next draft; the judge passes the git status fact. */
function world(on: any, drafts: string[], verdict = (_n: number) => '1 git status says nothing to commit. TRUE') {
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'cli' })
  mock.clock(on, { now: Date.UTC(2026, 9, 29, 12) })
  const w = { judged: [] as string[], status: [] as string[], files: new Map<string, string>(), steps: 0 }
  on('ui.status', (_$: any, e: any) => { w.status.push(e.text); return { value: undefined } as any })
  // The engine resolves paths for the platform: "/policy.md" becomes "D:\\policy.md" on a Windows runner, and a
  // Windows path on Linux is joined to the working folder. So a faked file is found by its tail, drive dropped.
  const tail = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.read', (_$: any, e: any) => {
    const want = tail(String(e.path))
    const hit = [...w.files.entries()].find(([k]) => tail(k) === want) ?? [...w.files.entries()].find(([k]) => want.endsWith(`/${tail(k).replace(/^\//, '')}`))
    if (!hit) throw new Error('none')
    return { value: hit[1] } as any
  })
  on('fs.write', (_$: any, e: any) => { w.files.set(e.path, e.content ?? e.text ?? e.data); return { value: undefined } as any })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }) as any)
  on('session.messages', () => ({ value: [{ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'git status' }, text: 'On branch main\nnothing to commit, working tree clean' }] }] }) as any)
  on('model.complete', (_$: any, e: any) => {
    if (e.prompt.startsWith('You check facts')) w.judged.push(e.prompt)
    return { value: {
      isAnswered: true,
      text: e.prompt.startsWith('Below are the opening') ? '- the repo is clean: SUPPORTED\nKEEP' : verdict(w.judged.length),
      usage: { input_tokens: 1, output_tokens: 1 },
    } } as any
  })
  on('turn.step', async function* () {
    const d = drafts[Math.min(w.steps++, drafts.length - 1)]!
    yield { kind: 'text', index: 0, text: d }
    return { turnId: 't1', index: 0, answer: d, toolUses: [], stopReason: 'end_turn' } as any
  })
  return w
}

async function step($: any, extra: Record<string, unknown> = {}) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1, ...extra })
  const chunks: any[] = []
  for await (const c of s) chunks.push(c)
  await s.result
  return { chunks, text: chunks.filter(c => c.kind === 'text').map(c => c.text).join('') }
}

test('a failed line holds the reply: nothing is shown, and the hold tool hands back the line and its reason', OPTS, async ($, on) => {
  const w = world(on, [reply(GOOD, BAD)])
  const r = await step($)
  expect(r.text).toBe('')
  const tool = r.chunks.find(c => c.kind === 'tool')
  expect(tool?.name).toBe(HOLD_TOOL)
  expect(r.chunks.find(c => c.kind === 'input')?.json).toBe('{}')
  const answer: any = await $.tool.call({ tool: HOLD_TOOL } as any)
  expect(answer.context[0]).toContain(BAD)
  expect(answer.context[0]).toContain('no command matching the proof ran this session')
  expect(answer.context[0]).toContain('Your draft:\nThe repo is clean.')
  expect(w.status.join(' | ')).toContain('fixing 1 line(s) before you see the reply (round 1)')
  expect(w.status.join(' | ')).not.toContain('cut 1 line(s)')
  expect([...w.files.keys()].some(p => p.endsWith('proof-holds.jsonl'))).toBe(true)
  expect([...w.files.keys()].some(p => p.endsWith('proof-cuts.jsonl'))).toBe(false)
})

test('the fixed reply is shown with no removed note, and a line that passed is not judged again', OPTS, async ($, on) => {
  const w = world(on, [reply(GOOD, BAD), reply(GOOD)])
  await step($)
  expect(w.judged.length).toBe(1)
  const r = await step($)
  expect(r.text).toContain(GOOD)
  expect(r.text).not.toContain('removed')
  expect(r.chunks.some(c => c.kind === 'tool')).toBe(false)
  expect(w.judged.length).toBe(1)
})

test('a line narrowed in the first round is shown narrowed in the second, unjudged', OPTS, async ($, on) => {
  const w = world(on, [reply(GOOD, BAD), reply(GOOD)], n => n === 1 ? '1 it only says nothing to commit. UNPROVEN REWRITE: The repo has nothing to commit' : '1 TRUE')
  await step($)
  expect(w.judged.length).toBe(2)
  const r = await step($)
  expect(r.text).toContain('- The repo has nothing to commit (git status: "nothing to commit")')
  expect(r.text).not.toContain('- The repo is clean (')
  expect(w.judged.length).toBe(2)
})

test('a judge that gives no answer is asked once more before a line is cut', OPTS, async ($, on) => {
  const w = world(on, [reply(GOOD)], n => n === 1 ? 'I cannot tell from this.' : '1 git status says nothing to commit. TRUE')
  const r = await step($)
  expect(w.judged.length).toBe(2)
  expect(r.text).toContain(GOOD)
  expect(r.chunks.some(c => c.kind === 'tool')).toBe(false)
})

test('after two holds the old cut and note are the last resort', OPTS, async ($, on) => {
  const BAD3 = '- It has four tags (git tag: "v1 v2 v3 v4")'
  const w = world(on, [reply(GOOD, BAD), reply(GOOD, BAD2), reply(GOOD, BAD3)])
  expect((await step($)).text).toBe('')
  expect((await step($)).text).toBe('')
  const r = await step($)
  expect(r.text).toContain(GOOD)
  expect(r.text).not.toContain('four tags')
  expect(r.text).toContain('1 line removed: not proven.')
  expect(w.steps).toBe(3)
})

test('a failed line that comes back unchanged is cut, not held again', OPTS, async ($, on) => {
  world(on, [reply(GOOD, BAD), reply(GOOD, BAD)])
  expect((await step($)).text).toBe('')
  const r = await step($)
  expect(r.text).not.toContain('two stashes')
  expect(r.text).toContain('1 line removed: not proven.')
})

test('a note admitting a missing check is sent back once, then shown as written, never cut', OPTS, async ($, on) => {
  const NOTE = "I haven't checked the stash."
  const draft = reply(GOOD).replace('The repo is clean.', `The repo is clean. ${NOTE}`)
  world(on, [draft, draft])
  expect((await step($)).text).toBe('')
  const r = await step($)
  expect(r.text).toContain(NOTE)
  expect(r.text).not.toContain('removed')
})

test('a new prompt starts the hold count again', OPTS, async ($, on) => {
  world(on, [reply(GOOD, BAD), reply(GOOD, BAD2), reply(GOOD, BAD), reply(GOOD, BAD2)])
  await step($); await step($)
  await $.prompt.submit({ text: 'And now?', origin: { kind: 'composer' } } as any)
  expect((await step($)).text).toBe('')
})

test('a subagent step is never held', OPTS, async ($, on) => {
  world(on, [reply(GOOD, BAD)])
  const r = await step($, { agentId: 'a1' })
  expect(r.text).toContain(BAD)
})

test('with the hold off, a failed line is cut at once', { options: { ...OPTS.options, proofHold: false } }, async ($, on) => {
  world(on, [reply(GOOD, BAD)])
  const r = await step($)
  expect(r.text).toContain('1 line removed: not proven.')
  expect(r.chunks.some(c => c.kind === 'tool')).toBe(false)
})

test('the hold row, its result and a group of only it draw nothing; other rows draw as the engine does', OPTS, async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }) as any)
  const base = { isRunning: false, isErrored: false, isInterrupted: false }
  const row = (component: string, props: Record<string, unknown>) => ({ plugin: 'guardrails-monitoring', component, requestId: 'r1', props }) as any
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const m of [
      row('ToolUse', { tool_use_id: 't1', tool: HOLD_TOOL, input: {}, ...base }),
      row('ToolResult', { tool_use_id: 't1', tool: HOLD_TOOL, output: 'Checked.', isErrored: false }),
      row('ToolGroup', { calls: [{ tool_use_id: 't1', tool: HOLD_TOOL, input: {}, ...base }], isActive: false, isExpanded: false }),
    ]) {
      const ui = await $.ui.mount({ ...m, surface })
      expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeFalsy()
      await ui.unmount()
    }
    for (const o of [
      row('ToolUse', { tool_use_id: 't2', tool: 'Bash', input: { command: 'ls' }, ...base }),
      row('ToolGroup', { calls: [{ tool_use_id: 't2', tool: 'Bash', input: {}, ...base }, { tool_use_id: 't1', tool: HOLD_TOOL, input: {}, ...base }], isActive: false, isExpanded: false }),
    ]) {
      const ui = await $.ui.mount({ ...o, surface })
      expect((await ui.find({ type: 'Text', text: /engine row/ }))?.text).toBe('engine row')
      await ui.unmount()
    }
  }
})

const MD = `Answer in the first sentence. Hard cap 6 lines and 120 words — a table of up to 4
rows counts as 1 line, a bigger table counts every row; code is excluded. Only "report",
"compare", "deep", "full", or "walk me through" lifts the cap.
- Delete on sight: just, really, basically, actually, simply, essentially, quite,
  very, note that, it's worth noting, in order to, at this point.
- No lead-ins: "Sure", "Certainly", "Great question", "I'd be happy to", "Let me".
When the user signals confusion ("don't understand", "confused", "confusing",
"what do you mean", "makes no sense", "I'm lost", "explain again"), drop every table,
use simpler words, the same word cap, the recommendation first.`
const LEN = { options: { ...OPTS.options, replyPolicyFile: '/policy.md', lengthHold: true } }
const LONG = reply(GOOD).replace('The repo is clean.', `The repo is clean. ${'Every word here counts toward the cap. '.repeat(20)}`)
const lengthWorld = (on: any, drafts: string[]) => {
  const w = world(on, drafts)
  w.files.set('/policy.md', MD)
  return w
}
const fileOf = (w: any, name: string): string | undefined =>
  [...w.files.entries()].find(([k]: [string, string]) => k.replace(/\\/g, '/').endsWith(`/logs/${name}`))?.[1]
const dayCount = (w: any) => Object.values(JSON.parse(fileOf(w, 'counts.json')!))[0]

test('an over-cap draft is held and sent back to be cut down; the shown reply is logged next to the draft', LEN, async ($, on) => {
  const w = lengthWorld(on, [LONG, reply(GOOD)])
  expect((await step($)).text).toBe('')
  const answer: any = await $.tool.call({ tool: HOLD_TOOL } as any)
  expect(answer.context[0]).toContain('(the whole reply)\n   Reason: over the length cap:')
  expect(answer.context[0]).toContain('keep every number')
  expect(w.status.join(' | ')).toMatch(/shortening a \d+-word draft before you see the reply \(round 1\)/)
  const shown = await step($)
  expect(shown.text).toContain(GOOD)
  const row = JSON.parse(fileOf(w, 'length-holds.jsonl')!.trim())
  expect(row.draft).toBe(LONG)
  expect(row.draftWords).toBeGreaterThan(120)
  expect(row.stillOver).toBe(false)
  expect(row.rounds).toBe(1)
  expect(dayCount(w)).toEqual({ checked: 1, overCap: 1, shown: 1 })
})

test('a draft still over the cap after two holds is shown, and the log says it is still over', LEN, async ($, on) => {
  const w = lengthWorld(on, [LONG, LONG, LONG])
  expect((await step($)).text).toBe('')
  expect((await step($)).text).toBe('')
  expect((await step($)).text).toContain('Every word here')
  expect(JSON.parse(fileOf(w, 'length-holds.jsonl')!.trim())).toMatchObject({ rounds: 2, stillOver: true })
  expect(dayCount(w)).toEqual({ checked: 1, overCap: 1, shown: 1, shownOver: 1 })
})

test('with the length hold off, a long reply is shown at once and counted as over', { options: { ...LEN.options, lengthHold: false } }, async ($, on) => {
  const w = lengthWorld(on, [LONG])
  expect((await step($)).text).toContain('Every word here')
  expect(fileOf(w, 'length-holds.jsonl')).toBeUndefined()
  expect(dayCount(w)).toEqual({ checked: 1, overCap: 1, shown: 1, shownOver: 1 })
})

test('a lift word in the prompt lets a long reply through unheld', LEN, async ($, on) => {
  const w = lengthWorld(on, [LONG])
  await $.prompt.submit({ text: 'Give me the full report', origin: { kind: 'composer' } } as any)
  expect((await step($)).text).toContain('Every word here')
  expect(dayCount(w)).toEqual({ checked: 1, overCap: 0, shown: 1 })
})

const JOB = 'Job 01889246 closes 2026-12-29.'
const LONGF = LONG.replace('The repo is clean.', `The repo is clean. ${JOB}`)
const SHORTF = reply(GOOD).replace('The repo is clean.', `The repo is clean. ${JOB}`)

test('a shorter rewrite that drops a fact is held again and told what it dropped', LEN, async ($, on) => {
  const w = lengthWorld(on, [LONGF, reply(GOOD), SHORTF])
  expect((await step($)).text).toBe('')
  expect((await step($)).text).toBe('')
  const answer: any = await $.tool.call({ tool: HOLD_TOOL } as any)
  expect(answer.context[0]).toContain('Reason: dropped from your first draft: 01889246, 2026-12-29')
  expect(answer.context[0]).toContain('Put each one back')
  expect(w.status.join(' | ')).toContain('putting back 2 dropped fact(s) before you see the reply (round 2)')
  expect((await step($)).text).toContain(JOB)
  expect(JSON.parse(fileOf(w, 'length-holds.jsonl')!.trim())).toMatchObject({ rounds: 2, dropped: [], fellBack: false, stillOver: false })
})

test('a fact moved to a file the reply names counts as kept', LEN, async ($, on) => {
  const note = 'C:\\notes\\job.md'
  const moved = reply(GOOD).replace('The repo is clean.', `The repo is clean. The job details are in ${note}`)
  const w = lengthWorld(on, [LONGF, moved])
  w.files.set(note, 'Job 01889246 closes 2026-12-29.')
  expect((await step($)).text).toBe('')
  expect((await step($)).text).toContain(note)
  expect(JSON.parse(fileOf(w, 'length-holds.jsonl')!.trim())).toMatchObject({ rounds: 1, dropped: [] })
})

test('a fact still missing after the last round brings back the first draft', LEN, async ($, on) => {
  const w = lengthWorld(on, [LONGF, reply(GOOD), reply(GOOD)])
  expect((await step($)).text).toBe('')
  expect((await step($)).text).toBe('')
  const shown = await step($)
  expect(shown.text).toContain(JOB)
  expect(shown.text).toContain('Every word here')
  expect(w.status.join(' | ')).toContain('showing the first draft, because the shorter one dropped 2 fact(s)')
  expect(JSON.parse(fileOf(w, 'length-holds.jsonl')!.trim())).toMatchObject({ rounds: 2, fellBack: true, stillOver: true, dropped: ['01889246', '2026-12-29'] })
})

test('a question to the user cut from the rewrite is sent back', LEN, async ($, on) => {
  const w = lengthWorld(on, [LONG, reply(GOOD).replace(' Push?', ''), reply(GOOD)])
  expect((await step($)).text).toBe('')
  expect((await step($)).text).toBe('')
  const answer: any = await $.tool.call({ tool: HOLD_TOOL } as any)
  expect(answer.context[0]).toContain('dropped from your first draft: 1 question to the user')
  expect((await step($)).text).toContain('Push?')
  expect(w.status.join(' | ')).not.toContain('showing the first draft')
})

test('the notes name a fix for each kind of failure', () => {
  const n = holdNotes('Draft text.', [
    { line: '- a', reason: 'no proof in a checkable form' },
    { line: '- b', reason: 'judge: FALSE four files differ, not three' },
    { line: 'Opening.', reason: 'opening: rewrite "x" not proven either' },
    { line: '- c', reason: 'no screenshot in the last message' },
    { line: '- d', reason: 'claim outside Facts found: quote not in that command\'s output' },
  ])
  expect(n).toContain('1. - a\n   Reason: no proof in a checkable form\n   Fix: Run a read-only command now')
  expect(n).toContain('Reason: judge: FALSE four files differ, not three\n   Fix: The output does not show it as worded')
  expect(n).toContain('Fix: Your first sentence claims more')
  expect(n).toContain('Fix: Use (screenshot: file.png)')
  expect(n).toContain('5. - d\n   Reason: quote not in that command\'s output\n   Fix: Run a read-only command now')
  expect(n).toContain('Do not mention this check.')
  expect(n.endsWith('Your draft:\nDraft text.')).toBe(true)
})
