import type { On } from 'claude-code'
import { program, segments } from './shell'
import { SignOff, signOffText } from './signoff'

// A commit is the point where work becomes a record. Two checks hold it there: skipping the
// repo's own hooks needs a human sign-off, and the repo's listed checks must pass first.

export type Commit = { text: string; cwd?: string; skipsHooks: boolean }

/** `git commit` invocations in a command line, with whether each skips hooks. */
export function commits(command: string): Commit[] {
  const out: Commit[] = []
  for (const s of segments(command)) {
    if (program(s.words[0]) !== 'git') continue
    let i = 1
    let cwd = s.cwd
    while (i < s.words.length && s.words[i]!.startsWith('-')) {
      const w = s.words[i]!
      if (w === '-C' && s.words[i + 1]) { cwd = s.words[i + 1]; i += 2; continue }
      i += w === '-c' ? 2 : 1
    }
    if (s.words[i] !== 'commit') continue
    const args = s.words.slice(i + 1)
    const skipsHooks = args.some(a => a === '--no-verify' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a) && !a.startsWith('--'))
    out.push({ text: s.text, cwd, skipsHooks })
  }
  return out
}

/** Check commands from the repo's list: one per line, `#` starts a comment. */
export function parseChecks(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean)
}

export const tail = (s: string, lines = 15) => s.trimEnd().split(/\r?\n/).slice(-lines).join('\n')

async function repoRoot($: any, cwd: string | undefined): Promise<string | undefined> {
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], cwd ? { cwd } : undefined)
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}

// PowerShell's -Command exits 1 on any failure; this passes the check's own exit code through.
export async function checkArgv($: any, check: string): Promise<string[]> {
  if ((await $.env.get('OS')) !== 'Windows_NT') return ['sh', '-c', check]
  return ['powershell', '-NoProfile', '-Command', `${check}\n$ok = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }`]
}

export type PrecommitOptions = { checksFile: string; timeoutSeconds: number; blockNoVerify: boolean }

export function precommitCheck(on: On, signOff: SignOff, opts: PrecommitOptions) {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    const found = commits(command)
    if (!found.length) return next(e)
    const session = await $.session.cwd()

    if (opts.blockNoVerify && found.some(c => c.skipsHooks)) {
      const key = `no-verify\u0000${command.trim()}`
      if (!signOff.consume(key, await $.clock.now())) {
        return { deny: `[precommit-check] Refused: this commit skips the repo's own checks (--no-verify). ` +
          `Fix what the checks report instead. ${signOffText(signOff.codeFor(key))}` }
      }
    }

    for (const c of found) {
      const cwd = c.cwd ? (/^([A-Za-z]:)?[\\/]/.test(c.cwd) ? c.cwd : `${session}/${c.cwd}`) : session
      const root = await repoRoot($, cwd)
      if (!root || !opts.checksFile) continue
      const listed = await $.fs.read(`${root}/${opts.checksFile}`).catch(() => undefined)
      if (listed === undefined) continue
      for (const check of parseChecks(listed)) {
        const r = await $.process.run(await checkArgv($, check), { cwd: root, timeoutMs: opts.timeoutSeconds * 1000 })
          .catch((err: Error) => ({ exitCode: -1, stdout: '', stderr: err.message }))
        if (r.exitCode !== 0) {
          return { deny: `[precommit-check] Refused: the check "${check}" failed (exit ${r.exitCode}) in ${root}, so nothing was committed. ` +
            `Fix it, then commit again. Last lines:\n${tail(`${r.stdout}\n${r.stderr}`)}` }
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[precommit-check] Refused: the checks could not run, so the commit is held. Run them by hand and say what they report.' }))
}
