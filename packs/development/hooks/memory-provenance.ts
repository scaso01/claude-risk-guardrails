import type { On } from 'claude-code'

// A remembered fact is reused later as if it were checked. When a new memory file is written,
// it should say where the fact came from and when; if it doesn't, ask for both.

const DATE = /\b20\d{2}-[01]\d-[0-3]\d\b/
const ORIGIN = /https?:\/\/\S+|\b(source|sources|verified|checked|confirmed|per|from|according to|why)\b\s*[:*]|\*\*why:\*\*|\b(said|told|stated|asked)\b|`[^`]+`/i

export function missing(text: string): string[] {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, (fm) => (/\b(source|verified|date)\s*:/i.test(fm) ? fm : ''))
  const out: string[] = []
  if (!DATE.test(body)) out.push('the date it was checked (YYYY-MM-DD)')
  if (!ORIGIN.test(body)) out.push('where it came from (a URL, a file, a command, or what the user said)')
  return out
}

export const isMemoryPath = (path: string, patterns: string[]) => {
  const p = `/${path.replace(/\\/g, '/').toLowerCase()}`
  return p.endsWith('.md') && patterns.some(m => m && p.includes(m.toLowerCase())) && !/\/memory\.md$/.test(p)
}

export function memoryProvenance(on: On, patterns: string[]) {
  on('tool.call', { tool: 'Write' }, async ($, e: any, next) => {
    const fp = typeof e.file_path === 'string' ? e.file_path : ''
    if (!isMemoryPath(fp, patterns)) return next(e)
    const existed = await $.fs.exists(fp).catch(() => true)
    const r = await next(e)
    if (existed || r.deny !== undefined || r.isError) return r
    const gaps = missing(String(e.content ?? ''))
    if (!gaps.length) return r
    const name = fp.replace(/\\/g, '/').split('/').pop()
    return { ...r, context: [...(r.context ?? []),
      `[memory-provenance] The new memory ${name} is missing ${gaps.join(' and ')}. ` +
      'A later session will treat it as checked fact, so add both now.'] }
  }).catch(($, e, next) => next(e))
}
