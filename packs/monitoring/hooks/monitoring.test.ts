import { test, expect, mock } from 'claude-code/testing'
import {
  emptyState, nameDecision, onPrompt, onSessionStart, onSubagentStart, onSubagentStop, sessionKey, type HoldState,
} from './hold-core'
import { addedLines, isNotesFile, undatedFigures } from './stale-number-flag'

const CFG = { ttlMinutes: 120, graceSeconds: 60, block: false }
const SID = '11111111-2222-3333-4444-555555555555'
const notif = (tid: string, still = false) =>
  `<task-notification>\n<task-id>${tid}</task-id>\n<status>completed</status>\n<summary>x</summary>\n` +
  (still ? '<note>This agent stopped with background work of its own still running.</note>\n' : '') +
  `<result>report from ${tid}</result>\n</task-notification>`
const final = (id: string, body: string) =>
  `<agent-message from="${id}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output.\n  ${body}\n</agent-message>`

// ---- agent-hold, ported from the original hook's self-check ----

test('session key comes from the transcript path, never the first uuid in it', () => {
  const slug = 'C:/x/projects/C--foreign-99999999-8888-7777-6666-555555555555-slug'
  expect(sessionKey(`${slug}/${SID}.jsonl`, 'x')).toBe(SID)
  expect(sessionKey(`${slug}/${SID}/subagents/agent-a0d05679d3d3a549c.jsonl`, 'not-main')).toBe(SID)
  expect(sessionKey(undefined, 'abc')).toBe('abc')
})

test('agent-hold full cycle: hold, interrupt, still-running, other task, compact, release', () => {
  const s = emptyState(); let t = 1_000_000
  expect(onPrompt(s, 'hello', t, CFG).context).toBeUndefined()
  onSubagentStart(s, 'a0d05679d3d3a549c', 'fork', t)
  onSubagentStart(s, 'ac205ec1059534d0c', 'general-purpose', t)
  expect(Object.keys(s.agents).length).toBe(2)
  const user = onPrompt(s, 'what is the capital of France?', ++t, CFG)
  expect(user.context).toContain("2 agents running. Answer the user's message now.")
  expect(s.queued).toEqual([])
  expect(onPrompt(s, 'stop the agents now', ++t, CFG).context).toBeUndefined()
  expect(onPrompt(s, '<agent-message from="a0d05679d3d3a549c">\n[Subagent hand-back] found X</agent-message>', ++t, CFG).context)
    .toContain('2 agents running. Reply with exactly one line')
  expect(onPrompt(s, notif('a0d05679d3d3a549c', true), ++t, CFG).context).toContain('2 agents running.')
  expect(onPrompt(s, notif('bz9u1is3i'), ++t, CFG).context).toContain('not an agent report')
  expect(onPrompt(s, notif('bz9u1is3i'), ++t, { ...CFG, block: true }).block).toBe('2 agents running.')
  expect(onSessionStart(s, 'compact', ++t).context).toContain('[agent-hold] Active')
  expect(onPrompt(s, notif('a0d05679d3d3a549c'), ++t, CFG).context).toContain('1 agent running.')
  const rel = onPrompt(s, notif('ac205ec1059534d0c'), ++t, CFG)
  expect(rel.release).toBe(true)
  expect(rel.context).toContain('ALL AGENTS DONE')
  expect(rel.context).toContain('found X')
  expect(rel.context).toContain('report from ac205ec1059534d0c')
  expect(rel.context).not.toContain('capital of France')
  expect(s).toEqual(emptyState())
})

test('hold off, hold on, and a restart mid-hold', () => {
  const s = emptyState(); let t = 1_000_000
  onSubagentStart(s, 'acc3333cc3333cc33', 'fork', t)
  expect(onPrompt(s, 'hold off', ++t, CFG).context).toContain('Disabled')
  expect(onPrompt(s, 'unrelated question', ++t, CFG).context).toBeUndefined()
  expect(onPrompt(s, 'hold on', ++t, CFG).context).toContain('Enabled')
  expect(onPrompt(s, 'unrelated question', ++t, CFG).context).toContain('1 agent running. Answer')
  onPrompt(s, '<agent-message from="acc3333cc3333cc33">\n[Subagent hand-back] partial</agent-message>', ++t, CFG)
  onSessionStart(s, 'resume', ++t)
  const r = onPrompt(s, 'anything', ++t, CFG)
  expect(r.context).toContain('ALL AGENTS DONE')
  expect(r.context).toContain('hold ended by restart')
})

