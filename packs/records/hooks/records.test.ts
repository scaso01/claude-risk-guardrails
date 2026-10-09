import { test, expect, mock } from 'claude-code/testing'
import { claimsDone } from './clean-tree-on-done'
import { dbWrites, pathTag } from './db-snapshot'
import { ageNote, DEFAULT_DOCS, isTrackedDoc } from './doc-age-stamp'
import { parseDecisions, removed } from './never-revert'
import { EditLog, globMatch } from './paths'
import { ledgerFile, ROLL_AT, turnLedger, writerTag } from './turn-ledger'

type Proc = (argv: string[]) => { exitCode: number; stdout: string }

function world(on: any, proc: Proc = () => ({ exitCode: 1, stdout: '' }), files: Record<string, string> = {}) {
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  mock.clock(on, { now: Date.UTC(2026, 9, 8, 12) })
  const reached: any[] = []
  const runs: string[][] = []
  const writes: Record<string, string> = {}
  // On Linux the engine treats `C:/x` as relative and prefixes the working folder.
  const key = (p: string) => p.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', (_$: any, e: any) => { runs.push(e.argv); return { value: { ...proc(e.argv), stderr: '' } } })
  on('fs.read', (_$: any, e: any) => {
    const k = key(e.path)
    const v = writes[k] ?? files[k]
    if (v !== undefined) return { value: v }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  on('fs.write', (_$: any, e: any) => { writes[key(e.path)] = e.text; return { value: undefined } })
  on('fs.exists', (_$: any, e: any) => ({ value: files[key(e.path)] !== undefined || writes[key(e.path)] !== undefined }))
  on('fs.list', () => ({ value: [] }))
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: { ok: true } as any, text: 'file text' } })
  return { reached, runs, writes }
}

const denyText = (r: any) => String(r?.deny ?? (r?.isError ? r.text : '') ?? '')

// ---- clean-tree-on-done ----

test('done-claim detection reads only the end of the reply', () => {
  expect(claimsDone('All four packs are done.')).toBe(true)
  expect(claimsDone('Fixed the regex.')).toBe(true)
  expect(claimsDone('Here is the plan for the next step.')).toBe(false)
  expect(claimsDone('done ' + 'x'.repeat(700))).toBe(false)
})

test('clean-tree-on-done sends a done claim back when session edits are uncommitted', async ($, on) => {
  world(on, argv => argv.includes('status') ? { exitCode: 0, stdout: argv.at(-1) === 'C:/proj/a.ts' ? ' M a.ts\n' : '' } : { exitCode: 1, stdout: '' })
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/a.ts', old_string: 'a', new_string: 'b' } as any)
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/b.ts', content: 'x' } as any)
  const r: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Slice 2 is done.' } as any)
  expect(String(r.block)).toContain('1 file(s) changed this session are not committed')
  expect(String(r.block)).toContain('C:/proj/a.ts')
  const again: any = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'Slice 2 is done.' } as any)
  expect(again.block).toBeUndefined()
  const plan: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Next I will write tests.' } as any)
  expect(plan.block).toBeUndefined()
})

test('clean-tree-on-done catches files changed by a shell command, not ones dirty before the session', async ($, on) => {
  let changed = false
  world(on, argv => {
    if (argv.includes('rev-parse')) return { exitCode: 0, stdout: 'C:/proj\n' }
    if (argv.includes('status')) return { exitCode: 0, stdout: changed ? ' M old.txt\n M calc.py\n' : ' M old.txt\n' }
    return { exitCode: 1, stdout: '' }
  })
  on('classic.Stop', () => ({}))
  await $.tool.call({ tool: 'Bash', command: "printf 'x' >> calc.py" } as any)
  changed = true
  const r: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Done.' } as any)
  expect(String(r.block)).toContain('1 file(s) changed this session')
  expect(String(r.block)).toContain('C:/proj/calc.py')
  expect(String(r.block)).not.toContain('old.txt')
})

test('clean-tree-on-done stays quiet when nothing was edited', async ($, on) => {
  const { runs } = world(on)
  on('classic.Stop', () => ({}))
  const r: any = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Done.' } as any)
  expect(r.block).toBeUndefined()
  expect(runs.length).toBe(0)
})

// ---- doc-age-stamp ----

test('doc-age-stamp patterns and wording', () => {
  const p = DEFAULT_DOCS.split(',').map(s => s.trim())
  expect(isTrackedDoc('C:/r/HANDOFF.md', p)).toBe(true)
  expect(isTrackedDoc('/r/docs/session-handoff-2026.md', p)).toBe(true)
  expect(isTrackedDoc('/r/src/status.ts', p)).toBe(false)
  expect(isTrackedDoc('/r/README.md', p)).toBe(false)
  expect(globMatch('PLAN*.md', 'plan-v2.md')).toBe(true)
  expect(ageNote('HANDOFF.md', 9.4, 14, false)).toBe('[doc-age-stamp] HANDOFF.md was last committed 9 days ago, and 14 commits have landed since. Treat it as a draft: check its claims against the code before acting on them.')
  expect(ageNote('HANDOFF.md', 3, 0, false)).toBeUndefined()
})

