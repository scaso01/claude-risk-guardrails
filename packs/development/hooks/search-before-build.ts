import type { On } from 'claude-code'

// Before building something new, find out whether it already exists. Ported from a Python
// hook proven over a 218-session replay: a large new code file, a large Edit, or a shell
// redirect that writes code is held until the session shows research.

export const CODE_EXT = ['py', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'sh', 'ps1', 'psm1', 'rs', 'go', 'java', 'rb', 'kt',
  'swift', 'c', 'cpp', 'h', 'cs', 'sql', 'vue', 'svelte']
export const MIN_LINES = 10
export const MIN_EDIT_ADDED = 60
const MAX_BLOCKS_PER_SESSION = 3
export const OPT_OUT = ['skip the search gate', 'no research needed', "don't search first"]

// Longest first so `.tsx` is never read as `.ts`; the lookarounds keep `.json` and `a.py -> b.py` out.
const EXT_ALT = [...CODE_EXT].sort((a, b) => b.length - a.length || a.localeCompare(b)).join('|')
const REDIRECT = new RegExp(`(?<![-\\w])>>?\\s*(['"]?)([^\\s'"|;&>]+\\.(?:${EXT_ALT}))\\1(?=$|[\\s'";|&>)])`, 'g')
const WRITER = new RegExp(`(?:\\btee\\s+(?:-a\\s+)?|\\bcurl\\b[^|;&\\n]*?\\s-o\\s+|\\bOut-File\\s+(?:-FilePath\\s+)?|\\bSet-Content\\s+(?:-Path\\s+)?)(['"]?)([^\\s'"|;&>]+\\.(?:${EXT_ALT}))\\1(?=$|[\\s'";|&>)])`, 'gi')
const CD = /(?:^|[|;&\n])\s*(?:cd|Set-Location|pushd)\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))/g
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/
const UNRESOLVABLE = /[$`*?]/

const ext = (p: string) => { const b = p.replace(/\\/g, '/').split('/').pop() ?? ''; const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : '' }
const lines = (s: unknown) => (typeof s === 'string' ? (s.match(/\n/g) ?? []).length : 0)
const isAbs = (p: string) => /^([A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(p)

export function isTestFile(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase()
  const base = p.split('/').pop() ?? ''
  return base.startsWith('test_') || base.startsWith('_') || base.includes('_test.') || base.includes('.test.') ||
    base.includes('.spec.') || p.includes('/tests/') || p.includes('/test/') || p.includes('/__tests__/')
}

/** Removes heredoc bodies so a redirect written inside one is not read as real. */
export function stripHeredocs(command: string): string {
  const src = command.split('\n'), out: string[] = []
  for (let i = 0; i < src.length; i++) {
    out.push(src[i]!)
    const m = HEREDOC.exec(src[i]!)
    if (m) { i++; while (i < src.length && src[i]!.trim() !== m[2]) i++ }
  }
  return out.join('\n')
}

function resolve(raw: string, command: string, upto: number, cwd: string): string | undefined {
  if (UNRESOLVABLE.test(raw)) return undefined
  if (isAbs(raw)) return raw
  let base = cwd
  let last: RegExpExecArray | undefined
  for (const m of command.slice(0, upto).matchAll(CD)) last = m as RegExpExecArray
  if (last) {
    const dir = last[1] ?? last[2] ?? last[3] ?? ''
    if (UNRESOLVABLE.test(dir)) return undefined
    base = isAbs(dir) ? dir : `${base}/${dir}`
  }
  return base ? `${base.replace(/[\\/]+$/, '')}/${raw}` : undefined
}

export type Candidate = { path: string; lines: number; isEdit: boolean }

/** Every file this call would create or grow by enough to count as building something new. */
export function candidates(tool: string, input: Record<string, unknown>, cwd: string): Candidate[] {
  if (tool === 'Write') return [{ path: String(input.file_path ?? ''), lines: lines(input.content) + 1, isEdit: false }]
  if (tool === 'Edit') {
    const added = lines(input.new_string) - lines(input.old_string)
    return added >= MIN_EDIT_ADDED ? [{ path: String(input.file_path ?? ''), lines: added, isEdit: true }] : []
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const raw = String(input.command ?? '')
    const n = lines(raw) + 1
    const cmd = stripHeredocs(raw)
    const hits = [...cmd.matchAll(REDIRECT), ...cmd.matchAll(WRITER)].sort((a, b) => a.index! - b.index!)
    return hits.flatMap(m => { const p = resolve(m[2]!, cmd, m.index!, cwd); return p ? [{ path: p, lines: n, isEdit: false }] : [] })
  }
  return []
}

export function gatedByShape(c: Candidate, skip: string[]): boolean {
  if (!c.path || !CODE_EXT.includes(ext(c.path))) return false
  if (!c.isEdit && c.lines < MIN_LINES) return false
  const low = c.path.replace(/\\/g, '/').toLowerCase()
  return !skip.some(s => s && low.includes(s.toLowerCase())) && !isTestFile(c.path)
}

/** `Tool` or `Tool:kind`, where kind is an agent's subagent_type or a skill's name; `*` is a wildcard. */
export function isResearch(tool: string, input: Record<string, unknown>, allow: string[]): boolean {
  const kind = String(input.subagent_type ?? input.skill ?? '')
  return allow.some(a => {
    const [t, k] = a.split(':').map(s => s.trim())
    const re = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')
    return re(t!).test(tool) && (k === undefined || re(k).test(kind))
  })
}

async function evidence($: any, allow: string[]): Promise<{ found: boolean; lastUser: string }> {
  const rows: any[] = await $.session.messages()
  let found = false, lastUser = ''
  for (const m of rows) {
    if (m.role === 'user' && m.text) lastUser = m.text
    for (const u of m.toolUses ?? []) if (isResearch(String(u.tool), u.input ?? {}, allow)) found = true
  }
  return { found, lastUser }
}

export type SearchOptions = { researchTools: string[]; skipPaths: string[]; warnOnly: boolean }

export function searchBeforeBuild(on: On, opts: SearchOptions) {
  let blocks = 0
  on('tool.call', { tool: ['Write', 'Edit', 'Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const cwd = await $.session.cwd()
    let target: Candidate | undefined
    for (const c of candidates(e.tool, e, cwd)) {
      if (!gatedByShape(c, opts.skipPaths)) continue
      if (!c.isEdit && (await $.fs.exists(c.path).catch(() => false))) continue
      target = c
      break
    }
    if (!target) return next(e)
    const { found, lastUser } = await evidence($, opts.researchTools)
    if (found || OPT_OUT.some(p => lastUser.toLowerCase().includes(p)) || blocks >= MAX_BLOCKS_PER_SESSION) return next(e)
    blocks++
    const name = target.path.replace(/\\/g, '/').split('/').pop()
    const msg = `[search-before-build] ${opts.warnOnly ? 'Warning' : 'Refused'}: this writes a new ${target.lines}-line code file (${name}) ` +
      'with no research this session. Before building something new, find out whether it already exists: search the web ' +
      'or the docs, or send a research agent, then retry. To skip once, explain why and have the user say "skip the search gate".'
    if (opts.warnOnly) {
      const r = await next(e)
      return r.deny !== undefined ? r : { ...r, context: [...(r.context ?? []), msg] }
    }
    return { deny: msg }
  }).catch(($, e, next) => next(e))
}
