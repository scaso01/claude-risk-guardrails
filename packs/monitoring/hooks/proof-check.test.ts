import { test, expect } from 'claude-code/testing'
import { fillArgv, passes, proofOf, quoteFound, toolMatches, factBullets, cutUnprovenFacts, judgePrompt, parseVerdicts, otherBullets, parseClaims, openingOf, parseOpening, openingPrompt, removedNote, talksAboutChecking, evidenceView } from './policy'
import type { CheckFile } from './policy'
import { verifyFacts } from './reply-policy'

const CHECKS: CheckFile = {
  aliases: { dotfiles: 'C:/repos/dotfiles' },
  checks: {
    'git-clean': { argv: ['git', '-C', '{1}', 'status', '--porcelain'], pass: 'empty' },
    'slow': { argv: ['slow'], pass: 'exit0' },
  },
}

const MSGS = [
  { role: 'user', text: 'please push the dotfiles repo', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [
    { tool_use_id: 'a', tool: 'Bash', input: { command: 'git -C dotfiles status' }, text: 'On branch master\nnothing to commit, working tree clean' },
    { tool_use_id: 'b', tool: 'Bash', input: { command: 'echo "pushed to origin ok"' }, text: 'pushed to origin ok' },
  ] },
]

function fake(outputs: Record<string, { exitCode: number; stdout: string }>) {
  const ran: string[][] = []
  const $ = {
    ui: { status: () => {} },
    clock: { now: async () => Date.UTC(2026, 9, 26, 22, 20) },
    session: { messages: async () => MSGS },
    process: {
      run: async (argv: string[]) => {
        ran.push(argv)
        const r = outputs[argv[0]!]
        if (!r) throw new Error('timed out')
        return { ...r, stderr: '' }
      },
    },
  }
  return { $, ran }
}

const reply = (...facts: string[]) => `Answer.\n\nFacts found:\n${facts.map(f => `- ${f}`).join('\n')}\n\nDone:\n- built it`

test('proofOf reads the four proof forms and rejects vague ones', () => {
  expect(proofOf('- Repo is clean (check: git-clean dotfiles)')).toEqual({ kind: 'check', id: 'git-clean', args: ['dotfiles'] })
  expect(proofOf('- Clean (git status: "nothing to commit")')).toEqual({ kind: 'quote', source: 'git status', quote: 'nothing to commit' })
  expect(proofOf('- You want it (you said: "push the dotfiles")')).toEqual({ kind: 'said', quote: 'push the dotfiles' })
  expect(proofOf('- Status bar shows it (your screenshot)')).toEqual({ kind: 'screenshot' })
  expect(proofOf('- Clean (git status, 2:40 PM)')).toBe(null)
  expect(proofOf('- No bracket at all')).toBe(null)
})

test('quotes under 6 characters never count, and matching ignores case and spacing', () => {
  expect(quoteFound('clean', ['working tree clean'])).toBe(false)
  expect(quoteFound('Nothing  to commit', ['nothing to commit, working tree clean'])).toBe(true)
})

test('toolMatches needs every word of the source in the call', () => {
  expect(toolMatches('git status', 'Bash', { command: 'git -C x status' })).toBe(true)
  expect(toolMatches('git log', 'Bash', { command: 'git -C x status' })).toBe(false)
})

test('fillArgv fills aliases and refuses unsafe or missing arguments', () => {
  const def = CHECKS.checks['git-clean']!
  expect(fillArgv(def, ['dotfiles'], CHECKS.aliases)).toEqual(['git', '-C', 'C:/repos/dotfiles', 'status', '--porcelain'])
  expect(fillArgv(def, ["x'; rm -rf /"], CHECKS.aliases)).toBe(null)
  expect(fillArgv(def, [], CHECKS.aliases)).toBe(null)
})

test('passes applies empty, exit0, equals and contains rules', () => {
  expect(passes('empty', { exitCode: 0, stdout: '\n' }, [])).toBe(true)
  expect(passes('empty', { exitCode: 0, stdout: ' M a.ts' }, [])).toBe(false)
  expect(passes('equals:0', { exitCode: 0, stdout: '0\r\n' }, [])).toBe(true)
  expect(passes('contains:{2}', { exitCode: 0, stdout: 'llama-server' }, ['8080', 'llama'])).toBe(true)
  expect(passes('contains:{2}', { exitCode: 1, stdout: 'llama-server' }, ['8080', 'llama'])).toBe(false)
  expect(passes('made-up', { exitCode: 0, stdout: '' }, [])).toBe(false)
})

