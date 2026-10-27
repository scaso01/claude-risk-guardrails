import type { Register } from 'claude-code'
import { inventoryNote, uncountedClaim } from './inventory-gate'
import { fidelityNote, pastedSource, transcriptSources, unsupported } from './source-fidelity'
import { VERIFY_TOOL_DEF, verifyBeforeAnswer, verifyDeny, verifyPrompt, verifyRecord, verifyState } from './verify-before-answer'

const HISTORY_CAP = 2_000_000

export const register: Register = (on, options) => {
  const fidelity = options.sourceFidelity !== false
  const inventory = options.inventoryGate !== false
  const minChars = Math.max(200, Number(options.pasteMinChars ?? 1500) || 1500)
  const beatDir = String(options.heartbeatDir ?? '').trim()
  const verify = options.verifyBeforeAnswer !== false ? verifyState() : undefined
  let prompt = ''
  // Findings reach the user as a notice and the model with the next prompt, never as a sent-back reply.
  let pending = ''
  // Every prompt and tool result this session: a figure read three turns ago is still sourced.
  let history = ''
  const remember = (s: string) => { history = `${history}\n${s}`.slice(-HISTORY_CAP) }

  // One session-start hook per pack: the checker's tool, then this pack's heartbeat.
  on('session.start', async ($, e, next) => {
    if (verify) await $.tool.register(VERIFY_TOOL_DEF)
    const r = await next(e)
    if (beatDir) {
      const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
      await $.fs.write(`${beatDir.replace(/^~(?=[\\/]|$)/, home).replace(/[\\/]+$/, '')}/guardrails-outcomes.txt`, new Date(await $.clock.now()).toISOString())
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (verify) verifyPrompt(verify, e.text)
    if (fidelity) { prompt = e.text; remember(e.text) }
    if (!pending) return next(e)
    const note = pending
    pending = ''
    return next({ ...e, context: [...(e.context ?? []), note] })
  })
  if (fidelity || verify) {
    on('tool.call', async ($, e, next) => {
      const deny = verify && verifyDeny(verify, e)
      if (deny) return deny
      const r = await next(e)
      if (verify) verifyRecord(verify, e, r)
      if (fidelity) {
        if (typeof r.text === 'string') remember(r.text)
        else if (r.result !== undefined) remember(JSON.stringify(r.result) ?? '')
      }
      return r
    })
  }
  // verify-before-answer: a final reply is checked before it is shown.
  if (verify) verifyBeforeAnswer(on, verify)

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
}
