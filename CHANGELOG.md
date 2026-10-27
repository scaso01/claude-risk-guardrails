# Changelog

## Unreleased (since v0.1.0)

### verify-before-answer (new, outcomes pack, on by default)
- A second model reads each final reply against the turn's tool results before it is shown. Claims nothing backed are sent back as read-only checks; you see one checked answer, never the draft. Switch: `verifyBeforeAnswer`.
- Paired runs against earlier versions of this checker: second stops fell from 31 to 18 of 60 (p = 0.025); unbacked claims per answer fell from 1.05 to 0.72 (P fewer = 0.90), and on a code question from 2.7 to 1.3 (P > 0.99). On a live download-status question the new version gave no gain (3.0 vs 3.3, P fewer = 0.27).
- Coding check: 5 tasks with and 5 without, all 10 passed their tests and no edit was blocked. Median added time was about 28 seconds on coding tasks and 8.5 seconds on everyday questions.
- After two holds the reply is shown as the model wrote it, with no "(not checked)" labels; only side statements the question did not need are trimmed. Cutting the sentences a final check called unchecked was tried and turned off: on 19 saved replies it cut 38% of true lines and 43% of unshown ones (p = 0.58), and caught 14% of 30 planted false lines (Opus: 13% of true lines cut, 57% of planted lines caught).
- A flagged risk is held until the reply names a fix and a % confidence with its reason, or the test that would give one. Replaying 37 saved replies with bare risks twice each, 68 of 74 runs were held; 16 of 16 runs with covered risks and 24 of 24 with no risks were left alone. Live, 10 of 10 risk reviews ended with a fix and a %; the median reply took 95 seconds against 64.5 before.
- A reply that declines something false the user asked for is no longer sent back as an unanswered part: 0 of 40 replay runs against 13 of 40 before, while 30 of 30 real gaps were still caught.

### reply-policy
- Before each answer, the length rule from the policy file (line and word cap, and the reply shape quoted from its `Shape:` sentence) is added to the prompt; a rule stated beside the question is followed more closely than one in the system prompt alone.
- Rewrites by a second model are now opt-in (`replyPolicyRewrite`, default off). In testing they cut about 7 words a reply and lost 2 of 146 points, so by default the reply is never rewritten.
- Single filler words are deleted in place instead of rewriting the reply.
- When rewrites are on, a rewrite that drops a list item, table row or number is discarded, and warning lines are kept word for word.
- Confusion keeps the normal word cap and the same shape, with simpler words. When the user is confused, the `Recommend:` group is moved up under the opening answer; only lines move, none are dropped. Halving the cap doubled missed points in a 5-vs-5 test.
- Lift and confusion words count only in the user's own words, not in pasted text; agent reports are not treated as the user's question.
- Bullets sit tight under their heading, with one blank line between groups; `*`, `+` and `•` markers print as `-`.
- Interactive CLI sessions count as human; a daily tally records replies checked and drafts over the cap.

### End-of-reply checks
- source-fidelity, inventory-gate and clean-tree-on-done no longer send a finished reply back, which made the model write a second, unrequested message. You see a one-line notice instead, and the model gets the finding with your next message.
- clean-tree-on-done ignores "done" inside quotes, code and hyphenated names such as `clean-tree-on-done`, and flags the same uncommitted files only once.

### inventory-gate
- Flags only the writer's own coverage claims ("I reviewed everything"), not descriptions of what code does ("each reply is checked").
- A send-back asks for one added line with the count, never a reply that replaces the answer.

### source-fidelity
- Accepts confidence estimates in common wordings ("80% confidence", "70% sure", "(85%)" after a recommendation).
- Reads the session transcript at check time and remembers figures the user gave or tools returned in earlier turns, so a plugin reload no longer forgets them.

### Other controls
- backup-file-guard: copying a live file to a backup name is allowed; editing the backup stays blocked without a sign-off.
- publish-gate: an approval covers the held push and its repository, not the whole command line.
- clean-tree-on-done: a file written through a symlink is checked in the repository it lands in, so a linked folder no longer hides it; "haven't committed", "hasn't committed" and "didn't committed" count as telling the user.
- turn-ledger: one file per process per day, so concurrent sessions never lose a row.

### Project
- CI scans the full history for secrets, not only the pushed range.
- The demo runner keeps the debug log of any call slower than 120 seconds.