test('a check proof is re-run; a pass is stamped with the time, a fail is cut', async () => {
  const ok = fake({ git: { exitCode: 0, stdout: '' } })
  const r = await verifyFacts(ok.$, reply('Dotfiles has no unsaved work (check: git-clean dotfiles)'), CHECKS, '')
  expect(r.cut).toBe(0)
  expect(ok.ran).toEqual([['git', '-C', 'C:/repos/dotfiles', 'status', '--porcelain']])
  expect(r.text).toMatch(/- Dotfiles has no unsaved work \(git-clean dotfiles, \d{1,2}:20 [AP]M\)/)

  const dirty = fake({ git: { exitCode: 0, stdout: ' M terse.md' } })
  const d = await verifyFacts(dirty.$, reply('Dotfiles has no unsaved work (check: git-clean dotfiles)'), CHECKS, '')
  expect(d.cut).toBe(1)
  expect(d.text).toBe('Answer.\n\nDone:\n- built it')
})

test('unknown check ids, a missing checks file and a failing run are all cut', async () => {
  const f = fake({})
  expect((await verifyFacts(f.$, reply('X (check: made-up thing)'), CHECKS, '')).cut).toBe(1)
  expect((await verifyFacts(f.$, reply('X (check: git-clean dotfiles)'), null, '')).cut).toBe(1)
  expect((await verifyFacts(f.$, reply('X (check: slow)'), CHECKS, '')).cut).toBe(1)
})

test('a quote proof must come from a real tool output, not from the call itself', async () => {
  const f = fake({})
  const real = await verifyFacts(f.$, reply('Nothing left to commit (git status: "nothing to commit")'), CHECKS, '')
  expect(real.cut).toBe(0)
  expect(f.ran).toEqual([])
  expect((await verifyFacts(f.$, reply('Pushed (git push: "nothing to commit")'), CHECKS, '')).cut).toBe(1)
  expect((await verifyFacts(f.$, reply('Clean (git status: "everything pushed")'), CHECKS, '')).cut).toBe(1)
  expect((await verifyFacts(f.$, reply('Pushed (echo: "pushed to origin ok")'), CHECKS, '')).cut).toBe(1)
})

test('your words and your screenshot are checked against what you sent', async () => {
  const f = fake({})
  expect((await verifyFacts(f.$, reply('You asked for a push (you said: "push the dotfiles")'), CHECKS, '')).cut).toBe(0)
  expect((await verifyFacts(f.$, reply('You asked for a merge (you said: "merge the branch")'), CHECKS, '')).cut).toBe(1)
  expect((await verifyFacts(f.$, reply('The bar shows it (your screenshot)'), CHECKS, '[Image #8] look')).cut).toBe(0)
  expect((await verifyFacts(f.$, reply('The bar shows it (your screenshot)'), CHECKS, 'no image here')).cut).toBe(1)
})

test('each cut line comes back with the reason it failed', async () => {
  const f = fake({ git: { exitCode: 0, stdout: ' M terse.md' } })
  const r = await verifyFacts(f.$, reply(
    'A (git status, now)',
    'B (check: git-clean dotfiles)',
    'C (check: made-up x)',
    'D (git log: "abcdefgh")',
    'E (git status: "everything pushed")',
    'F (git status: "clean")',
  ), CHECKS, '')
  expect(r.cuts.map(c => c.reason)).toEqual([
    'no proof in a checkable form',
    'check failed: exit 0, output "M terse.md"',
    'check "made-up" is not in the checks file',
    'no command matching the proof ran this session',
    'quote not in that command\'s output',
    'quote shorter than 6 characters',
  ])
  expect(r.cuts[0]!.line).toBe('- A (git status, now)')
})

