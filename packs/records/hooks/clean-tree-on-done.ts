import type { On } from 'claude-code'
import { dirOf, type EditLog } from './paths'
import type { Carried } from './signoff'

const DONE = /\b(done|finished|complete[d]?|all set|shipped|implemented|fixed|ready to (merge|ship))\b/i

/** True when the end of a reply claims the work is finished. */
export const claimsDone = (reply: string) => DONE.test(reply.slice(-600))

/** True when the reply already tells the user that changes are left uncommitted. */
export const admitsUncommitted = (reply: string) =>
  /\b(?:uncommitted|not (?:yet )?committed|(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t|haven['’]t|hasn['’]t|didn['’]t) (?:yet )?committed|left (?:them |it )?uncommitted)\b/i.test(reply)

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
  for (const logged of files) {
    // A symlinked path (e.g. a memory dir linked into a dotfiles repo) only shows in git at its target.
    const st = await $.fs.stat(logged, { resolve: true }).catch(() => undefined)
    const f: string = st?.realPath ?? logged
    const r = await $.process.run(['git', '-C', dirOf(f), 'status', '--porcelain', '--', f], { timeoutMs: 15_000 }).catch(() => undefined)
    if (r?.exitCode === 0 && r.stdout.trim()) out.push(f)
  }
  return out
}

const key = (p: string) => p.replace(/\\/g, '/').toLowerCase()

// Files changed by Edit and Write are logged directly. Files changed any other way (a shell
// redirect, a script) are found by comparing git status with a snapshot taken before the
// session's first change; files already dirty then are left out, as the session didn't make them.
// The finding goes to the user as a notice and to the model with the next prompt; sending the
// reply back made the model write a second, unrequested message.
export function cleanTreeOnDone(on: On, edits: EditLog, carried: Carried) {
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
    const reply = String(e.last_assistant_message ?? '')
    if (!claimsDone(reply) || admitsUncommitted(reply)) return r
    const before = await baseline
    const found = new Map<string, string>()
    for (const f of await uncommitted($, [...edits.session])) found.set(key(f), f)
    if (before) {
      for (const f of (await dirty($, await $.session.cwd())) ?? []) if (!before.has(key(f))) found.set(key(f), f)
    }
    const left = [...found.values()]
    if (!left.length) return r
    const more = left.length > 10 ? ` and ${left.length - 10} more` : ''
    $.ui.log(`Uncommitted (${left.length}): ${left.slice(0, 10).join(', ')}${more}`)
    carried.add(`[clean-tree-on-done] Your last reply said the work was finished, but ${left.length} file(s) changed this session are not committed: ` +
      `${left.slice(0, 10).join(', ')}${more}. The user saw a notice listing them. Commit only if they ask; otherwise do not mention it again.`)
    return r
  })
}
