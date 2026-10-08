import type { Register } from 'claude-code'
import { agentHold } from './agent-hold'
import { replyPolicy } from './reply-policy'
import { staleNumberFlag } from './stale-number-flag'

const PACKS = ['guardrails-approval', 'guardrails-records', 'guardrails-monitoring', 'guardrails-development', 'guardrails-outcomes', 'guardrails-challenge']

export const register: Register = (on, options) => {
  const beatDir = String(options.heartbeatDir ?? '').trim()
  const watchdog = options.controlsWatchdog !== false && !!beatDir
  const policy = options.replyPolicy === true

  if (options.agentHold !== false) {
    agentHold(on, String(options.agentHoldDir || '~/.claude/guardrails/agent-hold'), {
      ttlMinutes: Number(options.agentHoldTtlMinutes ?? 120) || 120,
      graceSeconds: Number(options.agentHoldGraceSeconds ?? 60),
      block: options.agentHoldBlock === true,
    }, options.agentNameStrip !== false)
  }
  if (policy) {
    replyPolicy(on, {
      policyFile: String(options.replyPolicyFile ?? '').trim(),
      model: String(options.replyPolicyModel || 'sonnet'),
      logDir: String(options.replyPolicyLogDir ?? '~/.claude/guardrails/reply-policy').trim(),
    })
  }
  if (options.staleNumberFlag !== false) {
    staleNumberFlag(on, String(options.notesPaths || '/memory/, /notes/').split(',').map(s => s.trim()).filter(Boolean))
  }
  // One session-start hook per pack: commands, then this pack's heartbeat.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (policy) await $.command.register({ name: 'full-reply', description: 'Show the last reply reply-policy shortened, as originally written' })
    if (watchdog) await $.command.register({ name: 'guardrails-status', description: 'Show when each guardrail pack last loaded' })
    if (beatDir) {
      const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
      await $.fs.write(`${beatDir.replace(/^~(?=[\\/]|$)/, home).replace(/[\\/]+$/, '')}/guardrails-monitoring.txt`, new Date(await $.clock.now()).toISOString())
    }
    return r
  })

  if (watchdog) {
    on('command.run', { command: 'guardrails-status' }, async ($) => {
      const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
      const dir = beatDir.replace(/^~(?=[\\/]|$)/, home)
      const entries: any[] = await $.fs.list(dir).catch(() => [])
      const now = await $.clock.now()
      const lines = PACKS.map(p => {
        const hit = entries.find(x => x.name === `${p}.txt`)
        if (!hit) return `${p}: never loaded`
        const min = Math.round((now - hit.mtimeMs) / 60_000)
        return `${p}: last loaded ${min < 1 ? 'just now' : min < 120 ? `${min} min ago` : `${Math.round(min / 60)} h ago`}`
      })
      return { text: ['Guardrail packs, by last load:', ...lines].join('\n') }
    })
  }
}