test('parseVerdicts reads numbered verdicts and leaves missing ones empty', () => {
  const v = parseVerdicts('1. TRUE: matches\n2 - FALSE - 56 lines not 45\nnoise\n4. UNPROVEN firewall never tested', 4)
  expect(v.map(x => x?.verdict)).toEqual(['TRUE', 'FALSE', undefined, 'UNPROVEN'])
  expect(v[1]!.why).toBe('56 lines not 45')
  expect(parseVerdicts('FACT 1: TRUE - ok\n**Fact 2** — UNPROVEN no fetch\n3: Verdict: FALSE wrong', 3).map(x => x?.verdict)).toEqual(['TRUE', 'UNPROVEN', 'FALSE'])
  const real = parseVerdicts('Fact 1: TRUE. Status output reads "nothing to commit".\n2 UNPROVEN: contents not shown.', 2)
  expect(real.map(x => x?.verdict)).toEqual(['TRUE', 'UNPROVEN'])
  expect(real[1]!.why).toBe('contents not shown.')
  expect(judgePrompt([{ fact: '- A (x: "yyyyyy")', evidence: 'out' }])).toContain('FACT 1: - A (x: "yyyyyy")\nEVIDENCE 1:\nout')
})

test('the judge keeps only facts it marks TRUE and cuts the rest with its reason', async () => {
  const f = fake({ git: { exitCode: 0, stdout: '' } })
  const prompts: string[] = []
  const $ = { ...f.$, model: { complete: async (r: any) => (prompts.push(r.prompt), { isAnswered: true, text: '1. TRUE ok\n2. FALSE wrong count' }) } }
  const r = await verifyFacts($, reply(
    'Dotfiles has no unsaved work (check: git-clean dotfiles)',
    'Nothing left to commit (git status: "nothing to commit")',
    'B (git status, now)',
  ), CHECKS, '', 'sonnet')
  const facts = prompts.filter(p => p.startsWith('You check facts'))
  expect(facts.length).toBe(1)
  expect(prompts.length).toBe(2)
  expect(facts[0]).toContain('EVIDENCE 2:\nBash')
  expect(facts[0]).toContain('nothing to commit, working tree clean')
  expect(facts[0]).toContain('REWRITE:')
  expect(r.cuts.map(c => c.reason)).toEqual(['no proof in a checkable form', 'judge: FALSE wrong count'])
  expect(r.text).toMatch(/Dotfiles has no unsaved work \(git-clean dotfiles, /)
  expect(r.text).not.toContain('Nothing left to commit')
})

test('a judge that fails or skips a fact cuts it', async () => {
  const f = fake({})
  const down = { ...f.$, model: { complete: async () => { throw new Error('rate limited') } } }
  const a = await verifyFacts(down, reply('Clean (git status: "nothing to commit")'), CHECKS, '', 'sonnet')
  expect(a.cuts[0]!.reason).toBe('judge gave no verdict: rate limited')
  const silent = { ...f.$, model: { complete: async () => ({ isAnswered: true, text: 'I am not sure.' }) } }
  expect((await verifyFacts(silent, reply('Clean (git status: "nothing to commit")'), CHECKS, '', 'sonnet')).cut).toBe(1)
  const off = await verifyFacts(f.$, reply('Clean (git status: "nothing to commit")'), CHECKS, '', '')
  expect(off.cut).toBe(0)
})

test('factBullets lists fact lines outside code, and the old cut still behaves', () => {
  expect(factBullets(reply('A (x: "yyyyyy")', 'B') + '\n\n```\nFacts found:\n- code\n```')).toEqual(['- A (x: "yyyyyy")', '- B'])
  expect(cutUnprovenFacts(reply('A (git status, now)', 'B')).cut).toBe(1)
})

const router = (answers: { claims?: string; first?: string; second?: string; opening?: string; fix?: string }) => {
  const prompts: string[] = []
  const complete = async (r: any) => {
    prompts.push(r.prompt)
    if (r.prompt.startsWith('Below are lines')) return { isAnswered: true, text: answers.claims ?? '' }
    if (r.prompt.startsWith('Below are the opening')) return { isAnswered: true, text: answers.opening ?? 'supported. KEEP' }
    if (r.prompt.startsWith('Reword this opening')) return { isAnswered: true, text: answers.fix ?? '' }
    const firstRound = r.prompt.includes('REWRITE:')
    return { isAnswered: true, text: (firstRound ? answers.first : answers.second) ?? '' }
  }
  return { prompts, complete }
}

test('parseVerdicts reads the verdict last, even on its own line, and never from a reason word', () => {
  const v = parseVerdicts('1: matches the status line. TRUE\n2: 94 belongs to BlackBerry, not Pan Am; contradicted.\nFALSE\n3: says true only for main. UNPROVEN REWRITE: Main is clean', 3)
  expect(v.map(x => x?.verdict)).toEqual(['TRUE', 'FALSE', 'UNPROVEN'])
  expect(v[0]!.why).toBe('matches the status line.')
  expect(v[2]!.rewrite).toBe('Main is clean')
  expect(judgePrompt([{ fact: 'x', evidence: 'y' }])).toContain('then the verdict (TRUE, FALSE or UNPROVEN) last')
})

test('parseVerdicts pulls out a narrowed rewrite and ignores NONE', () => {
  const v = parseVerdicts('1 UNPROVEN one gap only. REWRITE: The last two runs were 5 minutes apart.\n2 UNPROVEN no data REWRITE: NONE', 2)
  expect(v[0]).toEqual({ verdict: 'UNPROVEN', why: 'one gap only.', rewrite: 'The last two runs were 5 minutes apart' })
  expect(v[1]!.rewrite).toBe(undefined)
})

test('an overstated fact is narrowed when the judge proves the narrowed wording, and cut when it does not', async () => {
  const f = fake({})
  const m = router({ claims: '1 OTHER', first: '1 UNPROVEN overstated REWRITE: Nothing is left to commit', second: '1 TRUE ok' })
  const r = await verifyFacts({ ...f.$, model: m }, reply('Everything is pushed everywhere (git status: "nothing to commit")'), CHECKS, '', 'sonnet')
  expect(r.cut).toBe(0)
  expect(r.rewrites.length).toBe(1)
  expect(r.text).toContain('- Nothing is left to commit (git status: "nothing to commit")')
  expect(r.text).not.toContain('Everything is pushed')

  const dup = router({ claims: '1 OTHER', first: '1 overstated UNPROVEN REWRITE: Nothing is left to commit (git status: "nothing to commit")', second: '1 ok TRUE' })
  const rd = await verifyFacts({ ...f.$, model: dup }, reply('Everything is pushed everywhere (git status: "nothing to commit")'), CHECKS, '', 'sonnet')
  expect(rd.text).toContain('- Nothing is left to commit (git status: "nothing to commit")\n')
  expect(rd.text.match(/git status:/g)!.length).toBe(1)

  const no = router({ claims: '1 OTHER', first: '1 UNPROVEN overstated REWRITE: Nothing is left to commit', second: '1 UNPROVEN still too much' })
  const r2 = await verifyFacts({ ...f.$, model: no }, reply('Everything is pushed everywhere (git status: "nothing to commit")'), CHECKS, '', 'sonnet')
  expect(r2.cut).toBe(1)
  expect(r2.cuts[0]!.reason).toContain('narrowed version not proven either')
  const f3 = router({ claims: '1 OTHER', first: '1 FALSE wrong', second: '1 TRUE' })
  expect((await verifyFacts({ ...f.$, model: f3 }, reply('Clean (git status: "nothing to commit")'), CHECKS, '', 'sonnet')).cut).toBe(1)
})

test('with a judge, a mislabelled proof still finds its output, but an echo never counts', async () => {
  const f = fake({})
  const ok = router({ claims: '1 OTHER', first: '1 TRUE fine' })
  const r = await verifyFacts({ ...f.$, model: ok }, reply('Nothing left (repo check: "nothing to commit")'), CHECKS, '', 'sonnet')
  expect(r.cut).toBe(0)
  expect((await verifyFacts({ ...f.$, model: ok }, reply('Pushed (push check: "pushed to origin ok")'), CHECKS, '', 'sonnet')).cut).toBe(1)
  expect((await verifyFacts(f.$, reply('Nothing left (repo check: "nothing to commit")'), CHECKS, '')).cut).toBe(1)
})

test('empty-output proofs and short quotes need the judge and the named command', async () => {
  const f = fake({})
  const ok = router({ claims: '1 OTHER', first: '1 TRUE fine' })
  expect(proofOf('- No unpushed commits (git log @{u}..HEAD: empty output)')).toEqual({ kind: 'empty', source: 'git log @{u}..HEAD' })
  expect((await verifyFacts({ ...f.$, model: ok }, reply('Nothing new (git status: empty output)'), CHECKS, '', 'sonnet')).cut).toBe(0)
  expect((await verifyFacts(f.$, reply('Nothing new (git status: empty output)'), CHECKS, '')).cut).toBe(1)
  expect((await verifyFacts({ ...f.$, model: ok }, reply('Clean (git status: "clean")'), CHECKS, '', 'sonnet')).cut).toBe(0)
  expect((await verifyFacts({ ...f.$, model: ok }, reply('Clean (git log: "clean")'), CHECKS, '', 'sonnet')).cut).toBe(1)
})

test('a claim outside Facts found is cut when unproven; plans and picks stay', async () => {
  const text = 'Answer.\n\nDone:\n- The screen test showed nothing in the chat.\n- Nothing left (git status: "nothing to commit")\n\nOutstanding issues:\n1. Build it?\n   - My pick: yes. Go?'
  expect(otherBullets(text)).toEqual(['- The screen test showed nothing in the chat.', '- Nothing left (git status: "nothing to commit")', '- My pick: yes. Go?'])
  expect(parseClaims('1 CLAIM\n2: claim\n3 OTHER', 3)).toEqual([true, true, false])
  const f = fake({})
  const m = router({ claims: '1 CLAIM\n2 CLAIM\n3 OTHER' })
  expect((await verifyFacts({ ...f.$, model: m }, text, CHECKS, '', 'sonnet')).cut).toBe(0)
  const r = await verifyFacts({ ...f.$, model: m }, text, CHECKS, '', 'sonnet', true)
  expect(r.cut).toBe(1)
  expect(r.cuts[0]!.reason).toBe('claim outside Facts found: no proof in a checkable form')
  expect(r.text).not.toContain('screen test')
  expect(r.text).toContain('- Nothing left (git status: "nothing to commit")')
  expect(r.text).toContain('- My pick: yes. Go?')
  const down = { ...f.$, model: { complete: async () => { throw new Error('rate limited') } } }
  expect((await verifyFacts(down, text, CHECKS, '', 'sonnet', true)).cut).toBe(0)
})

test('openingOf takes the first paragraph only when the reply opens with prose', () => {
  expect(openingOf('Yes, it is clean.\n\nFacts found:\n- x')).toBe('Yes, it is clean.')
  expect(openingOf('Facts found:\n- x')).toBe('')
  expect(openingOf('```\ncode\n```\n\nText')).toBe('')
  expect(parseOpening('fine.\nKEEP')).toEqual({ keep: true })
  expect(parseOpening('goes beyond.\nREWRITE: 70 containers are running.')).toEqual({ rewrite: '70 containers are running.' })
  expect(parseOpening('no idea')).toBe(null)
  expect(parseOpening('- 70 running: SUPPORTED\n- none restarting: UNSUPPORTED\nKEEP')).toEqual({ unsupported: ['none restarting'] })
  expect(parseOpening('- 70 running: SUPPORTED\nKEEP')).toEqual({ keep: true })
  expect(openingPrompt('o', ['f'], [], ['git log\nabc1234'])).toContain('COMMAND OUTPUT:\ngit log\nabc1234')
})

test('an opening that repeats a cut fact is narrowed; a supported one is kept', async () => {
  const f = fake({})
  const text = 'Nothing is left to commit, and none are unhealthy.\n\nFacts found:\n- Nothing left (git status: "nothing to commit")\n- None unhealthy (docker ps: "unhealthy: none")'
  const m = router({ first: '1 ok TRUE', second: '1 matches git status. TRUE', opening: 'repeats a cut fact.\nREWRITE: Nothing is left to commit.' })
  const r = await verifyFacts({ ...f.$, model: m }, text, CHECKS, '', 'sonnet')
  expect(r.text.startsWith('Nothing is left to commit.\n\nFacts found:')).toBe(true)
  expect(r.rewrites.map(w => w.to)).toContain('Nothing is left to commit.')
  expect(m.prompts.find(p => p.startsWith('Below are the opening'))).toContain('CUT FACTS:\n- None unhealthy')
  const k = router({ first: '1 ok TRUE', opening: 'supported.\nKEEP' })
  expect((await verifyFacts({ ...f.$, model: k }, text, CHECKS, '', 'sonnet')).text.startsWith('Nothing is left to commit, and none are unhealthy.')).toBe(true)
})

test('a failed opening rewrite gets one retry, then falls back to a proven fact', async () => {
  const f = fake({})
  const text = 'Nothing is left to commit, and none are unhealthy.\n\nFacts found:\n- Nothing left (git status: "nothing to commit")'
  const bad = router({ first: '1 ok TRUE', second: '1 adds a pushed claim. UNPROVEN', opening: 'goes beyond.\nREWRITE: Nothing is left to commit, and it is pushed.', fix: 'REWRITE: Nothing is left, and it is pushed.' })
  const r = await verifyFacts({ ...f.$, model: bad }, text, CHECKS, '', 'sonnet')
  expect(r.text.startsWith('Nothing left.\n\nFacts found:')).toBe(true)
  expect(r.cuts.some(c => c.line.startsWith('Nothing is left to commit, and none') && c.reason.includes('opened with the fact'))).toBe(true)
  expect(bad.prompts.find(p => p.startsWith('Reword this opening of a reply so a fact checker'))).toContain('adds a pushed claim')
  const kept = router({ first: '1 ok TRUE', second: '1 matches. TRUE', opening: '- nothing to commit: SUPPORTED\n- none unhealthy: UNSUPPORTED\nKEEP', fix: 'REWRITE: Nothing is left to commit.' })
  const k = await verifyFacts({ ...f.$, model: kept }, text, CHECKS, '', 'sonnet')
  expect(k.text.startsWith('Nothing is left to commit.\n\nFacts found:')).toBe(true)
  expect(kept.prompts.find(p => p.startsWith('Reword this opening'))).toContain('none unhealthy')
  let judged = 0
  const retried = { prompts: [] as string[], complete: async (q: any) => {
    if (q.prompt.startsWith('Below are the opening')) return { isAnswered: true, text: 'goes beyond.\nREWRITE: Nothing is left to commit, and it is pushed.' }
    if (q.prompt.startsWith('Reword this opening')) return { isAnswered: true, text: 'REWRITE: Nothing is left to commit.' }
    if (q.prompt.includes('REWRITE:')) return { isAnswered: true, text: '1 ok TRUE' }
    return { isAnswered: true, text: judged++ ? '1 matches. TRUE' : '1 adds a pushed claim. UNPROVEN' }
  } }
  expect((await verifyFacts({ ...f.$, model: retried }, text, CHECKS, '', 'sonnet')).text.startsWith('Nothing is left to commit.\n\nFacts found:')).toBe(true)
})

test('the reply says how many lines were removed, just above the questions', () => {
  expect(removedNote('Answer.\n\nOutstanding issues:\n1. Go?', 2)).toBe('Answer.\n\n2 lines removed: not proven.\n\nOutstanding issues:\n1. Go?')
  expect(removedNote('Answer.', 1)).toBe('Answer.\n\n1 line removed: not proven.')
  expect(removedNote('Answer.', 0)).toBe('Answer.')
})

test('a rewrite that talks about checking instead of answering is refused', () => {
  expect(talksAboutChecking("I haven't confirmed which fact checks are live or where fake facts appear.")).toBe(true)
  expect(talksAboutChecking("Understood, but I haven't confirmed yet what has changed, so I'll check before saying anything about public videos.")).toBe(true)
  expect(talksAboutChecking('Yes, the dotfiles repo is clean and in sync with its remote, but it holds one old stash.')).toBe(false)
  expect(talksAboutChecking('The gateway is running and listening on port 18794. The task itself shows Ready.')).toBe(false)
  expect(talksAboutChecking('Noted: you said Toys R Us is public.')).toBe(false)
  expect(talksAboutChecking("No command output or view data is available yet, so I can't say how first-day views from YouTube compare for new videos.")).toBe(true)
  expect(talksAboutChecking("I can't say what that note covers, since no evidence was provided.")).toBe(true)
  expect(talksAboutChecking('New videos since Oct 23 got at most 24 first-day views, and the newest data is from Oct 26.')).toBe(false)
  expect(talksAboutChecking('Yes, the Watchdog is set to start every 5 minutes, and it also runs once at boot.')).toBe(false)
})

test('the judge sees a quote found past the cut-off, with the start of the output kept', () => {
  const text = 'a'.repeat(5000) + ' the Quote   here ' + 'b'.repeat(2000)
  const v = evidenceView(text, 'the quote here')
  expect(v).toContain('the Quote   here')
  expect(v.startsWith('a'.repeat(1000))).toBe(true)
  expect(v.length).toBeLessThan(3100)
  expect(evidenceView('short', 'x')).toBe('short')
  expect(evidenceView(text, 'missing words')).toBe(text.slice(0, 3000))
  expect(evidenceView(text, '')).toBe(text.slice(0, 3000))
})
