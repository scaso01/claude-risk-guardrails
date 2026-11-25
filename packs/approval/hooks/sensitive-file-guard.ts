import type { On } from 'claude-code'

const END = '(?=\\n?$)'
const SETTINGS_REASON = "Claude Code's own settings, which control these guardrails"
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
    return SETTINGS_REASON
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

// A spelling proves little once links are involved: a plain-looking path can land on a protected
// file, and the settings file can itself be a link to a plain-looking one.
const SETTINGS_FILES = ['settings.json', 'settings.local.json']
const fold = (p: string, home: string) => normalize(p, home).toLowerCase()

/** Where `path` lands with links followed; a file not there yet lands in its followed folder. */
async function landing($: any, path: string): Promise<string | undefined> {
  const real = async (p: string): Promise<string | undefined> => {
    try {
      return (await $.fs.stat(p, { resolve: true })).realPath
    } catch {
      return undefined
    }
  }
  const own = await real(path)
  if (own) return own
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dir = await real(cut < 0 ? '.' : path.slice(0, cut + 1))
  return dir === undefined ? undefined : `${dir.replace(/[\\/]$/, '')}/${path.slice(cut + 1)}`
}

/** Where the settings files land, in comparable form. */
async function settingsLandings($: any, home: string): Promise<string[]> {
  if (!home) return []
  const landed = await Promise.all(SETTINGS_FILES.map(name => landing($, `${home}/.claude/${name}`)))
  return landed.filter((p): p is string => p !== undefined).map(p => fold(p, home))
}

/** Why a write to `filePath` is refused, by its spelling or by where it lands, or undefined. */
export async function protectedReason($: any, filePath: string, home: string, settings?: string[]): Promise<string | undefined> {
  const spelled = sensitiveReason(filePath, home)
  if (spelled) return spelled
  const landed = await landing($, filePath.replace(/^~(?=[\\/])/, () => home))
  if (landed === undefined) return undefined
  const followed = sensitiveReason(landed, home)
  if (followed) return followed
  return (settings ?? (await settingsLandings($, home))).includes(fold(landed, home)) ? SETTINGS_REASON : undefined
}

async function shellHit($: any, command: string, home: string): Promise<{ path: string; reason: string } | undefined> {
  const paths = shellWritePaths(command)
  if (!paths.length) return undefined
  const settings = await settingsLandings($, home)
  for (const frag of paths) {
    const reason = await protectedReason($, frag, home, settings)
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
    const reason = typeof fp === 'string' && fp ? await protectedReason($, fp, await home($)) : undefined
    if (reason) return { deny: `[sensitive-file-guard] Refused: ${fp} is protected (${reason}). Ask the user to make this change by hand.` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[sensitive-file-guard] Refused: the guard could not check this path.' }))

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const hit = typeof e.command === 'string' ? await shellHit($, e.command, await home($)) : undefined
    if (hit) return { deny: `[sensitive-file-guard] Refused: this command writes to ${hit.path}, which is protected (${hit.reason}). Ask the user to make this change by hand.` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[sensitive-file-guard] Refused: the guard could not check this command.' }))
}
