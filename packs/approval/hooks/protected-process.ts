import type { On } from 'claude-code'
import { program, segments } from './shell'
import { signOffText, type SignOff } from './signoff'

export type Rule = { name: string; route?: string }

/** `"a => route; b"` to rules. */
export function parseRules(spec: string): Rule[] {
  return spec.split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const [name, ...route] = x.split('=>')
    const r = route.join('=>').trim()
    return r ? { name: name!.trim(), route: r } : { name: name!.trim() }
  }).filter(r => r.name)
}

const LISTERS = new Set(['get-process', 'gps', 'ps', 'get-service', 'gsv', 'pgrep', 'get-ciminstance', 'get-wmiobject'])

/** True when a simple command stops, kills or restarts something. */
export function isStop(words: string[]): boolean {
  const p = program(words[0])
  const a = words.slice(1).map(x => x.toLowerCase())
  if (['taskkill', 'tskill', 'kill', 'pkill', 'killall', 'stop-process', 'spps', 'stop-service', 'restart-service', 'stop-scheduledtask'].includes(p)) return true
  if (p === 'sc' || p === 'sc.exe') return a[0] === 'stop'
  if (p === 'net') return a[0] === 'stop'
  if (p === 'schtasks') return a.includes('/end')
  if (p === 'systemctl') return a.some(x => ['stop', 'restart', 'kill', 'disable'].includes(x))
  if (p === 'service') return a.some(x => ['stop', 'restart'].includes(x))
  if (p === 'docker' || p === 'podman') return a.some(x => ['stop', 'restart', 'kill', 'rm'].includes(x)) || (a[0] === 'compose' && a.some(x => ['down', 'stop', 'restart', 'kill', 'rm'].includes(x)))
  if (p === 'wmic') return a.includes('delete') || a.includes('terminate')
  return false
}

const nameRe = (name: string) => new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i')

export type Stop = { text: string; names: Rule[]; pids: string[] }

/** Each stop command in `command`, with the protected names it mentions and any bare PIDs. */
export function stops(command: string, rules: Rule[]): Stop[] {
  const segs = segments(command)
  const out: Stop[] = []
  segs.forEach((s, i) => {
    if (!isStop(s.words)) return
    const prev = segs[i - 1]
    const target = prev && LISTERS.has(program(prev.words[0])) ? `${prev.text} | ${s.text}` : s.text
    const names = rules.filter(r => nameRe(r.name).test(target))
    const pids = s.words.slice(1).filter(x => /^\d{2,7}$/.test(x))
    out.push({ text: target, names, pids })
  })
  return out
}

async function pidName($: any, pid: string): Promise<string | undefined> {
  const win = await $.process.run(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 10_000 }).catch(() => undefined)
  const m = win?.exitCode === 0 ? /^"([^"]+)"/.exec(win.stdout.trim()) : null
  if (m) return m[1]
  const ps = await $.process.run(['ps', '-p', pid, '-o', 'comm='], { timeoutMs: 10_000 }).catch(() => undefined)
  return ps?.exitCode === 0 && ps.stdout.trim() ? ps.stdout.trim() : undefined
}

export function protectedProcess(on: On, signOff: SignOff, rules: () => Rule[]) {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const list = rules()
    const command = typeof e.command === 'string' ? e.command : ''
    if (!list.length || !command) return next(e)
    const hits = new Map<string, Rule>()
    for (const s of stops(command, list)) {
      for (const r of s.names) hits.set(r.name, r)
      if (s.names.length) continue
      for (const pid of s.pids) {
        const n = await pidName($, pid)
        for (const r of list) if (n && nameRe(r.name).test(n)) hits.set(r.name, r)
      }
    }
    const blocked = [...hits.values()].filter(r => !(r.route && command.toLowerCase().includes(r.route.toLowerCase())))
    if (!blocked.length) return next(e)
    const key = `${e.tool}\u0000${command.trim()}`
    if (signOff.consume(key, await $.clock.now())) return next(e)
    const what = blocked.map(r => r.route ? `${r.name} (approved route: ${r.route})` : r.name).join(', ')
    return { deny: `[protected-process] Refused: this command stops a protected process: ${what}. Use the approved route where one is listed. Otherwise: ${signOffText(signOff.codeFor(key))}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '[protected-process] Refused: the guard could not check this command.' }))
}
