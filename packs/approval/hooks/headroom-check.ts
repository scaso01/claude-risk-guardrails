import type { On } from 'claude-code'
import { SignOff, signOffText } from './signoff'

// A build or install that fills the disk fails halfway and can corrupt what else is writing
// there. Before one starts, check the free space on the drive it runs in.

const HEAVY = /\b(docker\s+(compose\s+)?build|docker[- ]compose\s+up\b[^\n;&|]*--build|docker\s+pull|pip3?\s+install|python3?\s+-m\s+pip\s+install|uv\s+(pip\s+install|sync)|npm\s+(install|ci|i)\b|pnpm\s+(install|i)\b|yarn(\s+install)?\s*$|bun\s+install|cargo\s+(build|install)|gradlew?(\.bat)?\s+\S*(build|assemble)|go\s+build|winget\s+install|choco\s+install|apt(-get)?\s+install|brew\s+install|ollama\s+pull|huggingface-cli\s+download|hf\s+download)\b/im

export const isHeavy = (command: string) => HEAVY.test(command)

/** Free bytes on the drive holding `dir`, or undefined if it cannot be read. */
async function freeBytes($: any, dir: string): Promise<number | undefined> {
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const drive = /^([A-Za-z]):/.exec(dir)?.[1] ?? 'C'
    const r = await $.process.run(['powershell', '-NoProfile', '-Command', `(Get-PSDrive -Name ${drive}).Free`])
    const n = Number(r.stdout.trim())
    return r.exitCode === 0 && Number.isFinite(n) && r.stdout.trim() !== '' ? n : undefined
  }
  const r = await $.process.run(['df', '-Pk', dir])
  const kb = Number(r.stdout.trim().split('\n').at(-1)?.split(/\s+/)[3])
  return r.exitCode === 0 && Number.isFinite(kb) ? kb * 1024 : undefined
}

export const gb = (bytes: number) => Math.round(bytes / 1e8) / 10

export function headroomCheck(on: On, signOff: SignOff, minFreeGB: number) {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e: any, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    if (!isHeavy(command)) return next(e)
    const cwd = await $.session.cwd()
    const free = await freeBytes($, cwd).catch(() => undefined)
    if (free === undefined || free >= minFreeGB * 1e9) return next(e)
    const key = `headroom\u0000${command.trim()}`
    if (signOff.consume(key, await $.clock.now())) return next(e)
    return { deny: `[headroom-check] Refused: this build or install would start with only ${gb(free)} GB free on the drive holding ${cwd} ` +
      `(the floor is ${minFreeGB} GB). Free space first. Otherwise: ${signOffText(signOff.codeFor(key))}` }
  }).catch(($, e, next) => next(e))
}
