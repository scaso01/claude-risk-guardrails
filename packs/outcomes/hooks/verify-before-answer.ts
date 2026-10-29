import type { On } from 'claude-code'

const MAX_HOLDS = 2
const PER_RESULT = 4000
const ALL_RESULTS = 60000
const TIMEOUT_MS = 30000
const TOOL_NAME = 'verify_before_answering'
const TOOL = `mcp__guardrails-outcomes__${TOOL_NAME}`
// Each hold made the model dig further and report a new unchecked frontier; this rule sits in the call input because the model ignores rules that only appear in a tool result.
const NO_NEW = 'Then answer only what the question asks. Never add a remark about something the question did not ask. If a check the question needs could not run, keep that claim marked as not checked and say why in a few words; never state it as fact.'
// Helper reports are second-hand; the parent re-checks what it passes on, so they never count as evidence.
const NOT_EVIDENCE = new Set(['Agent', 'Task'])

const ROLE =
  'You audit an assistant reply before the user sees it. The assistant runs on the user\'s own Windows PC with tools that can ' +
  'read any file, run shell and PowerShell commands, query local services and other machines over SSH, and search the web. '

const REWRITE_RULE =
  '"rewrite" lists side statements the question does not need that the tool results do not show, including each sentence under ' +
  'CONCLUSIONS whose conclusion the tool results do not show (for example "it listens on 0.0.0.0, so other machines can reach it" when ' +
  'nothing tested another machine). For each give "sentence", copied exactly from the draft, and "rewrite", the same sentence with ' +
  'the unchecked part removed, using only words already in that sentence; use "" to drop the sentence entirely. ' +
  'Never remove the word "only", a negation (not, no, never, n\'t), a percentage, or a reason (a "because" clause, or the part before "so"), ' +
  'and never change a line that says something was not checked.'

// A search hit was taken as proof of what code does, so code claims went out as fact.
const BACKED =
  'A claim about what code or a config file does counts as shown only when the tool results include the code that does it, read with ' +
  'the lines around it; a search hit, a variable name or a constant alone shows only that the line exists. A search that found nothing ' +
  'shows only that those words are absent from the files searched, not that the feature is absent.\n'

// A requested reply the evidence contradicted was listed as missing, which pushed the model toward stating it.
const DECLINED =
  'A reply or statement the user asked for that the draft declines, because the tool results contradict it or do not show it, counts as answered; never list it in "missing".\n'

const RISK_PREFIX = 'Risk without a fix and %: '
// A flagged risk with no fix, or a fix with no tested confidence, leaves the user to guess whether it can be closed.
const COVERED =
  'A risk is covered when the draft names a fix for it and either gives a % confidence that the fix works with the reason for that %, ' +
  'or says there is no % yet and names the test that would give one (for example "No % yet. Rerunning the backtest would give one."). ' +
  'The fix and the % or test may sit on the lines under the risk, and one fix may cover a group of risk lines. ' +
  'Whether the reason behind a % is itself backed is judged like any other claim, never as a risk.'
const RISKS =
  '"check" also lists each risk the draft flags that is not covered. Every line under a "Risk:" heading is a risk, however small or factual it sounds; ' +
  'so is a warning that something could go wrong, or an item in a list of risks, problems or issues, including when the user asked for the risks. ' +
  'This holds even when the line says it was not checked, is untested or has no fix yet, and a fix with no % and no named test is not covered. ' + COVERED +
  ` Its "claim" starts "${RISK_PREFIX}" and its "how" is "add the simplest fix and your % confidence that it works, with the evidence behind the %; with no evidence yet, name the test that would give it".\n`

