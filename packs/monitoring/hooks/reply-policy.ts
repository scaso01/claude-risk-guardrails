import type { On } from 'claude-code'
import { countWords, droppedFacts, hasList, isNotice, keepProtected, lengthReminder, listItems, lostProtected, ownWords, parseRules, rewritePrompt, tightBullets, issuesLast, cutUnprovenFacts, stripFiller, userText, violations } from './policy'
import { MIN_QUOTE, judgePrompt, parseVerdicts, clockTime, factBullets, fillArgv, passes, proofOf, quoteFound, quoteIn, replaceProof, proofSuffix, rewriteFacts, toolMatches, claimPrompt, parseClaims, otherBullets, rewriteOther, openingOf, openingPrompt, openingFixPrompt, openingRetryPrompt, parseOpening, removedNote, talksAboutChecking, evidenceView, holdNotes } from './policy'
import type { CheckFile } from './policy'

export type ReplyPolicyOptions = { policyFile: string; model: string; logDir: string; rewrite: boolean; proofCheck: boolean; proofChecksFile: string; judgeModel: string; allLines: boolean; hold: boolean }

export const replyPolicyOptions = (o: Record<string, unknown>): ReplyPolicyOptions => ({
  policyFile: String(o.replyPolicyFile ?? '').trim(),
  model: String(o.replyPolicyModel || 'sonnet'),
  logDir: String(o.replyPolicyLogDir ?? '~/.claude/guardrails/reply-policy').trim(),
  rewrite: o.replyPolicyRewrite === true,
  proofCheck: o.proofCheck === true,
  proofChecksFile: String(o.proofChecksFile ?? '').trim(),
  judgeModel: String(o.proofJudgeModel ?? 'sonnet').trim(),
  allLines: o.proofCheckAllLines === true,
  hold: o.proofHold !== false,
})

export const HOLD_TOOL_NAME = 'proof_check'
export const HOLD_TOOL = `mcp__guardrails-monitoring__${HOLD_TOOL_NAME}`
export const HOLD_TOOL_DEF = { name: HOLD_TOOL_NAME, description: 'Internal reply check run by a plugin. Never call it yourself.', inputSchema: { type: 'object' }, isDeferred: false }
const MAX_HOLDS = 2
const HOLD_BUDGET_MS = 60_000
const HIDDEN = { type: 'Box', props: { display: 'none' } } as any

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

/** Per-day tally in `<logDir>/counts.json`: replies checked, and drafts over the line or word cap. */
async function countReply($: any, logDir: string, overCap: boolean): Promise<void> {
  if (!logDir) return
  const path = `${await expand($, logDir)}/counts.json`
  let counts: Record<string, { checked: number; overCap: number }> = {}
  try { counts = JSON.parse(await $.fs.read(path)) } catch { /* first reply */ }
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const d = counts[day] ?? { checked: 0, overCap: 0 }
  d.checked++
  if (overCap) d.overCap++
  counts[day] = d
  await $.fs.write(path, JSON.stringify(counts))
}

const PER_CHECK_MS = 10_000
const PER_REPLY_MS = 20_000

/**
 * Keeps a Facts found: line only when its proof holds now: a named check from the user's
 * allowlist re-run and passed, a quoted tool output, the user's own words, or an attached screenshot.
 */
export type Cut = { line: string; reason: string }
export type Rewrite = { from: string; to: string }
/** Lines that passed earlier in this turn: the line as written, the line as shown, and the output that proved it. */
export type Passed = Map<string, { to: string; ev?: string }>

