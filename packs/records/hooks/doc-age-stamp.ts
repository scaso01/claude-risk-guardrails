import type { On } from 'claude-code'
import { baseOf, dirOf, globMatch } from './paths'

export const DEFAULT_DOCS = 'HANDOFF*.md, HANDOFF*.txt, STATUS*.md, TODO*.md, NEXT*.md, PLAN*.md, *handoff*.md, *status*.md'

export const isTrackedDoc = (path: string, patterns: string[]) => patterns.some(p => globMatch(p, baseOf(path)))

export function ageNote(file: string, days: number, commitsSince: number, dirty: boolean): string | undefined {
  if (commitsSince < 1 && !dirty) return undefined
  const age = days < 1 ? 'today' : days < 2 ? '1 day ago' : `${Math.floor(days)} days ago`
  const parts = [`[doc-age-stamp] ${baseOf(file)} was last committed ${age}`]
  if (commitsSince > 0) parts.push(`and ${commitsSince} commit${commitsSince === 1 ? ' has' : 's have'} landed since`)
  const tail = dirty ? ' The working tree also has uncommitted changes.' : ''
  return `${parts.join(', ')}.${tail} Treat it as a draft: check its claims against the code before acting on them.`
}

async function docAge($: any, file: string): Promise<string | undefined> {
  const dir = dirOf(file)
  const run = (args: string[]) => $.process.run(['git', '-C', dir, ...args], { timeoutMs: 15_000 }).catch(() => undefined)
  const last = await run(['log', '-1', '--format=%H %ct', '--', file])
  if (last?.exitCode !== 0) return undefined
  const [hash, ts] = last.stdout.trim().split(' ')
  if (!hash) return `[doc-age-stamp] ${baseOf(file)} has never been committed, so nothing shows how current it is. Treat it as a draft.`
  const count = await run(['rev-list', '--count', `${hash}..HEAD`])
  const dirty = await run(['status', '--porcelain'])
  const days = ((await $.clock.now()) / 1000 - Number(ts)) / 86400
  return ageNote(file, days, Number(count?.stdout.trim() || 0), !!dirty?.stdout.trim())
}

export function docAgeStamp(on: On, patterns: string[]) {
  on('tool.call', { tool: 'Read' }, async ($, e: any, next) => {
    const r = await next(e)
    const fp = e.file_path
    if (r.deny !== undefined || r.isError || typeof fp !== 'string' || !isTrackedDoc(fp, patterns)) return r
    const note = await docAge($, fp).catch(() => undefined)
    return note ? { ...r, context: [...(r.context ?? []), note] } : r
  })
}