export const FIRST =
  ROLE + 'You get the user question, every tool result the assistant saw this turn, the draft reply, and the draft sentences that draw a conclusion.\n' + BACKED +
  '"check" lists each statement in the draft that (a) the user needs to answer their question, (b) is NOT backed by the tool results, ' +
  'and (c) a read-only check could settle in under a minute; never suggest a check that changes files, databases, services or settings. Skip lines the draft itself marks as unchecked; those are listed already. ' +
  'Never list in "check": what the tool results already show; opinions or estimates labelled as such; anything needing the user\'s own ' +
  'eyes, accounts, passwords or physical access; investigations beyond the question asked.\n' + RISKS +
  '"missing" lists each part of the user question that the draft does not answer.\n' + DECLINED + REWRITE_RULE + '\n' +
  'Answer with JSON only: {"check":[{"claim":"<short>","how":"<the exact check>"}],"missing":["<part of the question>"],"rewrite":[{"sentence":"<exact>","rewrite":"<shorter>"}]}. Empty lists if none.'

export const AGAIN =
  ROLE + 'Earlier the assistant was told to settle some items before answering. You get the user question, those items, every tool result this ' +
  'turn, the new draft, the draft sentences that draw a conclusion, and NOTES: new draft lines that say something was not checked. ' + BACKED +
  'For each item, decide if it is resolved: a tool result settles it; or the draft no longer says it ' +
  'and the user question did not ask about it; or the draft says in a few words why only the user can settle it. ' +
  `An item starting "${RISK_PREFIX}" is resolved when the draft now covers that risk or no longer flags it. ` + COVERED + ' ' +
  'Judge ONLY these items in "open"; never add new ones there.\n' +
  '"hold" lists the number of each note the user question needs AND a read-only check could settle in under a minute. ' +
  'Leave a note out of "hold" if only a change (a real download, a restart, a write), the user, a login, admin rights, physical access ' +
  'or a long test could settle it, or if the question does not need it; those notes stay in the reply as written.\n' +
  '"missing" lists each part of the user question that the new draft does not answer.\n' + DECLINED + REWRITE_RULE + '\n' +
  'Answer with JSON only: {"open":[<numbers of the items still unresolved>],"hold":[<numbers of notes to check first>],"missing":["<part of the question>"],"rewrite":[{"sentence":"<exact>","rewrite":"<shorter>"}]}.'

export const LAST =
  ROLE + 'This draft is the assistant\'s final answer and will be shown now. You get the user question, every tool result this turn, the items ' +
  'still open, the draft, and the draft sentences that draw a conclusion.\n' + BACKED + REWRITE_RULE + '\n' +
  'Answer with JSON only: {"rewrite":[{"sentence":"<exact>","rewrite":"<shorter>"}]}. Empty list if none.'

