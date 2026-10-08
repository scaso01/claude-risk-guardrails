import { test, expect, mock } from 'claude-code/testing'
import { SignOff } from './signoff'
import { publishActions, githubRepo } from './publish-gate'
import { parseRules, stops } from './protected-process'
import { sensitiveReason, shellTarget } from './sensitive-file-guard'
import { isBackupCopy, liveFile } from './backup-file-guard'
import { gb, isHeavy } from './headroom-check'
import { redact, secretHits } from './message-redact'
import { parseMarker } from './stale-copy-band'

type Proc = (argv: string[]) => { exitCode: number; stdout: string }

function world(on: any, proc: Proc = () => ({ exitCode: 1, stdout: '' }), http: (url: string) => number = () => 500, withFs = true) {
  mock.env(on, { USERPROFILE: 'C:\\Users\\t', OS: 'Windows_NT' })
  mock.clock(on, { now: Date.UTC(2026, 9, 8, 12) })
  const reached: any[] = []
  const runs: string[][] = []
  on('process.run', (_$: any, e: any) => { runs.push(e.argv); return { value: { ...proc(e.argv), stderr: '' } } })
  on('http.fetch', (_$: any, e: any) => ({ value: { status: http(e.url), ok: http(e.url) === 200, headers: {}, text: '' } }))
  on('tool.call', (_$: any, e: any) => { reached.push(e); return { result: { ok: true } as any } })
  if (withFs) on('fs.exists', () => ({ value: false }))
  return { reached, runs }
}

const denyText = (r: any) => String(r?.deny ?? (r?.isError ? r.text : '') ?? '')

// ---- sensitive-file-guard ----

test('sensitive-file-guard refuses secrets and passes lookalikes', async ($, on) => {
  const { reached } = world(on)
  const bad: any = await $.tool.call({ tool: 'Write', file_path: 'C:/p/.env', content: 'x' } as any)
  expect(denyText(bad)).toContain('[sensitive-file-guard] Refused')
  const settings: any = await $.tool.call({ tool: 'Edit', file_path: 'C:\\Users\\t\\.claude\\settings.json', old_string: 'a', new_string: 'b' } as any)
  expect(denyText(settings)).toContain("Claude Code's own settings")
  const ok: any = await $.tool.call({ tool: 'Write', file_path: 'C:/p/.env.example', content: 'x' } as any)
  expect(denyText(ok)).toBe('')
  expect(reached.length).toBe(1)
})

test('sensitive-file-guard patterns', () => {
  const h = 'C:\\Users\\t'
  expect(sensitiveReason('~/.ssh/id_ed25519', h)).toBe('SSH private key')
  expect(sensitiveReason('/srv/app/server.key', h)).toBe('key or certificate file')
  expect(sensitiveReason('repo/.git/config', h)).toBe('Git internals')
  expect(sensitiveReason('repo/credentials.json', h)).toBe('possible credentials file')
  expect(sensitiveReason('repo/.github/workflows/ci.yml', h)).toBeUndefined()
  expect(sensitiveReason('repo/keyboard.ts', h)).toBeUndefined()
  expect(sensitiveReason('C:/other/.claude/settings.json', h)).toBeUndefined()
})

// ---- sign-off ----

test('only the person can approve, once, before it expires', () => {
  const s = new SignOff(() => 0.5)
  const code = s.codeFor('k')
  expect(s.codeFor('k')).toBe(code)
  expect(s.approveFrom(`approve ${code}`, 'peer', 0, 15)).toEqual([])
  expect(s.approveFrom(`approve ${code}`, 'auto-continuation', 0, 15)).toEqual([])
  expect(s.consume('k', 0)).toBe(false)
  expect(s.approveFrom(`ok, approve ${code.toLowerCase()}`, 'composer', 0, 15)).toEqual([code])
  expect(s.consume('other', 1)).toBe(false)
  expect(s.consume('k', 1)).toBe(true)
  expect(s.consume('k', 2)).toBe(false)
  const late = s.codeFor('k')
  s.approveFrom(`approve ${late}`, 'bridge', 0, 15)
  expect(s.consume('k', 16 * 60_000)).toBe(false)
})

