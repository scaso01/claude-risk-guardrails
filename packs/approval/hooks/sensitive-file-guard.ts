import type { On } from 'claude-code'

const END = '(?=\\n?$)'
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `C:\x` and `~/x` to `/c/x`, so one set of patterns covers Windows, Git Bash and Unix paths. */
export function normalize(raw: string, home: string): string {
  const unix = (p: string) => {
    p = p.replace(/\\/g, '/')
    return p.length >= 2 && p[1] === ':' ? '/' + p[0]!.toLowerCase() + p.slice(2) : p
  }
  const h = unix(home)
  let p = raw.replace(/\\/g, '/')
  if (p.startsWith('~/')) p = h + p.slice(1)
  return unix(p)
}

/** Why `filePath` is protected, or undefined. */
export function sensitiveReason(filePath: string, home: string): string | undefined {
  const p = normalize(filePath, home)
  const env = new RegExp(`(^|/)(\\.env|\\.env\\.[^/]+)${END}`, 'iu').exec(p)
  if (env && !/\.(example|sample|template)$/i.test(env[0])) return 'a .env file, which holds API keys or secrets'
  if (/(^|\/)\.ssh\/id_/iu.test(p)) return 'SSH private key'
  if (new RegExp(`\\.(pem|key|p12|pfx)${END}`, 'iu').test(p)) return 'key or certificate file'
  if (/(^|\/)\.git\//u.test(p)) return 'Git internals'
  if (new RegExp(`(^|/)(credentials|secrets?)[^/]*\\.[^/]+${END}`, 'iu').test(p)) return 'possible credentials file'
  if (home && new RegExp(`^${escRe(normalize(home, home))}/\\.claude/settings(\\.local)?\\.json${END}`, 'iu').test(p))
    return "Claude Code's own settings, which control these guardrails"
  return undefined
}

// A shell command can write a file as easily as Edit can. It is held when it both writes
// (redirect, copy, move, delete, an in-place edit or a .NET write) and names a protected path.
const HARMLESS_REDIRECTS = /\d?>&\d|\d?>\s*(\/dev\/null|\$null|nul)\b/gi
const WRITES = /(>>?|\btee\b|\b(Set|Add)-Content\b|\bOut-File\b|\b(New|Copy|Move|Remove|Rename)-Item\b|::(Write|Append)All|\bsed\s+(-\w+\s+)*-i|\b(cp|mv|rm|del|truncate|install)\b)/i

/** Path-like words of a command that writes files; empty when the command writes nothing. */
export function shellWritePaths(command: string): string[] {
  const cmd = command.replace(HARMLESS_REDIRECTS, ' ')
  if (!WRITES.test(cmd)) return []
  return cmd.split(/[\s'"`();,|&<>=]+/).filter(f => f && !f.startsWith('-') && /[./\\~]/.test(f))
}

/** The protected path a shell command writes to, with why, or undefined. */
export function shellTarget(command: string, home: string): { path: string; reason: string } | undefined {
  for (const frag of shellWritePaths(command)) {
    const reason = sensitiveReason(frag, home)
    if (reason) return { path: frag, reason }
  }
  return undefined
}

async function home($: any): Promise<string> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
}

export function sensitiveFileGuard(on: On) {
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e: any, next) => {
    const fp = e.file_path ?? e.notebook_path
    const reason = typeof fp === 'string' && fp ? sensitiveReason(fp, await home($)) : undefined
    if (reason) return { deny: `[sensitive-file-guard] Refused: ${fp} is protected (${reason}). Ask the user to make this change by hand.` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[sensitive-file-guard] Refused: the guard could not check this path.' }))

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const hit = typeof e.command === 'string' ? shellTarget(e.command, await home($)) : undefined
    if (hit) return { deny: `[sensitive-file-guard] Refused: this command writes to ${hit.path}, which is protected (${hit.reason}). Ask the user to make this change by hand.` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[sensitive-file-guard] Refused: the guard could not check this command.' }))
}
