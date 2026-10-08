import type { On } from 'claude-code'
import { dirOf, type EditLog } from './paths'

const DONE = /\b(done|finished|complete[d]?|all set|shipped|implemented|fixed|ready to (merge|ship))\b/i

/** True when the end of a reply claims the work is finished. */
export const claimsDone = (reply: string) => DONE.test(reply.slice(-600))

/** Paths from `git status --porcelain`, made absolute under the repo root. */
export function parsePorcelain(root: string, out: string): string[] {
  return out.split(/\r?\n/).filter(l => l.length > 3).map(l => {
    let p = l.slice(3)
    if (p.includes(' -> ')) p = p.split(' -> ')[1]!
    return `${root.replace(/[\\/]+$/, '')}/${p.replace(/^"|"$/g, '')}`
  })
}

async function dirty($: any, cwd: string): Promise<string[] | undefined> {
  const top = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 }).catch(() => undefined)
  if (top?.exitCode !== 0) return undefined
  const st = await $.process.run(['git', '-C', cwd, 'status', '--porcelain', '-uall'], { timeoutMs: 15_000 }).catch(() => undefined)
  return st?.exitCode === 0 ? parsePorcelain(top.stdout.trim(), st.stdout) : undefined
}

async function uncommitted($: any, files: string[]): Promise<string[]> {
  const out: string[] = []
  for (const f of files) {
    const r = await $.process.run(['git', '-C', dirOf(f), 'status', '--porcelain', '--', f], { timeoutMs: 15_000 }).catch(() => undefined)
    if (r?.exitCode === 0 && r.stdout.trim()) out.push(f)
  }
  return out
}

const key = (p: string) => p.replace(/\\/g, '/').toLowerCase()

// Files changed by Edit and Write are logged directly. Files changed any other way (a shell
// redirect, a script) are found by comparing git status with a snapshot taken before the
// session's first change; files already dirty then are left out, as the session didn't make them.
export function cleanTreeOnDone(on: On, edits: EditLog) {
  let baseline: Promise<Set<string> | undefined> | undefined

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'] }, async ($, e: any, next) => {
    if (!baseline) {
      const cwd = await $.session.cwd()
      baseline = dirty($, cwd).then(d => (d ? new Set(d.map(key)) : undefined)).catch(() => undefined)
    }
    await baseline
    return next(e)
  })

  on('classic.Stop', async ($, e: any, next) => {
    const r = await next(e)
    if (e.stop_hook_active || r.block !== undefined || !baseline) return r
    if (!claimsDone(String(e.last_assistant_message ?? ''))) return r
    const before = await baseline
    const found = new Map<string, string>()
    for (const f of await uncommitted($, [...edits.session])) found.set(key(f), f)
    if (before) {
      for (const f of (await dirty($, await $.session.cwd())) ?? []) if (!before.has(key(f))) found.set(key(f), f)
    }
    const left = [...found.values()]
    if (!left.length) return r
    const list = left.slice(0, 10).map(f => `- ${f}`).join('\n') + (left.length > 10 ? `\n- and ${left.length - 10} more` : '')
    return {
      ...r,
      block: `[clean-tree-on-done] Your reply says the work is finished, but ${left.length} file(s) changed this session are not committed:\n${list}\n` +
        'Either commit them, or tell the user plainly that they are left uncommitted and why.',
    }
  })
}
