import { test, expect, mock } from 'claude-code/testing'

const REPLY = 'Yes, the repo is clean.\n\nFacts found:\n' +
  '- The repo is clean (git status: "nothing to commit")\n' +
  '- It holds two stashes (git stash list: "stash@{1}: WIP")\n\n' +
  'Outstanding issues:\n1. Push it?\n   - My pick: yes, 90% sure. Push?'

test('a whole reply goes through the checker and tells the reader what was removed',
  { options: { replyPolicy: true, proofCheck: true, proofHold: false, replyPolicyLogDir: '' } }, async ($, on) => {
    mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'cli' })
    mock.clock(on, { now: Date.UTC(2026, 9, 27, 12) })
    const status: string[] = []
    on('ui.status', (_$: any, e: any) => { status.push(e.text); return { value: undefined } as any })
    on('session.messages', () => ({ value: [{ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'git status' }, text: 'On branch main\nnothing to commit, working tree clean' }] }] }) as any)
    on('model.complete', (_$: any, e: any) => ({ value: {
      isAnswered: true,
      text: e.prompt.startsWith('Below are the opening') ? '- the repo is clean: SUPPORTED\nKEEP' : '1 git status says nothing to commit. TRUE',
      usage: { input_tokens: 1, output_tokens: 1 },
    } }) as any)
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: REPLY }
      return { turnId: 't1', index: 0, answer: REPLY, toolUses: [], stopReason: 'end_turn' } as any
    })
    const s = $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 })
    let shown = ''
    for await (const c of s) if (c.kind === 'text') shown += c.text
    await s.result
    expect(status.join(' | ')).toContain('proof-check: cut 1 line(s)')
    expect(shown).toContain('- The repo is clean (git status: "nothing to commit")')
    expect(shown).not.toContain('two stashes')
    expect(shown).toContain('1 line removed: not proven.\n\nOutstanding issues:')
    expect(shown.trimEnd().endsWith('Push?')).toBe(true)
  })

test('a proof deep in a long output reaches the judge, and each checked reply logs its judge time',
  { options: { replyPolicy: true, proofCheck: true, replyPolicyLogDir: '/logs' } }, async ($, on) => {
    mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'cli' })
    mock.clock(on, { now: Date.UTC(2026, 9, 28, 12) })
    on('ui.status', () => ({ value: undefined }) as any)
    const long = 'line of filler output\n'.repeat(1200) + 'Ready to push: 3 commits ahead of origin\n' + 'tail\n'.repeat(50)
    on('session.messages', () => ({ value: [{ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'git status' }, text: long }] }] }) as any)
    const asked: string[] = []
    on('model.complete', (_$: any, e: any) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: e.prompt.startsWith('Below are the opening') ? '- three commits: SUPPORTED\nKEEP' : '1 the output says 3 commits ahead. TRUE', usage: { input_tokens: 1, output_tokens: 1 } } } as any
    })
    const files = new Map<string, string>()
    on('fs.read', (_$: any, e: any) => ({ value: files.get(e.path) ?? '' }) as any)
    on('fs.write', (_$: any, e: any) => { files.set(e.path, e.content ?? e.text ?? e.data); return { value: undefined } as any })
    const reply = 'It is three commits ahead.\n\nFacts found:\n- It is three commits ahead (git status: "3 commits ahead of origin")'
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: reply }
      return { turnId: 't1', index: 0, answer: reply, toolUses: [], stopReason: 'end_turn' } as any
    })
    const s = $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 })
    let shown = ''
    for await (const c of s) if (c.kind === 'text') shown += c.text
    await s.result
    expect(long.indexOf('3 commits ahead')).toBeGreaterThan(20000)
    expect(asked[0]).toContain('Ready to push: 3 commits')
    expect(shown).toContain('three commits ahead (git status')
    const times = [...files.entries()].find(([p]) => p.endsWith('proof-times.jsonl'))
    expect(times).toBeTruthy()
    expect(JSON.parse(times![1].trim()).facts).toBe(1)
  })
