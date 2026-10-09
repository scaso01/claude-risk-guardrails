# Controls reference

One entry per guardrail: what it stops, how it responds, where it maps, how to configure it,
and a screenshot from a live run. The SR 26-2 sections are applied **by analogy** (its
footnote 3 puts generative and agentic AI out of scope). Every mapping is the author's
judgment, not an official crosswalk.

**How a guardrail responds.** There are three kinds of response:

- **Refuses**: the action does not run. The model sees why, and for irreversible actions
  it gets a one-time code that only you can approve (see [sign-off](#sign-off)).
- **Sends back**: a finished reply goes back to the model with what's wrong, before you see it.
  This happens once per reply, so it can't loop.
- **Notes**: the action runs, and the model gets a note next to the result.

Every option below goes in `settings.json` under `pluginConfigs.<pack>`, or in the `/config`
menu. Each guardrail also has an on/off switch named after it (`publishGate`,
`neverRevert` and so on), on by default unless marked otherwise.

**Contents**

- [Effective challenge](#effective-challenge-guardrails-challenge): pushback-check, commit-claim-audit
- [Outcomes analysis](#outcomes-analysis-guardrails-outcomes): source-fidelity, inventory-gate
- [Ongoing monitoring](#ongoing-monitoring-guardrails-monitoring): agent-hold, reply-policy, controls-watchdog, stale-number-flag
- [Development and use](#development-and-use-guardrails-development): search-before-build, test-reminder, precommit-check, rules-persist, memory-provenance
- [Governance and controls](#governance-and-controls-guardrails-approval): publish-gate, protected-process, sensitive-file-guard, message-redact, backup-file-guard, headroom-check, stale-copy-band
- [Documentation](#documentation-guardrails-records): clean-tree-on-done, doc-age-stamp, never-revert, db-snapshot, turn-ledger
- [Sign-off](#sign-off) and [shared options](#shared-options)

---

## Effective challenge (`guardrails-challenge`)

### pushback-check

**Stops:** the agent dropping a correct answer just because you pushed back.
**Responds:** notes. When your prompt challenges the last answer ("are you sure?", "that's
wrong"), the model is told to re-check the source and then either hold its answer or name the
new fact that changed it.
**Maps to:** SR 26-2 III Effective Challenge · NIST AI RMF Measure.

![pushback-check](images/pushback-check.png)

### commit-claim-audit

**Stops:** a subagent saying "committed the fix to X" when the commit touched Y, or doesn't exist.
**Responds:** notes. When a subagent's report names commit IDs, the real `git show --stat`
for up to three of them is placed next to the report, and a missing commit is called out.
**Maps to:** SR 26-2 III Effective Challenge, V Outcomes Analysis · NIST AI RMF Measure.

![commit-claim-audit](images/commit-claim-audit.png)

---

## Outcomes analysis (`guardrails-outcomes`)

### source-fidelity

**Stops:** figures in a reply that the document you pasted never stated, such as a salary,
date or percentage.
**Responds:** sends back. Figures are compared by value, so `$150k` and `150,000` match.
Only the figures missing from the source are listed.
**Maps to:** SR 26-2 V Outcomes Analysis · NIST AI RMF Measure.

| Option | Default | What it does |
|---|---|---|
| `pasteMinChars` | `1500` | A prompt this long counts as a pasted document even without paste markers. |

![source-fidelity](images/source-fidelity.png)

### inventory-gate

**Stops:** "I reviewed everything" with no count.
**Responds:** sends back. A reply that claims full coverage must say how many items it
covered out of how many, such as "3 of 3 files".
**Maps to:** SR 26-2 VI Model Inventory · NIST AI RMF Map.

![inventory-gate](images/inventory-gate.png)

---

## Ongoing monitoring (`guardrails-monitoring`)

### agent-hold

**Stops:** acting on one background agent's report while the others are still running.
**Responds:** holds each report while agents run, and the model answers with one status
line. When the last agent finishes, all reports arrive together in one message. It also
drops the name from agent launches that don't need one, because a named agent's report
bypasses the hold.
**Maps to:** SR 26-2 VI Governance & Controls · NIST AI RMF Manage.

| Option | Default | What it does |
|---|---|---|
| `agentNameStrip` | on | Drop an agent's name unless it must message other agents. |
| `agentHoldDir` | `~/.claude/guardrails/agent-hold` | Hold state per session and a monthly event log. |
| `agentHoldTtlMinutes` | `120` | An agent with no report after this long leaves the hold. |
| `agentHoldGraceSeconds` | `60` | How long to wait for a finished agent's report before your next prompt releases the hold with a warning. |
| `agentHoldBlock` | off | Block held reports outright instead of answering each with one line. |

![agent-hold](images/agent-hold.png)

### reply-policy

**Stops:** replies that break your written response policy.
**Responds:** checks each final reply against the policy file. A reply that breaks it is
rewritten by a second model. Warnings and error text are never cut, the original is one
`/full-reply` away, and each violation is logged so rates can be measured. **Off by default.**
It runs only in sessions a person is typing into, never in scripted runs.
**Maps to:** SR 26-2 V Ongoing Monitoring · NIST AI RMF Measure, Manage.

| Option | Default | What it does |
|---|---|---|
| `replyPolicyFile` | bundled `policies/terse.md` | Your policy. It must state a line and word cap ("Hard cap N lines and M words"), a table rule, the words that lift the cap, a filler list and a lead-in list, in the bundled file's wording. The check refuses to run, and says so, if any of these is missing. |
| `replyPolicyModel` | `sonnet` | The model that rewrites a reply. |
| `replyPolicyLogDir` | `~/.claude/guardrails/reply-policy` | One JSON file per reply that broke the policy. Empty turns logging off. |

![reply-policy](images/reply-policy.png)

### controls-watchdog

**Stops:** a guardrail pack that silently stops loading.
**Responds:** every pack records when it loaded. `/guardrails-status` lists each pack's last
load. For a check that can't fail with the packs, add
[`watchdog/controls-watchdog.mjs`](../watchdog/controls-watchdog.mjs) as a plain `SessionStart`
command hook. It runs outside the mod engine and names any pack that missed the last two
session starts. It never blocks a session from starting.
**Maps to:** SR 26-2 VI Roles & Responsibilities (the internal-audit role) · NIST AI RMF Govern.

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node /path/to/claude-risk-guardrails/watchdog/controls-watchdog.mjs" } ] } ] } }
```

![controls-watchdog](images/controls-watchdog.png)

### stale-number-flag

**Stops:** counts and figures saved to notes with no date, which go stale unnoticed.
**Responds:** notes. Lines with a figure and no date are listed, and the model is asked to
add when each was checked.
**Maps to:** SR 26-2 V Ongoing Monitoring (data relevance) · NIST AI RMF Measure.

| Option | Default | What it does |
|---|---|---|
| `notesPaths` | `/memory/, /notes/` | Path fragments that mark a notes file (Markdown or text). |

![stale-number-flag](images/stale-number-flag.png)

---

## Development and use (`guardrails-development`)

### search-before-build

**Stops:** large new code written before any search for an existing solution.
**Responds:** refuses a new code file of 10+ lines, or an edit adding 60+, until the session
shows research: a web search, a docs lookup or a research agent. You can always say "no
search needed". It refuses at most three times per session.
**Maps to:** SR 26-2 IV Model Development · NIST AI RMF Map.

| Option | Default | What it does |
|---|---|---|
| `researchTools` | web search and fetch tools | Tool names that count as research. `Agent:Explore` names an agent type, `Skill:*search*` a skill, `*` is a wildcard. |
| `searchSkipPaths` | `/tmp/, /temp/, /scratchpad/` | Path fragments where throwaway code is fine. |
| `searchWarnOnly` | off | Let the write through with a warning instead. |

![search-before-build](images/search-before-build.png)

### test-reminder

**Stops:** code edited and never tested.
**Responds:** notes, once per file per session. After a source file is edited, it names the
test that covers it (`test_x`, `x_test`, `x.test`, `x.spec`, or `XTest`), or says none exists.
It watches the Edit and Write tools, not shell edits.
**Maps to:** SR 26-2 IV Development (testing) · NIST AI RMF Measure.

![test-reminder](images/test-reminder.png)

### precommit-check

**Stops:** commits that fail the repo's own checks, and commits that skip its hooks.
**Responds:** refuses. Before `git commit`, it runs each command listed in the repo's
`.claude/precommit`. A failing check refuses the commit and shows the output. A commit with
`--no-verify` needs your sign-off. Repos without the file are not checked.
**Maps to:** SR 26-2 IV Development (testing) · NIST AI RMF Measure.

| Option | Default | What it does |
|---|---|---|
| `precommitFile` | `.claude/precommit` | Relative to the repo root. One command per line; `#` starts a comment. |
| `precommitTimeoutSeconds` | `120` | A check still running after this counts as failed. At most 600. |
| `blockNoVerify` | on | Skipping the repo's hooks needs your sign-off. |

![precommit-check](images/precommit-check.png)

### rules-persist

**Stops:** operating rules lost when the context compacts, the session resumes or clears,
the model switches, or a subagent starts with none of them.
**Responds:** adds your rules file back at each of those moments, and adds a subagent rules
file to every subagent's start.
**Maps to:** SR 26-2 IV Model Use · NIST AI RMF Govern.

| Option | Default | What it does |
|---|---|---|
| `rulesFile` | empty (off) | Markdown file of the rules that must survive. |
| `subagentRulesFile` | empty (off) | Markdown file added to every subagent's start. |

![rules-persist](images/rules-persist.png)

### memory-provenance

**Stops:** facts saved to long-term memory with no source or date.
**Responds:** notes. When a new memory file is written without both, the model is asked to add them.
**Maps to:** SR 26-2 IV Development (data quality) · NIST AI RMF Map.

| Option | Default | What it does |
|---|---|---|
| `memoryPaths` | `/memory/` | Path fragments that mark a memory file. |

![memory-provenance](images/memory-provenance.png)

---

## Governance and controls (`guardrails-approval`)

### publish-gate

**Stops:** a repo made public, or a push to a public repo, without your sign-off.
**Responds:** refuses with a one-time code. It sees through wrapper commands such as `sudo`,
`env` and `rtk`. Private repos are not affected.
**Maps to:** SR 26-2 VI Roles & Responsibilities · NIST AI RMF Govern.

| Option | Default | What it does |
|---|---|---|
| `publishGatePushes` | on | Also hold `git push` to a public GitHub repo. |

![publish-gate](images/publish-gate.png)

### protected-process

**Stops:** killing or restarting named critical processes outside their approved route.
**Responds:** refuses with a one-time code and names the approved route, if one is listed.
**Maps to:** SR 26-2 VI Roles & Responsibilities · NIST AI RMF Govern.

| Option | Default | What it does |
|---|---|---|
| `protectedProcesses` | empty | Entries separated by `;`, each `name` or `name => approved route`, such as `postgres => systemctl restart postgresql`. |

![protected-process](images/protected-process.png)

### sensitive-file-guard

**Stops:** edits to credentials, keys, `.env` files, `.git/` internals and Claude Code's own
settings file.
**Responds:** refuses and asks you to make the change by hand. It covers edit tools and shell
writes: redirects, `tee`, `sed -i`, `cp`/`mv`/`rm`, PowerShell `Set-Content` and .NET file calls.
**Maps to:** SR 26-2 VI Governance & Controls · NIST AI RMF Manage.

![sensitive-file-guard](images/sensitive-file-guard.png)

### message-redact

**Stops:** secrets leaving the session in messages to other agents or sessions.
**Responds:** replaces each credential in the outgoing message with `[REDACTED]`, then
sends it and tells the model. Only known key formats are matched, so ordinary words are left alone.
**Maps to:** SR 26-2 VI Governance & Controls · NIST AI RMF Manage.

| Option | Default | What it does |
|---|---|---|
| `messageTools` | `SendMessage` and any MCP `send_message` | Tool names that send messages; `*` is a wildcard. |

![message-redact](images/message-redact.png)

### backup-file-guard

**Stops:** edits landing in a backup copy (`.bak`, `.orig`, `x~`, "Copy of x") instead of the live file.
**Responds:** refuses, names the live file, and offers a one-time code if the copy really is the target.
It covers edit tools and shell writes such as `sed -i` and redirects.
**Maps to:** SR 26-2 VI Governance & Controls · NIST AI RMF Manage.

![backup-file-guard](images/backup-file-guard.png)

### headroom-check

**Stops:** builds and installs started on a nearly full drive.
**Responds:** refuses with a one-time code when the drive holding the working folder is below the floor.
**Maps to:** SR 26-2 VI Governance & Controls · NIST AI RMF Manage.

| Option | Default | What it does |
|---|---|---|
| `minFreeGB` | `10` | The free-space floor in GB. |

![headroom-check](images/headroom-check.png)

### stale-copy-band

**Stops:** work done in an old copy of a project instead of the live one.
**Responds:** refuses edits inside any folder whose root holds the marker file, and points to
the live copy. A one-time code allows the edit if the old copy really is the target. It covers
edit tools and shell writes such as `sed -i` and redirects.
**Maps to:** SR 26-2 VI Model Inventory · NIST AI RMF Map.

| Option | Default | What it does |
|---|---|---|
| `staleCopyMarker` | `.claude/stale-copy.txt` | Put it in the OLD copy. First line: the live copy's path. Following lines: why. |

![stale-copy-band](images/stale-copy-band.png)

---

## Documentation (`guardrails-records`)

### clean-tree-on-done

**Stops:** "done" said while files changed this session are still uncommitted.
**Responds:** sends back. It counts files changed by edit tools and, by comparing `git status`
with a snapshot taken before the session's first change, files changed by shell commands.
Files that were already dirty before the session are left out.
**Maps to:** SR 26-2 VI Documentation · NIST AI RMF Manage.

![clean-tree-on-done](images/clean-tree-on-done.png)

### doc-age-stamp

**Stops:** handoff and status docs read as current when the code has moved on.
**Responds:** notes. When such a doc is read, the model is told how many days ago it was last
committed and how many commits have landed since, and to treat it as a draft.
**Maps to:** SR 26-2 VI Documentation · NIST AI RMF Map.

| Option | Default | What it does |
|---|---|---|
| `docPatterns` | `HANDOFF*.md`, `STATUS*.md`, `TODO*.md` and similar | File-name patterns to stamp. |

![doc-age-stamp](images/doc-age-stamp.png)

### never-revert

**Stops:** an edit that undoes a design choice the project wrote down after a past incident.
**Responds:** refuses an edit that removes text listed in the repo's never-revert file, and
quotes the recorded reason. A one-time code allows it. Deleting a rule from the file is refused too.
**Maps to:** SR 26-2 V Conceptual Soundness · NIST AI RMF Govern.

| Option | Default | What it does |
|---|---|---|
| `neverRevertFile` | `.claude/never-revert.txt` | Relative to the repo root. One rule per line: `exact text => why it stays`. |

![never-revert](images/never-revert.png)

### db-snapshot

**Stops:** a write to a SQLite database with no backup taken first.
**Responds:** backs the database up before a shell command writes to it (through `sqlite3`
or Python), then lets the write run. If no backup can be made, the write waits for your sign-off.
**Maps to:** SR 26-2 VI Documentation (continuity) · NIST AI RMF Manage.

| Option | Default | What it does |
|---|---|---|
| `snapshotDir` | `~/.claude/guardrails/db-snapshots` | Where snapshots go. |
| `snapshotKeep` | `3` | Snapshots kept per database; the oldest is overwritten. |
| `snapshotEveryMinutes` | `30` | Skip a new snapshot if one of the same database is this recent. |

![db-snapshot](images/db-snapshot.png)

### turn-ledger

**Stops:** work with no record.
**Responds:** appends one JSON line per turn: what was asked, which tools ran, which files changed. Each Claude process writes its own file, `<ledgerDir>/<YYYY-MM-DD>/<session>.<tag>.jsonl`, so sessions finishing together never overwrite each other's rows; a file nearing the 4 MiB write limit continues in `<session>.<tag>.1.jsonl`. Read a day by reading every file in its folder.
**Maps to:** SR 26-2 VI Documentation · NIST AI RMF Govern.

| Option | Default | What it does |
|---|---|---|
| `ledgerDir` | `~/.claude/guardrails/ledger` | One folder per day, one JSONL file per Claude process inside it. |
| `ledgerPrompts` | on | Record the first 200 characters of each prompt. Off records only tools and files. |

![turn-ledger](images/turn-ledger.png)

---

## Sign-off

A guardrail that holds an irreversible action shows a code such as `G-4821`. Type
`approve G-4821` at the prompt and the exact same action may run once. Only a prompt Claude
Code marks as typed by a person (at the terminal or through Remote Control) counts, so the
model can't approve itself.

## Shared options

| Option | Packs | Default | What it does |
|---|---|---|---|
| `approvalMinutes` | approval, development, records | `15` | How long an approval stays valid after you type it. |
| `heartbeatDir` | all | `~/.claude/guardrails/heartbeats` | Where each pack records its last load, for `/guardrails-status` and the watchdog. |
