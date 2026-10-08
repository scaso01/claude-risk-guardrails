// Copied from shared/signoff.ts by scripts/sync-shared.sh. Edit the original.
// One-time human sign-off. A guard refuses an action and shows a code; the action may run
// once after the person types "approve <code>" themselves. The model cannot approve: only a
// prompt the engine stamps as the person's own (terminal or Remote Control) counts.

import type { On } from 'claude-code'

export const HUMAN_ORIGINS = new Set(['composer', 'bridge'])

type Pending = { key: string; approvedUntil?: number }

export class SignOff {
  private pending = new Map<string, Pending>()

  constructor(private random: () => number = Math.random) {}

  /** The code for `key`, reusing an open one so a retry shows the same code. */
  codeFor(key: string): string {
    for (const [code, p] of this.pending) if (p.key === key && p.approvedUntil === undefined) return code
    let code: string
    do code = 'G-' + String(Math.floor(this.random() * 9000) + 1000)
    while (this.pending.has(code))
    this.pending.set(code, { key })
    return code
  }

  /** Records approvals found in a prompt; returns the codes it approved. */
  approveFrom(text: string, originKind: string, now: number, minutes: number): string[] {
    if (!HUMAN_ORIGINS.has(originKind)) return []
    const out: string[] = []
    for (const m of text.matchAll(/\bapprove\s+(G-\d{4})\b/gi)) {
      const code = m[1]!.toUpperCase()
      const p = this.pending.get(code)
      if (!p) continue
      p.approvedUntil = now + minutes * 60_000
      out.push(code)
    }
    return out
  }

  /** True once per approval: consumes it. */
  consume(key: string, now: number): boolean {
    for (const [code, p] of this.pending) {
      if (p.key !== key || p.approvedUntil === undefined) continue
      this.pending.delete(code)
      if (p.approvedUntil >= now) return true
    }
    return false
  }
}

export const signOffText = (code: string) =>
  `This needs a human sign-off. Stop and ask the user. If they agree, they type ` +
  `"approve ${code}" themselves, and then you may run the exact same command once.`

/** Turns the person's own "approve G-1234" into an approval, and tells the model it landed. */
export function listenForApprovals(on: On, signOff: SignOff, minutes: number, pack: string) {
  on('prompt.submit', async ($, e, next) => {
    const codes = signOff.approveFrom(e.text, e.origin?.kind ?? '', await $.clock.now(), minutes)
    if (!codes.length) return next(e)
    const note = `[${pack}] The user approved ${codes.join(', ')}. The held action may run once, unchanged, within ${minutes} minutes.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))
}
