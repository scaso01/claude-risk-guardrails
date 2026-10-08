import json, glob, os, re, sys
# 18: a leftover copy is decided by the file NAME's suffix, never by "backup" appearing inside a word.
BACKUP = re.compile(r'''(?ix)(
    \.(bak|orig|old|backup|sav|prev)(\.\d+)?$          # x.py.bak, x.orig, x.bak.2
  | \.(bak|orig|backup)[-_.]?\d{6,}.*$                 # x.bak-20260801, x.bak.20260801-1200
  | ~$                                                 # editor backup x.py~
  | \.task-backup[^\/]*$                              # exported scheduled-task backups, x.task-backup-1.xml
  | (^|[\/])copy\ of\ [^\/]+$ | \ -\ copy(\ \(\d+\))?\.[^.\/]+$   # Windows "Copy of x" / "x - Copy.txt"
)''')
# 17: known credential FORMATS, anchored so they can't start mid-word ("risk-", "task-", "desk-").
SECRET = re.compile(r'''(?x)
   (?<![A-Za-z0-9])sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_\-]{20,}
 | (?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}
 | (?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}
 | (?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Z0-9])
 | (?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9\-]{10,}
 | -----BEGIN\ [A-Z ]*PRIVATE\ KEY-----
 | (?i:bearer)\s+[A-Za-z0-9_\-\.=]{24,}
 | (?i:(?:password|passwd|pwd|secret|api[_-]?key|token))\s*[=:]\s*["']?[^\s"'<>{}$]{8,}
''')
PLACEHOLDER = re.compile(r'(?i)(x{4,}|\*{3,}|<[^>]+>|\$\{?\w+|your[_-]|example|changeme|placeholder|redacted|dummy|test123|\.\.\.)')
def has_mixed(s): return bool(re.search(r'\d', s)) and bool(re.search(r'[A-Za-z]', s))
def secret_hits(text):
    out=[]
    for m in SECRET.finditer(text):
        v=m.group(0)
        body=re.split(r'[=:\s]+', v, maxsplit=1)[-1]
        if PLACEHOLDER.search(v): continue
        if not has_mixed(body) and 'PRIVATE KEY' not in v: continue
        out.append(v)
    return out

if sys.argv[1:] == ['selftest']:
    real = ['sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'AKIA' + 'ABCD1234EFGH5678',
            'Bearer ' + 'eyJhbGciOiJIUzI1NiJ9.abc123DEF456ghi', 'password=' + 'Tr0ub4dor&3x', '-----BEGIN RSA PRIVATE KEY-----']
    fake = ['https://x.com/model-risk-management-sr-26-2', 'task-backup', 'desk-reference-2026', 'password=<your-password>',
            'api_key=${API_KEY}', 'token: xxxxxxxxxxxx', 'Bearer token goes here', 'sk-learn is a library', 'risk-adjusted-return-1234567890abcdefghij']
    bk_real = [r'C:\a\b\config.py.bak', r'C:\a\x.orig', r'C:\a\heal.ps1.bak-20260801', r'C:\a\notes.md~', r'C:\a\Task.task-backup-1.xml', r'C:\a\b - Copy.txt']
    bk_fake = [r'C:\a\memory_backup.py', r'C:\a\nightly-backup.ps1', r'C:\a\test_memory_backup.py', r'C:\a\profile-old-BACKUP-2026-07.md', r'C:\a\backups\db.sqlite']
    ok=True
    for s in real:
        r=bool(secret_hits(s)); ok&=r; print('SECRET real ', 'CAUGHT' if r else 'MISSED', s[:14]+'…')
    for s in fake:
        r=bool(secret_hits(s)); ok&=not r; print('SECRET fake ', 'FALSE ALARM' if r else 'quiet', s[:40])
    for p in bk_real:
        r=bool(BACKUP.search(p)); ok&=r; print('BACKUP real ', 'CAUGHT' if r else 'MISSED', os.path.basename(p))
    for p in bk_fake:
        r=bool(BACKUP.search(p)); ok&=not r; print('BACKUP fake ', 'FALSE ALARM' if r else 'quiet', os.path.basename(p))
    print('ALL PASS' if ok else 'FAILURES'); sys.exit(0 if ok else 1)

root=os.path.expanduser('~/.claude/projects')
files=glob.glob(root+'/**/*.jsonl', recursive=True)
msg_n=edit_n=0; s_hits=[]; b_hits=[]
for f in files:
    for line in open(f, encoding='utf-8', errors='ignore'):
        if '"tool_use"' not in line: continue
        try: e=json.loads(line)
        except Exception: continue
        for b in (e.get('message') or {}).get('content') or []:
            if not isinstance(b, dict) or b.get('type')!='tool_use': continue
            n=b.get('name',''); inp=b.get('input') or {}
            if 'SendMessage' in n or 'send_message' in n:
                msg_n+=1
                for v in secret_hits(json.dumps(inp)): s_hits.append((os.path.basename(f)[:8], v[:6]+'***', len(v)))
            if n in ('Edit','Write','MultiEdit','NotebookEdit'):
                edit_n+=1
                p=inp.get('file_path') or inp.get('notebook_path') or ''
                if BACKUP.search(p): b_hits.append((os.path.basename(f)[:8], p))
print(f'files={len(files)} messages={msg_n} edits={edit_n}')
print(f'message-redact hits: {len(s_hits)}'); [print('  ',h) for h in s_hits[:20]]
print(f'backup-file-guard hits: {len(b_hits)}'); [print('  ',h) for h in b_hits[:20]]
