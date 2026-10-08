import type { On } from 'claude-code'
import { program, segments, type Segment } from './shell'
import { signOffText, type SignOff } from './signoff'

export type PublishAction =
  | { kind: 'visibility'; text: string }
  | { kind: 'push'; text: string; remote?: string; cwd?: string }

const flagValue = (words: string[], i: number) => words[i]!.includes('=') ? words[i]!.split('=').slice(1).join('=') : words[i + 1]

/** Commands in `command` that publish a repo, or push to a remote that might be public. */
export function publishActions(command: string): PublishAction[] {
  const out: PublishAction[] = []
  for (const s of segments(command)) {
    const w = s.words
    if (program(w[0]) === 'gh') {
      const sub = `${w[1] ?? ''} ${w[2] ?? ''}`.toLowerCase()
      if (sub === 'repo create' && w.some(x => /^--public$/i.test(x))) out.push({ kind: 'visibility', text: s.text })
      else if (sub === 'repo edit' && w.some((x, i) => /^--visibility(=|$)/i.test(x) && /^public$/i.test(flagValue(w, i) ?? '')))
        out.push({ kind: 'visibility', text: s.text })
      else if ((w[1] ?? '').toLowerCase() === 'api' && w.some(x => /^(private=false|visibility=public)$/i.test(x)))
        out.push({ kind: 'visibility', text: s.text })
      continue
    }
    if (program(w[0]) === 'git') {
      const push = gitPush(s)
      if (push) out.push(push)
    }
  }
  return out
}

const GIT_OPTS_WITH_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace'])
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

function gitPush(s: Segment): PublishAction | undefined {
  const w = s.words
  let cwd = s.cwd
  let i = 1
  while (i < w.length && w[i]!.startsWith('-')) {
    if (w[i] === '-C') { cwd = w[i + 1]; i += 2; continue }
    i += GIT_OPTS_WITH_VALUE.has(w[i]!) ? 2 : 1
  }
  if (w[i] !== 'push') return undefined
  if (w.slice(i + 1).some(x => x === '--dry-run' || x === '-n')) return undefined
  let remote: string | undefined
  for (let j = i + 1; j < w.length; j++) {
    const x = w[j]!
    if (x.startsWith('--repo=')) { remote = x.slice(7); break }
    if (x.startsWith('-')) { if (PUSH_OPTS_WITH_VALUE.has(x)) { if (x === '--repo') { remote = w[j + 1]; break } j++ } continue }
    remote = x
    break
  }
  return { kind: 'push', text: s.text, remote, cwd }
}

/** `owner/repo` for a GitHub URL, or undefined. */
export function githubRepo(url: string): string | undefined {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : undefined
}

type Visibility = 'PUBLIC' | 'PRIVATE' | 'INTERNAL' | 'UNKNOWN'

const visibility = new Map<string, Visibility>()

async function remoteUrl($: any, remote: string | undefined, cwd: string | undefined): Promise<string | undefined> {
  if (remote && /[:/]/.test(remote)) return remote
  const init = cwd ? { cwd, timeoutMs: 10_000 } : { timeoutMs: 10_000 }
  let name = remote
  if (!name) {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'], init).catch(() => undefined)
    name = r?.exitCode === 0 && r.stdout.includes('/') ? r.stdout.trim().split('/')[0] : 'origin'
  }
  const r = await $.process.run(['git', 'remote', 'get-url', '--push', name], init).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.trim() : undefined
}

async function repoVisibility($: any, repo: string): Promise<Visibility> {
  const known = visibility.get(repo)
  if (known && known !== 'UNKNOWN') return known
  let v: Visibility = 'UNKNOWN'
  const gh = await $.process.run(['gh', 'repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility'], { timeoutMs: 15_000 }).catch(() => undefined)
  const out = gh?.exitCode === 0 ? gh.stdout.trim().toUpperCase() : ''
  if (out === 'PUBLIC' || out === 'PRIVATE' || out === 'INTERNAL') v = out
  else {
    // Without gh: the public API answers 200 for a public repo and 404 for a private one.
    const r = await $.http.fetch(`https://api.github.com/repos/${repo}`, { headers: { Accept: 'application/vnd.github+json' } }).catch(() => undefined)
    if (r?.status === 200) v = 'PUBLIC'
    else if (r?.status === 404) v = 'PRIVATE'
  }
  visibility.set(repo, v)
  return v
}

export function publishGate(on: On, signOff: SignOff, options: { pushes: boolean }) {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    const actions = publishActions(command)
    if (!actions.length) return next(e)
    const reasons: string[] = []
    for (const a of actions) {
      if (a.kind === 'visibility') { reasons.push(`"${a.text}" makes a repository public.`); continue }
      if (!options.pushes) continue
      const url = await remoteUrl($, a.remote, a.cwd)
      const repo = url ? githubRepo(url) : undefined
      if (!repo) continue
      const v = await repoVisibility($, repo)
      if (v === 'PUBLIC') reasons.push(`"${a.text}" pushes to ${repo}, a public repository.`)
      else if (v === 'UNKNOWN') reasons.push(`"${a.text}" pushes to ${repo}, and the guard could not confirm it is private.`)
    }
    if (!reasons.length) return next(e)
    const key = `${e.tool}\u0000${command.trim()}`
    if (signOff.consume(key, await $.clock.now())) return next(e)
    return { deny: `[publish-gate] Refused: ${reasons.join(' ')} ${signOffText(signOff.codeFor(key))}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[publish-gate] Refused: the gate could not check this command, so it is held for a human.' }))
}
