import type { Register } from 'claude-code'
import { backupFileGuard } from './backup-file-guard'
import { headroomCheck } from './headroom-check'
import { heartbeat } from './heartbeat'
import { messageRedact } from './message-redact'
import { protectedProcess, parseRules } from './protected-process'
import { publishGate } from './publish-gate'
import { sensitiveFileGuard } from './sensitive-file-guard'
import { listenForApprovals, SignOff } from './signoff'
import { staleCopyBand } from './stale-copy-band'

const list = (v: unknown, fallback: string) => String(v || fallback).split(',').map(s => s.trim()).filter(Boolean)

export const register: Register = (on, options) => {
  const signOff = new SignOff()
  const minutes = Number(options.approvalMinutes ?? 15) || 15

  if (options.sensitiveFileGuard !== false) sensitiveFileGuard(on)
  if (options.publishGate !== false) publishGate(on, signOff, { pushes: options.publishGatePushes !== false })
  if (options.protectedProcess !== false) {
    const rules = parseRules(String(options.protectedProcesses ?? ''))
    protectedProcess(on, signOff, () => rules)
  }
  if (options.messageRedact !== false) messageRedact(on, list(options.messageTools, 'SendMessage, mcp__*send_message*'))
  if (options.backupFileGuard !== false) backupFileGuard(on, signOff)
  if (options.headroomCheck !== false) headroomCheck(on, signOff, Math.max(0, Number(options.minFreeGB ?? 10)))
  if (options.staleCopyBand !== false) staleCopyBand(on, signOff, String(options.staleCopyMarker || '.claude/stale-copy.txt'))

  heartbeat(on, String(options.heartbeatDir ?? '').trim(), 'guardrails-approval')
  listenForApprovals(on, signOff, minutes, 'guardrails-approval')
}
