// Agent hold, pure logic. While background agents run, their reports are saved and the model
// answers each with one line; when the last one finishes, every saved report comes back in one
// message to review together. The user's own prompts pass with a note. No I/O here.

export type Agent = { type: string; started: number; finished?: number }
export type Held = { at: number; id: string; text: string }
export type HoldState = {
  agents: Record<string, Agent>
  held: Held[]
  queued: { at: number; text: string }[]
  disabled: boolean
  releasePending: boolean
}
export type LogRow = { kind: string; [k: string]: unknown }
export type Outcome = { context?: string; block?: string; release?: boolean; log: LogRow[] }

export const emptyState = (): HoldState => ({ agents: {}, held: [], queued: [], disabled: false, releasePending: false })
export const isIdle = (s: HoldState) => !Object.keys(s.agents).length && !s.held.length && !s.queued.length && !s.disabled && !s.releasePending

const TASK_ID = /<task-id>\s*([^<\s]+)\s*<\/task-id>/
const TASK_STATUS = /<status>\s*(\w+)\s*<\/status>/
const STILL_RUNNING = /stopped with background work of its own still running/i
const AGENT_MSG = /<agent-message\s+from="([^"]+)"/
const FINAL_REPORT = /\[Subagent hand-back\][^\n]*is the final report of a subagent/i
const TEAMMATE = /<teammate-message\s+teammate_id="([^"]+)"/
const STOPPED_BY_USER = /Background agent [\s\S]{0,200}? was stopped by the user/
const PEER = /<channel source="claude-peers"|<cross-session-message/i
const INTERRUPT = /\b(stop|cancel|kill|abort|wait|answer now|urgent)\b/i
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const PLAIN_AGENT_ID = /^a[0-9a-f]{16}$/

export type HoldConfig = { ttlMinutes: number; graceSeconds: number; block: boolean }

/** The main session's id. A subagent's events may carry its own session id, so read the transcript path. */
export function sessionKey(transcriptPath: string | undefined, sessionId: string | undefined): string {
  const p = (transcriptPath ?? '').replace(/\\/g, '/')
  const sub = new RegExp(`(${UUID})/subagents/`).exec(p)
  if (sub) return sub[1]!
  const main = new RegExp(`(${UUID})\\.jsonl$`).exec(p)
  if (main) return main[1]!
  return sessionId || 'unknown'
}

const iso = (t: number) => new Date(t).toISOString()
const countLine = (s: HoldState) => { const n = Object.keys(s.agents).length; return `${n} agent${n === 1 ? '' : 's'} running.` }

function matchAgent(s: HoldState, ref: string): string | undefined {
  if (s.agents[ref]) return ref
  return Object.keys(s.agents).find(a => ref && (a.includes(ref) || ref.includes(a)))
}

function overdue(s: HoldState, now: number, cfg: HoldConfig): boolean {
  const ids = Object.keys(s.agents)
  if (!ids.length) return false
  const held = new Set(s.held.map(h => h.id))
  return ids.every(a => {
    const fin = s.agents[a]!.finished
    return fin !== undefined && (held.has(a) || fin <= now - cfg.graceSeconds * 1000)
  })
}

function dropStale(s: HoldState, now: number, cfg: HoldConfig) {
  for (const [a, m] of Object.entries(s.agents)) {
    if (m.started < now - cfg.ttlMinutes * 60_000) {
      delete s.agents[a]
      s.held.push({ at: now, id: a, text: `[dropped stale agent ${a} (${m.type}) after ${cfg.ttlMinutes} min with no report]` })
    }
  }
}

function hold(s: HoldState, cfg: HoldConfig, extra: string): Pick<Outcome, 'context' | 'block'> & { how: string } {
  const n = countLine(s)
  if (cfg.block) return { block: n, how: 'block' }
  return { context: `[agent-hold] ${n} Reply with exactly one line and nothing else: "${n}" ${extra}`, how: 'instruct' }
}

