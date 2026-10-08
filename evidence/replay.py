import json, os, re, glob, csv, subprocess, collections, random
OUT = os.path.dirname(os.path.abspath(__file__))
# Replays every Claude Code transcript under ROOT and counts how often each planned control
# would have fired. Paths and names specific to one machine come from the environment.
ROOT = os.path.expanduser(os.environ.get('REPLAY_ROOT', '~/.claude/projects'))
SELF = os.environ.get('REPLAY_SKIP_SESSION', '')  # the session running this replay, if any
PROTECTED = os.environ.get('REPLAY_PROTECTED', r'postgres|redis|nginx|\bnode(\.exe)?\b|\bpython\w*(\.exe)?\b')
PUBLIC_DIR = os.path.expanduser(os.environ.get('REPLAY_PUBLIC_DIR', ''))
POLICY_LOG = os.path.expanduser(os.environ.get('REPLAY_POLICY_LOG', '~/.claude/guardrails/reply-policy'))
REPO_DIRS = [os.path.expanduser(p) for p in os.environ.get('REPLAY_REPO_DIRS', '~/Projects').split(os.pathsep) if p]
random.seed(1)
NAMES = {1:'pushback-check',2:'commit-claim-audit',3:'source-fidelity',4:'inventory-gate',5:'agent-hold',6:'reply-policy',7:'controls-watchdog',8:'stale-number-flag',9:'search-before-build',10:'test-reminder',11:'precommit-check',12:'rules-persist',13:'memory-provenance',14:'publish-gate',15:'protected-process',16:'sensitive-file-guard',17:'message-redact',18:'backup-file-guard',19:'headroom-check',20:'stale-copy-band',21:'clean-tree-on-done',22:'doc-age-stamp',23:'never-revert',24:'db-snapshot',25:'turn-ledger'}
fires = collections.Counter(); sess = collections.defaultdict(set); samples = collections.defaultdict(list); seen_n = collections.Counter()
extra = collections.Counter()
SECRET = re.compile(r'(\bsk-[A-Za-z0-9_-]{8,}|ghp_\w+|gho_\w+|AKIA\w+|Bearer\s+\S+|(?i:password|passwd|token|secret|apikey)\s*[=:]\s*\S+)')


def hit(c, s, ex, n=1):
    fires[c] += n
    sess[c].add(s)
    seen_n[c] += 1
    ex = SECRET.sub('[REDACTED]', re.sub(r'\s+', ' ', ex))[:200]
    L = samples[c]
    if len(L) < 40:
        L.append((s[:8], ex))
    else:
        j = random.randrange(seen_n[c])
        if j < 40:
            L[j] = (s[:8], ex)


