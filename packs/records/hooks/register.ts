import type { Register } from 'claude-code'
import { cleanTreeOnDone } from './clean-tree-on-done'
import { dbSnapshot } from './db-snapshot'
import { DEFAULT_DOCS, docAgeStamp } from './doc-age-stamp'
import { heartbeat } from './heartbeat'
import { neverRevert } from './never-revert'
import { EditLog, isAbs, join } from './paths'
import { listenForApprovals, SignOff } from './signoff'
import { turnLedger } from './turn-ledger'

export const register: Register = (on, options) => {
  const signOff = new SignOff()
  const minutes = Number(options.approvalMinutes ?? 15) || 15
  const edits = new EditLog()

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e: any, next) => {
    const r = await next(e)
    const fp = e.file_path ?? e.notebook_path
    if (r.deny === undefined && !r.isError && typeof fp === 'string') edits.add(isAbs(fp) ? fp : join(await $.session.cwd(), fp))
    return r
  })

  if (options.cleanTreeOnDone !== false) cleanTreeOnDone(on, edits)
  if (options.docAgeStamp !== false) {
    const patterns = String(options.docPatterns || DEFAULT_DOCS).split(',').map(s => s.trim()).filter(Boolean)
    docAgeStamp(on, patterns)
  }
  if (options.neverRevert !== false) neverRevert(on, signOff, String(options.neverRevertFile || '.claude/never-revert.txt'))
  if (options.dbSnapshot !== false) {
    dbSnapshot(on, signOff, {
      dir: String(options.snapshotDir || '~/.claude/guardrails/db-snapshots'),
      keep: Math.max(1, Number(options.snapshotKeep ?? 3) || 3),
      everyMinutes: Math.max(0, Number(options.snapshotEveryMinutes ?? 30)),
    })
  }
  if (options.turnLedger !== false) turnLedger(on, edits, String(options.ledgerDir || '~/.claude/guardrails/ledger'), options.ledgerPrompts !== false)

  heartbeat(on, String(options.heartbeatDir ?? '').trim(), 'guardrails-records')
  listenForApprovals(on, signOff, minutes, 'guardrails-records')
}