test('named teammates are never held, and a repeated prompt is answered each time', () => {
  const s = emptyState(); let t = 1_000_000
  expect(onSubagentStart(s, 'aownaswork-vet-ae86e53e4d85a845', 'vet', t)[0]!.kind).toBe('skip-teammate')
  expect(onPrompt(s, 'yes please', ++t, CFG).context).toBeUndefined()
  onSubagentStart(s, 'addd444ddd444ddd4', 'fork', t)
  for (let i = 0; i < 2; i++) expect(onPrompt(s, 'yes please', ++t, CFG).context).toContain('1 agent running. Answer')
  expect(onPrompt(s, notif('addd444ddd444ddd4'), ++t, CFG).context).toContain('report from addd444ddd444ddd4')
})

test('foreground hand-backs release by wording, mid-run messages do not', () => {
  const s = emptyState(); let t = 1_000_000
  onSubagentStart(s, 'aeee555eee555eee5', 'Explore', t)
  onSubagentStart(s, 'afff666fff666fff6', 'Explore', t)
  expect(onPrompt(s, final('aeee555eee555eee5', 'pong one'), ++t, CFG).context).toContain('1 agent running.')
  expect(onPrompt(s, '<agent-message from="afff666fff666fff6">\n[Subagent hand-back] progress</agent-message>', ++t, CFG).context).toContain('1 agent running.')
  const r = onPrompt(s, final('afff666fff666fff6', 'pong two'), ++t, CFG)
  for (const x of ['pong one', 'pong two', 'progress']) expect(r.context).toContain(x)
  expect(onPrompt(s, 'next question', ++t, CFG).context).toBeUndefined()
})

test('the finish signal releases a report in any wording', () => {
  const s = emptyState(); let t = 1_000_000
  onSubagentStart(s, 'a1111222233334444', 'Explore', t)
  onSubagentStart(s, 'a5555666677778888', 'Explore', t)
  expect(onPrompt(s, '<agent-message from="a1111222233334444">\nmid-run note</agent-message>', ++t, CFG).context).toContain('2 agents running.')
  onSubagentStop(s, 'a1111222233334444', 'Explore', ++t)
  expect(onPrompt(s, '<agent-message from="a1111222233334444">\nREWORDED final one</agent-message>', ++t, CFG).context).toContain('1 agent running.')
  onSubagentStop(s, 'a5555666677778888', 'Explore', ++t)
  const r = onPrompt(s, '<agent-message from="a5555666677778888">\nREWORDED final two</agent-message>', ++t, CFG)
  for (const x of ['final one', 'final two', 'mid-run']) expect(r.context).toContain(x)
  expect(onSubagentStop(s, 'a9999999999999999', 'Explore', ++t)).toEqual([])
})

test('a report that never arrives releases after the grace window with a warning', () => {
  const s = emptyState(); let t = 1_000_000
  onSubagentStart(s, 'abbbb2222bbbb2222', 'Explore', t)
  onSubagentStop(s, 'abbbb2222bbbb2222', 'Explore', t)
  expect(onPrompt(s, 'where is it?', t + 1000, CFG).context).toContain('1 agent running. Answer')
  const r = onPrompt(s, 'hello again', t + 61_000, CFG)
  expect(r.context).toContain('WARNING')
  expect(r.context).toContain('hello again')
})

test('an early report from a finished agent does not warn, and still-running clears the finish mark', () => {
  const s = emptyState(); let t = 1_000_000
  onSubagentStart(s, 'acccc3333cccc3333', 'Explore', t)
  onSubagentStart(s, 'adddd4444dddd4444', 'Explore', t)
  onPrompt(s, '<agent-message from="acccc3333cccc3333">\nearly report</agent-message>', ++t, CFG)
  onSubagentStop(s, 'acccc3333cccc3333', 'Explore', ++t)
  expect(onPrompt(s, 'status?', ++t, CFG).context).toContain('2 agents running. Answer')
  onPrompt(s, notif('adddd4444dddd4444', true), ++t, CFG)
  onSubagentStop(s, 'adddd4444dddd4444', 'Explore', ++t)
  const r = onPrompt(s, 'status now?', ++t, CFG)
  expect(r.context).toContain('early report')
  expect(r.context).not.toContain('WARNING')
  const s2: HoldState = emptyState()
  onSubagentStart(s2, 'aeeee5555eeee5555', 'fork', t)
  onSubagentStart(s2, 'affff6666ffff6666', 'fork', t)
  onSubagentStop(s2, 'aeeee5555eeee5555', 'fork', ++t)
  onPrompt(s2, notif('aeeee5555eeee5555', true), ++t, CFG)
  expect(s2.agents['aeeee5555eeee5555']!.finished).toBeUndefined()
})