const MARK = /\b(?:haven['’]t|have not|hasn['’]t|didn['’]t|did not|couldn['’]t|could not|can['’]t|cannot|unable to)\s+(?:yet\s+)?(?:verif|check|confirm|test|run|look|open|load|read|see|tell)|\bnot (?:yet )?(?:verified|checked|confirmed)\b|\bunverified\b|\bunknown\b|\b(?:don['’]t|do not) know\b|\bnot sure\b|\bonly (?:read|searched|skimmed|grepped|checked|looked)\b|\bshould I (?:check|look|read|verify|confirm)\b|\bwant me to\b|\bif you (?:want|like|'d like)\b|\bI can (?:check|look|read|verify|confirm|find)\b|\blet me (?:check|look|read|verify|confirm)\b/i

// A note that says the check was refused would only be refused again, so it stays as written instead of causing another stop.
const REASON = /\b(?:log ?in|sign(?:ed)? in|password|credential|your account|admin|elevat|permission|only you|your own|physical|blocked|refused|denied|not allowed|tool rule|stopped me)/i

// Sentences that draw a conclusion; each goes to the judge by name so a "so X" guess is ruled on every time.
const CONCLUDE = /(?:,\s*so\b|\bso (?:it|its|it's|other|any|anyone|you|your|this|that|they|the|there|nothing|no)\b|\bwhich means\b|\bthat means\b|\bmeaning\b|\btherefore\b|\bthus\b|\bhence\b|\bimpl(?:y|ies)\b|\bsuggests?\b|\blikely\b|\bprobably\b)/i

export function unchecked(draft: string): string[] {
  const out: string[] = []
  let inSection = false
  for (const l of draft.split(/\r?\n/)) {
    if (/^\s*Unverified:\s*$/i.test(l)) { inSection = true; continue }
    if (/^\s*[A-Z][a-z ]+:\s*$/.test(l)) inSection = false
    if (l.trim() && (inSection || MARK.test(l))) out.push(l.trim().replace(/^[-*]\s*/, ''))
  }
  return out
}

export function conclusions(draft: string): string[] {
  const out: string[] = []
  for (const l of draft.split(/\r?\n/)) {
    for (const s of l.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').split(/(?<=[.!?])\s+/)) {
      if (s.trim() && CONCLUDE.test(s)) out.push(s.trim())
    }
  }
  return out.slice(0, 20)
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'LSP', 'TaskOutput', TOOL])
const READ_MCP = /__(?:brain_|ctx_)?(?:get|list|read|search|query|recall|status|listening_ports|check|recent|summaries|timeline)\w*$/
const SHELLS = new Set(['Bash', 'PowerShell'])
const CTX_CODE = /__ctx_execute(?:_file)?$/
const CTX_BATCH = /__ctx_batch_execute$/
// Code run through the sandbox can write or launch processes in ways shell patterns miss.
const CODE_WRITES = /\b(?:writeFile|appendFile|unlink|rm|rmdir|mkdir|rename|copyFile|cp|symlink|chmod|truncate)(?:Sync)?\s*\(|\b(?:createWriteStream|child_process|exec(?:Sync|File)?|spawn(?:Sync)?|subprocess|os\.system|os\.popen|requests\.(?:post|put|delete|patch))\b|method\s*[:=]\s*['"](?:POST|PUT|DELETE|PATCH)|urlopen\([^)]*\bdata\s*=/i
// Over ssh or `sh -c` the quoted text is a command, so redirects inside it count.
const REMOTE = /\b(?:ssh(?:\.exe)?|docker\s+exec|sh\s+-c|bash\s+-c|wsl)\b/i
const shellReadOnly = (cmd: string) => !WRITES.test(cmd) && !(SQL.test(cmd) && SQL_WRITES.test(cmd)) && !REDIRECT.test(unquote(cmd)) && !(REMOTE.test(cmd) && REDIRECT.test(cmd))
const WRITES = new RegExp([
  String.raw`\b(?:Set|Remove|New|Add|Clear|Stop|Start|Restart|Rename|Move|Copy|Install|Uninstall|Enable|Disable|Register|Unregister|Update|Suspend|Resume|Reset|Push|Export|Mount|Dismount|Initialize|Repair|Invoke)-(?!Location\b|StrictMode\b|WebRequest\b|RestMethod\b|Command\b|Sleep\b)\w+|\bFormat-Volume\b`,
  String.raw`\bOut-File\b|\bWrite-(?!Output\b|Host\b|Verbose\b|Error\b)\w+`,
  String.raw`(?:^|[\s;|&('"\x60])(?:rm|mv|cp|del|erase|rmdir|rd|mkdir|md|touch|chmod|chown|kill|taskkill|pkill|killall|shutdown|reboot|tee|truncate|dd|ln|winget|choco|apt|apt-get|scoop|crontab)(?=\s|$)`,
  String.raw`\bsed\s+-i|\bfind\b[^|;]*\s-(?:delete|exec)\b|\bpip\d?\s+(?:install|uninstall)|\b(?:npm|bun|pnpm|yarn)\s+(?:i|install|add|remove|uninstall|update|publish)\b`,
  String.raw`\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|reset|checkout|switch|restore|clean|add|rm|mv|stash|rebase|merge|pull|tag|cherry-pick|revert|am|apply|gc|prune|branch\s+-[dDmM]|config\s+(?!--get))`,
  String.raw`\bschtasks(?:\.exe)?\s+/(?:create|delete|change|run|end)|\bsc(?:\.exe)?\s+(?:stop|start|config|delete|create|pause|continue)\b|\bnet\s+(?:stop|start|user|share)\b`,
  String.raw`\bdocker\s+(?:compose|rm|rmi|stop|start|restart|kill|run|pull|push|create|update|prune|system\s+prune|volume\s+rm|network\s+rm|cp)\b|\bsystemctl\s+(?:start|stop|restart|reload|enable|disable|mask)\b|\bsudo\b`,
  String.raw`-Method\s+['"]?(?:Post|Put|Delete|Patch)|-X\s*['"]?(?:POST|PUT|DELETE|PATCH)\b|\bcurl\b[^|;]*\s(?:-d|--data\S*|-F|--form)\s`,
  String.raw`\.(?:Delete|Kill|Stop|Start|Remove|Create|Terminate|MoveTo|CopyTo|Truncate|WriteAll\w*)\(|\bopen\([^)]*['"][wax+]|(?<!stdout|stderr)\.write\(|\bos\.(?:remove|unlink|rename|replace|rmdir|makedirs|mkdir)\b|\bshutil\.|\.unlink\(|\.write_(?:text|bytes)\(`,
].join('|'), 'i')
const SQL = /\b(?:sqlite3|execute|executescript|psql|mysql)\b/i
const SQL_WRITES = /\b(?:wal_checkpoint|VACUUM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX)|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX))/i
// A redirect writes a file; quoted text and here-docs are data, so redirects are looked for outside them.
const REDIRECT = /(?<![0-9&=<-])>{1,2}(?!\s*(?:\$null|\/dev\/null|&\d|NUL\b))\s*[\w~.\/\\$]/
const unquote = (c: string) => c
  .replace(/<<-?\s*'?(\w+)'?[\s\S]*?\n\1\b/g, ' ')
  .replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, ' ')
  .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' ')

