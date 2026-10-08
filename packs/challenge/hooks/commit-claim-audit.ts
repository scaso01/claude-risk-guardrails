// A subagent's "committed the fix as 3f2a91c" is a claim, not evidence. When an agent's report
// names a commit, the real `git show --stat` for it is placed next to the report.

const CLAIM = /(?:commit(?:ted)?|pushed|hash|sha)\W[^\n]{0,40}?\b((?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40})\b|\b((?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40})\b\W[^\n]{0,20}commit/gi

/** Commit ids a report claims, in order, without repeats; a short id of a listed full id is a repeat. */
export function claimedShas(report: string): string[] {
  const out: string[] = []
  for (const m of report.matchAll(CLAIM)) {
    const sha = (m[1] ?? m[2])!.toLowerCase()
    if (!out.some(x => x.startsWith(sha) || sha.startsWith(x))) out.push(sha)
  }
  return out
}

export function evidence(sha: string, found: boolean, stat: string, where: string): string {
  if (!found) return `${sha}: no such commit in ${where}. The report names a commit this repository does not have; check which repository it went to, or whether it was made at all.`
  const lines = stat.trim().split(/\r?\n/)
  const shown = lines.length > 14 ? [...lines.slice(0, 13), `... ${lines.length - 13} more lines`] : lines
  return `${sha} in ${where}:\n${shown.join('\n')}`
}

export const auditNote = (parts: string[]) =>
  `[commit-claim-audit] The agent's report names ${parts.length} commit(s). Here is what git records for each; compare it with what the report says before relaying it.\n\n${parts.join('\n\n')}`