CODE = ('.py', '.ts', '.tsx', '.js', '.rs', '.ps1', '.kt')
RE = dict(
    chall=re.compile(r"(\b(are you (really )?(sure|certain)\b|you sure\b|is that (really )?(right|true|correct))|^\s*(really\s*\?|no[,.!]\s|no\s*$|wrong\b|nope\b)|that'?s (wrong|not (right|true|correct))|that is wrong|not true|that can'?t be right)", re.I),
    chall_old=re.compile(r"^\s*(are you (really )?(sure|certain)\b|really\s*\?|you sure\b|is that (really )?(right|true|correct)|that'?s (wrong|not (right|true|correct))|that is wrong|no[,.!]\s|no\s*$|wrong\b|nope\b|not true|that can'?t be right)", re.I),
    rev=re.compile(r"(^\s*(no\b|not certain|honest answer|fair (challenge|catch|point)|right\b|essentially yes|yes\b)|let me check harder|i asserted|i (didn'?t|haven'?t) (verif|check)|you'?re (absolutely )?right|you are (absolutely )?right|i was wrong|my mistake|correction\b|i (made|got) (a|that) (mistake|wrong)|good catch|i misread|that was (wrong|incorrect))", re.I),
    inv=re.compile(r"\b(everything|all|every|full(y)?)\b[^.\n]{0,50}\b(audit|review|check|list|inventory|enumerate)\w*|\b(audit|review|check|list|inventory|enumerate)\w*\b[^.\n]{0,30}\b(everything|all of|every|full)\b", re.I),
    mods=re.compile(r"stopped loading|mods down|mod[s]? (are )?down|Mods pill", re.I),
    num=re.compile(r"(?<![\w.])\d{2,}(?![\w-])"), date=re.compile(r"\d{4}-\d{2}-\d{2}"),
    test=re.compile(r"\b(pytest|cargo (test|nextest)|npm (run )?test|npx vitest|vitest|gradlew?(\.bat)?\s+\S*test|gradle\S*\s+\S*test|yarn test|pnpm test|unittest|go test)\b", re.I),
    pub=re.compile(r"gh repo edit[^\n]*public|gh repo create[^\n]*--public", re.I),
    pushpub=re.compile(r"git\b[^\n]*\bpush\b", re.I),
    killv=re.compile(r"\b(taskkill|Stop-Process|pkill|killall|kill)\b", re.I),
    killt=re.compile(PROTECTED, re.I),
    sens=re.compile(r"(\.env($|\.|[\\/])|\.ssh[\\/]id_|\.pem$|\.key$|credentials[^\\/]*$|[\\/]secret[^\\/]*$|[\\/]settings\.json$|[\\/]\.git[\\/])", re.I),
    bak=re.compile(r"(\.bak|\.orig|backup)", re.I),
    disk=re.compile(r"No space left on device|disk full", re.I),
    build=re.compile(r"docker (compose )?build|docker[- ]compose up[^\n]*--build|docker compose up[^\n]*--build|pip3? install|python -m pip install", re.I),
    stale=re.compile(r"-bf-A6|-v2[\\/]|-archive[\\/]", re.I),
    done=re.compile(r"\b(done|finished|complete[d]?|all set|shipped|implemented|fixed)\b", re.I),
    handoff=re.compile(r"^(HANDOFF|STATUS|TODO)[^\\/]*\.(md|txt)$|^[^\\/]*handoff[^\\/]*\.md$", re.I),
    revert=re.compile(r"put (it|that|them) back|bring (it|that) back|you (reverted|removed|deleted|undid)|\bundid\b|removed it again|\bregression\b|broke it again|revert (it|that)|undo (that|it)|restore (it|that)", re.I),
    dml=re.compile(r"DELETE\s+FROM|\bUPDATE\s+\w+\s+SET|DROP\s+TABLE", re.I),
    hexsha=re.compile(r"\b[0-9a-f]{7,40}\b"),
    csha=re.compile(r"(commit(ted)?|pushed|hash|sha)\W[^\n]{0,40}\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b\W[^\n]{0,20}commit", re.I),
    commitw=re.compile(r"commit", re.I),
    compact=re.compile(r"^This session is being continued from a previous conversation", re.I),
    model=re.compile(r"<command-name>/model|^/model\b", re.I),
    secretmsg=re.compile(r"sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,}|password\s*=\s*\S+", re.I),
)
# A repo kept twice (a public copy and a working copy) makes edits in the wrong one possible.
pubnames = set(os.listdir(PUBLIC_DIR)) if PUBLIC_DIR and os.path.isdir(PUBLIC_DIR) else set()
dup = re.compile(r"Projects[\\/]+(%s)(?=[\\/\s\"']|$)" % '|'.join(map(re.escape, pubnames))) if pubnames else re.compile(r'(?!)')
SYSTEMY = ('Stop hook feedback', 'Base directory for this skill', 'Another Claude session sent', 'Review this change for', '[harness', '<task-notification', '<system-reminder', '<command-', 'Caveat:', '[Request interrupted', '<local-command', '<user-prompt-submit-hook', '<bash-')
gitcache = {}