// ---- publish-gate ----

test('publish-gate finds publishing commands and ignores lookalikes', () => {
  expect(publishActions('gh repo create me/x --public --source .').map(a => a.kind)).toEqual(['visibility'])
  expect(publishActions('gh repo edit me/x --visibility public --accept-visibility-change-consequences').map(a => a.kind)).toEqual(['visibility'])
  expect(publishActions('gh repo edit me/x --visibility=public').map(a => a.kind)).toEqual(['visibility'])
  expect(publishActions('rtk gh repo edit me/x --visibility public').map(a => a.kind)).toEqual(['visibility'])
  expect(publishActions('sudo env GH_HOST=github.com gh repo edit me/x --visibility public').map(a => a.kind)).toEqual(['visibility'])
  expect(publishActions('gh api -X PATCH repos/me/x -F private=false').map(a => a.kind)).toEqual(['visibility'])
  expect(publishActions('gh repo edit me/x --visibility private')).toEqual([])
  expect(publishActions('gh repo view me/x --json visibility')).toEqual([])
  expect(publishActions('gh repo create me/x --private')).toEqual([])
  expect(publishActions('echo "gh repo create x --public"')).toEqual([])
  expect(publishActions('git log --grep push')).toEqual([])
  expect(publishActions('git push --dry-run origin main')).toEqual([])
  expect(publishActions('cd /r/x && git push -u upstream main')).toEqual([{ kind: 'push', text: 'git push -u upstream main', remote: 'upstream', cwd: '/r/x' }])
  expect(publishActions('git -C /r/y push')).toEqual([{ kind: 'push', text: 'git -C /r/y push', remote: undefined, cwd: '/r/y' }])
  expect(githubRepo('git@github.com:me/x.git')).toBe('me/x')
  expect(githubRepo('https://github.com/me/x')).toBe('me/x')
  expect(githubRepo('https://gitlab.com/me/x.git')).toBeUndefined()
})

test('publish-gate holds a visibility flip and a plugin prompt cannot approve it', async ($, on) => {
  const { reached } = world(on)
  const call = { tool: 'Bash', command: 'gh repo edit me/x --visibility public' } as any
  const first: any = await $.tool.call(call)
  expect(denyText(first)).toContain('[publish-gate] Refused')
  const code = /approve (G-\d{4})/.exec(denyText(first))![1]
  await $.prompt.submit({ text: `approve ${code}` } as any).catch(() => undefined)
  const second: any = await $.tool.call(call)
  expect(denyText(second)).toContain(code!)
  expect(reached.length).toBe(0)
})

test('publish-gate holds pushes to public repos only', async ($, on) => {
  const { reached } = world(on, argv => {
    if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: 'origin/main\n' }
    if (argv[1] === 'remote') return { exitCode: 0, stdout: argv[4] === 'origin' ? 'git@github.com:me/open.git\n' : 'https://github.com/me/closed.git\n' }
    if (argv[0] === 'gh') return { exitCode: 0, stdout: argv[3] === 'me/open' ? 'PUBLIC\n' : 'PRIVATE\n' }
    return { exitCode: 1, stdout: '' }
  })
  const pub: any = await $.tool.call({ tool: 'Bash', command: 'git push' } as any)
  expect(denyText(pub)).toContain('pushes to me/open, a public repository')
  const priv: any = await $.tool.call({ tool: 'Bash', command: 'git push backup main' } as any)
  expect(denyText(priv)).toBe('')
  expect(reached.length).toBe(1)
})

