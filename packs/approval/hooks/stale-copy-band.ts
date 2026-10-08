import type { On } from 'claude-code'
import { shellWritePaths } from './sensitive-file-guard'
import { SignOff, signOffText } from './signoff'

// Two clones of one project drift apart, and work done in the old one is lost. A copy is
// marked stale by a small file at its root (default `.claude/stale-copy.txt`): the first line
// names the live copy, the rest says why. Edits inside a marked copy wait for a sign-off.

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const parent = (p: string) => { const i = p.lastIndexOf('/'); return i <= 0 ? '' : p.slice(0, i) }

export function parseMarker(text: string): { live: string; why: string } {
  const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean)
  return { live: lines[0] ?? '', why: lines.slice(1).join(' ') }
}

async function markerFor($: any, cache: Map<string, string | null>, markerName: string, file: string): Promise<{ root: string; text: string } | undefined> {
  let dir = parent(norm(file))
  const seen: string[] = []
  for (let i = 0; dir && i < 12; i++, dir = parent(dir)) {
    const key = dir.toLowerCase()
    if (cache.has(key)) {
      const hit = cache.get(key)
      for (const s of seen) cache.set(s, hit ?? null)
      return hit ? { root: hit, text: await $.fs.read(`${hit}/${markerName}`) } : undefined
    }
    seen.push(key)
    if (await $.fs.exists(`${dir}/${markerName}`).catch(() => false)) {
      for (const s of seen) cache.set(s, dir)
      return { root: dir, text: await $.fs.read(`${dir}/${markerName}`) }
    }
  }
  for (const s of seen) cache.set(s, null)
  return undefined
}

/** Shell words as absolute paths: `~` is the home folder, a relative path sits under the session folder. */
async function absolute($: any, words: string[]): Promise<string[]> {
  if (!words.length) return []
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const cwd = norm(await $.session.cwd())
  return words.map(w => /^~(?=[\\/]|$)/.test(w) ? home + w.slice(1) : /^([a-z]:|[\\/])/i.test(w) ? w : `${cwd}/${w}`)
}

export function staleCopyBand(on: On, signOff: SignOff, markerName: string) {
  const cache = new Map<string, string | null>()
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const files = typeof e.command === 'string'
      ? await absolute($, shellWritePaths(e.command))
      : [String(e.file_path ?? e.notebook_path ?? '')].filter(Boolean)
    let hit: { root: string; text: string } | undefined
    for (const fp of files) if ((hit = await markerFor($, cache, markerName, fp))) break
    if (!hit) return next(e)
    const key = `stale\u0000${hit.root.toLowerCase()}`
    if (signOff.consume(key, await $.clock.now())) return next(e)
    const { live, why } = parseMarker(hit.text)
    return { deny: `[stale-copy-band] Refused: ${hit.root} is marked as an old copy.${why ? ` Why: ${why.replace(/[.\s]+$/, '')}.` : ''} ` +
      `${live ? `The live copy is ${live}; make this change there. ` : ''}If this copy really is the target: ${signOffText(signOff.codeFor(key))}` }
  }).catch(($, e, next) => next(e))
}