test('doc-age-stamp adds the age to the read result', async ($, on) => {
  const now = Date.UTC(2026, 9, 8, 12) / 1000
  world(on, argv => {
    if (argv.includes('log')) return { exitCode: 0, stdout: `abc123 ${now - 5 * 86400}\n` }
    if (argv.includes('rev-list')) return { exitCode: 0, stdout: '7\n' }
    if (argv.includes('status')) return { exitCode: 0, stdout: '' }
    return { exitCode: 1, stdout: '' }
  })
  const r: any = await $.tool.call({ tool: 'Read', file_path: 'C:/proj/STATUS.md' } as any)
  expect(r.context?.join(' ')).toContain('last committed 5 days ago, and 7 commits have landed since')
  const plain: any = await $.tool.call({ tool: 'Read', file_path: 'C:/proj/main.ts' } as any)
  expect(plain.context).toBeUndefined()
})

// ---- never-revert ----

test('never-revert rule parsing', () => {
  const d = parseDecisions('# kept on purpose\nIdentityAgent=none => scheduled ssh broke without it\n127.0.0.1\n')
  expect(d).toEqual([{ text: 'IdentityAgent=none', reason: 'scheduled ssh broke without it' }, { text: '127.0.0.1', reason: '' }])
  expect(removed(d, 'ssh -o IdentityAgent=none host', 'ssh host').map(x => x.text)).toEqual(['IdentityAgent=none'])
  expect(removed(d, 'ssh -o IdentityAgent=none host', 'ssh -o IdentityAgent=none -v host')).toEqual([])
})

test('never-revert refuses an edit that drops a recorded decision', async ($, on) => {
  const { reached } = world(on, argv => argv.includes('rev-parse') ? { exitCode: 0, stdout: 'C:/proj\n' } : { exitCode: 1, stdout: '' }, {
    'C:/proj/.claude/never-revert.txt': 'IdentityAgent=none => scheduled ssh broke without it\n',
    'C:/proj/run.ps1': 'ssh -o IdentityAgent=none host\n',
  })
  const bad: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/run.ps1', old_string: 'ssh -o IdentityAgent=none host', new_string: 'ssh host' } as any)
  expect(denyText(bad)).toContain('[never-revert] Refused')
  expect(denyText(bad)).toContain('scheduled ssh broke without it')
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/run.ps1', old_string: 'host', new_string: 'host2' } as any)
  const rules: any = await $.tool.call({ tool: 'Write', file_path: 'C:/proj/.claude/never-revert.txt', content: '' } as any)
  expect(denyText(rules)).toContain('deletes a recorded decision')
  expect(reached.length).toBe(1)
})

// ---- db-snapshot ----

test('db-snapshot finds writes and skips reads', () => {
  expect(dbWrites('sqlite3 data/app.db "DELETE FROM jobs WHERE id=3"')).toEqual([{ path: 'data/app.db', cwd: undefined }])
  expect(dbWrites('cd /srv/x && sqlite3 store.sqlite3 "UPDATE t SET a=1"')).toEqual([{ path: 'store.sqlite3', cwd: '/srv/x' }])
  expect(dbWrites('sqlite3 data/app.db "SELECT count(*) FROM jobs"')).toEqual([])
  expect(dbWrites('ls data/*.db')).toEqual([])
  expect(dbWrites('python -c "import sqlite3;c=sqlite3.connect(\'C:/d/orders.db\');c.execute(\'delete from x\');c.commit()"')[0]!.path).toBe('C:/d/orders.db')
  expect(pathTag('C:\\d\\a.db')).toBe(pathTag('c:/d/a.db'))
  expect(pathTag('C:/d/a.db')).not.toBe(pathTag('C:/e/a.db'))
})

test('db-snapshot backs up before the write, once per window', async ($, on) => {
  const { reached, runs } = world(on, argv => argv[0] === 'sqlite3' && argv[2]?.startsWith('.backup') ? { exitCode: 0, stdout: '' } : { exitCode: 0, stdout: '' },
    { 'C:/proj/data/app.db': 'SQLite' })
  const cmd = { tool: 'Bash', command: 'sqlite3 data/app.db "DELETE FROM jobs"' } as any
  const r: any = await $.tool.call(cmd)
  expect(r.context?.join(' ')).toContain('[db-snapshot] Backed up before the write: C:\\proj/data/app.db -> C:\\Users\\t/.claude/guardrails/db-snapshots/app-')
  await $.tool.call(cmd)
  expect(runs.filter(a => a[0] === 'sqlite3').length).toBe(1)
  expect(reached.length).toBe(2)
})

test('db-snapshot holds the write when no backup can be made', async ($, on) => {
  const { reached } = world(on, () => ({ exitCode: 1, stdout: '' }), { 'C:/proj/app.db': 'SQLite' })
  const r: any = await $.tool.call({ tool: 'PowerShell', command: 'sqlite3 app.db "DROP TABLE x"' } as any)
  expect(denyText(r)).toContain('[db-snapshot] Refused: could not back up')
  expect(reached.length).toBe(0)
})

// ---- turn-ledger ----

