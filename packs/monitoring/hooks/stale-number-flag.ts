import type { On } from 'claude-code'

// A count saved to notes with no date goes stale silently: "992 sources" reads as current forever.
const NUM = /(?<![\w.:/$-])\d{2,}(?:,\d{3})*(?![\w.:/%-]|\.\d)/
const DATED = /\b\d{4}-\d{2}(-\d{2})?\b|\b(19|20)\d{2}\b|\b\d{1,2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b(today|yesterday)\b/i
const STRIP = /`[^`]*`|https?:\/\/\S+|\b\d{1,3}(\.\d{1,3}){3}\b|\bv?\d+\.\d+(\.\d+)*\b|\[[^\]]*\]\([^)]*\)/g

/** Lines that state a figure with nothing saying when it was true. */
export function undatedFigures(lines: string[]): string[] {
  let inCode = false
  return lines.filter(raw => {
    const line = raw.trim()
    if (line.startsWith('```')) { inCode = !inCode; return false }
    if (inCode || !line || line.startsWith('---') || /^[a-z_]+:\s/i.test(line)) return false
    const prose = line.replace(STRIP, ' ')
    return NUM.test(prose) && !DATED.test(line)
  })
}

export const addedLines = (before: string, after: string) => {
  const old = new Set(before.split(/\r?\n/).map(l => l.trim()))
  return after.split(/\r?\n/).filter(l => !old.has(l.trim()))
}

export const isNotesFile = (path: string, markers: string[]) => {
  const p = path.replace(/\\/g, '/').toLowerCase()
  return /\.(md|txt)$/.test(p) && markers.some(m => m && p.includes(m.toLowerCase()))
}

export function staleNumberFlag(on: On, markers: string[]) {
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e: any, next) => {
    const fp = e.file_path
    if (typeof fp !== 'string' || !isNotesFile(fp, markers)) return next(e)
    const before = e.tool === 'Edit' ? String(e.old_string ?? '') : await $.fs.read(fp).catch(() => '')
    const after = e.tool === 'Edit' ? String(e.new_string ?? '') : String(e.content ?? '')
    const bad = undatedFigures(addedLines(before, after))
    const r = await next(e)
    if (!bad.length || r.deny !== undefined || r.isError) return r
    const shown = bad.slice(0, 5).map(l => `- ${l.trim().replace(/^[-*+]\s+/, '').slice(0, 160)}`).join('\n')
    const note = `[stale-number-flag] ${bad.length} saved line(s) state a figure with no date:\n${shown}\n` +
      "Add when each figure was checked (for example 'verified 2026-10-08'), so a later reader can tell how old it is."
    return { ...r, context: [...(r.context ?? []), note] }
  })
}
