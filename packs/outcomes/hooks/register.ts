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
  // Findings reach the user as a notice and the model with the next prompt, never as a sent-back reply.
  let pending = ''
  // Every prompt and tool result this session: a figure read three turns ago is still sourced.
  let history = ''
  const remember = (s: string) => { history = `${history}\n${s}`.slice(-HISTORY_CAP) }

  on('prompt.submit', async ($, e, next) => {
    if (fidelity) { prompt = e.text; remember(e.text) }
    if (!pending) return next(e)
    const note = pending
    pending = ''
    return next({ ...e, context: [...(e.context ?? []), note] })
  })
  if (fidelity) {
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
        if (figs.length) {
          $.ui.log(`Figures not in your pasted text or any tool result: ${figs.slice(0, 8).join(', ')}${figs.length > 8 ? ` and ${figs.length - 8} more` : ''}`)
          notes.push(fidelityNote(figs))
        }
      }
    }
    if (inventory && uncountedClaim(reply)) {
      $.ui.log('Reply says "all"/"every" without a count.')
      notes.push(inventoryNote)
    }
    if (notes.length) pending = `About your last reply (the user saw a notice): ${notes.join('\n\n')} Correct it at the start of this reply in one line.`
    return r
  })

  heartbeat(on, String(options.heartbeatDir ?? '').trim(), 'guardrails-outcomes')
}