// The judge sometimes copies the proof bracket into its rewrite; the original bracket is added back once.
const withoutProof = (s: string) => { let t = s.trim(); while (proofOf(`- ${t}`)) t = t.replace(/\s*\((?:[^()"]|"[^"]*")+\)\.?\s*$/, ''); return t }

const outputOf = (u: any) => [u.text ?? '', typeof u.result === 'string' ? u.result : JSON.stringify(u.result ?? '')]
const evidenceOf = (u: any, quote = '') => `${u.tool} ${JSON.stringify(u.input ?? '').slice(0, 300)}\n${evidenceView(outputOf(u).join('\n'), quote)}`

/**
 * With a judge, the proof only has to point at the right output; the judge then rules on the claim.
 * Without one, the proof's own form is all that is checked, so the stricter rules apply.
 */
export async function verifyFacts($: any, text: string, checks: CheckFile | null, lastPrompt: string, judgeModel = '', allLines = false, passed: Passed = new Map()): Promise<{ text: string; cut: number; cuts: Cut[]; judgeMs: number; rewrites: Rewrite[] }> {
  const bullets = factBullets(text)
  // Picks carry their own evidence counts but are choices, so they are never cut as claims.
  const others = judgeModel && allLines ? otherBullets(text).filter(b => !/^- (My pick|Other choice)/i.test(b)) : []
  if (!bullets.length && !others.length) return { text, cut: 0, cuts: [], judgeMs: 0, rewrites: [] }
  const evidence = new Map<string, string>()
  let msgs: any[] | undefined
  const messages = async () => (msgs ??= await $.session.messages())
  const newestCalls = async () => (await messages()).flatMap(m => m.toolUses ?? []).reverse()
  const deadline = (await $.clock.now()) + PER_REPLY_MS
  const verdict = new Map<string, string | null>()
  const cuts: Cut[] = []
  const rewrites: Rewrite[] = []
  // A quote the call itself contains (an echo) proves nothing.
  const echoes = (q: string, u: any) => quoteIn(q, [JSON.stringify(u.input ?? '')])

  const judge = async (b: string): Promise<string | { cut: string }> => {
    const p = proofOf(b)
    if (!p) return { cut: 'no proof in a checkable form' }
    if (p.kind === 'screenshot') return /\[Image #\d+\]/.test(lastPrompt) ? b : { cut: 'no screenshot in the last message' }
    if (p.kind === 'shotfile') {
      // The judge reads text only, so it can confirm the picture was opened but never what it shows; the label says so.
      const name = p.file.replace(/^.*[\\/]/, '').toLowerCase()
      const opened = (await newestCalls()).some(u => u.tool === 'Read' && String(u.input?.file_path ?? '').replace(/^.*[\\/]/, '').toLowerCase() === name)
      return opened ? replaceProof(b, `from screenshot: ${p.file.replace(/^.*[\\/]/, '')}`) : { cut: 'that screenshot file was never opened this session' }
    }
    if (p.kind === 'said') return quoteFound(p.quote, (await messages()).filter(m => m.role === 'user').map(m => m.text)) ? b : { cut: 'the user never wrote that quote' }
    if (p.kind === 'empty') {
      if (!judgeModel) return { cut: 'an empty-output proof needs the judge' }
      const u = (await newestCalls()).find(u => toolMatches(p.source, u.tool, u.input))
      if (!u) return { cut: 'no command matching the proof ran this session' }
      evidence.set(b, evidenceOf(u)); return b
    }
    if (p.kind === 'quote') {
      const short = p.quote.trim().length < MIN_QUOTE
      // A short quote matches too much by chance, so it counts only in the output of the command it names.
      if (short && !judgeModel) return { cut: `quote shorter than ${MIN_QUOTE} characters` }
      let named = false
      const calls = await newestCalls()
      for (const u of calls) {
        if (!toolMatches(p.source, u.tool, u.input)) continue
        named = true
        if (echoes(p.quote, u)) continue
        if (quoteIn(p.quote, outputOf(u))) { evidence.set(b, evidenceOf(u, p.quote)); return b }
      }
      // The label is the model's own name for the command ("port check"), so with a judge any output holding the quote will do.
      if (judgeModel && !short) for (const u of calls) {
        if (!echoes(p.quote, u) && quoteIn(p.quote, outputOf(u))) { evidence.set(b, evidenceOf(u, p.quote)); return b }
      }
      if (short && !named) return { cut: `quote shorter than ${MIN_QUOTE} characters` }
      return { cut: named ? 'quote not in that command\'s output' : 'no command matching the proof ran this session' }
    }
    const def = checks?.checks[p.id]
    if (!def) return { cut: checks ? `check "${p.id}" is not in the checks file` : 'no checks file' }
    const argv = fillArgv(def, p.args, checks!.aliases)
    if (!argv) return { cut: 'check arguments missing or unsafe' }
    const left = deadline - (await $.clock.now())
    if (left <= 0) return { cut: 'out of time for checks this reply' }
    const r = await $.process.run(argv, { timeoutMs: Math.min(PER_CHECK_MS, left) }).catch((err: Error) => err)
    if (r instanceof Error) return { cut: `check did not run: ${r.message}` }
    if (!passes(def.pass, r, p.args)) return { cut: `check failed: exit ${r.exitCode}, output "${r.stdout.trim().slice(0, 120)}"` }
    evidence.set(b, `${argv.join(' ')}\nexit ${r.exitCode}\n${r.stdout.slice(0, 20000)}`)
    return replaceProof(b, `${[p.id, ...p.args].join(' ')}, ${clockTime(await $.clock.now())}`)
  }

  const ask = (prompt: string): Promise<any> => $.model.complete({ model: judgeModel, prompt }).catch((err: Error) => ({ error: err.message }))
  const said = (rr: any) => rr?.error ? `: ${rr.error}` : rr?.isAnswered ? `; it said: ${String(rr.text).slice(0, 300)}` : '; no answer'
  const start = await $.clock.now()
  // Lines outside Facts found: are sorted into claims and the rest while the facts are checked.
  const claimsAsked = others.length ? ask(claimPrompt(others)) : null

  // A line that passed earlier in this turn is kept as it passed, so a second look cannot flip it.
  for (const b of bullets) {
    if (verdict.has(b)) continue
    const was = passed.get(b)
    if (was) { verdict.set(b, was.to); if (was.ev) evidence.set(b, was.ev); continue }
    const v = await judge(b)
    if (typeof v === 'string') verdict.set(b, v)
    else { verdict.set(b, null); cuts.push({ line: b, reason: v.cut }) }
  }
  const judged = [...evidence.keys()].filter(b => verdict.get(b) && !passed.has(b))
  if (judgeModel && judged.length) {
    const rr = await ask(judgePrompt(judged.map(b => ({ fact: verdict.get(b)!, evidence: evidence.get(b)! })), true))
    const verdicts = rr?.isAnswered ? parseVerdicts(rr.text, judged.length) : []
    // Live, a judge that gave no answer cut a true line, so the facts it left unruled are asked once more.
    const unruled = judged.map((_, i) => i).filter(i => !verdicts[i])
    if (unruled.length) {
      const ra = await ask(judgePrompt(unruled.map(i => ({ fact: verdict.get(judged[i]!)!, evidence: evidence.get(judged[i]!)! })), true))
      const again = ra?.isAnswered ? parseVerdicts(ra.text, unruled.length) : []
      unruled.forEach((i, k) => { if (again[k]) verdicts[i] = again[k] })
    }
    const retry: { b: string; to: string; why: string }[] = []
    judged.forEach((b, i) => {
      const v = verdicts[i]
      if (v?.verdict === 'TRUE') return
      if (v?.verdict === 'UNPROVEN' && v.rewrite) retry.push({ b, to: `- ${withoutProof(v.rewrite.replace(/^[-\s]+/, ''))}${proofSuffix(verdict.get(b)!)}`, why: v.why })
      verdict.set(b, null)
      if (!(v?.verdict === 'UNPROVEN' && v.rewrite)) cuts.push({ line: b, reason: v ? `judge: ${v.verdict} ${v.why}` : `judge gave no verdict${said(rr)}` })
    })
    if (retry.length) {
      // A narrowed fact is shown only if the judge, asked afresh, finds the narrowed wording proven.
      const r2 = await ask(judgePrompt(retry.map(x => ({ fact: x.to, evidence: evidence.get(x.b)! }))))
      const v2 = r2?.isAnswered ? parseVerdicts(r2.text, retry.length) : []
      retry.forEach((x, i) => {
        if (v2[i]?.verdict === 'TRUE') { verdict.set(x.b, x.to); rewrites.push({ from: x.b, to: x.to }); return }
        cuts.push({ line: x.b, reason: `judge: UNPROVEN ${x.why}; narrowed version not proven either: ${v2[i] ? `${v2[i]!.verdict} ${v2[i]!.why}` : `no verdict${said(r2)}`}` })
      })
    }
  }
  for (const b of bullets) { const to = verdict.get(b); if (to) passed.set(b, { to, ev: evidence.get(b) }) }
  let out = rewriteFacts(text, s => verdict.has(s) ? verdict.get(s)! : s)
  // In a live test a fact cut from the list still stood in the opening sentence, so the opening is held to what survived.
  const opening = judgeModel && bullets.length ? openingOf(out.text) : ''
  const openedAs = opening ? passed.get(opening) : undefined
  if (openedAs) out = { ...out, text: out.text.replace(opening, openedAs.to) }
  else if (opening) {
    const proven = factBullets(out.text)
    const shown = [...evidence.entries()].filter(([b]) => verdict.get(b)).map(([, e]) => e)
    const ro = await ask(openingPrompt(opening, proven, cuts.map(c => c.line), [...new Set(shown)]))
    let o = ro?.isAnswered ? parseOpening(String(ro.text)) : null
    if (o && 'unsupported' in o) {
      const rf = await ask(openingFixPrompt(opening, o.unsupported))
      const f = rf?.isAnswered ? parseOpening(String(rf.text)) : null
      o = f && 'rewrite' in f ? f : null
    }
    if (!o) $.ui.status(`proof-check: opening sentence not checked${said(ro)}`)
    else if ('rewrite' in o && o.rewrite !== opening) {
      // In testing one rewrite added a claim of its own, so the new wording is judged before it is shown.
      const ev = [...proven, '', ...new Set(shown)].join('\n')
      const proves = async (s: string) => {
        const re = await ask(judgePrompt([{ fact: s, evidence: ev }]))
        return (re?.isAnswered ? parseVerdicts(re.text, 1)[0] : undefined) ?? { verdict: 'NONE', why: `no verdict${said(re)}` }
      }
      let to = o.rewrite
      // Live, two rewrites swapped an answer for "I haven't confirmed ...", which the judge passed because it claims nothing.
      const meta = { verdict: 'NOT AN ANSWER', why: 'it talks about checking instead of answering' }
      let v = talksAboutChecking(to) ? meta : await proves(to)
      if (v.verdict !== 'TRUE') {
        // In testing, one retry that names the judge's reason turned a failed rewrite into a proven one.
        const rr = await ask(openingRetryPrompt(to, v.why, proven, [...new Set(shown)]))
        const r2 = rr?.isAnswered ? parseOpening(String(rr.text)) : null
        if (r2 && 'rewrite' in r2 && !talksAboutChecking(r2.rewrite)) {
          const v2 = await proves(r2.rewrite)
          if (v2.verdict === 'TRUE') { to = r2.rewrite; v = v2 }
        }
      }
      if (v.verdict === 'TRUE') {
        out = { ...out, text: out.text.replace(opening, to) }
        rewrites.push({ from: opening, to })
        passed.set(opening, { to })
      } else {
        // A fact that already passed the judge opens the reply instead, so it never opens blank or unproven.
        const first = proven[0] ? withoutProof(proven[0].replace(/^[-\s]+/, '')).replace(/[^.!?]$/, '$&.') : ''
        out = { ...out, text: first ? out.text.replace(opening, first) : out.text.replace(opening, '').replace(/^\s+/, '') }
        cuts.push({ line: opening, reason: `opening: rewrite "${to}" not proven either: ${v.verdict} ${v.why}; opened with ${first ? `the fact "${first}"` : 'nothing'}` })
      }
    } else passed.set(opening, { to: opening })
  }
  if (claimsAsked) {
    const rc = await claimsAsked
    if (!rc?.isAnswered) $.ui.status(`proof-check: lines outside Facts found: were not checked${said(rc)}`)
    else {
      const claims = parseClaims(rc.text, others.length)
      const keep = new Map<string, string | null>()
      for (const [i, b] of others.entries()) {
        if (!claims[i] || keep.has(b)) continue
        const was = passed.get(b)
        if (was) { keep.set(b, was.to); continue }
        const v = await judge(b)
        if (typeof v === 'string') { keep.set(b, v); passed.set(b, { to: v }) }
        else { keep.set(b, null); cuts.push({ line: b, reason: `claim outside Facts found: ${v.cut}` }) }
      }
      const o = rewriteOther(out.text, s => keep.has(s) ? keep.get(s)! : s)
      out = { text: o.cut ? o.text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') : o.text, cut: out.cut + o.cut }
    }
  }
  return { ...out, cuts, judgeMs: judgeModel ? (await $.clock.now()) - start : 0, rewrites }
}

/** One JSON line per cut fact, so wrongly cut true facts can be found and fixed later. */
async function logCuts($: any, logDir: string, cuts: Cut[], prompt: string): Promise<void> {
  if (!logDir || !cuts.length) return
  const path = `${await expand($, logDir)}/proof-cuts.jsonl`
  let old = ''
  try { old = await $.fs.read(path) } catch { /* first cut */ }
  const at = new Date(await $.clock.now()).toISOString()
  const rows = cuts.map(c => JSON.stringify({ at, prompt: prompt.slice(0, 200), ...c })).join('\n')
  await $.fs.write(path, `${old}${rows}\n`)
}

/** One JSON line per checked reply, so the real wait the judge adds can be measured. */
async function logTime($: any, logDir: string, judgeMs: number, facts: number, cut: number): Promise<void> {
  if (!logDir) return
  const path = `${await expand($, logDir)}/proof-times.jsonl`
  let old = ''
  try { old = await $.fs.read(path) } catch { /* first reply */ }
  await $.fs.write(path, `${old}${JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), judgeMs, facts, cut })}\n`)
}

/** One JSON line per held reply: the round, the judge time and why each line failed. */
async function logHold($: any, logDir: string, round: number, judgeMs: number, cuts: Cut[], prompt: string): Promise<void> {
  if (!logDir) return
  const path = `${await expand($, logDir)}/proof-holds.jsonl`
  let old = ''
  try { old = await $.fs.read(path) } catch { /* first hold */ }
  await $.fs.write(path, `${old}${JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), prompt: prompt.slice(0, 200), round, judgeMs, cuts })}\n`)
}

/** Without the file every check-style proof fails, so its fact lines are cut, never trusted. */
async function loadChecks($: any, file: string): Promise<CheckFile | null> {
  if (!file) return null
  try { return JSON.parse(await $.fs.read(await expand($, file))) }
  catch (err) { $.ui.status(`proof-check: checks file unreadable: ${(err as Error).message}`); return null }
}

export function replyPolicy(on: On, opts: ReplyPolicyOptions) {
  let lastPrompt = ''
  let lastFull = ''
  let fromPhone: Promise<boolean> | undefined
  // One prompt's holds: how many, the checking time spent, the notes for the model, and what passed or failed.
  let holds = 0
  let holdMs = 0
  let notes = ''
  let passed: Passed = new Map()
  let failed = new Set<string>()

  if (opts.proofCheck && opts.hold) {
    on('tool.call', { tool: HOLD_TOOL } as any, async () => ({ result: `Checked. ${notes}`, context: [notes] }) as any)
    // The hold is the plugin's own step, so its row, result and a group of only it draw nothing.
    on('ui.render', { component: 'ToolUse' } as any, async ($, e: any, next) => e.props?.tool === HOLD_TOOL ? HIDDEN : next(e))
    on('ui.render', { component: 'ToolResult' } as any, async ($, e: any, next) => e.props?.tool === HOLD_TOOL ? HIDDEN : next(e))
    on('ui.render', { component: 'ToolGroup' } as any, async ($, e: any, next) => {
      const calls = e.props?.calls ?? []
      return calls.length && calls.every((c: any) => c.tool === HOLD_TOOL) ? HIDDEN : next(e)
    })
  }

  on('prompt.submit', async ($, e, next) => {
    const t = userText(e.text)
    if (isNotice(t)) return next(e)
    lastPrompt = t
    holds = 0; holdMs = 0; notes = ''; passed = new Map(); failed = new Set()
    let rules
    try {
      const file = opts.policyFile ? await expand($, opts.policyFile) : `${$.plugin.root}/policies/terse.md`
      rules = parseRules(await $.fs.read(file))
    } catch (err) {
      // An unreadable policy file must never block the prompt; the reply check reports it.
      $.ui.status(`reply-policy: no length reminder: ${(err as Error).message}`)
      return next(e)
    }
    if (rules.lift.test(ownWords(t))) return next(e)
    return next({ ...e, context: [...(e.context ?? []), lengthReminder(rules, rules.confused.test(ownWords(t)))] })
  })

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
    let confusedReply = false
    if (r.toolUses.length === 0 && r.stopReason === 'end_turn' && text) {
      try {
        const file = opts.policyFile ? await expand($, opts.policyFile) : `${$.plugin.root}/policies/terse.md`
        const rules = parseRules(await $.fs.read(file))
        const own = ownWords(lastPrompt)
        const confused = rules.confused.test(own)
        confusedReply = confused
        const v = rules.lift.test(own) && !confused ? [] : violations(text, rules, confused)
        await countReply($, opts.logDir, v.some(x => / \(cap \d+/.test(x))).catch(() => undefined)
        let draft = text, vv = v
        if (v.some(x => x.startsWith('filler:'))) {
          const stripped = stripFiller(text, rules.banned)
          if (stripped !== text) { draft = stripped; vv = violations(stripped, rules, confused) }
        }
        const base = draft
        const items = listItems(text)
        // A model rewrite is the one step that can lose a point, so it runs only when asked for.
        for (let attempt = 0; opts.rewrite && attempt < 3 && vv.length; attempt++) {
          const rr: any = await $.model.complete({ model: opts.model, prompt: rewritePrompt(rules, lastPrompt, draft, vv, confused) })
          const cand = rr.isAnswered ? rr.text.trim() : ''
          if (!cand) break
          if (hasList(text) && !hasList(cand)) { vv = [...v, 'the rewrite dropped the list; keep the main points as a list']; continue }
          if (!confused && listItems(cand) < items) { vv = [...v, `the rewrite dropped list items; keep all ${items} items and their table rows, shorten the prose instead`]; continue }
          const lost = confused ? [] : droppedFacts(text, cand)
          if (lost.length) { vv = [...v, `the rewrite dropped these facts: ${lost.join(', ')}; put every one back and cut words instead`]; continue }
          const warned = lostProtected(text, cand)
          if (warned.length) { vv = [...v, `the rewrite dropped these warnings; keep each one: ${warned.join(' | ')}`]; continue }
          draft = cand
          vv = violations(cand, rules, confused)
        }
        // Substance beats length: a rewrite that lost list items or facts is discarded.
        if (!confused && (listItems(draft) < items || droppedFacts(text, draft).length)) { draft = base; vv = violations(base, rules, confused) }
        let kept = 0
        if (draft !== text && (vv.length < v.length || countWords(draft) < countWords(text))) {
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
    if (r.toolUses.length === 0 && r.stopReason === 'end_turn') {
      let facts
      let held = false
      try {
        if (opts.proofCheck) {
          const v = await verifyFacts($, out, await loadChecks($, opts.proofChecksFile), lastPrompt, opts.judgeModel, opts.allLines, passed)
          holdMs += v.judgeMs
          if (opts.judgeModel && factBullets(out).length) await logTime($, opts.logDir, v.judgeMs, factBullets(out).length, v.cuts.length).catch((err: Error) => $.ui.status(`proof-check: time log not written: ${err.message}`))
          // A line that failed last round and came back unchanged means the notes did not help, so it is cut instead.
          const repeat = v.cuts.some(c => failed.has(c.line))
          if (opts.hold && v.cuts.length && holds < MAX_HOLDS && holdMs < HOLD_BUDGET_MS && !repeat) {
            holds++
            failed = new Set(v.cuts.map(c => c.line))
            notes = holdNotes(out, v.cuts)
            await logHold($, opts.logDir, holds, v.judgeMs, v.cuts, lastPrompt).catch((err: Error) => $.ui.status(`proof-check: hold log not written: ${err.message}`))
            $.ui.status(`proof-check: fixing ${v.cuts.length} line(s) before you see the reply (round ${holds})`)
            held = true
          } else {
            const rows = [...v.cuts, ...v.rewrites.map(w => ({ line: w.from, reason: `narrowed to: ${w.to}` }))]
            await logCuts($, opts.logDir, rows, lastPrompt).catch((err: Error) => $.ui.status(`proof-check: cut log not written: ${err.message}`))
          }
          facts = v
        } else facts = cutUnprovenFacts(out)
        const secs = 'judgeMs' in facts && facts.judgeMs ? `, judge ${Math.round(facts.judgeMs / 1000)} s` : ''
        const narrowed = 'rewrites' in facts && facts.rewrites.length ? `, narrowed ${facts.rewrites.length}` : ''
        // A held reply already said it is being fixed; its draft's cuts are never shown.
        if (!held && (facts.cut || secs)) $.ui.status(opts.proofCheck
          ? `proof-check: cut ${facts.cut} line(s) whose proof did not hold${narrowed}${secs}`
          : `reply-policy: cut ${facts.cut} fact line(s) with no proof`)
      } catch (err) {
        facts = cutUnprovenFacts(out)
        $.ui.status(`proof-check failed, kept only bracketed facts: ${(err as Error).message}`)
      }
      if (held) {
        // The draft is never shown; the model gets the notes from the hold tool and writes the reply again.
        for (const c of buf) if (c.kind === 'thinking' || c.kind === 'engine') yield c
        yield { kind: 'tool', index: 999, id: `toolu_proofhold${await $.clock.now()}`, name: HOLD_TOOL } as any
        yield { kind: 'input', index: 999, json: '{}' } as any
        yield { kind: 'stop', stopReason: 'tool_use', usage: r.usage } as any
        return { ...r, answer: '', toolUses: [{ name: HOLD_TOOL, input: {} }], stopReason: 'tool_use' }
      }
      out = removedNote(tightBullets(issuesLast(facts.text)), 'cuts' in facts ? facts.cuts.length : facts.cut)
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
