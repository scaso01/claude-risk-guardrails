import { test, expect, mock } from 'claude-code/testing'
import { claimedShas, evidence } from './commit-claim-audit'
import { isChallenge } from './pushback-check'

function world(on: any, report: string, git: (argv: string[]) => { exitCode: number; stdout: string }) {
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  mock.clock(on, { now: Date.UTC(2026, 9, 8, 12) })
  const runs: string[][] = []
  const prompts: any[] = []
  on('fs.write', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('process.run', (_$: any, e: any) => { runs.push(e.argv); return { value: { stderr: '', ...git(e.argv) } } })
  on('prompt.submit', (_$: any, e: any) => { prompts.push(e); return { text: e.text } })
  on('tool.call', () => ({ result: { ok: true } as any, text: report }))
  return { runs, prompts }
}

// ---- pushback-check ----

test('pushback-check knows a challenge from an ordinary prompt', () => {
  for (const p of ['are you sure?', 'No, that is the old path', "that's wrong, it moved", 'Is that really right?', 'really?'])
    expect(isChallenge(p)).toBe(true)
  for (const p of ['now run the tests', 'no rush, do it tomorrow', 'make sure the build is green', 'I know that is right'])
    expect(isChallenge(p)).toBe(false)
})

test('pushback-check adds the re-check instruction to a challenge only', async ($, on) => {
  const { prompts } = world(on, '', () => ({ exitCode: 1, stdout: '' }))
  await $.prompt.submit({ text: 'Are you sure? I thought it was 3.', origin: { kind: 'composer' } } as any)
  expect(String(prompts[0].context)).toContain('[pushback-check]')
  await $.prompt.submit({ text: 'great, ship it', origin: { kind: 'composer' } } as any)
  expect(prompts[1].context).toBeUndefined()
})

// ---- commit-claim-audit ----

test('commit-claim-audit finds the commits a report claims', () => {
  expect(claimedShas('Committed the fix as 3f2a91c and pushed.')).toEqual(['3f2a91c'])
  expect(claimedShas('See a1b2c3d4 (commit) and commit 3f2a91c; also commit 3F2A91C.')).toEqual(['a1b2c3d4', '3f2a91c'])
  expect(claimedShas('The file hash deadbeef1cafe is listed')).toEqual(['deadbeef1cafe'])
  expect(claimedShas('Commit 2fa3ecdbd11854efb00b8a4a25ab00aec9e16589 (commit 2fa3ecd) is in.')).toEqual(['2fa3ecdbd11854efb00b8a4a25ab00aec9e16589'])
  expect(claimedShas('Ran 1234567 tests, no commits made.')).toEqual([])
  expect(claimedShas('Updated the colour to abcdefa.')).toEqual([])
  expect(evidence('3f2a91c', false, '', 'C:/repo')).toContain('no such commit in C:/repo')
})

test('commit-claim-audit puts git show next to the claim', async ($, on) => {
  const { runs } = world(on, 'Done: committed the fix as 3f2a91c. Also see commit 9e9e9e1.', argv =>
    argv.at(-1) === '3f2a91c' ? { exitCode: 0, stdout: '3f2a91c Fix parser (bot, 1 minute ago)\n src/b.ts | 2 +-\n' } : { exitCode: 128, stdout: '' })
  const r: any = await $.tool.call({ tool: 'Agent', description: 'fix', prompt: 'fix the parser', subagent_type: 'debugger' } as any)
  const note = String(r.context)
  expect(note).toContain('[commit-claim-audit]')
  expect(note).toContain('src/b.ts | 2 +-')
  expect(note).toContain('9e9e9e1: no such commit in C:/repo')
  expect(runs[0]).toEqual(['git', '-C', 'C:/repo', 'show', '--stat', '--format=%h %s (%an, %ar)', '3f2a91c'])
})

test('commit-claim-audit leaves reports without commit claims alone', async ($, on) => {
  const { runs } = world(on, 'Found three call sites; nothing changed.', () => ({ exitCode: 0, stdout: '' }))
  const r: any = await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'find call sites', subagent_type: 'Explore' } as any)
  expect(r.context).toBeUndefined()
  expect(runs.length).toBe(0)
})
