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

// The file API has no append and no cross-process lock: a write replaces the whole file,
// so two writers sharing one file lose whichever row lands second. Each process writes its
// own file per day instead (session id + a random tag drawn at load, so a session resumed
// in a second process still gets a file of its own), and its turns run one at a time.
export const ROLL_AT = 3 * 1024 * 1024 // reads and writes reject over 4 MiB

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

export function ledgerFile(dir: string, at: Date, session: string, writer: string, part = 0): string {
  let name = session.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown'
  if (RESERVED.test(name)) name = `_${name}`
  const suffix = part ? `.${part}` : ''
  return `${dir.replace(/[\\/]+$/, '')}/${at.toISOString().slice(0, 10)}/${name}.${writer}${suffix}.jsonl`
}

export const writerTag = (random: () => number = Math.random) =>
  Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')

export function turnLedger(on: On, edits: EditLog, dir: string, keepPrompts: boolean, writer = writerTag()) {
  let asked = ''
  let tools: Record<string, number> = {}
  let part = 0

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
    const root = dir.replace(/^~(?=[\\/]|$)/, home)
    const session = await $.session.id()
    const row: LedgerRow = {
      at: now.toISOString(), session, turn: e.turnId,
      ended: e.isAborted ? 'aborted' : e.reason, asked, tools, changed: [...edits.turn],
    }
    const line = JSON.stringify(row) + '\n'
    let path = ledgerFile(root, now, session, writer, part)
    let prior: string = await $.fs.read(path).catch(() => '')
    if (prior.length + line.length > ROLL_AT) {
      part += 1
      path = ledgerFile(root, now, session, writer, part)
      prior = await $.fs.read(path).catch(() => '')
    }
    await $.fs.write(path, prior + line)
    return r
  })
}