export function readOnly(tool: string, e: any): boolean {
  if (READ_TOOLS.has(tool)) return true
  if (SHELLS.has(tool)) return shellReadOnly(String(e.command ?? ''))
  if (!tool.startsWith('mcp__')) return false
  if (CTX_BATCH.test(tool)) return Array.isArray(e.commands) && e.commands.every((c: any) => shellReadOnly(String(c?.command ?? '')))
  if (CTX_CODE.test(tool)) {
    const code = String(e.code ?? '')
    if (/^(?:shell|bash|sh|powershell)$/i.test(String(e.language ?? ''))) return shellReadOnly(code)
    return !WRITES.test(code) && !CODE_WRITES.test(code) && !(SQL.test(code) && SQL_WRITES.test(code))
  }
  return READ_MCP.test(tool)
}

type Item = { claim: string; how: string; src: 'mark' | 'judge' | 'missing'; by?: number }
type Pair = { sentence: string; rewrite: string }

// The judge sometimes writes prose and then the JSON, or the JSON twice; the last whole object is its answer.
export function lastJson(text: string): any {
  const end = text.lastIndexOf('}')
  let i = end < 0 ? -1 : text.lastIndexOf('{', end)
  while (i >= 0) {
    try {
      const v = JSON.parse(text.slice(i, end + 1))
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch { /* not a whole object yet; widen */ }
    i = i === 0 ? -1 : text.lastIndexOf('{', i - 1)
  }
  return undefined
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
const ints = (v: any): number[] => Array.isArray(v) ? v.filter((n: any) => Number.isInteger(n)) : []
const pairs =(v: any): Pair[] => Array.isArray(v) ? v.filter((p: any) => typeof p?.sentence === 'string' && typeof p?.rewrite === 'string' && p.sentence.trim()) : []
const strings = (v: any): string[] => Array.isArray(v) ? v.filter((s: any) => typeof s === 'string' && s.trim()) : []
const HEADING = /^\s*[A-Z][a-z ]+:\s*$/
// The marker needs a space after it, so "2.5 GB" keeps its number.
const LEAD = /^\s*(?:[-*]|\d+\.)\s+/
const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
// A trim only removes words, so its words appear in the sentence in the same order, each used once.
const inOrder = (w: string, s: string) => {
  const src = tokens(s)
  let k = 0
  return tokens(w).every(t => { while (k < src.length && src[k] !== t) k++; return k++ < src.length })
}

const GUARD = /\bonly\b|\b(?:not|never|no|none|nothing|nobody|neither|nor|cannot)\b|n['’]t\b|\d+(?:\.\d+)?\s*%|\b(?:because|since|due to)\b|\b(?:probably|likely|unlikely|maybe|perhaps|possibly|may|might|could|seems?|appears?|about|approximately|around|roughly|nearly|almost|at least|at most|up to|most|mostly|some|unless|if|estimated|suspect|guess|think|believe)\b/gi
const SO = /,?\s*\b(?:so|which means|that means|meaning|therefore|thus|hence)\b/i
const REASONS = new RegExp(REASON.source, 'gi')
const STOP = new Set('the a an is are was on of to and in it its it s that this for with by as at be not only'.split(' '))
const content = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(x => !STOP.has(x)))
const guarded = (s: string) => (s.match(GUARD) ?? []).map(t => t.toLowerCase().replace(/’/g, "'").replace(/\s+/g, ''))

// A trim may cut the conclusion after "so", but never the reason before it, "only", a negation, a %, or a reason only the user can settle.
export function safeTrim(s: string, w: string): boolean {
  let keep = s
  const have = words(w)
  const m = SO.exec(s)
  if (m) {
    const head = s.slice(0, m.index)
    const headWords = words(head)
    if (![...headWords].every(x => have.has(x))) return false
    const tailKept = [...content(s.slice(m.index + m[0].length))].some(x => have.has(x) && !headWords.has(x))
    keep = tailKept ? s : head
  }
  const left = guarded(w)
  for (const t of guarded(keep)) {
    const k = left.indexOf(t)
    if (k < 0) return false
    left.splice(k, 1)
  }
  const lw = w.toLowerCase()
  return (keep.match(REASONS) ?? []).every(r => lw.includes(r.toLowerCase()))
}

const SPECIFIC = /\d[\d,.:]*\d|\d|\b[\w-]+\.(?:exe|py|js|ts|json|db|log|md|txt|ya?ml|toml|ps1|sh|cmd|bat)\b/gi
const specifics = (s: string) => new Set((s.match(SPECIFIC) ?? []).map(x => x.toLowerCase().replace(/,/g, '')))
// The judge also drops side facts the tool results back; a fix may cut an untested conclusion, never a number or file name the results show.
const cutsBacked = (s: string, w: string, evidence: string) => {
  const kept = specifics(w)
  const ev = evidence.toLowerCase().replace(/,/g, '')
  return [...specifics(s)].some(x => !kept.has(x) && ev.includes(x))
}

// Applies only rewrites that remove words: a rewrite may never add a word the sentence did not already have.
export function applyRewrites(text: string, list: Pair[], evidence = ''): { text: string; applied: number } {
  let out = text
  let applied = 0
  for (const p of list) {
    const s = p.sentence.trim().replace(LEAD, '')
    const w = p.rewrite.trim().replace(LEAD, '')
    if (!out.includes(s)) continue
    if (!inOrder(w, s)) continue
    if (MARK.test(s) || unchecked(out).some(n => n.includes(s) || s.includes(n))) continue
    if (w ? !safeTrim(s, w) : /\d\s*%/.test(s)) continue
    if (evidence && cutsBacked(s, w, evidence)) continue
    if (!w) {
      const lines = out.split('\n')
      const k = lines.findIndex(l => l.replace(LEAD, '').trim() === s)
      if (k < 0) continue
      lines.splice(k, 1)
      out = lines.join('\n')
    } else {
      out = out.replace(s, () => w)
    }
    applied++
  }
  return { text: applied ? tidy(out) : text, applied }
}

function tidy(text: string): string {
  const lines = text.split('\n')
  const keep = lines.filter((l, n) => {
    if (!HEADING.test(l)) return true
    const rest = lines.slice(n + 1).find(x => x.trim())
    return rest !== undefined && !HEADING.test(rest)
  })
  return keep.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const MERGE = 0.65
export function overlap(a: string, b: string): number {
  const A = content(a)
  const B = content(b)
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n / Math.max(1, Math.min(A.size, B.size))
}
// A number or name in the shorter claim that the longer lacks means two different claims (port 8080 vs 8081, desktop vs laptop).
function sameFacts(a: string, b: string): boolean {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  const long = content(l)
  const names = new Set((s.match(/\b[A-Z][\w-]*/g) ?? []).flatMap(x => tokens(x)))
  return [...content(s)].every(x => long.has(x) || !(/\d/.test(x) || names.has(x)))
}
// Two judges often flag one claim in different words; the longer wording is kept. One judge's own items are distinct by intent.
export function dedupe(items: Item[]): Item[] {
  const out: Item[] = []
  for (const i of items) {
    const k = out.findIndex(o => norm(o.claim) === norm(i.claim) || (o.src === 'judge' && i.src === 'judge' && o.by !== i.by && overlap(o.claim, i.claim) >= MERGE && sameFacts(o.claim, i.claim)))
    if (k < 0) out.push(i)
    else if (i.claim.length > out[k].claim.length) out[k] = i
  }
  return out
}

type Stats = { calls: number; failed: number; input: number; output: number }

// The mod loader only lets $ be passed to functions declared at the top of the file.
async function ask($: any, stats: Stats, system: string, prompt: string, maxTokens: number): Promise<{ j: any; raw: string }> {
  let raw = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    stats.calls++
    const v: any = await $.model.complete({ model: 'sonnet', system, prompt, maxTokens, timeoutMs: TIMEOUT_MS })
      .catch((err: Error) => ({ isAnswered: false, reason: err.message }))
    if (v.isAnswered) {
      stats.input += v.usage?.input_tokens ?? 0
      stats.output += v.usage?.output_tokens ?? 0
      raw = v.text
      const j = lastJson(v.text)
      if (j) return { j, raw }
    } else {
      raw = `${v.reason}${v.status ? ` ${v.status}` : ''}`
    }
  }
  stats.failed++
  return { j: undefined, raw }
}

async function record($: any, log: string | undefined, add: Record<string, number>) {
  if (!log) return
  const path = `${log}/usage-${new Date().toISOString().slice(0, 10)}.json`
  const cur: any = await $.fs.read(path).then((t: any) => JSON.parse(String(t))).catch(() => ({}))
  for (const [k, v] of Object.entries(add)) cur[k] = (cur[k] ?? 0) + v
  await $.fs.write(path, JSON.stringify(cur, null, 1)).catch(() => undefined)
}

export const VERIFY_TOOL = TOOL
export const VERIFY_RECORDED = 'Recorded. Run each check now with your tools, then write one answer. If a check truly cannot be run, say in a few words why only the user can. Do not mention this step. Checks must be read-only: never change files, databases, services, tasks or settings to settle one.'

export type VerifyState = { question: string; results: string[]; open: Item[]; holds: number; stats: Stats }

export const VERIFY_TOOL_DEF = { name: TOOL_NAME, description: 'Records the checks you will run before answering.', inputSchema: { type: 'object', properties: { check: { type: 'array', items: { type: 'string' } } } }, isDeferred: false }

export function verifyState(): VerifyState {
  return { question: '', results: [], open: [], holds: 0, stats: { calls: 0, failed: 0, input: 0, output: 0 } }
}

export function verifyPrompt(st: VerifyState, text: string) {
  Object.assign(st, verifyState(), { question: text })
}

/** Refusal for a write while a held reply is being settled, else undefined. */
export function verifyDeny(st: VerifyState, e: any): { deny: string } | undefined {
  if (st.holds > 0 && !e.agentId && !readOnly(e.tool, e)) {
    return { deny: 'While settling the checks before your answer, only read-only tools and commands may run. Find a read-only way, or keep the claim marked as not checked and say why.' }
  }
  return undefined
}

/** Keeps a main-session tool result as evidence for the checker. */
export function verifyRecord(st: VerifyState, e: any, r: any) {
  if (e.agentId || e.tool === TOOL || NOT_EVIDENCE.has(e.tool)) return
  const out = typeof r.text === 'string' ? r.text : JSON.stringify(r.result ?? r.deny ?? '')
  st.results.push(`[${e.tool}] ${JSON.stringify(e).slice(0, 300)}
${String(out).slice(0, PER_RESULT)}`)
}

// The loader follows the hook context only into functions declared in this file, never across an import,
// so the reply hook lives here; the pack's one unmatched tool hook calls verifyDeny and verifyRecord.
export function verifyBeforeAnswer(on: On, st: VerifyState) {
  on('tool.call', { tool: TOOL } as any, async () => ({ result: VERIFY_RECORDED }))
  on('turn.step', async function* ($, e, next) {
    return yield* step($, st, e, next)
  })
}

async function* step($: any, st: VerifyState, e: any, next: any) {
  const s = next(e)
  if (e.agentId) return yield* s
  const buf: any[] = []
  for await (const c of s) buf.push(c)
  const r: any = await s.result
  const text = buf.filter(c => c.kind === 'text').map(c => c.text).join('')
  const final = r.toolUses.length === 0 && r.stopReason === 'end_turn' && text.trim()
  if (!final) { for (const c of buf) yield c; return r }

  const log = await $.env.get('HOLD_LOG')
  const evidence = st.results.join('\n\n').slice(-ALL_RESULTS) || '(no tools were run this turn)'
  const concl = conclusions(text)
  const head = `USER QUESTION:\n${st.question}\n\nTOOL RESULTS THIS TURN:\n${evidence}\n\n`
  const tail = `DRAFT REPLY:\n${text}\n\nCONCLUSIONS:\n${concl.map(l => `- ${l}`).join('\n') || '(none)'}`
  let check: Item[] = []
  let fixes: Pair[] = []
  const verdicts: string[] = []

  // Cutting the sentences this last check called unchecked removed 38% of true lines and caught 14% of planted false ones, so it only trims side statements.
  if (st.holds >= MAX_HOLDS) {
    const v = await ask($, st.stats, LAST, head + `ITEMS STILL OPEN:\n${st.open.map(i => `- ${i.claim}`).join('\n') || '(none)'}\n\n` + tail, 1500)
    verdicts.push(v.raw)
    if (v.j) fixes = pairs(v.j.rewrite)
    else $.ui.log('verify-before-answer: final check skipped, its AI check failed twice')
  } else if (st.holds === 0) {
    const marked: Item[] = unchecked(text).map(l => ({ claim: l, how: 'run the check that settles it, or remove the line if the question did not ask for it', src: 'mark' }))
    const both = await Promise.all([ask($, st.stats, FIRST, head + tail, 1500), ask($, st.stats, FIRST, head + tail, 1500)])
    const judged: Item[] = []
    for (const [by, v] of both.entries()) {
      verdicts.push(v.raw)
      if (!v.j) continue
      for (const i of Array.isArray(v.j.check) ? v.j.check : []) if (typeof i?.claim === 'string' && typeof i?.how === 'string') judged.push({ claim: i.claim, how: i.how, src: 'judge', by })
      for (const m of strings(v.j.missing)) judged.push({ claim: `The question asks: ${m}`, how: 'answer this part using a read-only check', src: 'missing' })
      fixes.push(...pairs(v.j.rewrite))
    }
    if (both.every(v => !v.j)) $.ui.log('verify-before-answer: checker skipped, its AI check failed twice')
    check = dedupe([...marked, ...judged])
  } else {
    const left = unchecked(text)
    const onlyMarks = st.open.every(i => i.src === 'mark')
    const gone = st.open.every(i => !text.includes(i.claim))
    const openClaims = new Set(st.open.map(i => i.claim))
    // A note is never deleted: it is either checked first (hold) or shown as written.
    const notes = left.filter(l => !REASON.test(l) && !openClaims.has(l))
    const holdNote = (l: string): Item => ({ claim: l, how: 'run the read-only check that settles it, then replace the note with what you found', src: 'mark' })
    if (!(onlyMarks && gone && !left.length && !concl.length)) {
      const v = await ask($, st.stats, AGAIN, head + `ITEMS:\n${st.open.map((i, n) => `${n + 1}. ${i.claim}`).join('\n')}\n\nNOTES:\n${notes.map((l, n) => `${n + 1}. ${l}`).join('\n') || '(none)'}\n\n` + tail, 1500)
      verdicts.push(v.raw)
      if (v.j) {
        const nums = ints(v.j.open)
        check = st.open.filter((_, n) => nums.includes(n + 1))
        const hold = ints(v.j.hold)
        notes.forEach((l, n) => { if (hold.includes(n + 1)) check.push(holdNote(l)) })
        for (const m of strings(v.j.missing)) check.push({ claim: `The question asks: ${m}`, how: 'answer this part using a read-only check', src: 'missing' })
        fixes = pairs(v.j.rewrite)
      } else {
        $.ui.log('verify-before-answer: re-check skipped, its AI check failed twice')
        check = notes.map(holdNote)
      }
    } else {
      verdicts.push('(skipped: every held line was self-marked and is gone)')
    }
    check = dedupe(check)
  }

  if (check.length) {
    if (log) await $.fs.write(`${log}/judge-${Date.now()}.json`, JSON.stringify({ hold: st.holds, draft: text, verdicts, check, fixes }, null, 1)).catch(() => undefined)
    st.open = check
    st.holds++
    $.ui.log(`verify-before-answer: held, ${check.length} to check`)
    for (const c of buf) if (c.kind === 'thinking' || c.kind === 'engine') yield c
    yield { kind: 'tool', index: 999, id: `toolu_hold${Date.now()}`, name: TOOL } as any
    const input = { check: [...check.map(i => `${i.claim} (how: ${i.how})`), NO_NEW] }
    yield { kind: 'input', index: 999, json: JSON.stringify(input) } as any
    yield { kind: 'stop', stopReason: 'tool_use', usage: r.usage } as any
    return { ...r, answer: '', toolUses: [{ name: TOOL, input }], stopReason: 'tool_use' }
  }

  const fixed = applyRewrites(text, fixes, evidence)
  if (log) await $.fs.write(`${log}/judge-${Date.now()}.json`, JSON.stringify({ hold: st.holds, draft: text, verdicts, check, fixes, shown: fixed.text, rewrites: fixed.applied }, null, 1)).catch(() => undefined)
  await record($, log, { answers: 1, holds: st.holds, calls: st.stats.calls, failed: st.stats.failed, input_tokens: st.stats.input, output_tokens: st.stats.output, rewrites: fixed.applied })
  if (fixed.text === text) { for (const c of buf) yield c; return r }
  let done = false
  for (const c of buf) {
    if (c.kind === 'text') { if (!done) { done = true; yield { ...c, text: fixed.text } } }
    else yield c
  }
  return { ...r, answer: fixed.text }

}
