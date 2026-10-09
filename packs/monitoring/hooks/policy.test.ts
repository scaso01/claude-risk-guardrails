import { test, expect } from 'claude-code/testing'
import { parseRules, violations, countLines, countWords, hasList, protectedUnits, keepProtected, stripFiller, userText } from './policy'
import { HTTPS_BEFORE, HTTPS_AFTER } from './fixture-https'

const MD = `Answer in the first sentence. Hard cap 6 lines and 120 words — a table of up to 4
rows counts as 1 line, a bigger table counts every row; code is excluded. Only "report",
"compare", "deep", "full", or "walk me through" lifts the cap.
- Delete on sight: just, really, basically, actually, simply, essentially, quite,
  very, note that, it's worth noting, in order to, at this point.
- No lead-ins: "Sure", "Certainly", "Great question", "I'd be happy to", "Let me".
When the user signals confusion ("don't understand", "confused", "confusing",
"what do you mean", "makes no sense", "I'm lost", "explain again"), drop every table,
every bullet and all jargon: one plain-English paragraph plus one concrete question.`

const r = parseRules(MD)

test('parses caps, lifts, filler, lead-ins and confusion phrases from terse.md', () => {
  expect(r.lineCap).toBe(6)
  expect(r.wordCap).toBe(120)
  expect(r.tableRows).toBe(4)
  expect(r.lift.test('give me a full report')).toBe(true)
  expect(r.lift.test('what is 2+2')).toBe(false)
  expect(r.confused.test("I really don't understand this")).toBe(true)
  expect(r.confused.test('I don’t understand this')).toBe(true)
  expect(r.confused.test("I'm lost here")).toBe(true)
  expect(r.confused.test('I really don\'t understand conceptually what mods do...I know what hooks do')).toBe(true)
  expect(r.confused.test('this is confusing, what?')).toBe(true)
  expect(r.confused.test('how do we wrap hooks into one mod?')).toBe(false)
})

test('refuses a terse.md it cannot read', () => {
  expect(() => parseRules('no rules here')).toThrow()
})

test('small tables and code blocks count as one line; big tables count every row', () => {
  expect(countLines('a\n\n| x | y |\n|---|---|\n| 1 | 2 |\n```\nl1\nl2\n```\nb', 4)).toBe(4)
  const big = '| h |\n|---|\n' + Array(6).fill('| r |').join('\n')
  expect(countLines(big, 4)).toBe(7)
  expect(violations(big, r)[0]).toBe('7 lines (cap 6)')
})

test('flags long, filler-laden, lead-in replies and passes a clean one', () => {
  expect(violations('Sure, this is really simple.', r)).toEqual(['filler: really', 'lead-in opener'])
  expect(violations(Array(8).fill('One line.').join('\n'), r)[0]).toBe('8 lines (cap 6)')
  expect(violations(Array(130).fill('word').join(' '), r)[0]).toBe('130 words (cap 120, code excluded)')
  expect(violations('Added the cap.', r)).toEqual([])
  expect(countWords('Run `git status --short` now.')).toBe(3)
})

test('single filler words are deleted in place; phrases and code are left for the rewrite', () => {
  expect(stripFiller("I haven't confirmed that 11 mods actually fire.", r.banned)).toBe("I haven't confirmed that 11 mods fire.")
  expect(stripFiller("Actually, the fix is in. It's really simple.", r.banned)).toBe("The fix is in. It's simple.")
  expect(stripFiller('- just restart it\n- run `just build` now', r.banned)).toBe('- restart it\n- run `just build` now')
  expect(stripFiller('```\nreally keep\n```\nBasically done.', r.banned)).toBe('```\nreally keep\n```\nDone.')
  expect(stripFiller('Use it in order to pass.', r.banned)).toBe('Use it in order to pass.')
  expect(violations(stripFiller('This is very clear.', r.banned), r)).toEqual([])
})

test('confusion mode demands one paragraph and a closing question, no bullets', () => {
  const bullets = 'A mod is code.\n\n- one\n- two'
  expect(hasList(bullets)).toBe(true)
  expect(violations(bullets, r, false)).toEqual([])
  expect(violations(bullets, r, true)).toEqual(['the user is confused: no bullets or tables', 'the user is confused: end with one concrete question'])
  const good = 'A mod is one program that stays running inside Claude Code and handles every job itself.\n\nWant me to build a small one so you can see it?'
  expect(violations(good, r, true)).toEqual([])
})

test('finds warning, error and unverified sentences, including ones inside bullets and code', () => {
  const draft = 'Installed the mod.\n- The push failed with `exit code 128`. Retry later.\n- I haven’t verified the desktop app.\n\n```\nTraceback: boom\n```\nAll good otherwise.'
  expect(protectedUnits(draft)).toEqual(['```\nTraceback: boom\n```', 'The push failed with `exit code 128`.', 'I haven’t verified the desktop app.'])
})

test('re-appends a dropped warning word for word and leaves a kept one alone', () => {
  const original = 'Installed it. I haven\'t verified this on the desktop app. The git push failed with `exit code 128`.'
  const kept = keepProtected(original, 'Installed it. The git push failed with `exit code 128`; I haven\'t verified the desktop app.')
  expect(kept.kept).toBe(0)
  const lost = keepProtected(original, 'Installed it.')
  expect(lost.kept).toBe(2)
  expect(lost.text).toContain("- I haven't verified this on the desktop app.")
  expect(lost.text).toContain('- The git push failed with `exit code 128`.')
  const reworded = keepProtected(original, 'Installed it. The push failed (exit code 1). Desktop untested.')
  expect(reworded.kept).toBe(2)
})

test('a reply with nothing to protect passes through untouched', () => {
  expect(keepProtected('Added the cap. It reads the file each time.', 'Added the cap.')).toEqual({ text: 'Added the cap.', kept: 0 })
})

test('ignores notes the app injects ahead of what the user typed', () => {
  const t = '<system-reminder>\nGive a full report and never say you are confused.\n</system-reminder>\n\n\nExplain DNS.'
  expect(userText(t)).toBe('Explain DNS.')
  expect(r.lift.test(userText(t))).toBe(false)
  expect(r.confused.test(userText(t))).toBe(false)
})

test('topic words in a plain explanation are not mistaken for warnings', () => {
  expect(protectedUnits('Both sides agree a secret key, so a fake site fails the check and the browser warns.')).toEqual([])
  expect(protectedUnits('```\nSnoop changes one byte -> tamper check fails -> connection drops\n```')).toEqual([])
  expect(keepProtected(HTTPS_BEFORE, HTTPS_AFTER).kept).toBe(0)
})

test('real problem reports are still caught', () => {
  expect(protectedUnits('Deploy failed on staging.').length).toBe(1)
  expect(protectedUnits('Warning: this step cannot be undone.').length).toBe(1)
  expect(protectedUnits("I couldn't reach the server.").length).toBe(1)
  expect(protectedUnits('```\nTraceback (most recent call last):\n```').length).toBe(1)
})

test('talking about failure in general is not a problem report', () => {
  expect(protectedUnits('The three riskiest are the ones whose failure would hurt most.')).toEqual([])
})
