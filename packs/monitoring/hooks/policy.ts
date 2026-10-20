// Reply policy, pure logic: read the policy file's rules, count what a reply breaks, and keep
// warnings word for word through a rewrite. No I/O here.

export type Rules = {
  lineCap: number; wordCap: number; tableRows: number; shape: string
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
  const shape = flat.match(/Shape: (.+?)(?= No paragraph longer| Exception:|$)/)
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
    shape: shape?.[1]?.trim() ?? '',
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
/** Bullet and numbered items plus table body rows: what a shortened reply must not lose. */
export const listItems = (t: string) =>
  (prose(t).match(/^\s*([-*•]|\d+[.)])\s+/gm)?.length ?? 0) +
  (prose(t).match(/^\s*\|(?!\s*:?-{3,})/gm)?.length ?? 0)
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
  return v
}

// Single filler words are deleted in place; a model rewrite for one word can change the meaning.
export function stripFiller(text: string, banned: RegExp): string {
  const re = new RegExp(`${banned.source},?[ \\t]?(\\w)?`, 'gi')
  // Code and quoted words are left alone: quoting "just" is talking about the word, not using it.
  return text.split(/(```[\s\S]*?```|`[^`]*`|"[^"\n]*"|“[^”\n]*”)/).map((part, i) => i % 2 ? part :
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
    ? `The user's message signals confusion, so make the reply simpler, never longer: ` +
      `the same headings and bullets, Recommend: first with one clear decision, everyday words and no jargon. ` +
      `Keep every recommendation, decision and question to the user. `
    : `Open with the answer to the user's question. Keep every fact in the draft: every number, percentage, ` +
      `confidence figure, name, date, path, ID, link, code span, list item, table row, option, caveat, ` +
      `recommendation and question to the user. Shorten by cutting words, never facts: drop filler, repetition, ` +
      `background, narration of steps taken and restated context; merge sentences and use tighter wording. ` +
      `If every fact cannot fit the cap, keep every fact and go over the cap. ` +
      `Keep the draft's shape: when it has bullets or a numbered list, the rewrite has them too, one short bullet ` +
      `per draft bullet; never turn a list into a paragraph. `) +
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
    if (line.trim().startsWith('|')) { if (PROTECT.test(line)) units.push(line.trim()) }
    else for (const sent of line.replace(/^\s*([-*•]|\d+[.)])\s+/, '').split(/(?<=[.!?])\s+(?=[A-Z`"*])/))
      if (sent.trim() && PROTECT.test(sent)) units.push(sent.trim())
  return units
}

export function survives(unit: string, rewrite: string): boolean {
  if (unit.startsWith('```')) return rewrite.includes(unit.replace(/^```\w*\n?|```$/g, '').trim())
  if (![...unit.matchAll(/`([^`]+)`/g)].every(m => rewrite.includes(m[1]!))) return false
  const low = rewrite.toLowerCase(), words = sig(unit.replace(/`[^`]*`/g, ' '))
  // The problem word must survive, but reworded counts: "warning" kept as "warn", "failed" as "fails".
  const root = ((unit.match(PROTECT)?.[0] ?? '').toLowerCase().match(/[a-z]+/g) ?? [])
    .sort((a, b) => b.length - a.length)[0]?.slice(0, 4)
  if (root && !low.includes(root)) return false
  return !words.length || words.filter(w => low.includes(w)).length / words.length >= 0.5
}

/** Protected sentences and error blocks of the original that the rewrite lost. */
export const lostProtected = (original: string, rewrite: string) => protectedUnits(original).filter(u => !survives(u, rewrite))

// Last resort after the rewrite was asked to keep them: lost warnings go back in as plain bullets.
export function keepProtected(original: string, rewrite: string): { text: string; kept: number } {
  const lost = lostProtected(original, rewrite)
  if (!lost.length) return { text: rewrite, kept: 0 }
  const list = lost.map(u => u.startsWith('```') ? u : `- ${u}`).join('\n')
  return { text: `${rewrite}\n\n${list}`, kept: lost.length }
}

export const userText = (t: string) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

// Pasted text is not Sean asking: "Full-time" in a pasted job posting must not lift the cap.
export const ownWords = (t: string) => t.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/g, ' ').trim()

const ITEM = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+\S/
// Old gap lines are stripped: a zero-width-space line printed as three blank lines (Sean, 2026-10-16).
const GAP = String.fromCharCode(0x200b)

/**
 * Bullets sit tight under their heading, one per line, with one blank line between groups.
 * Items stay markdown list items ("- "), which the terminal draws one per line; a "•" line
 * would be a paragraph, and two of them in a row would print as one line.
 */
const HEADING = /^[A-Z][A-Za-z ]{0,20}:\s*$/
export function tightBullets(text: string): string {
  return text.split(/(```[\s\S]*?```)/).map((part, i) => {
    if (i % 2) return part
    const out: string[] = []
    let inList = false
    for (const line of part.split('\n')) {
      const blank = ['', GAP].includes(line.trim())
      if (ITEM.test(line)) {
        if (inList) while (out.length && ['', GAP].includes(out[out.length - 1]!.trim())) out.pop()
        else if (out.length && out[out.length - 1]!.trim() !== '' && !HEADING.test(out[out.length - 1]!)) out.push('')
        out.push(line.replace(/^([ \t]*)[*+•][ \t]+/, '$1- '))
        inList = true
        continue
      }
      if (inList && !blank && !/^[ \t]/.test(line)) { if (out.length && out[out.length - 1] !== '') out.push(''); inList = false }
      else if (inList && !blank) { out.push(line); continue }
      out.push(blank ? '' : line)
    }
    return out.join('\n')
  }).join('')
}

/** Sent beside each prompt: a length rule in the user turn is followed more closely than one in the system prompt alone. */
export const lengthReminder = (rules: Rules, confused = false) =>
  (confused ? `The user is confused: use simpler words, never more of them. Put the recommendation first with one clear decision and use everyday words. ` : '') +
  `Length rule for this reply: at most ${rules.lineCap} lines and ${rules.wordCap} words (a table of up to ${rules.tableRows} rows counts as 1 line; code is excluded). ` +
  (rules.shape ? `Shape, from the policy file: ${rules.shape} ` : '') +
  'Keep every point, with its status, certainty and scope exact. Drop how you got there and restated context.'

/** Agent reports and harness notices arrive as prompts but are not the user's question. */
export const isNotice = (t: string) => /^<(?!pasted_content)/.test(t) || /^Mod hot-reloading is off/.test(t)

/** Numbers, links, code and the closing question in `original` that `rewrite` lost. */
export function droppedFacts(original: string, rewrite: string): string[] {
  const lost: string[] = []
  for (const m of original.matchAll(FENCE)) if (!rewrite.includes(m[0].replace(/^```\w*\n?|```$/g, '').trim())) lost.push('a code block')
  const body = original.replace(FENCE, ' ')
  const spans = [...body.matchAll(/`([^`]+)`/g)].map(m => m[1]!)
  const plain = body.replace(/`[^`]*`/g, ' ').replace(/^\s*\d+[.)]\s+/gm, ' ')
  const tokens = [...plain.matchAll(/https?:\/\/[^\s)>\]]+|\d[\d,.:/-]*\d%?|\d%?/g)].map(m => m[0].replace(/[.,:/-]+$/, ''))
  for (const f of new Set([...spans, ...tokens])) if (!rewrite.includes(f)) lost.push(f)
  if (/\?\s*$/.test(original.trim()) && !rewrite.includes('?')) lost.push('the closing question')
  return lost
}
