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
  on('fs.read', (_$: any, e: any) => { const v = w.files.get(e.path); if (v === undefined) throw new Error('none'); return { value: v } as any })
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
