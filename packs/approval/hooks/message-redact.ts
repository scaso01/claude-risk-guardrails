import type { On } from 'claude-code'

// Messages to other agents and sessions leave this session's control. Known credential
// formats are replaced with [REDACTED] before the message is sent. The patterns match
// formats, never words, so "risk-adjusted" or "task-backup" are left alone.

const SECRET = new RegExp([
  String.raw`(?<![A-Za-z0-9])sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_\-]{20,}`,
  String.raw`(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}`,
  String.raw`(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}`,
  String.raw`(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Z0-9])`,
  String.raw`(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9\-]{10,}`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`,
  String.raw`[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9_\-.=]{24,}`,
  String.raw`(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Pp][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn])\s*[=:]\s*["']?[^\s"'<>{}$]{8,}`,
].join('|'), 'g')
const PLACEHOLDER = /(x{4,}|\*{3,}|<[^>]+>|\$\{?\w+|your[_-]|example|changeme|placeholder|redacted|dummy|test123|\.\.\.)/i
const mixed = (s: string) => /\d/.test(s) && /[A-Za-z]/.test(s)

/** Credential-shaped substrings, skipping placeholders and all-letter or all-digit values. */
export function secretHits(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(SECRET)) {
    const v = m[0]
    if (PLACEHOLDER.test(v)) continue
    const body = v.split(/[=:\s]+/).slice(1).join(' ') || v
    if (!v.includes('PRIVATE KEY') && !mixed(body)) continue
    out.push(v)
  }
  return out
}

function scrub(value: unknown, hits: string[]): unknown {
  if (typeof value === 'string') {
    let s = value
    for (const h of secretHits(value)) { hits.push(h); s = s.split(h).join('[REDACTED]') }
    return s
  }
  if (Array.isArray(value)) return value.map(v => scrub(v, hits))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, hits)]))
  return value
}

/** The tool's input with every secret replaced, and how many were found. */
export function redact(input: Record<string, unknown>): { input: Record<string, unknown>; count: number } {
  const hits: string[] = []
  const out = scrub(input, hits) as Record<string, unknown>
  return { input: out, count: hits.length }
}

export const toolPattern = (globs: string[]) =>
  new RegExp(`^(?:${globs.map(g => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).join('|')})$`)

const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

export function messageRedact(on: On, tools: string[]) {
  on('tool.call', { tool: toolPattern(tools) }, async ($, e: any, next) => {
    const input = Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))
    const { input: clean, count } = redact(input)
    if (!count) return next(e)
    const r = await next({ ...e, ...clean })
    if (r.deny !== undefined) return r
    $.ui.status(`message-redact: removed ${count} secret(s) from a ${e.tool} message`)
    return { ...r, context: [...(r.context ?? []), `[message-redact] ${count} secret(s) in this message were replaced with [REDACTED] before it was sent. Never put credentials in messages; point to where they are stored instead.`] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[message-redact] Refused: the message could not be checked for secrets, so it was not sent.' }))
}