def in_git(p):
    d = os.path.dirname(p)
    for _ in range(12):
        if d in gitcache:
            return gitcache[d]
        if os.path.exists(os.path.join(d, '.git')):
            gitcache[d] = True
            return True
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    return False


def scratch(p):
    q = p.lower()
    return '\\scratchpad\\' in q or '\\temp\\' in q or '\\resumes\\' in q


def txt(c):
    if isinstance(c, str):
        return c
    out = []
    for b in c or []:
        if isinstance(b, dict):
            if b.get('type') == 'text':
                out.append(b.get('text', ''))
            elif b.get('type') == 'tool_result':
                x = b.get('content')
                if isinstance(x, str):
                    out.append(x)
                elif isinstance(x, list):
                    out.append(' '.join(y.get('text', '') for y in x if isinstance(y, dict)))
    return '\n'.join(out)


files = glob.glob(ROOT + r'\**\*.jsonl', recursive=True)
allsess = set()
mn = mx = None
nsub = nev = nmain = nbad = 0
notif_by_sess = collections.Counter()
for f in files:
    rel = os.path.relpath(f, ROOT).split(os.sep)
    s = rel[1].replace('.jsonl', '') if len(rel) > 1 else rel[0]
    if s == SELF:
        continue
    is_sub = 'subagents' in rel
    if is_sub:
        nsub += 1
    else:
        nmain += 1
    allsess.add(s)
    toolname = {}
    prev_chall = None
    test_after = True
    searched = False
    last_edit = -1
    last_commit = -1
    last_edit_git = -1
    last_asst_text = ''
    idx = 0
    msg_agents = collections.Counter()
    for line in open(f, encoding='utf8', errors='replace'):
        try:
            d = json.loads(line)
        except Exception:
            nbad += 1
            continue
        nev += 1
        idx += 1
        ts = d.get('timestamp')
        if ts:
            mn = ts if mn is None or ts < mn else mn
            mx = ts if mx is None or ts > mx else mx
        t = d.get('type')
        if t == 'queue-operation':
            if 'task-notification' in str(d.get('content', ''))[:200]:
                notif_by_sess[s] += 1
            continue
        if t == 'system':
            if d.get('subtype') == 'compact_boundary':
                hit(12, s, 'compact_boundary')
                extra['compactions'] += 1
            continue
        m = d.get('message') or {}
        c = m.get('content')
        if t == 'user':
            T = txt(c)
            isres = isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c)
            if isres:
                for b in c:
                    if not isinstance(b, dict) or b.get('type') != 'tool_result':
                        continue
                    x = txt([b])
                    tn = toolname.get(b.get('tool_use_id'), '')
                    if tn in ('Agent', 'Task') and RE['csha'].search(x):
                        hit(2, s, x[:200])
                    if RE['disk'].search(x) and tn in ('Bash', 'PowerShell'):
                        hit(19, s, 'DISKFULL ' + x[:150])
                        extra['disk_full_results'] += 1
                    if RE['mods'].search(x):
                        hit(7, s, x[:200])
                continue
            if is_sub or d.get('isSidechain'):
                continue
            if T.lstrip().startswith('<task-notification'):
                notif_by_sess[s] += 1
                continue
            if RE['compact'].search(T[:200]):
                hit(12, s, 'continued-session summary')
                extra['compactions'] += 1
                continue
            if T.lstrip().startswith(SYSTEMY):
                if RE['model'].search(T[:200]):
                    hit(12, s, T[:80])
                    extra['model_switch'] += 1
                continue
            if not T.strip():
                continue
            hit(25, s, T[:80])
            prev_chall = T if (len(T) < 150 and RE['chall'].search(T)) else None
            if prev_chall:
                extra['challenge_opportunities'] += 1
            if '<pasted_content' in T or len(T) > 1500:
                hit(3, s, T[:100])
            if len(T) < 2500 and RE['inv'].search(T):
                hit(4, s, T[:150])
            if RE['revert'].search(T) and len(T) < 600:
                hit(23, s, T[:150])
            if RE['mods'].search(T):
                hit(7, s, T[:150])
        elif t == 'assistant':
            if not isinstance(c, list):
                continue
            mid = m.get('id')
            T = txt(c)
            if prev_chall is not None and T.strip():
                if RE['rev'].search(T[:400]):
                    hit(1, s, prev_chall[:60] + ' => ' + T[:80])
                prev_chall = None
            if T.strip():
                last_asst_text = T
                if RE['mods'].search(T):
                    hit(7, s, T[:150])
            for b in c:
                if not isinstance(b, dict) or b.get('type') != 'tool_use':
                    continue
                n = b.get('name', '')
                inp = b.get('input') or {}
                toolname[b.get('id')] = n
                fp = inp.get('file_path') or inp.get('path') or ''
                if not isinstance(fp, str):
                    fp = ''
                cmd = inp.get('command') or ''
                if not isinstance(cmd, str):
                    cmd = ''
                if n in ('Agent', 'Task'):
                    extra['agent_calls'] += 1
                    msg_agents[mid] += 1
                    if msg_agents[mid] == 2:
                        hit(5, s, 'parallel agents in one turn')
                    if msg_agents[mid] == 1:
                        hit(12, s, 'subagent start ' + str(inp.get('subagent_type', ''))[:30])
                        extra['subagent_starts'] += 1
                if n in ('Edit', 'Write', 'MultiEdit'):
                    new = inp.get('new_string') or inp.get('content') or ''
                    if not isinstance(new, str):
                        new = str(new)
                    low = fp.replace('/', '\\').lower()
                    if re.search(r'(\\memory\\|claude-memory\\)[^\\]*\.md$', low):
                        bad = [l for l in new.splitlines() if RE['num'].search(l) and not RE['date'].search(l)]
                        if bad:
                            hit(8, s, os.path.basename(fp) + ': ' + bad[0][:120])
                    if RE['sens'].search(fp) and not re.search(r'\.(example|sample|template)$', fp, re.I):
                        hit(16, s, fp)
                    if RE['bak'].search(fp):
                        hit(18, s, fp)
                    if fp.lower().endswith(CODE):
                        if not is_sub and not scratch(fp):
                            last_edit = idx
                            test_after = False
                        if n == 'Write' and not is_sub and not scratch(fp) and len(new.splitlines()) >= 10 and not searched:
                            hit(9, s, fp + ' (%d lines)' % len(new.splitlines()))
                    if fp and in_git(fp) and not scratch(fp) and '\\.claude\\' not in fp:
                        last_edit_git = idx
                if n in ('WebSearch', 'WebFetch', 'Grep', 'Glob') or (n == 'Skill' and 'search' in json.dumps(inp)) or (n in ('Bash', 'PowerShell') and re.search(r'search|\brg\b|\bgrep\b', cmd)):
                    searched = True
                if n == 'Read' and RE['handoff'].search(os.path.basename(fp)):
                    hit(22, s, fp)
                if n in ('Bash', 'PowerShell'):
                    if RE['test'].search(cmd):
                        test_after = True
                    if re.search(r'git\s+(-C\s+\S+\s+)?commit', cmd):
                        last_commit = idx
                    if RE['pub'].search(cmd):
                        hit(14, s, cmd[:150])
                        extra['pub_visibility_or_create'] += 1
                    elif RE['pushpub'].search(cmd) and re.search(r'Projects[\\/]+public', cmd + ' ' + str(d.get('cwd', ''))):
                        hit(14, s, cmd[:150])
                        extra['push_in_public'] += 1
                    if any(RE['killv'].search(L) and RE['killt'].search(L) for L in cmd.splitlines()):
                        hit(15, s, cmd[:150])
                    if RE['build'].search(cmd):
                        hit(19, s, 'BUILD ' + cmd[:120])
                        extra['build_cmds'] += 1
                    if (re.search(r'sqlite3', cmd) and '.db' in cmd) or (RE['dml'].search(cmd) and '.db' in cmd):
                        hit(24, s, cmd[:150])
                        if RE['dml'].search(cmd):
                            extra['db_write_ish'] += 1
                if n.endswith('brain_remember'):
                    extra['brain_remember_total'] += 1
                    if 'trust_level' not in inp:
                        hit(13, s, json.dumps(inp)[:120])
                if n in ('SendMessage', 'mcp__claude-peers__send_message'):
                    extra['sendmessage_total'] += 1
                    if RE['secretmsg'].search(json.dumps(inp)):
                        hit(17, s, 'secret-like in message to ' + str(inp.get('to') or inp.get('to_id')))
                blob = fp + ' ' + cmd
                if RE['stale'].search(blob):
                    hit(20, s, blob[:150])
                    extra['stale_marker'] += 1
                elif dup.search(blob):
                    hit(20, s, blob[:150])
                    extra['dup_nonpublic'] += 1
    if last_edit >= 0 and not test_after:
        hit(10, s, 'code edited, no test run later (%s)' % os.path.basename(f)[:20])
    if not is_sub and last_edit_git >= 0 and last_commit < last_edit_git and last_asst_text.strip() and RE['done'].search(last_asst_text[-600:]):
        hit(21, s, last_asst_text[-120:])
