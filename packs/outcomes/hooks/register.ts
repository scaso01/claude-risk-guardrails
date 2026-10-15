import type { Register } from 'claude-code'
import { heartbeat } from './heartbeat'
import { inventoryNote, uncountedClaim } from './inventory-gate'
import { fidelityNote, pastedSource, transcriptSources, unsupported } from './source-fidelity'

const HISTORY_CAP = 2_000_000

export const register: Register = (on, options) => {
  const fidelity = options.sourceFidelity !== false
  const inventory = options.inventoryGate !== false
  const minChars = Math.max(200, Number(options.pasteMinChars ?? 1500) || 1500)
  let prompt = ''
  // Every prompt and tool result this session: a figure read three turns ago is still sourced.
  let history = ''
  const remember = (s: string) => { history = `${history}\n${s}`.slice(-HISTORY_CAP) }

  if (fidelity) {
    on('prompt.submit', async ($, e, next) => { prompt = e.text; remember(e.text); return next(e) })
    on('tool.call', async ($, e, next) => {
      const r = await next(e)
      if (typeof r.text === 'string') remember(r.text)
      else if (r.result !== undefined) remember(JSON.stringify(r.result) ?? '')
      return r
    })
  }

  // One end-of-reply check for the pack; each guardrail adds its note.
  on('classic.Stop', async ($, e: any, next) => {
    const r = await next(e)
    if (e.stop_hook_active || r.block !== undefined) return r
    const reply = String(e.last_assistant_message ?? '')
    if (!reply) return r
    const notes: string[] = []
    if (fidelity) {
      const source = pastedSource(prompt, minChars)
      if (source !== undefined) {
        // In-memory history starts empty whenever the plugin loads mid-session; the transcript does not.
        const path = String(e.transcript_path ?? '')
        const transcript = path ? await $.fs.read(path).then(transcriptSources).catch(() => '') : ''
        const figs = unsupported(reply, `${transcript}\n${history}`)
        if (figs.length) notes.push(fidelityNote(figs))
      }
    }
    if (inventory && uncountedClaim(reply)) notes.push(inventoryNote)
    return notes.length ? { ...r, block: notes.join('\n\n') } : r
  })

  heartbeat(on, String(options.heartbeatDir ?? '').trim(), 'guardrails-outcomes')
}
