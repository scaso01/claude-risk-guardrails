import { test, expect, mock } from 'claude-code/testing'
import { missing, isMemoryPath } from './memory-provenance'
import { commits, parseChecks } from './precommit-check'
import { reloadText, switchText } from './rules-persist'
import { candidates, gatedByShape, isResearch, stripHeredocs } from './search-before-build'
import { coveringTest, isTest, reminder, testNames } from './test-reminder'

type Proc = (argv: string[], init?: any) => { exitCode: number; stdout: string; stderr?: string }

function world(on: any, opts: { proc?: Proc; files?: Record<string, string>; dirs?: Record<string, { name: string; kind: string }[]>; messages?: any[] } = {}) {
  mock.env(on, { USERPROFILE: 'C:\\Users\\t', OS: 'Windows_NT' })
  mock.clock(on, { now: Date.UTC(2026, 9, 8, 12) })
  const files = opts.files ?? {}
  // On Linux the engine treats `C:/x` as relative and prefixes the working folder.
  const key = (p: string) => p.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')
  const reached: any[] = []
  const runs: { argv: string[]; init?: any }[] = []
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.messages', () => ({ value: opts.messages ?? [] }))
  on('process.run', (_$: any, e: any) => {
    runs.push({ argv: e.argv, init: e.init })
    return { value: { stderr: '', ...(opts.proc ?? (() => ({ exitCode: 1, stdout: '' })))(e.argv, e.init) } }
  })
  on('fs.read', (_$: any, e: any) => {
    const v = files[key(e.path)]
    if (v !== undefined) return { value: v }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  on('fs.exists', (_$: any, e: any) => ({ value: files[key(e.path)] !== undefined || (opts.dirs ?? {})[key(e.path)] !== undefined }))
  on('fs.list', (_$: any, e: any) => ({ value: (opts.dirs ?? {})[key(e.path)] ?? [] }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: { ok: true } as any, text: 'ok' } })
  return { reached, runs }
}

const code = (lines: number) => Array.from({ length: lines }, (_, i) => `x${i} = ${i}`).join('\n')
const RESEARCH = ['WebSearch', 'Agent:Explore', 'Skill:*search*']

// ---- search-before-build ----

test('search-before-build finds what a call would create', () => {
  expect(candidates('Write', { file_path: 'C:/p/a.py', content: code(12) }, 'C:/p')[0]!.lines).toBe(12)
  expect(candidates('Edit', { file_path: 'a.ts', old_string: 'a', new_string: code(30) }, '')).toEqual([])
  expect(candidates('Bash', { command: 'cd sub && cat > tool.py <<EOF\nprint(1)\nEOF' }, 'C:/p')[0]!.path).toBe('C:/p/sub/tool.py')
  expect(candidates('Bash', { command: 'echo hi > notes.json' }, 'C:/p')).toEqual([])
  expect(candidates('Bash', { command: 'x=1; echo > "$OUT.py"' }, 'C:/p')).toEqual([])
  expect(stripHeredocs("cat <<'EOF'\necho > fake.py\nEOF\necho done")).toBe("cat <<'EOF'\necho done")
})

test('search-before-build exempts tests, small files and skipped paths', () => {
  const big = (path: string) => ({ path, lines: 40, isEdit: false })
  expect(gatedByShape(big('C:/p/src/gate.ts'), ['/scratchpad/'])).toBe(true)
  expect(gatedByShape(big('C:/p/tests/test_gate.py'), [])).toBe(false)
  expect(gatedByShape(big('C:/p/gate.test.ts'), [])).toBe(false)
  expect(gatedByShape(big('C:/x/scratchpad/try.py'), ['/scratchpad/'])).toBe(false)
  expect(gatedByShape({ path: 'C:/p/a.py', lines: 5, isEdit: false }, [])).toBe(false)
  expect(gatedByShape(big('C:/p/README.md'), [])).toBe(false)
})

test('search-before-build research matching', () => {
  expect(isResearch('WebSearch', {}, RESEARCH)).toBe(true)
  expect(isResearch('Agent', { subagent_type: 'Explore' }, RESEARCH)).toBe(true)
  expect(isResearch('Agent', { subagent_type: 'qa-engineer' }, RESEARCH)).toBe(false)
  expect(isResearch('Skill', { skill: 'web-search' }, RESEARCH)).toBe(true)
  expect(isResearch('Read', {}, RESEARCH)).toBe(false)
})

test('search-before-build refuses a new code file with no research, then lets it through after', async ($, on) => {
  const msgs: any[] = [{ role: 'user', text: 'build me a gate', toolUses: [] }]
  const w = world(on, { messages: msgs })
  const r: any = await $.tool.call({ tool: 'Write', file_path: 'C:/proj/gate.py', content: code(20) } as any)
  expect(String(r.deny)).toContain('[search-before-build] Refused')
  expect(w.reached.length).toBe(0)
  msgs.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: '1', tool: 'WebSearch', input: { query: 'existing gate' } }] })
  const ok: any = await $.tool.call({ tool: 'Write', file_path: 'C:/proj/gate.py', content: code(20) } as any)
  expect(ok.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
})

