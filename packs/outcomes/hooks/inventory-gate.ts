// "I reviewed everything" means nothing unless "everything" was listed. A full-coverage claim
// must say how many items were checked out of how many were inventoried.

const CLAIM = /\b(everything|all|every|each)\b[^.\n]{0,50}\b(reviewed|checked|audited|verified|covered|inspected|scanned|went through)\b|\b(reviewed|checked|audited|verified|went through|inspected|scanned)\b[^.\n]{0,30}\b(everything|all of|every|each)\b/i
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
  'State it as a count, for example "checked 14 of 14 files". If you never listed the items, list them first, then check them.'