test('publish-gate falls back to the GitHub API when gh is missing', async ($, on) => {
  const { reached } = world(on, argv => argv[1] === 'remote' ? { exitCode: 0, stdout: 'https://github.com/me/x\n' } : { exitCode: 1, stdout: '' },
    url => url.endsWith('/me/x') ? 404 : 500)
  const r: any = await $.tool.call({ tool: 'PowerShell', command: 'git push origin main' } as any)
  expect(denyText(r)).toBe('')
  expect(reached.length).toBe(1)
})

test('publish-gate can leave pushes alone', { options: { publishGatePushes: false } }, async ($, on) => {
  const { reached, runs } = world(on)
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as any)
  expect(reached.length).toBe(1)
  expect(runs.length).toBe(0)
})

// ---- protected-process ----

const RULES = 'llama-server => schtasks /Run /TN "Llama Switch"; postgres'

test('protected-process finds stop commands', () => {
  const rules = parseRules(RULES)
  expect(rules).toEqual([{ name: 'llama-server', route: 'schtasks /Run /TN "Llama Switch"' }, { name: 'postgres' }])
  expect(stops('taskkill /F /IM llama-server.exe', rules)[0]!.names.map(r => r.name)).toEqual(['llama-server'])
  expect(stops('Get-Process llama-server | Stop-Process -Force', rules)[0]!.names.map(r => r.name)).toEqual(['llama-server'])
  expect(stops('systemctl restart postgresql', rules)[0]!.names).toEqual([])
  expect(stops('docker restart postgres', rules)[0]!.names.map(r => r.name)).toEqual(['postgres'])
  expect(stops('Get-Process llama-server', rules)).toEqual([])
  expect(stops('kill 4242', rules)[0]!.pids).toEqual(['4242'])
})

