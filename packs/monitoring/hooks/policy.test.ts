import { test, expect } from 'claude-code/testing'
import { parseRules, violations, countLines, countWords, hasList, listItems, protectedUnits, keepProtected, stripFiller, userText, droppedFacts, isNotice, lengthReminder, ownWords, spaceBullets } from './policy'
import { replyPolicyOptions } from './reply-policy'
import { HTTPS_BEFORE, HTTPS_AFTER } from './fixture-https'

const MD = `Answer in the first sentence. Hard cap 6 lines and 120 words — a table of up to 4
rows counts as 1 line, a bigger table counts every row; code is excluded. Only "report",
"compare", "deep", "full", or "walk me through" lifts the cap.
- Delete on sight: just, really, basically, actually, simply, essentially, quite,
  very, note that, it's worth noting, in order to, at this point.
- No lead-ins: "Sure", "Certainly", "Great question", "I'd be happy to", "Let me".
When the user signals confusion ("don't understand", "confused", "confusing",
"what do you mean", "makes no sense", "I'm lost", "explain again"), drop every table,
use simpler words, the same word cap, the recommendation first.`

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

test('confusion mode keeps bullets and the normal word cap', () => {
  const bullets = 'A mod is code.\n\n- one\n- two'
  expect(violations(bullets, r, true)).toEqual([])
  const long = Array(70).fill('word').join(' ')
  expect(violations(long, r, false).some(x => /confused/.test(x))).toBe(false)
  expect(violations(long, r, true)).toEqual(violations(long, r, false))
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

test('listItems counts bullets, numbered items and table rows, not code or separators', () => {
  expect(listItems('Intro.\n\n- a\n- b\n* c\n1. d\n2) e')).toBe(5)
  expect(listItems('| # | Mod |\n|---|---|\n| 1 | x |\n| 2 | y |')).toBe(3)
  expect(listItems('```\n- not a list\n```\nplain')).toBe(0)
  const seven = Array.from({ length: 7 }, (_, i) => `- item ${i + 1}`).join('\n')
  const five = Array.from({ length: 5 }, (_, i) => `- item ${i + 1}`).join('\n')
  expect(listItems(five)).toBeLessThan(listItems(seven))
})

test('droppedFacts catches lost confidence figures, numbers, code and the closing question', () => {
  const before = 'Move the job to 8 AM (85% confident). It runs `brain_review.py` 3 times. Should I move it?'
  expect(droppedFacts(before, before)).toEqual([])
  expect(droppedFacts(before, 'Move the job to 8 AM. It runs the script.')).toEqual(['brain_review.py', '85%', '3', 'the closing question'])
})

test('droppedFacts ignores numbered-list markers and keeps whole figures', () => {
  expect(droppedFacts('1. Pays up to $240,000.\n2. Applied 2026-08-11.', '- Pays up to $240,000, applied 2026-08-11.')).toEqual([])
})

test('isNotice skips agent reports and harness notices but not pasted text', () => {
  expect(isNotice('<task-notification> <task-id>x</task-id>')).toBe(true)
  expect(isNotice('Mod hot-reloading is off in this session')).toBe(true)
  expect(isNotice('<pasted_content id="1">hello</pasted_content> fix this')).toBe(false)
  expect(isNotice('why is the reply short?')).toBe(false)
})

test('lift and confusion words inside pasted text do not count as the ask', () => {
  const r = parseRules(MD)
  const p = '<pasted_content id="b105">On-site Full-time. I\'m lost on this one.</pasted_content id="b105">'
  expect(ownWords(p)).toBe('')
  expect(r.lift.test(ownWords(p))).toBe(false)
  expect(r.confused.test(ownWords(p))).toBe(false)
  expect(r.lift.test(ownWords(`${p} give me the full picture`))).toBe(true)
})

test('spaceBullets puts a visible gap between bullets and leaves code and tables alone', () => {
  const G = '\n\n'
  const old = ['', '', String.fromCharCode(0x200b), '', ''].join('\n')
  expect(spaceBullets('Answer.\n- one\n- two\n1. three')).toBe(`Answer.\n\n• one${G}• two${G}1\\. three`)
  expect(spaceBullets('Answer.\n\n- one\n\n* two\n+ three')).toBe(`Answer.\n\n• one${G}• two${G}• three`)
  expect(spaceBullets(`Answer.\n\n- one${old}- two`)).toBe(`Answer.\n\n• one${G}• two`)
  expect(spaceBullets(`Answer.\n\n• one${G}• two`)).toBe(`Answer.\n\n• one${G}• two`)
  expect(spaceBullets('- one\n  more of one\n- two\n\nAfter.\n2) three\n  - nested')).toBe(`• one\n  more of one${G}• two\n\nAfter.\n\n2\\) three${G}  - nested`)
  expect(spaceBullets('```\n- a\n- b\n```')).toBe('```\n- a\n- b\n```')
  expect(spaceBullets('Answer.\n\nDone:\n- one\n- two\n\nTo do:\n- three')).toBe(`Answer.\n\nDone:\n• one${G}• two\n\nTo do:\n• three`)
  expect(spaceBullets('| a |\n|---|\n| - b |')).toBe('| a |\n|---|\n| - b |')
})

test('a warning kept in other words is not appended again', () => {
  const before = 'Nightly check runs at 4:30. A mod with failing tests turns the pill red, and you get a warning in your next chat.'
  const after = 'Nightly check runs at 4:30. Failing tests turn the pill red and warn you in your next chat.'
  expect(keepProtected(before, after)).toEqual({ text: after, kept: 0 })
  expect(keepProtected(before, 'Nightly check runs at 4:30.').kept).toBe(1)
})

test('filler inside quotes or code is left alone', () => {
  const banned = /\b(just)\b/i
  expect(stripFiller('It removed only the word "just" from it.', banned)).toBe('It removed only the word "just" from it.')
  expect(stripFiller('It is just fine.', banned)).toBe('It is fine.')
})

test('lost warnings return as plain bullets with no extra heading', () => {
  const out = keepProtected('Done.\n\nThe upload failed on the last file.', 'Done.')
  expect(out.kept).toBe(1)
  expect(out.text).not.toContain('Kept word for word')
  expect(out.text).toContain('- The upload failed on the last file.')
})

test('the length reminder states the caps from the policy file', () => {
  const r = { ...parseRules(MD), lineCap: 5, wordCap: 100, tableRows: 4 }
  const t = lengthReminder(r)
  expect(t).toContain('at most 5 lines and 100 words')
  expect(t).toContain('up to 4 rows')
  expect(t).toContain('grouped under plain headings')
  expect(t).toContain('12 words or fewer')
  expect(lengthReminder(r, true)).toContain('at most 5 lines and 100 words')
  expect(lengthReminder(r, true)).toContain('Recommend: first')
})

test('reply rewrites stay off unless the option is set to true', () => {
  expect(replyPolicyOptions({}).rewrite).toBe(false)
  expect(replyPolicyOptions({ replyPolicy: true }).rewrite).toBe(false)
  expect(replyPolicyOptions({ replyPolicyRewrite: 'true' }).rewrite).toBe(false)
  expect(replyPolicyOptions({ replyPolicyRewrite: true }).rewrite).toBe(true)
})
