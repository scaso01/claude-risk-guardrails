// Copied from shared/shell.ts by scripts/sync-shared.sh. Edit the original.
// Splits a Bash or PowerShell command line into simple commands and tokens. Not a full shell
// parser: enough to find the program, its arguments and a preceding `cd` in the same line.

export type Segment = { text: string; words: string[]; cwd?: string }

// Programs that run the rest of the line as a command: `sudo gh ...` is a `gh` command.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'command', 'exec', 'nice', 'rtk', 'xargs', 'call', '&', '.'])

/** The words with any leading wrapper programs (and their VAR=value or -flag arguments) removed. */
export function unwrap(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    const name = w.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/i, '').toLowerCase()
    if (WRAPPERS.has(name)) { i++; continue }
    if (i > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^-/.test(w)) && WRAPPERS.has(words[i - 1]!.toLowerCase())) { i++; continue }
    if (/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(w)) { i++; continue }
    break
  }
  return words.slice(i)
}

export function tokenize(s: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]!)
  return out
}

/** Simple commands in order, each carrying the directory the last `cd` in the line moved to. */
export function segments(command: string): Segment[] {
  const parts = command.split(/\r?\n|&&|\|\||;|\|/)
  const out: Segment[] = []
  let cwd: string | undefined
  for (const raw of parts) {
    const text = raw.trim()
    if (!text) continue
    const words = unwrap(tokenize(text))
    const head = (words[0] ?? '').toLowerCase()
    if ((head === 'cd' || head === 'set-location' || head === 'pushd' || head === 'sl') && words[1]) {
      const arg = words[1] === '-Path' || words[1] === '-LiteralPath' ? words[2] : words[1]
      if (arg) cwd = arg
      continue
    }
    out.push({ text, words, cwd })
  }
  return out
}

/** Program name without directory or .exe, lower-cased. */
export const program = (word: string | undefined) =>
  (word ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
