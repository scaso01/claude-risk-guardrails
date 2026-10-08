import type { On } from 'claude-code'
import {
  emptyState, isIdle, nameDecision, onPrompt, onSessionStart, onSubagentStart, onSubagentStop, sessionKey,
  type HoldConfig, type HoldState, type LogRow, type Outcome,
} from './hold-core'

// State and log live on disk, so a hold survives compaction and a reload of this module.
// GUARDRAILS_AGENT_HOLD_DIR / _LOG override the folders (a health check points them at a scratch folder).

type Where = { dir: string; log: string }

async function where($: any, dir: string): Promise<Where> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const d = ((await $.env.get('GUARDRAILS_AGENT_HOLD_DIR')) || dir).replace(/^~(?=[\\/]|$)/, home).replace(/[\\/]+$/, '')
  const month = new Date(await $.clock.now()).toISOString().slice(0, 7)
  const log = (await $.env.get('GUARDRAILS_AGENT_HOLD_LOG')) || `${d}/events-${month}.jsonl`
  return { dir: d, log }
}

async function load($: any, w: Where, sid: string): Promise<HoldState> {
  const text: string | undefined = await $.fs.read(`${w.dir}/${sid}.json`).catch(() => undefined)
  if (!text?.trim()) return emptyState()
  return { ...emptyState(), ...JSON.parse(text) }
}

async function save($: any, w: Where, sid: string, s: HoldState): Promise<void> {
  const path = `${w.dir}/${sid}.json`
  if (isIdle(s)) {
    if (await $.fs.exists(path)) await $.fs.write(path, '')
    return
  }
  await $.fs.write(path, JSON.stringify(s))
}

async function writeLog($: any, w: Where, sid: string, rows: LogRow[]): Promise<void> {
  if (!rows.length) return
  const at = new Date(await $.clock.now()).toISOString()
  const prior: string = await $.fs.read(w.log).catch(() => '')
  await $.fs.write(w.log, prior + rows.map(r => JSON.stringify({ at, session: sid, ...r })).join('\n') + '\n')
}

// Events for parallel agents interleave at every await; one queue per session keeps each read-change-write whole.
const queues = new Map<string, Promise<unknown>>()

function step($: any, dir: string, e: any, fn: (s: HoldState, now: number) => Outcome | LogRow[]): Promise<Outcome> {
  const sid = sessionKey(e.transcript_path, e.session_id)
  const run = (queues.get(sid) ?? Promise.resolve()).catch(() => undefined).then(() => stepNow($, dir, sid, fn))
  queues.set(sid, run)
  return run
}

async function stepNow($: any, dir: string, sid: string, fn: (s: HoldState, now: number) => Outcome | LogRow[]): Promise<Outcome> {
  const w = await where($, dir)
  const s = await load($, w, sid)
  const r = fn(s, await $.clock.now())
  const out: Outcome = Array.isArray(r) ? { log: r } : r
  await save($, w, sid, s)
  if (out.release) await $.fs.write(`${w.dir}/${sid}.release`, new Date(await $.clock.now()).toISOString())
  await writeLog($, w, sid, out.log)
  return out
}

export function agentHold(on: On, dir: string, cfg: HoldConfig, stripNames: boolean) {
  on('classic.SubagentStart', async ($, e: any, next) => {
    const r = await next(e)
    await step($, dir, e, (s, now) => onSubagentStart(s, String(e.agent_id ?? '?'), String(e.agent_type ?? '?'), now))
    return r
  })

  on('classic.SubagentStop', async ($, e: any, next) => {
    const r = await next(e)
    await step($, dir, e, (s, now) => onSubagentStop(s, String(e.agent_id ?? '?'), String(e.agent_type ?? '?'), now))
    return r
  })

  on('classic.SessionStart', async ($, e: any, next) => {
    const r = await next(e)
    const out = await step($, dir, e, (s, now) => onSessionStart(s, String(e.source ?? ''), now))
    return out.context ? { ...r, additionalContext: [...(r.additionalContext ?? []), out.context] } : r
  })

  // Awaited before the model sees the prompt, so a held report never reaches it unannounced.
  on('classic.UserPromptSubmit', async ($, e: any, next) => {
    const r = await next(e)
    const out = await step($, dir, e, (s, now) => onPrompt(s, String(e.prompt ?? ''), now, cfg))
    if (out.block !== undefined && r.block === undefined) return { ...r, block: out.block }
    return out.context ? { ...r, additionalContext: [out.context, ...(r.additionalContext ?? [])] } : r
  })

  if (!stripNames) return
  on('tool.call', { tool: 'Agent' }, async ($, e: any, next) => {
    const d = nameDecision(e)
    if (d.action !== 'strip') return next(e)
    const { name: _dropped, ...rest } = e
    return next(rest)
  })
}
