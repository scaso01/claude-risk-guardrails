import type { On } from 'claude-code'
import { baseOf, isAbs, join, norm } from './paths'
import { segments } from './shell'
import { signOffText, type SignOff } from './signoff'

const DB_PATH = /(?:[A-Za-z]:)?[^\s"'`;|&<>()=,]*\.(?:db|sqlite3?)(?![A-Za-z0-9_])/g
const WRITE_SQL = /\b(insert|update|delete|drop|alter|create|replace|vacuum|attach|reindex)\b|\.(import|restore)\b|executescript|\.commit\(\)/i

/** Database files a command may write, each with the directory it is relative to. */
export function dbWrites(command: string): { path: string; cwd?: string }[] {
  if (!WRITE_SQL.test(command)) return []
  const out: { path: string; cwd?: string }[] = []
  for (const s of segments(command)) {
    for (const m of s.text.matchAll(DB_PATH)) {
      const path = m[0].replace(/^['"]|['"]$/g, '')
      if (/^https?:/i.test(path) || out.some(o => o.path === path)) continue
      out.push({ path, cwd: s.cwd })
    }
  }
  return out
}

/** A short stable tag so two databases with the same name don't share snapshot slots. */
export function pathTag(path: string): string {
  let h = 5381
  for (const c of norm(path).toLowerCase()) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0
  return h.toString(36).slice(0, 6)
}

const PY_BACKUP = 'import sqlite3,sys;s=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()'

async function backup($: any, src: string, dst: string): Promise<boolean> {
  const tries = [['sqlite3', src, `.backup '${dst.replace(/'/g, "''")}'`], ['python3', '-c', PY_BACKUP, src, dst], ['python', '-c', PY_BACKUP, src, dst]]
  for (const argv of tries) {
    const r = await $.process.run(argv, { timeoutMs: 120_000 }).catch(() => undefined)
    if (r?.exitCode === 0) return true
  }
  return false
}

/** The slot to overwrite next: a missing one, else the oldest. */
async function nextSlot($: any, dir: string, stem: string, keep: number): Promise<string> {
  const entries: any[] = await $.fs.list(dir).catch(() => [])
  let best = `${stem}.1.db`
  let oldest = Infinity
  for (let i = 1; i <= keep; i++) {
    const name = `${stem}.${i}.db`
    const hit = entries.find(x => x.name === name)
    if (!hit) return name
    if (hit.mtimeMs < oldest) { oldest = hit.mtimeMs; best = name }
  }
  return best
}

export type SnapshotOptions = { dir: string; keep: number; everyMinutes: number }

export function dbSnapshot(on: On, signOff: SignOff, opts: SnapshotOptions) {
  const lastTaken = new Map<string, number>()

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    const targets = dbWrites(command)
    if (!targets.length) return next(e)
    const now = await $.clock.now()
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const cwd = await $.session.cwd()
    const dir = opts.dir.replace(/^~(?=[\\/]|$)/, home)
    const failed: string[] = []
    const taken: string[] = []
    for (const t of targets) {
      const raw = t.path.replace(/^~(?=[\\/])/, home)
      const base = !t.cwd ? cwd : isAbs(t.cwd) ? t.cwd : join(cwd, t.cwd)
      const abs = isAbs(raw) ? raw : join(base, raw)
      if (!(await $.fs.exists(abs))) continue
      const key = norm(abs).toLowerCase()
      if (now - (lastTaken.get(key) ?? -Infinity) < opts.everyMinutes * 60_000) continue
      const stem = `${baseOf(abs).replace(/\.(db|sqlite3?)$/i, '')}-${pathTag(abs)}`
      const dst = `${dir}/${await nextSlot($, dir, stem, opts.keep)}`
      await $.fs.write(`${dir}/README.txt`, 'Snapshots taken by db-snapshot before a database write. Slots are reused oldest-first.\n')
      if (await backup($, abs, dst)) { lastTaken.set(key, now); taken.push(`${abs} -> ${dst}`) }
      else failed.push(abs)
    }
    if (failed.length) {
      const key = `${e.tool}\u0000${command.trim()}`
      if (!signOff.consume(key, now))
        return { deny: `[db-snapshot] Refused: could not back up ${failed.join(', ')} before this write (no sqlite3 or Python found, or the copy failed). ${signOffText(signOff.codeFor(key))}` }
    }
    const r = await next(e)
    if (!taken.length || r.deny !== undefined) return r
    return { ...r, context: [...(r.context ?? []), `[db-snapshot] Backed up before the write: ${taken.join('; ')}`] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[db-snapshot] Refused: the guard could not check this command.' }))
}
