import type { Register } from 'claude-code'
import { auditNote, claimedShas, evidence } from './commit-claim-audit'
import { heartbeat } from './heartbeat'
import { isChallenge, pushbackNote } from './pushback-check'

const MAX_SHAS = 3

async function gitShow($: any, cwd: string, sha: string): Promise<{ found: boolean; stat: string }> {
  const r = await $.process.run(['git', '-C', cwd, 'show', '--stat', '--format=%h %s (%an, %ar)', sha], { timeoutMs: 15_000 })
  return { found: r.exitCode === 0, stat: r.stdout }
}

export const register: Register = (on, options) => {
  if (options.pushbackCheck !== false) {
    on('prompt.submit', async ($, e, next) => {
      if (!isChallenge(e.text)) return next(e)
      return next({ ...e, context: [...(e.context ?? []), pushbackNote] })
    }).catch(($, e, next) => next(e))
  }

  if (options.commitClaimAudit !== false) {
    on('tool.call', { tool: 'Agent' }, async ($, e: any, next) => {
      const r = await next(e)
      if (r.deny !== undefined || r.isError) return r
      const report = typeof r.text === 'string' ? r.text : JSON.stringify(r.result ?? '')
      const shas = claimedShas(report).slice(0, MAX_SHAS)
      if (!shas.length) return r
      const cwd = await $.session.cwd()
      const parts: string[] = []
      for (const sha of shas) {
        const { found, stat } = await gitShow($, cwd, sha).catch(() => ({ found: false, stat: '' }))
        parts.push(evidence(sha, found, stat, cwd))
      }
      return { ...r, context: [...(r.context ?? []), auditNote(parts)] }
    }).catch(($, e, next) => next(e))
  }

  heartbeat(on, String(options.heartbeatDir ?? '').trim(), 'guardrails-challenge')
}
