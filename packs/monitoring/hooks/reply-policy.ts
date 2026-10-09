import type { On } from 'claude-code'
import { countWords, hasList, keepProtected, parseRules, rewritePrompt, userText, violations } from './policy'

export type ReplyPolicyOptions = { policyFile: string; model: string; logDir: string }

// A chat started from Remote Control has no surface and reads like a scripted run; what sets it
// apart on Windows is a `claude remote-control` process among its ancestors.
const ANCESTRY = `$i=$PID; $out=@(); foreach($n in 1..6){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$i"; if(-not $p){break}; $out+=$p.CommandLine; $i=$p.ParentProcessId }; $out -join "\`n"`

async function launchedByRemoteControl($: any): Promise<boolean> {
  if ((await $.env.get('OS')) !== 'Windows_NT') return false
  const r = await $.process.run(['powershell', '-NoProfile', '-Command', ANCESTRY])
  return r.exitCode === 0 && /claude(\.exe)?"?\s+remote-control\b/.test(r.stdout)
}

async function expand($: any, p: string): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return p.replace(/^~(?=[\\/]|$)/, home)
}

export function replyPolicy(on: On, opts: ReplyPolicyOptions) {
  let lastPrompt = ''
  let lastFull = ''
  let fromPhone: Promise<boolean> | undefined

  on('prompt.submit', ($, e, next) => { lastPrompt = userText(e.text); return next(e) })

  on('command.run', { command: 'full-reply' }, async () =>
    ({ text: lastFull || 'reply-policy has not shortened a reply since it last loaded.' }))

  on('turn.step', async function* ($, e, next) {
    const s = next(e)
    if (e.agentId) return yield* s
    const entry = await $.env.get('CLAUDE_CODE_ENTRYPOINT')
    const human = entry === 'cli' || entry === 'claude-desktop' ||
      (await $.session.surfaces()).length > 0 ||
      (await (fromPhone ??= launchedByRemoteControl($).catch(() => false)))
    if (!human) return yield* s
    const buf: any[] = []
    for await (const c of s) buf.push(c)
    const r = await s.result
    const text = buf.filter(c => c.kind === 'text').map(c => c.text).join('')
    let out = text
    if (r.toolUses.length === 0 && r.stopReason === 'end_turn' && text) {
      try {
        const file = opts.policyFile ? await expand($, opts.policyFile) : `${$.plugin.root}/policies/terse.md`
        const rules = parseRules(await $.fs.read(file))
        const confused = rules.confused.test(lastPrompt)
        const v = rules.lift.test(lastPrompt) && !confused ? [] : violations(text, rules, confused)
        let draft = text, vv = v
        for (let attempt = 0; attempt < 2 && vv.length; attempt++) {
          const rr: any = await $.model.complete({ model: opts.model, prompt: rewritePrompt(rules, lastPrompt, draft, vv, confused) })
          const cand = rr.isAnswered ? rr.text.trim() : ''
          if (!cand) break
          if (!confused && hasList(text) && !hasList(cand)) { vv = [...v, 'the rewrite dropped the list; keep the main points as a list']; continue }
          draft = cand
          vv = violations(cand, rules, confused)
        }
        let kept = 0
        if (draft !== text && vv.length < v.length) {
          ;({ text: out, kept } = keepProtected(text, draft))
          lastFull = text
          $.ui.status(`reply-policy: ${countWords(text)}→${countWords(out)} words${confused ? ' (confusion)' : ''}` +
            `${kept ? `, ${kept} warning line(s) kept` : ''} · /full-reply`)
        }
        if (v.length && opts.logDir) {
          const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
          await $.fs.write(`${await expand($, opts.logDir)}/${stamp}.json`,
            JSON.stringify({ prompt: lastPrompt, confused, violations: v, remaining: vv, kept, before: text, after: out, rewritten: out !== text }, null, 2))
        }
      } catch (err) {
        $.ui.status(`reply-policy off this reply: ${(err as Error).message}`)
      }
    }
    if (out === text) { for (const c of buf) yield c; return r }
    let done = false
    for (const c of buf) {
      if (c.kind === 'text') { if (!done) { done = true; yield { ...c, text: out } } }
      else yield c
    }
    return { ...r, answer: out }
  })
}
