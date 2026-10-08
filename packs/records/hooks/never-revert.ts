import type { On } from 'claude-code'
import { dirOf, norm } from './paths'
import { signOffText, type SignOff } from './signoff'

export type Decision = { text: string; reason: string }

/** Rules file lines: `<exact text that must stay> => <why it was decided>`; `#` starts a comment. */
export function parseDecisions(file: string): Decision[] {
  return file.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
    const i = l.lastIndexOf('=>')
    return i > 0 ? { text: l.slice(0, i).trim(), reason: l.slice(i + 2).trim() } : { text: l, reason: '' }
  }).filter(d => d.text)
}

/** Decisions present before an edit and gone after it. */
export const removed = (decisions: Decision[], before: string, after: string) =>
  decisions.filter(d => before.includes(d.text) && !after.includes(d.text))

async function repoRoot($: any, file: string): Promise<string | undefined> {
  const r = await $.process.run(['git', '-C', dirOf(file), 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 }).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.trim() : undefined
}

async function readOr($: any, path: string): Promise<string | undefined> {
  return $.fs.read(path).catch(() => undefined)
}

export function neverRevert(on: On, signOff: SignOff, rulesFile: string) {
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e: any, next) => {
    const fp = e.file_path
    if (typeof fp !== 'string') return next(e)
    const root = await repoRoot($, fp)
    if (!root) return next(e)
    const rulesPath = `${root}/${rulesFile}`
    const rules = await readOr($, rulesPath)
    if (rules === undefined) return next(e)
    const editingRules = norm(fp).toLowerCase() === norm(rulesPath).toLowerCase()
    let before: string, after: string
    if (e.tool === 'Edit') {
      const current = (await readOr($, fp)) ?? ''
      before = String(e.old_string ?? '')
      after = e.replace_all ? current.split(before).join(String(e.new_string ?? '')) : String(e.new_string ?? '')
      if (e.replace_all) before = current
    } else {
      before = (await readOr($, fp)) ?? ''
      after = String(e.content ?? '')
    }
    const hits = editingRules
      ? parseDecisions(before).filter(d => !parseDecisions(after).some(a => a.text === d.text))
      : removed(parseDecisions(rules), before, after)
    if (!hits.length) return next(e)
    const key = `${fp}\u0000${before.length}:${after.length}:${hits.map(h => h.text).join('|')}`
    if (signOff.consume(key, await $.clock.now())) return next(e)
    const what = hits.map(h => `"${h.text}"${h.reason ? ` (${h.reason})` : ''}`).join('; ')
    const lead = editingRules
      ? `[never-revert] Refused: this edit deletes a recorded decision from ${rulesFile}: ${what}.`
      : `[never-revert] Refused: this edit removes code the project decided to keep, per ${rulesFile}: ${what}.`
    return { deny: `${lead} ${signOffText(signOff.codeFor(key))}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[never-revert] Refused: the guard could not check this edit.' }))
}
