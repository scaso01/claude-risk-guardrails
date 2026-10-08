import type { On } from 'claude-code'
import type { EditLog } from './paths'

export type LedgerRow = {
  at: string
  session: string
  turn: string
  ended: string
  asked: string
  tools: Record<string, number>
  changed: string[]
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function ledgerFile(dir: string, at: Date): string {
  return `${dir.replace(/[\\/]+$/, '')}/${at.toISOString().slice(0, 10)}.jsonl`
}

export function turnLedger(on: On, edits: EditLog, dir: string, keepPrompts: boolean) {
  let asked = ''
  let tools: Record<string, number> = {}

  on('turn.start', async ($, e, next) => {
    asked = keepPrompts ? clip(String(e.text ?? '').replace(/\s+/g, ' ').trim(), 200) : ''
    tools = {}
    edits.newTurn()
    return next(e)
  })

  on('tool.call', async ($, e: any, next) => {
    if (!e.agentId) tools[e.tool] = (tools[e.tool] ?? 0) + 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = new Date(await $.clock.now())
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const path = ledgerFile(dir.replace(/^~(?=[\\/]|$)/, home), now)
    const row: LedgerRow = {
      at: now.toISOString(), session: await $.session.id(), turn: e.turnId,
      ended: e.isAborted ? 'aborted' : e.reason, asked, tools, changed: [...edits.turn],
    }
    const prior: string = await $.fs.read(path).catch(() => '')
    await $.fs.write(path, prior + JSON.stringify(row) + '\n')
    return r
  })
}