test('search-before-build lets an overwrite and an opted-out write through', async ($, on) => {
  const w = world(on, { files: { 'C:/proj/old.py': 'x' }, messages: [{ role: 'user', text: 'no research needed, just write it', toolUses: [] }] })
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/old.py', content: code(20) } as any)
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/new.py', content: code(20) } as any)
  expect(w.reached.length).toBe(2)
})

// ---- test-reminder ----

test('test-reminder naming', () => {
  expect(isTest('C:/p/tests/util.py')).toBe(true)
  expect(isTest('C:/p/src/util.spec.ts')).toBe(true)
  expect(isTest('C:/p/src/latest.py')).toBe(false)
  expect(testNames('util', 'py')).toContain('test_util.py')
  expect(testNames('util', 'ts')).toContain('util.test.js')
  expect(reminder('C:/p', 'C:/p/src/util.py', 'C:/p/tests/unit/test_util.py'))
    .toBe('[test-reminder] You changed src/util.py. Its test is tests/unit/test_util.py: run it before moving to the next task.')
})

test('test-reminder finds the test under the repo root and names it once', async ($, on) => {
  world(on, {
    files: { 'C:/p/.git': 'x' },
    dirs: {
      'C:/p/src': [{ name: 'util.py', kind: 'file' }],
      'C:/p/tests': [{ name: 'unit', kind: 'dir' }],
      'C:/p/tests/unit': [{ name: 'test_util.py', kind: 'file' }],
    },
  })
  const r: any = await $.tool.call({ tool: 'Edit', file_path: 'C:\\p\\src\\util.py', old_string: 'a', new_string: 'b' } as any)
  expect(String(r.context)).toContain('tests/unit/test_util.py')
  const again: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/p/src/util.py', old_string: 'b', new_string: 'c' } as any)
  expect(again.context).toBeUndefined()
})

test('test-reminder stays quiet with no matching test', async () => {
  const fs = { exists: async (p: string) => p === 'C:/p/.git', list: async () => [] as any[] }
  expect(await coveringTest(fs, 'C:/p/src/other.py')).toBeUndefined()
  expect(await coveringTest(fs, 'C:/p/README.md')).toBeUndefined()
})

// ---- precommit-check ----

test('precommit-check reads git commit lines', () => {
  expect(commits('git add . && git commit -m "fix -n parsing"')).toEqual([{ text: 'git commit -m "fix -n parsing"', cwd: undefined, skipsHooks: false }])
  expect(commits('git commit --no-verify -m x')[0]!.skipsHooks).toBe(true)
  expect(commits('git commit -anm x')[0]!.skipsHooks).toBe(true)
  expect(commits('git commit --amend --no-edit')[0]!.skipsHooks).toBe(false)
  expect(commits('git -C repo commit -m x')[0]!.cwd).toBe('repo')
  expect(commits('git log --oneline')).toEqual([])
  expect(commits('echo git commit')).toEqual([])
  expect(parseChecks('bun test  # unit\n\n# lint\nnpx tsc --noEmit\n')).toEqual(['bun test', 'npx tsc --noEmit'])
})

test('precommit-check refuses --no-verify until the user approves the code', async ($, on) => {
  const w = world(on, { proc: () => ({ exitCode: 0, stdout: 'C:/proj\n' }) })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'git commit --no-verify -m wip' } as any)
  const code = /approve (G-\d{4})/.exec(String(r.deny))![1]
  await $.prompt.submit({ text: `approve ${code}`, origin: { kind: 'composer' } } as any)
  const ok: any = await $.tool.call({ tool: 'Bash', command: 'git commit --no-verify -m wip' } as any)
  expect(ok.deny).toBeUndefined()
  expect(w.reached.length).toBe(1)
})