for s, n in notif_by_sess.items():
    if n >= 2:
        hit(5, s, '%d task-notifications' % n)
        extra['sess_with_2plus_notif'] += 1

# 6 terse-guard
tg = glob.glob(os.path.join(POLICY_LOG, '*.json'))
viol = collections.Counter()
rew = 0
for f in tg:
    try:
        d = json.load(open(f, encoding='utf8'))
    except Exception:
        continue
    hit(6, 'terse-guard', ' ; '.join(d.get('violations', []))[:100])
    if d.get('rewritten'):
        rew += 1
    for v in d.get('violations', []):
        viol[re.sub(r'\d+', 'N', v)] += 1
extra['terse_rewritten'] = rew
# 11 git
repos = []
for base in REPO_DIRS + ([PUBLIC_DIR] if PUBLIC_DIR else []):
    if not os.path.isdir(base):
        continue
    for n in os.listdir(base):
        if os.path.exists(os.path.join(base, n, '.git')):
            repos.append(os.path.join(base, n))
seenh = set()
totc = 0
for r in repos:
    try:
        o = subprocess.run(['git', '-C', r, 'log', '--all', '--format=%H%x09%s'], capture_output=True, text=True, encoding='utf8', errors='replace', timeout=60).stdout
    except Exception:
        continue
    for l in o.splitlines():
        h, _, sub = l.partition('\t')
        if h in seenh:
            continue
        seenh.add(h)
        totc += 1
        if re.search(r'\bfmt\b|clippy|\blint|format|CRLF|line ending', sub, re.I):
            hit(11, os.path.basename(r), sub)
extra['git_commits_total'] = totc
extra['git_repos'] = len(repos)

ns = len(allsess)
rows = []
for c in range(1, 26):
    rows.append([c, NAMES[c], fires[c], len(sess[c]), round(100 * len(sess[c]) / ns, 1)])
rows.sort(key=lambda r: -r[2])
with open(os.path.join(OUT, 'controls.csv'), 'w', newline='', encoding='utf8') as fh:
    w = csv.writer(fh)
    w.writerow(['#', 'control', 'fires', 'distinct_sessions', 'sessions_per_100'])
    w.writerows(rows)
json.dump({str(k): v for k, v in samples.items()}, open(os.path.join(OUT, 'samples.json'), 'w', encoding='utf8'), indent=1)
summary = dict(files=len(files), main=nmain, sub=nsub, sessions=ns, events=nev, bad_lines=nbad, first=mn, last=mx, extra=dict(extra), terse_total=len(tg), terse_top=viol.most_common(6))
json.dump(summary, open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf8'), indent=1)
print(json.dumps(summary, indent=1))
for r in rows:
    print(r)
