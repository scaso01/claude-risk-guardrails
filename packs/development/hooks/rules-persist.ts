import type { On } from 'claude-code'

// The rules that break first when context is lost come back after every compaction, resume,
// clear and model switch, and every subagent starts with its own short list.

const RELOAD_SOURCES = new Set(['compact', 'resume', 'clear'])

const clean = (s: string) => s.replace(/\r\n?/g, '\n').trim()

export function reloadText(source: unknown, rules: string): string | undefined {
  if (typeof source !== 'string' || !RELOAD_SOURCES.has(source)) return undefined
  const text = clean(rules)
  return text ? `[rules-persist] Core rules, reloaded after ${source}:\n${text}` : undefined
}

export function switchText(to: unknown, rules: string): string | undefined {
  const text = clean(rules)
  const name = typeof to === 'string' && to ? to : 'a new model'
  return text ? `[rules-persist] Core rules, reloaded because the model switched to ${name}:\n${text}` : undefined
}

async function expand($: any, p: string): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return p.replace(/^~(?=[\\/]|$)/, home)
}

async function readRules($: any, path: string): Promise<string | undefined> {
  if (!path) return undefined
  return $.fs.read(await expand($, path)).catch(() => undefined)
}

const withContext = (r: any, text: string | undefined) =>
  text ? { ...r, additionalContext: [...(r.additionalContext ?? []), text] } : r

export type RulesOptions = { rulesFile: string; subagentRulesFile: string }

export function rulesPersist(on: On, opts: RulesOptions) {
  on('classic.SessionStart', async ($, e: any, next) => {
    const r = await next(e)
    if (typeof e.source !== 'string' || !RELOAD_SOURCES.has(e.source)) return r
    const rules = await readRules($, opts.rulesFile)
    return withContext(r, rules === undefined ? undefined : reloadText(e.source, rules))
  })

  on('classic.PostModelSwitch', async ($, e: any, next) => {
    const r = await next(e)
    const rules = await readRules($, opts.rulesFile)
    return withContext(r, rules === undefined ? undefined : switchText(e.to_model ?? e.switch?.to_model, rules))
  })

  on('classic.SubagentStart', async ($, e: any, next) => {
    const r = await next(e)
    const rules = await readRules($, opts.subagentRulesFile)
    return withContext(r, rules === undefined ? undefined : clean(rules) || undefined)
  })
}
