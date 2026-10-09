// Reply policy, pure logic: read the policy file's rules, count what a reply breaks, and keep
// warnings word for word through a rewrite. No I/O here.

export type Rules = {
  lineCap: number; wordCap: number; tableRows: number
  lift: RegExp; banned: RegExp; leadIn: RegExp; confused: RegExp; text: string
}

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const anyOf = (words: string[], flags: string, prefix = '') => new RegExp(`${prefix}\\b(${words.map(esc).join('|')})\\b`, flags)
const anyOfQuoted = (s: string, flags: string, prefix = '') =>
  new RegExp(`${prefix}\\b(${[...s.matchAll(/"([^"]+)"/g)].map(m => esc(m[1]!).replace(/'/g, "['’]")).join('|')})\\b`, flags)

export function parseRules(md: string): Rules {
  const flat = md.replace(/\s+/g, ' ')
  const cap = flat.match(/Hard cap (\d+) lines and (\d+) words/)
  const table = flat.match(/table of up to (\d+) rows/)
  const lift = flat.match(/Only (.+?) lifts the cap/)
  const filler = flat.match(/Delete on sight: (.+?)\./)
  const lead = flat.match(/No lead-ins: (.+?)\./)
  const confused = flat.match(/signals confusion \((.+?)\)/)
  const missing = [!cap && 'cap', !table && 'table rule', !lift && 'lift words', !filler && 'filler list',
    !lead && 'lead-ins', !confused && 'confusion phrases'].filter(Boolean)
  if (missing.length) throw new Error(`policy file: cannot find ${missing.join(', ')}`)
  return {
    lineCap: +cap![1]!,
    wordCap: +cap![2]!,
    tableRows: +table![1]!,
    lift: anyOfQuoted(lift![1]!, 'i'),
    banned: anyOf(filler![1]!.split(',').map(w => w.trim()).filter(Boolean), 'gi'),
    leadIn: anyOfQuoted(lead![1]!, 'i', '^\\s*'),
    confused: anyOfQuoted(confused![1]!, 'i'),
    text: md,
  }
}

export function countLines(text: string, tableRows = Infinity): number {
  let n = 0, inCode = false, rows = 0
  const flush = () => { if (rows) n += rows > tableRows ? rows : 1; rows = 0 }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) { flush(); if (!inCode) n++; inCode = !inCode; continue }
    if (inCode) continue
    if (line.startsWith('|')) { if (!/^\|[\s:|-]+\|$/.test(line)) rows++; continue }
    flush()
    if (line !== '') n++
  }
  flush()
  return n
}

