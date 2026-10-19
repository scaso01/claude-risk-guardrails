// "I reviewed everything" means nothing unless "everything" was listed. A full-coverage claim
// must say how many items were checked out of how many were inventoried.

// Only the writer's own coverage counts: "I reviewed everything", "Checked all of the hooks".
// Descriptions of what code does ("each reply is checked", "each day's checked count") do not.
const CLAIM = /\b(?:I|I've|I have|we|we've|we have)\b[^.\n]{0,15}\b(?:everything|all|every|each)\b[^.\n]{0,50}\b(?:reviewed|checked|audited|verified|covered|inspected|scanned|went through|gone through|looked at)\b|(?:^\s*(?:[-*•]\s+)?|[.!?:;]\s+|\n\s*(?:[-*•]\s+)?|\b(?:I|I've|I have|we|we've|we have)\s+(?:also\s+|now\s+)?)(?:reviewed|checked|audited|verified|inspected|scanned|went through|gone through|looked at)\b[^.\n]{0,30}\b(?:everything|all|every|each)\b/i
const COUNT = /\b\d+\s*(?:of|out of|\/)\s*\d+\b|\ball\s+\d+\b|\b\d+\s+(?:files|items|repos|pages|rows|entries|tests|tasks|hooks|packs|sources|documents|records)\b/i
const FUTURE = /\b(i'll|i will|will|going to|let me|should|could|to)\s+(?:\w+\s+){0,2}(review|check|audit|verify|inspect|scan|go through)\b/i

/** True when the reply claims full coverage without stating a count. */
export function uncountedClaim(reply: string): boolean {
  const end = reply.slice(-800)
  const m = CLAIM.exec(end)
  if (!m) return false
  const sentence = end.slice(Math.max(0, end.lastIndexOf('.', m.index) + 1), m.index + m[0].length)
  if (FUTURE.test(sentence)) return false
  return !COUNT.test(reply)
}

export const inventoryNote =
  '[inventory-gate] Your reply claims full coverage ("all", "every", "everything") but never says how many items that was. ' +
  'Reply with one line only, and do not repeat or replace your answer, which the user already sees: state the count, for example "checked 14 of 14 files", ' +
  'or, if those words described what something does rather than what you checked, say so in one line.'
