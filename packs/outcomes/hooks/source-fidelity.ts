// When the user hands over a document, a reply about it should not add figures the document
// never stated: a salary, a date, a percentage. A figure passes if it is in the document, in
// the rest of the prompt, or in anything a tool returned this turn.

const FIGURE = /\$\s?\d+(?:,\d{3})*(?:\.\d+)?\s?(?:k|m|bn|million|billion|thousand)?\b|\b\d+(?:\.\d+)?\s?%|\b(?:19|20)\d{2}-[01]\d-[0-3]\d\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{3,}(?:\.\d+)?\b/gi

const flat = (s: string) => s.toLowerCase().replace(/[\s,$]/g, '')
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 }
const NUMBER = /\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn|million|billion|thousand)?\b/gi

/** A figure's numeric value: $185k and 185,000 are both 185000; 20% is 20. */
export function value(figure: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(k|m|bn|million|billion|thousand)?%?$/.exec(flat(figure))
  if (!m) return undefined
  return Math.round(Number(m[1]) * (m[2] ? MULT[m[2]]! : 1) * 1000) / 1000
}

/** Figures in the reply that appear nowhere in the source text. */
export function unsupported(reply: string, source: string): string[] {
  const text = flat(source)
  const values = new Set<number>()
  for (const m of source.matchAll(NUMBER)) { const v = value(m[0]); if (v !== undefined) values.add(v) }
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of reply.matchAll(FIGURE)) {
    const fig = m[0].trim()
    const key = flat(fig)
    if (seen.has(key)) continue
    seen.add(key)
    const v = value(fig)
    const found = v === undefined ? text.includes(key) : values.has(v)
    if (!found) out.push(fig)
  }
  return out
}

/** The pasted document in a prompt, or undefined when the prompt carries none. */
export function pastedSource(prompt: string, minChars: number): string | undefined {
  const tagged = [...prompt.matchAll(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g)].map(m => m[1]).join('\n')
  if (tagged.trim()) return tagged
  return prompt.length >= minChars ? prompt : undefined
}

export function fidelityNote(figures: string[]): string {
  const shown = figures.slice(0, 8).join(', ') + (figures.length > 8 ? `, and ${figures.length - 8} more` : '')
  return `[source-fidelity] Your reply uses figures that are not in the document the user gave you, nor in anything a tool returned this turn: ${shown}. ` +
    'For each one, say where it came from, or remove it. Do not present it as part of the document.'
}