const prose = (t: string) => t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, 'X')
export const countWords = (t: string) => (prose(t).match(/[A-Za-z0-9][\w'’.-]*/g) ?? []).length
export const hasList = (t: string) => /^\s*([-*•]|\d+[.)])\s+/m.test(prose(t))
const hasTable = (t: string) => /^\s*\|/m.test(prose(t))
const paragraphs = (t: string) => prose(t).split(/\n\s*\n/).filter(p => p.trim()).length

export function violations(text: string, rules: Rules, confused = false): string[] {
  const v: string[] = []
  const lines = countLines(text, rules.tableRows), words = countWords(text)
  if (lines > rules.lineCap) v.push(`${lines} lines (cap ${rules.lineCap})`)
  if (words > rules.wordCap) v.push(`${words} words (cap ${rules.wordCap}, code excluded)`)
  const banned = [...new Set((prose(text).match(rules.banned) ?? []).map(w => w.toLowerCase()))]
  if (banned.length) v.push(`filler: ${banned.join(', ')}`)
  if (rules.leadIn.test(prose(text))) v.push('lead-in opener')
  if (confused) {
    if (hasList(text) || hasTable(text)) v.push('the user is confused: no bullets or tables')
    if (paragraphs(text) > 2) v.push('the user is confused: one plain paragraph plus one question')
    if (!/\?\s*$/.test(text.trim())) v.push('the user is confused: end with one concrete question')
  }
  return v
}

// Single filler words are deleted in place; a model rewrite for one word can change the meaning.
export function stripFiller(text: string, banned: RegExp): string {
  const re = new RegExp(`${banned.source},?[ \\t]?(\\w)?`, 'gi')
  return text.split(/(```[\s\S]*?```|`[^`]*`)/).map((part, i) => i % 2 ? part :
    part.replace(re, (m, w: string, next?: string) => /\s/.test(w) ? m
      : (next && /[A-Z]/.test(w[0]!) ? next.toUpperCase() : next ?? ''))
  ).join('')
}

export const rewritePrompt = (rules: Rules, question: string, draft: string, v: string[], confused: boolean) =>
  `The user's reply policy is defined by this file:
<policy>
${rules.text}
</policy>

` +
  `The user asked:
<question>
${question}
</question>

` +
  `The draft reply below breaks that policy (${v.join('; ')}). Rewrite it so it obeys every rule in the policy, ` +
  `including the hard cap of ${rules.lineCap} lines and ${rules.wordCap} words.
` +
  (confused
    ? `The user's message signals confusion, so follow the policy's confusion rule exactly: one plain-English paragraph with no bullets, ` +
      `tables or jargon, explaining the idea in everyday words, then one concrete question on its own line. `
    : `The answer to the user's question is the part you must keep: open with it, then keep its main points, shortened. ` +
      `If the draft gives steps or a list, the rewrite keeps a shorter list of the most important ones. `) +
  `Cut supporting detail, background, side notes and repeated points before you cut any part of the answer. ` +
  `Keep verbatim anything the policy says never to compress. Output only the rewritten reply.

<draft>
${draft}
</draft>`

// Problem reports only. Topic words (secret, security, delete, fails) also appear in plain
// explanations and caused false keeps, so they are not on this list.
const PROTECT = /\b(error:|errors? (?:in|on|from|when|while)|failed|warning|unverified|(?:haven['’]t|have not|not|never) (?:been |yet )?verified|irreversible|(?:can['’]t|cannot) be undone|could ?n['’]t|could not|traceback|exception:|exit code \d+|permission denied)/i
const ERROR_BLOCK = /\b(Traceback|Error:|ERROR|FAILED|Exception|exit code \d+|fatal:)/
const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'were', 'what', 'when', 'your', 'they', 'them', 'then', 'than', 'into', 'only', 'also', 'because'])
const sig = (t: string) => (t.toLowerCase().match(/[a-z0-9][\w'’.-]{3,}/g) ?? []).filter(w => !STOP.has(w))
const FENCE = /```[\s\S]*?```/g

export function protectedUnits(text: string): string[] {
  const units: string[] = []
  for (const m of text.matchAll(FENCE)) if (ERROR_BLOCK.test(m[0])) units.push(m[0])
  for (const line of text.replace(FENCE, '\n').split('\n'))
    for (const sent of line.replace(/^\s*([-*•]|\d+[.)])\s+/, '').split(/(?<=[.!?])\s+(?=[A-Z`"*])/))
      if (sent.trim() && PROTECT.test(sent)) units.push(sent.trim())
  return units
}

export function survives(unit: string, rewrite: string): boolean {
  if (unit.startsWith('```')) return rewrite.includes(unit.replace(/^```\w*\n?|```$/g, '').trim())
  if (![...unit.matchAll(/`([^`]+)`/g)].every(m => rewrite.includes(m[1]!))) return false
  if (!PROTECT.test(rewrite)) return false
  const low = rewrite.toLowerCase(), words = sig(unit.replace(/`[^`]*`/g, ' '))
  return !words.length || words.filter(w => low.includes(w)).length / words.length >= 0.5
}

export function keepProtected(original: string, rewrite: string): { text: string; kept: number } {
  const lost = protectedUnits(original).filter(u => !survives(u, rewrite))
  if (!lost.length) return { text: rewrite, kept: 0 }
  const list = lost.map(u => u.startsWith('```') ? u : `- ${u}`).join('\n')
  return { text: `${rewrite}\n\nKept word for word from the full reply:\n${list}`, kept: lost.length }
}

export const userText = (t: string) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