export function releaseText(s: HoldState, note = ''): string {
  const h = s.held.length, q = s.queued.length
  const out = [
    `[agent-hold] ALL AGENTS DONE (${h} report-back${h === 1 ? '' : 's'} held, ${q} prompt${q === 1 ? '' : 's'} queued while they ran). ` +
      'Reply with ONE message: first the consolidated picture from every report-back below, then one answer per queued ' +
      'prompt. No status line, no recap of what ran, no per-agent headers unless findings conflict.',
  ]
  if (note) out.push(note)
  s.held.forEach((x, i) => out.push(`\n=== Held report-back ${i + 1} (${x.id}, ${iso(x.at)}) ===\n${x.text}`))
  s.queued.forEach((x, i) => out.push(`\n=== Queued prompt ${i + 1} from the user (${iso(x.at)}) ===\n${x.text}`))
  return out.join('\n')
}

function release(s: HoldState, note = ''): Outcome {
  const text = releaseText(s, note)
  const row = { kind: 'release', held: s.held.length, queued: s.queued.length }
  Object.assign(s, emptyState())
  return { context: text, release: true, log: [row] }
}

export function onSubagentStart(s: HoldState, id: string, type: string, now: number): LogRow[] {
  if (!PLAIN_AGENT_ID.test(id)) return [{ kind: 'skip-teammate', agent: id, type }]
  s.agents[id] = { type, started: now }
  return [{ kind: 'start', agent: id, type }]
}

export function onSubagentStop(s: HoldState, id: string, type: string, now: number): LogRow[] {
  if (!s.agents[id]) return []
  s.agents[id]!.finished = now
  return [{ kind: 'stop', agent: id, type }]
}

export function onSessionStart(s: HoldState, source: string, now: number): Outcome {
  if (!Object.keys(s.agents).length && !s.held.length && !s.queued.length) return { log: [] }
  if (source === 'compact') {
    return {
      context: `[agent-hold] Active: ${countLine(s)} ${s.held.length} report-back(s) held on disk, delivered in one message when the last agent finishes. Say nothing about them until then.`,
      log: [{ kind: 'compact-notice', agents: Object.keys(s.agents).length }],
    }
  }
  if (['startup', 'resume', 'clear'].includes(source)) {
    const n = Object.keys(s.agents).length
    if (n) {
      s.held.push({ at: now, id: 'restart', text: `[hold ended by restart: ${n} agent(s) did not survive the process]` })
      s.agents = {}
    }
    s.releasePending = !!(s.held.length || s.queued.length)
    return { log: [{ kind: 'restart', releasePending: s.releasePending }] }
  }
  return { log: [] }
}