test('protected-process refuses by name and by PID, passes others', { options: { protectedProcesses: RULES } }, async ($, on) => {
  const { reached } = world(on, argv => argv[0] === 'tasklist' && argv[2] === 'PID eq 4242'
    ? { exitCode: 0, stdout: '"llama-server.exe","4242","Console","1","900,000 K"\n' }
    : { exitCode: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\n' })
  const byName: any = await $.tool.call({ tool: 'PowerShell', command: 'Stop-Process -Name llama-server -Force' } as any)
  expect(denyText(byName)).toContain('approved route: schtasks /Run /TN "Llama Switch"')
  const byPid: any = await $.tool.call({ tool: 'Bash', command: 'taskkill /PID 4242 /F' } as any)
  expect(denyText(byPid)).toContain('[protected-process] Refused')
  await $.tool.call({ tool: 'Bash', command: 'taskkill /PID 1111 /F' } as any)
  await $.tool.call({ tool: 'Bash', command: 'taskkill /IM notepad.exe' } as any)
  await $.tool.call({ tool: 'Bash', command: 'schtasks /Run /TN "Llama Switch"' } as any)
  expect(reached.length).toBe(3)
})

test('protected-process does nothing with an empty list', async ($, on) => {
  const { reached } = world(on)
  await $.tool.call({ tool: 'Bash', command: 'taskkill /IM llama-server.exe' } as any)
  expect(reached.length).toBe(1)
})

// ---- message-redact ----

const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2'

test('message-redact catches credential formats and leaves lookalikes', () => {
  const real = [KEY, 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'AKIA' + 'ABCD1234EFGH5678', 'Bearer ' + 'eyJhbGciOiJIUzI1NiJ9.abc123DEF456ghi',
    'password=' + 'Tr0ub4dor&3x', '-----BEGIN RSA PRIVATE KEY-----']
  const fake = ['https://x.com/model-risk-management-sr-26-2', 'task-backup', 'desk-reference-2026', 'password=<your-password>',
    'api_key=${API_KEY}', 'token: xxxxxxxxxxxx', 'Bearer token goes here', 'sk-learn is a library', 'risk-adjusted-return-1234567890abcdefghij']
  for (const s of real) expect(secretHits(s).length).toBe(1)
  for (const s of fake) expect(secretHits(s)).toEqual([])
  const r = redact({ to: 'peer', message: `use ${KEY} for the call`, nested: [{ note: 'token=' + 'abc123def456' }] })
  expect(r.count).toBe(2)
  expect(JSON.stringify(r.input)).not.toContain(KEY)
  expect((r.input as any).message).toBe('use [REDACTED] for the call')
})

test('message-redact rewrites the message before it is sent', async ($, on) => {
  const { reached } = world(on)
  const r: any = await $.tool.call({ tool: 'SendMessage', to: 'peer', message: `key is ${KEY}` } as any)
  expect(reached[0].message).toBe('key is [REDACTED]')
  expect(String(r.context)).toContain('[message-redact] 1 secret(s)')
  await $.tool.call({ tool: 'SendMessage', to: 'peer', message: 'all clear' } as any)
  expect(reached[1].message).toBe('all clear')
})

// ---- backup-file-guard ----

test('backup-file-guard decides by suffix, not by the word backup', () => {
  for (const p of ['C:/a/b/config.py.bak', 'C:/a/x.orig', 'C:/a/heal.ps1.bak-20260801', 'C:/a/notes.md~', 'C:/a/b - Copy.txt', 'C:/a/Copy of plan.md'])
    expect(isBackupCopy(p)).toBe(true)
  for (const p of ['C:/a/memory_backup.py', 'C:/a/nightly-backup.ps1', 'C:/a/test_memory_backup.py', 'C:/a/profile-old-BACKUP-2026-07.md', 'C:/a/backups/db.sqlite'])
    expect(isBackupCopy(p)).toBe(false)
  expect(liveFile('C:/a/config.py.bak')).toBe('C:/a/config.py')
  expect(liveFile('C:/a/heal.ps1.bak-20260801')).toBe('C:/a/heal.ps1')
  expect(liveFile('C:/a/b - Copy.txt')).toBe('C:/a/b.txt')
})

test('backup-file-guard refuses an edit to a .bak and names the live file', async ($, on) => {
  const { reached } = world(on)
  const r: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/p/app.py.bak', old_string: 'a', new_string: 'b' } as any)
  expect(denyText(r)).toContain('Edit the live file (C:/p/app.py) instead')
  await $.tool.call({ tool: 'Edit', file_path: 'C:/p/app.py', old_string: 'a', new_string: 'b' } as any)
  expect(reached.length).toBe(1)
  const sh: any = await $.tool.call({ tool: 'Bash', command: "sed -i 's/^T = 5$/T = 30/' app.py.bak && head -3 app.py.bak" } as any)
  expect(denyText(sh)).toContain('[backup-file-guard] Refused: app.py.bak is a backup copy')
  await $.tool.call({ tool: 'Bash', command: 'grep -n T app.py.bak' } as any)
  expect(reached.length).toBe(2)
})

// ---- headroom-check ----

test('headroom-check knows a build or install when it sees one', () => {
  for (const c of ['docker compose up -d --build', 'pip install -r req.txt', 'npm ci', 'cargo build --release', 'cd x && bun install', 'winget install Git.Git'])
    expect(isHeavy(c)).toBe(true)
  for (const c of ['git status', 'echo pip', 'npm test', 'docker ps', 'cargo test']) expect(isHeavy(c)).toBe(false)
  expect(gb(4_321_000_000)).toBe(4.3)
})

test('headroom-check holds an install on a nearly full drive only', { options: { minFreeGB: 10 } }, async ($, on) => {
  let free = '4000000000'
  const { reached } = world(on, argv => argv[0] === 'powershell' ? { exitCode: 0, stdout: `${free}\n` } : { exitCode: 1, stdout: '' })
  on('session.cwd', () => ({ value: 'D:/build' }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'pip install torch' } as any)
  expect(denyText(r)).toContain('only 4 GB free on the drive holding D:/build')
  free = '50000000000'
  await $.tool.call({ tool: 'Bash', command: 'pip install torch' } as any)
  await $.tool.call({ tool: 'Bash', command: 'git status' } as any)
  expect(reached.length).toBe(2)
})

// ---- stale-copy-band ----

test('stale-copy-band reads the marker', () => {
  expect(parseMarker('C:/live/app\r\nThis clone stopped tracking main in July.\n')).toEqual({ live: 'C:/live/app', why: 'This clone stopped tracking main in July.' })
})

test('stale-copy-band refuses edits under a marked copy and passes others', async ($, on) => {
  const { reached } = world(on, undefined, undefined, false)
  on('fs.exists', (_$: any, e: any) => ({ value: e.path.replace(/\\/g, '/').endsWith('C:/old/app/.claude/stale-copy.txt') }))
  on('fs.read', () => ({ value: 'C:/live/app\nkept for reference only' }))
  const r: any = await $.tool.call({ tool: 'Write', file_path: 'C:\\old\\app\\src\\main.py', content: 'x' } as any)
  expect(denyText(r)).toContain('C:/old/app is marked as an old copy. Why: kept for reference only. The live copy is C:/live/app')
  const again: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/old/app/README.md', old_string: 'a', new_string: 'b' } as any)
  expect(denyText(again)).toContain('[stale-copy-band] Refused')
  await $.tool.call({ tool: 'Write', file_path: 'C:/live/app/src/main.py', content: 'x' } as any)
  expect(reached.length).toBe(1)
})

test('stale-copy-band also catches a shell edit under a marked copy', async ($, on) => {
  const { reached } = world(on, undefined, undefined, false)
  on('session.cwd', () => ({ value: 'C:\\old' }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path.replace(/\\/g, '/').endsWith('C:/old/app/.claude/stale-copy.txt') }))
  on('fs.read', () => ({ value: 'C:/live/app' }))
  const r: any = await $.tool.call({ tool: 'Bash', command: "sed -i 's/^MAX = 3$/MAX = 5/' app/src/retry.py" } as any)
  expect(denyText(r)).toContain('[stale-copy-band] Refused: C:/old/app is marked as an old copy')
  await $.tool.call({ tool: 'Bash', command: 'grep -n MAX app/src/retry.py' } as any)
  await $.tool.call({ tool: 'Bash', command: "sed -i 's/a/b/' C:/live/app/src/retry.py" } as any)
  expect(reached.length).toBe(2)
})

test('sensitive-file-guard also catches shell commands that write a protected file', () => {
  const H = 'C:\\Users\\t'
  const writes = [
    '$c = [IO.File]::ReadAllText("$PWD\\.env"); [IO.File]::AppendAllText("$PWD\\.env", "DEBUG=true`n")',
    'echo DEBUG=true >> .env',
    "sed -i 's/a/b/' config/.env.production",
    'Set-Content -Path ~/.ssh/id_ed25519 -Value x',
    'cp new.json ~/.claude/settings.json',
  ]
  for (const c of writes) expect(shellTarget(c, H)).toBeDefined()
  const fine = ['cat .env.example > .env.sample', 'git commit -m "update .env docs" 2>&1', 'ls -la .env', 'echo hi > notes.txt', 'grep KEY .env 2>/dev/null']
  for (const c of fine) expect(shellTarget(c, H)).toBeUndefined()
})

test('sensitive-file-guard refuses a PowerShell write to .env', async ($, on) => {
  const { reached } = world(on)
  const r: any = await $.tool.call({ tool: 'PowerShell', command: '[IO.File]::AppendAllText("$PWD\\.env", "DEBUG=true")' } as any)
  expect(denyText(r)).toContain('[sensitive-file-guard] Refused: this command writes to')
  await $.tool.call({ tool: 'PowerShell', command: 'Get-Content .env.example' } as any)
  expect(reached.length).toBe(1)
})
