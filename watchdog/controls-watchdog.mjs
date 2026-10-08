#!/usr/bin/env node
// controls-watchdog: a plain SessionStart command hook that names any guardrail pack that has
// stopped loading. It runs outside the mod engine on purpose, so a pack that fails to load
// cannot take its own warning down with it.
//
// Each pack writes <heartbeat dir>/<pack>.txt at session start (its heartbeatDir option).
// A pack is reported once it missed the last two process starts; one miss alone is ignored,
// because a run launched with a different set of mods would raise a false alarm.
// Fails open: it never blocks a session from starting.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SETTLE_MS = 60_000
const KEEP_STARTS = 20
const PROCESS_STARTS = new Set(['startup', 'resume'])

export function expectedPacks(settings) {
  const names = new Set()
  for (const [key, on] of Object.entries(settings.enabledPlugins ?? {}))
    if (on && /^guardrails-[a-z]+@/.test(key)) names.add(key.split('@')[0])
  const dirs = String(settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(path.delimiter === ';' ? ';' : /[;:]/)
  for (const d of dirs.map(s => s.trim()).filter(Boolean)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(d, '.claude-plugin', 'plugin.json'), 'utf8'))
      if (/^guardrails-/.test(meta.name)) names.add(meta.name)
    } catch { /* not a plugin folder */ }
  }
  return [...names].sort()
}

/** The older of the last two settled process starts, or null before there are two. */
export function referenceStart(starts, now) {
  const settled = starts.filter(t => now - t >= SETTLE_MS)
  return settled.length >= 2 ? settled[settled.length - 2] : null
}

export function check(packs, beats, starts, now) {
  const ref = referenceStart(starts, now)
  return packs.map(name => {
    const seen = beats[name] ?? null
    return { name, lastSeen: seen ? new Date(seen).toISOString() : null, ok: !(ref !== null && (seen === null || seen < ref)) }
  })
}

export function warning(rows) {
  const down = rows.filter(r => !r.ok)
  if (!down.length) return ''
  const list = down.map(r => `${r.name} (last loaded ${r.lastSeen ?? 'never'})`).join(', ')
  return `[controls-watchdog] GUARDRAILS NOT LOADING: ${list} did not start in the last two sessions, so those ` +
    'controls are off. Tell the user in your first reply, in plain words, which pack is down. Check with: claude plugin list'
}

function main() {
  const dir = (process.argv[2] ?? '~/.claude/guardrails/heartbeats').replace(/^~(?=[\\/]|$)/, os.homedir())
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json')
  let input = {}
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { /* no stdin */ }
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const packs = expectedPacks(settings)
  const stateFile = path.join(dir, '.watchdog-state.json')
  let starts = []
  try { starts = JSON.parse(fs.readFileSync(stateFile, 'utf8')).starts ?? [] } catch { /* first run */ }
  const now = Date.now()
  const beats = {}
  for (const p of packs) { try { beats[p] = fs.statSync(path.join(dir, `${p}.txt`)).mtimeMs } catch { beats[p] = null } }
  const rows = check(packs, beats, starts, now)
  if (PROCESS_STARTS.has(input.source)) starts = [...starts, now].slice(-KEEP_STARTS)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify({ starts }))
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runAt: new Date(now).toISOString(), packs: rows }, null, 1))
  const text = warning(rows)
  if (text) process.stdout.write(text + '\n')
}

function selfCheck() {
  const t0 = 1_000_000_000_000
  const starts = [t0, t0 + 3_600_000]
  const now = t0 + 7_200_000
  const rows = check(['guardrails-a', 'guardrails-b'], { 'guardrails-a': t0 + 3_700_000, 'guardrails-b': t0 - 1 }, starts, now)
  if (!rows[0].ok || rows[1].ok) throw new Error('down detection is wrong: ' + JSON.stringify(rows))
  if (check(['guardrails-b'], {}, [t0], now)[0].ok !== true) throw new Error('one missed start must not alarm')
  if (!warning(rows).includes('guardrails-b')) throw new Error('warning does not name the pack')
  const packs = expectedPacks({ enabledPlugins: { 'guardrails-approval@claude-risk-guardrails': true, 'other@x': true, 'guardrails-records@y': false } })
  if (JSON.stringify(packs) !== '["guardrails-approval"]') throw new Error('expectedPacks: ' + JSON.stringify(packs))
  process.stdout.write('controls-watchdog self-check: PASS\n')
}

if (process.argv.includes('--self-check')) selfCheck()
else { try { main() } catch (e) { process.stderr.write(`controls-watchdog: ${e.message}\n`) } }