test('agent names are dropped unless the launch mentions messaging', () => {
  expect(nameDecision({ prompt: 'x' }).action).toBe('none')
  expect(nameDecision({ name: 'scout', prompt: 'find the file' }).action).toBe('strip')
  expect(nameDecision({ name: 'scout', prompt: 'SendMessage the lead when done' }).action).toBe('keep')
  expect(nameDecision({ name: 'scout', prompt: 'x', isolation: 'remote' }).action).toBe('keep')
})

test('agent-hold keeps state on disk across events and writes the release flag', async ($, on) => {
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  mock.clock(on, { now: Date.UTC(2026, 9, 8, 12) })
  const files: Record<string, string> = {}
  const k = (p: string) => p.replace(/\\/g, '/')
  on('fs.read', (_$: any, e: any) => { if (files[k(e.path)] !== undefined) return { value: files[k(e.path)]! }; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  on('fs.write', (_$: any, e: any) => { files[k(e.path)] = e.text; return { value: undefined } })
  on('fs.exists', (_$: any, e: any) => ({ value: files[k(e.path)] !== undefined }))
  on('classic.SubagentStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  const tp = `C:/p/${SID}.jsonl`
  await $.classic.SubagentStart({ agent_id: 'a0d05679d3d3a549c', agent_type: 'fork', transcript_path: tp } as any)
  const held: any = await $.classic.UserPromptSubmit({ prompt: 'hi', transcript_path: tp } as any)
  expect(String(held.additionalContext)).toContain('1 agent running.')
  const rel: any = await $.classic.UserPromptSubmit({ prompt: notif('a0d05679d3d3a549c'), transcript_path: tp } as any)
  expect(String(rel.additionalContext)).toContain('ALL AGENTS DONE')
  const dir = 'C:/Users/t/.claude/guardrails/agent-hold'
  expect(files[`${dir}/${SID}.release`]).toBeDefined()
  expect(files[`${dir}/${SID}.json`]).toBe('')
  expect(files[`${dir}/events-2026-10.jsonl`]).toContain('"kind":"release"')
})

// ---- stale-number-flag ----

test('stale-number-flag catches undated counts and passes dated or technical lines', () => {
  expect(undatedFigures(['- yt-intel tracks 992 subscribed sources'])).toHaveLength(1)
  expect(undatedFigures(['- 138 notebooks live (CLI list, 2026-10-06)'])).toEqual([])
  expect(undatedFigures(['- verified Oct 8: 77 repos'])).toEqual([])
  expect(undatedFigures(['- Home Assistant on `:8123`'])).toEqual([])
  expect(undatedFigures(['- printer at 192.0.2.10'])).toEqual([])
  expect(undatedFigures(['- RTK v0.29.0 installed'])).toEqual([])
  expect(undatedFigures(['- Qwen3.8-27B is slower'])).toEqual([])
  expect(undatedFigures(['```', 'count = 500', '```'])).toEqual([])
  expect(undatedFigures(['name: thing-12'])).toEqual([])
  expect(addedLines('a\nb', 'a\nb\nc 42 items')).toEqual(['c 42 items'])
  expect(isNotesFile('C:\\Users\\x\\memory\\tools.md', ['/memory/'])).toBe(true)
  expect(isNotesFile('C:/repo/src/memory/cache.ts', ['/memory/'])).toBe(false)
})

test('stale-number-flag adds a note after the write, only for new undated figures', async ($, on) => {
  on('fs.read', () => ({ value: 'old 55 line\n' }))
  on('tool.call', () => ({ result: { ok: true } as any }))
  const r: any = await $.tool.call({ tool: 'Write', file_path: 'C:/m/memory/x.md', content: 'old 55 line\nnew count is 340 rows\n' } as any)
  expect(r.context?.join(' ')).toContain('[stale-number-flag] 1 saved line(s)')
  expect(r.context?.join(' ')).toContain('340 rows')
  const ok: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/m/memory/x.md', old_string: 'a', new_string: '340 rows (2026-10-08)' } as any)
  expect(ok.context).toBeUndefined()
})
