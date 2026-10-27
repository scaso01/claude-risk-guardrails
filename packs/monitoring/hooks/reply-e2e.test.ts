import { test, expect, mock } from 'claude-code/testing'

const REPLY = 'Yes, the repo is clean.\n\nFacts found:\n' +
  '- The repo is clean (git status: "nothing to commit")\n' +
  '- It holds two stashes (git stash list: "stash@{1}: WIP")\n\n' +
  'Outstanding issues:\n1. Push it?\n   - My pick: yes, 90% sure. Push?'

test('a whole reply goes through the checker and tells the reader what was removed',
  { options: { replyPolicy: true, proofCheck: true, replyPolicyLogDir: '' } }, async ($, on) => {
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
