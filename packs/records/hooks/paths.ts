// Path helpers that work on Windows and Unix paths alike, with no filesystem access.

export const isAbs = (p: string) => /^([A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(p)

export const join = (dir: string, p: string) => (isAbs(p) ? p : `${dir.replace(/[\\/]+$/, '')}/${p}`)

export const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '') || p

export const baseOf = (p: string) => p.replace(/^.*[\\/]/, '')

/** Comparable form: forward slashes, lower-case drive letter. */
export const norm = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`)

/** `*` and `?` glob over a file's base name, case-insensitive. */
export function globMatch(pattern: string, name: string): boolean {
  const re = pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re}$`, 'i').test(name)
}

/** Files this session wrote with the edit tools, kept per turn and for the whole session. */
export class EditLog {
  session = new Set<string>()
  turn = new Set<string>()
  add(path: string) { this.session.add(path); this.turn.add(path) }
  newTurn() { this.turn = new Set() }
}