test('precommit-check runs the listed checks and refuses on failure', async ($, on) => {
  const w = world(on, {
    files: { 'C:/proj/.claude/precommit': 'bun test\nnpx tsc --noEmit\n' },
    proc: argv => argv[0] === 'git' ? { exitCode: 0, stdout: 'C:/proj\n' }
      : String(argv.at(-1)).startsWith('npx tsc --noEmit') ? { exitCode: 2, stdout: 'a.ts(3,1): error TS2304' } : { exitCode: 0, stdout: 'pass' },
  })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' } as any)
  expect(String(r.deny)).toContain('"npx tsc --noEmit" failed (exit 2)')
  expect(String(r.deny)).toContain('error TS2304')
  expect(w.reached.length).toBe(0)
  expect(String(w.runs.find(x => String(x.argv.at(-1)).startsWith('bun test'))!.argv.at(-1))).toContain('exit $LASTEXITCODE')
})

test('precommit-check lets a commit through when the repo lists no checks', async ($, on) => {
  const w = world(on, { proc: () => ({ exitCode: 0, stdout: 'C:/proj\n' }) })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' } as any)
  expect(w.reached.length).toBe(1)
})

// ---- rules-persist ----

test('rules-persist wording', () => {
  expect(reloadText('compact', ' 1. Answer first.\r\n')).toBe('[rules-persist] Core rules, reloaded after compact:\n1. Answer first.')
  expect(reloadText('startup', 'x')).toBeUndefined()
  expect(switchText('', 'x')).toBe('[rules-persist] Core rules, reloaded because the model switched to a new model:\nx')
})

test('rules-persist re-adds the rules after compaction, a model switch and for subagents', { options: { rulesFile: '~/rules.md', subagentRulesFile: '~/sub.md' } }, async ($, on) => {
  world(on, { files: { 'C:/Users/t/rules.md': '1. Answer first.', 'C:/Users/t/sub.md': 'Show evidence.' } })
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('classic.SubagentStart', () => ({}))
  const c: any = await $.classic.SessionStart({ source: 'compact' } as any)
  expect(c.additionalContext[0]).toContain('reloaded after compact:\n1. Answer first.')
  const s: any = await $.classic.SessionStart({ source: 'startup' } as any)
  expect(s.additionalContext).toBeUndefined()
  const m: any = await $.classic.PostModelSwitch({ to_model: 'sonnet' } as any)
  expect(m.additionalContext[0]).toContain('switched to sonnet')
  const a: any = await $.classic.SubagentStart({ agent_type: 'Explore' } as any)
  expect(a.additionalContext).toEqual(['Show evidence.'])
})

// ---- memory-provenance ----

test('memory-provenance asks for what is missing', () => {
  expect(missing('The build server runs Ubuntu 24.04.')).toHaveLength(2)
  expect(missing('Verified 2026-10-08 via `uname -a`: Ubuntu 24.04.')).toEqual([])
  expect(missing('Source: https://example.com/doc (checked 2026-10-08)')).toEqual([])
  expect(missing('The user said the cap is 500.')).toEqual(['the date it was checked (YYYY-MM-DD)'])
  expect(isMemoryPath('C:/u/.claude/memory/fact.md', ['/memory/'])).toBe(true)
  expect(isMemoryPath('C:/u/.claude/memory/MEMORY.md', ['/memory/'])).toBe(false)
  expect(isMemoryPath('C:/u/src/memory.ts', ['/memory/'])).toBe(false)
})

test('memory-provenance notes a new memory without a source, not an existing one', async ($, on) => {
  world(on, { files: { 'C:/m/memory/old.md': 'x' } })
  const r: any = await $.tool.call({ tool: 'Write', file_path: 'C:/m/memory/new.md', content: 'The NAS is at the usual address.' } as any)
  expect(String(r.context)).toContain('[memory-provenance] The new memory new.md is missing')
  const old: any = await $.tool.call({ tool: 'Write', file_path: 'C:/m/memory/old.md', content: 'The NAS moved.' } as any)
  expect(old.context).toBeUndefined()
})
