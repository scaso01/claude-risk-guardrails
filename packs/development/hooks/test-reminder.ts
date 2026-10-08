import type { On } from 'claude-code'

// After a source file changes, name the test that covers it, once per file per session.
// Tests are found by convention: test_<name>, <name>_test, <name>.test, <name>.spec.

const ROOT_MARKERS = ['.git', 'pyproject.toml', 'setup.py', 'package.json', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts']
const TEST_DIRS = ['tests', 'test', '__tests__', 'spec']
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'target', '__pycache__'])
const SOURCE_EXT = new Set(['py', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'rs', 'go', 'java', 'rb', 'kt', 'cs', 'swift', 'php', 'ps1', 'sh'])
const MAX_DEPTH = 4

export type MiniFs = {
  exists: (p: string) => Promise<boolean>
  list: (p: string) => Promise<{ name: string; kind: string }[]>
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const dirOf = (p: string) => { const n = norm(p); const i = n.lastIndexOf('/'); return i <= 0 ? n.slice(0, i + 1) : n.slice(0, i) }
const baseOf = (p: string) => norm(p).split('/').pop() ?? ''

export function splitName(path: string): { stem: string; ext: string } | undefined {
  const b = baseOf(path)
  const i = b.lastIndexOf('.')
  if (i <= 0) return undefined
  return { stem: b.slice(0, i), ext: b.slice(i + 1).toLowerCase() }
}

export function isTest(path: string): boolean {
  const p = norm(path).toLowerCase()
  const b = baseOf(p)
  return b.startsWith('test_') || /[._](test|spec)\.[^.]+$/.test(b) || /_test\.[^.]+$/.test(b) ||
    p.split('/').some(s => TEST_DIRS.includes(s))
}

export function testNames(stem: string, ext: string): string[] {
  const jsLike = ['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs'].includes(ext)
  const exts = jsLike ? ['ts', 'js', 'tsx', 'jsx', 'mjs', 'cjs'] : [ext]
  const names = new Set<string>()
  for (const x of exts) {
    names.add(`test_${stem}.${x}`)
    names.add(`${stem}_test.${x}`)
    names.add(`${stem}.test.${x}`)
    names.add(`${stem}.spec.${x}`)
  }
  if (ext === 'java' || ext === 'kt' || ext === 'cs') { names.add(`${stem}Test.${ext}`); names.add(`${stem}Tests.${ext}`) }
  return [...names]
}

async function find(fs: MiniFs, dir: string, names: string[], depth: number): Promise<string | undefined> {
  const entries = await fs.list(dir).catch(() => [])
  const hit = entries.find(e => e.kind === 'file' && names.includes(e.name))
  if (hit) return `${dir}/${hit.name}`
  if (depth >= MAX_DEPTH) return undefined
  for (const e of entries) {
    if (e.kind !== 'dir' || SKIP_DIRS.has(e.name)) continue
    const deeper = await find(fs, `${dir}/${e.name}`, names, depth + 1)
    if (deeper) return deeper
  }
  return undefined
}

/** The covering test for an edited source file, or undefined. */
export async function coveringTest(fs: MiniFs, filePath: string): Promise<{ root: string; test: string } | undefined> {
  const parts = splitName(filePath)
  if (!parts || !SOURCE_EXT.has(parts.ext) || isTest(filePath)) return undefined
  const names = testNames(parts.stem, parts.ext)
  const own = dirOf(filePath)
  let root: string | undefined
  for (let cur = own, i = 0; i < 8; i++) {
    for (const m of ROOT_MARKERS) if (await fs.exists(`${cur}/${m}`)) { root = cur; break }
    if (root) break
    const up = dirOf(cur)
    if (!up || up === cur) break
    cur = up
  }
  if (!root) return undefined
  const sibling = (await fs.list(own).catch(() => [])).find(e => e.kind === 'file' && names.includes(e.name))
  if (sibling) return { root, test: `${own}/${sibling.name}` }
  for (const d of TEST_DIRS) {
    const t = await find(fs, `${root}/${d}`, names, 1)
    if (t) return { root, test: t }
  }
  return undefined
}

export function reminder(root: string, file: string, test: string): string {
  const rel = (p: string) => norm(p).slice(norm(root).length).replace(/^\//, '')
  return `[test-reminder] You changed ${rel(file)}. Its test is ${rel(test)}: run it before moving to the next task.`
}

export function testReminder(on: On) {
  const named = new Set<string>()
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e: any, next) => {
    const r = await next(e)
    const fp = e.file_path
    if (r.deny !== undefined || r.isError || typeof fp !== 'string') return r
    const key = norm(fp).toLowerCase()
    if (named.has(key)) return r
    const hit = await coveringTest({ exists: p => $.fs.exists(p), list: p => $.fs.list(p) as any }, norm(fp)).catch(() => undefined)
    if (!hit) return r
    named.add(key)
    return { ...r, context: [...(r.context ?? []), reminder(hit.root, fp, hit.test)] }
  }).catch(($, e, next) => next(e))
}
