# Changelog

## Unreleased (since v0.1.0)

### reply-policy
- Before each answer, the length rule from the policy file (line and word cap, and the reply shape quoted from its `Shape:` sentence) is added to the prompt; a rule stated beside the question is followed more closely than one in the system prompt alone.
- Rewrites by a second model are now opt-in (`replyPolicyRewrite`, default off). In testing they cut about 7 words a reply and lost 2 of 146 points, so by default the reply is never rewritten.
- Single filler words are deleted in place instead of rewriting the reply.
- When rewrites are on, a rewrite that drops a list item, table row or number is discarded, and warning lines are kept word for word.
- Confusion keeps the normal word cap and the same shape, with simpler words. When the user is confused, the `Recommend:` group is moved up under the opening answer; only lines move, none are dropped. Halving the cap doubled missed points in a 5-vs-5 test.
- Lift and confusion words count only in the user's own words, not in pasted text; agent reports are not treated as the user's question.
- Bullets sit tight under their heading, with one blank line between groups; `*`, `+` and `•` markers print as `-`.
- Interactive CLI sessions count as human; a daily tally records replies checked and drafts over the cap.

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