export function onPrompt(s: HoldState, prompt: string, now: number, cfg: HoldConfig): Outcome {
  dropStale(s, now, cfg)
  const cmd = prompt.trim().toLowerCase()
  if (cmd === 'hold off' || cmd === 'hold on' || cmd === 'hold status') {
    let context: string
    if (cmd === 'hold off') { s.disabled = true; context = "[agent-hold] Disabled for this session (say 'hold on' to re-enable)." }
    else if (cmd === 'hold on') { s.disabled = false; context = '[agent-hold] Enabled for this session.' }
    else context = `[agent-hold] ${s.disabled ? 'disabled' : 'enabled'}; ${countLine(s)} ${s.held.length} held, ${s.queued.length} queued.`
    return { context, log: [{ kind: 'command', command: cmd }] }
  }
  if (s.releasePending) {
    s.releasePending = false
    return release(s, 'The hold ended when the session restarted; the report-backs below were saved before that.')
  }
  if (s.disabled) return { log: [] }

  const task = prompt.includes('<task-notification>') ? TASK_ID.exec(prompt) : null
  const agentMsg = AGENT_MSG.exec(prompt)
  const team = TEAMMATE.exec(prompt)
  const active = Object.keys(s.agents).length > 0

  if (task) {
    const tid = task[1]!
    const aid = matchAgent(s, tid)
    const status = TASK_STATUS.exec(prompt)?.[1] ?? ''
    if (aid) {
      s.held.push({ at: now, id: aid, text: prompt })
      if (!STILL_RUNNING.test(prompt)) delete s.agents[aid]
      else delete s.agents[aid]!.finished
    }
    if (Object.keys(s.agents).length) {
      const h = hold(s, cfg, aid
        ? 'This agent report is saved and will be summarized in one message when the last agent finishes. Do not summarize, quote, or act on it now.'
        : 'This is not an agent report. Act on it only if your own work needs it.')
      return { context: h.context, block: h.block, log: [{ kind: h.how, why: aid ? 'task-notification' : 'other-task', agent: aid ?? tid, status }] }
    }
    if (aid || s.held.length || s.queued.length) return release(s)
    return { log: [] }
  }

  if (agentMsg) {
    const aid = matchAgent(s, agentMsg[1]!) ?? agentMsg[1]!
    if (!active) return { log: [] }
    const finished = s.agents[aid]?.finished !== undefined
    s.held.push({ at: now, id: aid, text: prompt })
    const log: LogRow[] = []
    if (finished || FINAL_REPORT.test(prompt)) {
      if (!finished) log.push({ kind: 'wording-only-release', agent: aid })
      delete s.agents[aid]
      if (!Object.keys(s.agents).length) { const r = release(s); r.log.unshift(...log); return r }
    }
    const h = hold(s, cfg, 'This hand-back is saved and will be summarized in one message when the last agent finishes. Do not summarize, quote, or act on it now.')
    return { context: h.context, block: h.block, log: [...log, { kind: h.how, why: 'agent-message', agent: aid }] }
  }

  if (STOPPED_BY_USER.test(prompt)) {
    s.held.push({ at: now, id: 'stopped', text: prompt.trim().slice(0, 500) })
    if (Object.keys(s.agents).length === 1) s.agents = {}
    if (!Object.keys(s.agents).length) return release(s)
    const h = hold(s, cfg, 'That agent is recorded as stopped.')
    return { context: h.context, block: h.block, log: [{ kind: h.how, why: 'stopped-by-user' }] }
  }

  if (!active || PEER.test(prompt) || team) return { log: [] }

  if (prompt.includes('<task-notification>') || prompt.includes('<task-id>')) {
    const h = hold(s, cfg, 'This is not an agent report. Act on it only if your own work needs it.')
    return { context: h.context, block: h.block, log: [{ kind: h.how, why: 'other-task' }] }
  }

  if (INTERRUPT.test(prompt)) return { log: [{ kind: 'pass', why: 'interrupt-word' }] }

  if (overdue(s, now, cfg)) {
    s.queued.push({ at: now, text: prompt })
    const held = new Set(s.held.map(h => h.id))
    const missing = Object.keys(s.agents).filter(a => !held.has(a))
    const row = { kind: 'grace-release', agents: Object.keys(s.agents), missing }
    const r = release(s, missing.length
      ? "[agent-hold] WARNING: an agent finished but its report never reached the hold. Tell the user in one plain line that the agent hold needs a look (see the hold's event log)."
      : '')
    r.log.unshift(row)
    return r
  }

  return {
    context: `[agent-hold] ${countLine(s)} Answer the user's message now. Do not summarize or act on agent results unless they ask; those arrive together in one message when the last agent finishes.`,
    log: [{ kind: 'pass-with-note', why: 'user-prompt' }],
  }
}

/** Launch text that means the agent must message others, so it keeps its name. */
const W = '[\\p{L}\\p{N}_]'
const KEEP = new RegExp(
  `SendMessage|ListAgents|teammate|(?<!${W})team(?!${W})|(?<!${W})messag(e|es|ing)(?!${W})|coordinat|` +
    `(?<!${W})reply to(?!${W})|(?<!${W})report to(?!${W})|(?<!${W})talk to(?!${W})|(?<!${W})hand(s|ed)? off to(?!${W})`,
  'iu',
)

/** A named agent becomes a teammate whose report bypasses the hold, so names are dropped unless needed. */
export function nameDecision(input: Record<string, unknown>): { action: 'strip' | 'keep' | 'none'; reason: string } {
  if (!input.name) return { action: 'none', reason: 'unnamed' }
  if (input.isolation === 'remote') return { action: 'keep', reason: 'remote agent' }
  const text = [input.prompt, input.description].filter(x => typeof x === 'string').join(' ')
  const m = KEEP.exec(text)
  if (m) return { action: 'keep', reason: `launch text mentions '${m[0]}'` }
  return { action: 'strip', reason: 'no messaging in launch text' }
}