test('turn-ledger appends one row per turn', async ($, on) => {
  const { writes } = world(on)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.start({ text: 'fix   the parser\nplease', turnId: 't1' } as any).catch(() => undefined)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/p.ts', old_string: 'a', new_string: 'b' } as any)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as any).catch(() => undefined)
  const names = Object.keys(writes).filter(k => k.startsWith('C:/Users/t/.claude/guardrails/ledger/2026-10-08/sess-1.'))
  expect(names.length).toBe(1)
  expect(names[0]).toMatch(/\/sess-1\.[0-9a-z]{6}\.jsonl$/)
  const row = JSON.parse(writes[names[0]].trim())
  expect(row).toMatchObject({ session: 'sess-1', turn: 't1', ended: 'answer', asked: 'fix the parser please', tools: { Edit: 1, Bash: 1 }, changed: ['C:/proj/p.ts'] })
})

// Two Claude processes, each with its own registration, sharing one filesystem. Every read
// is held until both have read, which is the interleaving that lost a row in the shared
// daily file: both read the same prior text, then each wrote back only its own row.
function sharedDisk() {
  const files: Record<string, string> = {}
  let reads = 0
  let release!: () => void
  const bothRead = new Promise<void>(r => { release = r })
  const fs = {
    read: async (p: string) => {
      if (++reads === 2) release()
      await bothRead
      if (files[p] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files[p]
    },
    write: async (p: string, t: string) => { files[p] = t },
  }
  return { files, fs }
}

function process(fs: any, session: string, writer: string) {
  const hooks: Record<string, any> = {}
  turnLedger(((ev: string, h: any) => { hooks[ev] = h }) as any, new EditLog(), '~/.ledger', true, writer)
  const $ = {
    clock: { now: async () => Date.UTC(2026, 9, 8, 12) },
    env: { get: async (k: string) => (k === 'HOME' ? '/home/t' : undefined) },
    session: { id: async () => session },
    fs,
  }
  const pass = async (e: any) => e
  return {
    turn: async (turnId: string) => {
      await hooks['turn.start']($, { text: `ask ${turnId}`, turnId }, pass)
      await hooks['turn.complete']($, { turnId, reason: 'answer', isAborted: false }, pass)
    },
  }
}

const rows = (files: Record<string, string>) =>
  Object.values(files).flatMap(t => t.trim().split('\n')).map(l => JSON.parse(l).turn).sort()

test('turn-ledger keeps both rows when two sessions finish together', async () => {
  const { files, fs } = sharedDisk()
  await Promise.all([process(fs, 'sess-a', 'aaaaaa').turn('a1'), process(fs, 'sess-b', 'bbbbbb').turn('b1')])
  expect(rows(files)).toEqual(['a1', 'b1'])
})

test('turn-ledger keeps both rows when one session id runs in two processes', async () => {
  const { files, fs } = sharedDisk()
  await Promise.all([process(fs, 'sess-a', 'aaaaaa').turn('x1'), process(fs, 'sess-a', 'cccccc').turn('y1')])
  expect(rows(files)).toEqual(['x1', 'y1'])
})

test('turn-ledger keeps every row of one session across turns', async () => {
  const files: Record<string, string> = {}
  const fs = {
    read: async (p: string) => { if (files[p] === undefined) throw new Error('ENOENT'); return files[p] },
    write: async (p: string, t: string) => { files[p] = t },
  }
  const one = process(fs, 'sess-a', 'aaaaaa')
  for (const t of ['t1', 't2', 't3']) await one.turn(t)
  expect(Object.keys(files)).toEqual(['/home/t/.ledger/2026-10-08/sess-a.aaaaaa.jsonl'])
  expect(rows(files)).toEqual(['t1', 't2', 't3'])
})

test('turn-ledger starts a new part before a file reaches the size limit', async () => {
  const full = '/home/t/.ledger/2026-10-08/sess-a.aaaaaa.jsonl'
  const files: Record<string, string> = { [full]: 'x'.repeat(ROLL_AT - 10) + '\n' }
  const fs = {
    read: async (p: string) => { if (files[p] === undefined) throw new Error('ENOENT'); return files[p] },
    write: async (p: string, t: string) => { files[p] = t },
  }
  await process(fs, 'sess-a', 'aaaaaa').turn('t1')
  expect(files[full].length).toBe(ROLL_AT - 9)
  expect(JSON.parse(files['/home/t/.ledger/2026-10-08/sess-a.aaaaaa.1.jsonl'].trim()).turn).toBe('t1')
})

test('ledger file names are safe on every platform', () => {
  const at = new Date(Date.UTC(2026, 9, 8))
  expect(ledgerFile('/l/', at, '../../etc/x', 'w')).toBe('/l/2026-10-08/.._.._etc_x.w.jsonl')
  expect(ledgerFile('/l', at, 'CON', 'w')).toBe('/l/2026-10-08/_CON.w.jsonl')
  expect(ledgerFile('/l', at, '', 'w')).toBe('/l/2026-10-08/unknown.w.jsonl')
  expect(writerTag(() => 0)).toBe('000000')
  expect(writerTag(() => 0.999999)).toMatch(/^[0-9a-z]{6}$/)
})
