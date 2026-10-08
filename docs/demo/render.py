"""Render the live runs in docs/demo/runs into screenshots in docs/images.

Each image shows a real session as Claude Code shows it: the prompt, each tool call and its
result, the guardrail's refusal or note, and the model's reply. Text is the run's own, cut for
length (marked with ...) but never reworded. Needs Python Playwright with Chromium installed.

    python docs/demo/render.py            # every run, plus overview and social preview
"""
from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
RUNS = HERE / 'runs'
IMAGES = HERE.parent / 'images'

PACKS = {
    'approval': ('Approval', 'A human signs off before anything that cannot be undone',
                 ['sensitive-file-guard', 'publish-gate', 'protected-process', 'message-redact', 'backup-file-guard', 'headroom-check', 'stale-copy-band']),
    'records': ('Records', 'Leave a trail a reviewer can follow',
                ['clean-tree-on-done', 'doc-age-stamp', 'never-revert', 'db-snapshot', 'turn-ledger']),
    'monitoring': ('Monitoring', 'Keep watching after approval',
                   ['agent-hold', 'reply-policy', 'controls-watchdog', 'stale-number-flag']),
    'development': ('Development', 'Look before building, test what changed',
                    ['search-before-build', 'test-reminder', 'precommit-check', 'rules-persist', 'memory-provenance']),
    'outcomes': ('Outcomes', 'Check claims against the evidence',
                 ['source-fidelity', 'inventory-gate']),
    'challenge': ('Challenge', 'Hold answers to evidence, not pressure',
                  ['pushback-check', 'commit-claim-audit']),
}

CSS = """
:root { --bg:#0b0f14; --card:#11161d; --line:#1f2731; --fg:#d7dde5; --dim:#7d8896; --accent:#d97757;
        --red:#f0716b; --redbg:#2a1416; --amber:#e8b45a; --amberbg:#2a2113; --violet:#b69cff; --violetbg:#1d1830;
        --green:#7fd18b; --blue:#79b8ff; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); font-family:'JetBrains Mono','Cascadia Code',Consolas,monospace; color:var(--fg); padding:28px; }
.card { width:980px; background:var(--card); border:1px solid var(--line); border-radius:14px; overflow:hidden;
        box-shadow:0 18px 50px rgba(0,0,0,.45); }
.bar { display:flex; align-items:center; gap:8px; padding:12px 16px; border-bottom:1px solid var(--line); background:#0e1319; }
.dot { width:11px; height:11px; border-radius:50%; } .d1{background:#ff5f57}.d2{background:#febc2e}.d3{background:#28c840}
.title { margin-left:12px; font-size:13px; color:var(--dim); letter-spacing:.2px; }
.title b { color:var(--fg); font-weight:600; } .pill { margin-left:auto; font-size:11px; padding:3px 9px; border-radius:99px;
        background:#1a222c; color:var(--accent); border:1px solid #2a3440; text-transform:uppercase; letter-spacing:.8px; }
.body { padding:18px 22px 20px; font-size:13.5px; line-height:1.55; }
.ev { margin:0 0 10px; white-space:pre-wrap; word-break:break-word; }
.prompt { color:#e9edf2; } .prompt::before { content:'> '; color:var(--accent); font-weight:700; }
.prompt { background:#151c25; border-left:3px solid var(--accent); padding:8px 12px; border-radius:6px; }
.tool { color:var(--fg); } .tool .b { color:var(--green); } .tool .n { font-weight:700; } .tool .a { color:var(--dim); }
.result { color:var(--dim); padding-left:22px; } .result::before { content:'\\23BF  '; color:#4a5563; }
.box { border-radius:8px; padding:10px 14px; margin:2px 0 12px 22px; white-space:pre-wrap; }
.box .lbl { display:block; font-size:10.5px; letter-spacing:1px; text-transform:uppercase; margin-bottom:4px; opacity:.85; }
.refuse { background:var(--redbg); border:1px solid #5a2a2c; color:#ffd9d6; } .refuse .lbl { color:var(--red); }
.note { background:var(--amberbg); border:1px solid #57461f; color:#f6e3bd; } .note .lbl { color:var(--amber); }
.stop { background:var(--violetbg); border:1px solid #3b3166; color:#e2d9ff; } .stop .lbl { color:var(--violet); }
.tag { font-weight:700; }
.reply { color:var(--fg); } .reply code { color:#c9b8ff; font-family:inherit; } .reply::before { content:'\\25CF\\00a0'; color:#e9edf2; }
.files { margin-top:6px; border-top:1px dashed var(--line); padding-top:12px; }
.file { color:var(--blue); font-size:12.5px; } .fbody { color:var(--dim); font-size:12px; margin:2px 0 10px 14px; white-space:pre-wrap; }
.more { color:#4a5563; font-style:italic; }
"""

TAG = re.compile(r'\[([a-z]+(?:-[a-z]+)+)\]')


DEMO_PATH = re.compile(r'~/demo[^\s\'"`)]*')


def esc(s: str) -> str:
    return html.escape(DEMO_PATH.sub(lambda m: m.group(0).replace(chr(92), '/'), s))


def tagged(s: str) -> str:
    return TAG.sub(lambda m: f'<span class="tag">[{m.group(1)}]</span>', esc(s))


def tidy(s: str) -> str:
    """Display clean-up only: shorter paths, no harness XML, fake keys masked."""
    s = re.sub(r'<task-notification>[\s\S]*?</task-notification>', '[an agent report, held]', s)
    s = re.sub(r'(?m)^output_file:.*$\n?', '', s)
    s = re.sub(r'Async agent launched successfully\.[\s\S]*', 'Agent launched in the background.', s)
    s = re.sub(r'~[\\/]+\.claude[\\/]+projects[\\/]+[^\\/\s"]+[\\/]+', '~/.claude/projects/.../', s)
    s = re.sub(r'~[^\s"\'`,)]*', lambda m: re.sub(r'[\\/]+', '/', m.group(0)), s)
    s = re.sub(r'(?:~|[A-Za-z]:|[\w.-]+)(?:\\+[\w.-]+)+\.\w{1,5}\b', lambda m: re.sub(r'\\+', '/', m.group(0)), s)
    return re.sub(r'(sk-ant-api03-)[A-Za-z0-9_-]+', r'\1••••••••', s)


def clip(s: str, lines: int, width: int = 400) -> str:
    s = tidy(s)
    rows = s.strip().splitlines() or ['']
    out = [r if len(r) <= width else r[:width] + ' ...' for r in rows[:lines]]
    if len(rows) > lines:
        out.append('...')
    return '\n'.join(out)


def prompt_text(s: str) -> str:
    m = re.search(r'<pasted_content[^>]*>([\s\S]*?)</pasted_content>|--- posting ---([\s\S]*?)--- end of posting ---', s)
    if m:
        n = len((m.group(1) or m.group(2)).strip().splitlines())
        s = s[:m.start()].rstrip() + f'\n[pasted document: {n} lines]'
    return clip(s, 6)


def tool_args(tool: str, inp: dict) -> str:
    if tool in ('Write', 'Edit', 'Read', 'NotebookEdit'):
        return str(inp.get('file_path') or inp.get('notebook_path') or '')
    if tool in ('Bash', 'PowerShell'):
        return clip(str(inp.get('command', '')), 3, 150)
    if tool == 'Agent':
        return str(inp.get('description') or inp.get('subagent_type') or '')
    if tool == 'SendMessage':
        return clip(f"to {inp.get('to') or inp.get('recipient')}: {inp.get('message') or inp.get('content') or ''}", 2, 150)
    return clip(json.dumps(inp, ensure_ascii=False), 2, 150)


def box(kind: str, label: str, text: str) -> str:
    return f'<div class="box {kind}"><span class="lbl">{label}</span>{tagged(clip(text, 9, 300))}</div>'


def event_html(ev: dict) -> str:
    k = ev['kind']
    if k == 'prompt':
        return f'<div class="ev prompt">{esc(prompt_text(ev["text"]))}</div>'
    if k == 'tool':
        return f'<div class="ev tool"><span class="b">●</span> <span class="n">{esc(ev["tool"])}</span><span class="a">({esc(tidy(tool_args(ev["tool"], ev["input"])))})</span></div>'
    if k == 'result':
        t = ev['text']
        if TAG.search(t) and ('Refused' in t or ev.get('error')):
            return box('refuse', 'guardrail refused the action', re.sub(r'</?tool_use_error>', '', t))
        if TAG.search(t):
            return box('note', 'guardrail note', t)
        if t.startswith('guardrails-monitoring: Guardrail packs'):  # slash-command output, prefixed by the engine
            return f'<div class="ev result">{esc(clip(t.split(": ", 1)[1], 8, 160))}</div>'
        return f'<div class="ev result">{esc(clip(t, 3, 160))}</div>'
    if k == 'note':
        return box('note', 'guardrail note the model receives', ev['text'])
    if k == 'stop':
        return box('stop', 'sent back to the model before you see the reply', ev['text'])
    if k == 'reply':
        text = re.sub(r'(?m)^\s*```\w*\s*$\n?', '', ev['text']).replace('**', '')
        return f'<div class="ev reply">{re.sub(r"`([^`]+)`", r"<code>\1</code>", esc(clip(text, 7, 300)))}</div>'
    return ''


def pick(events: list[dict], limit: int = 16) -> list[dict]:
    """Keeps every guardrail moment and what surrounds it; drops the middle of long runs."""
    if len(events) <= limit:
        return events
    keep = set(range(2)) | {len(events) - 1}
    for i, ev in enumerate(events):
        if TAG.search(ev.get('text', '') or '') or ev['kind'] in ('note', 'stop'):
            keep |= {i - 1, i, i + 1}
    idx = sorted(i for i in keep if 0 <= i < len(events))[:limit]
    out, last = [], -1
    for i in idx:
        if i != last + 1:
            out.append({'kind': 'gap'})
        out.append(events[i])
        last = i
    return out


def files_html(files: dict) -> str:
    if not files:
        return ''
    parts = ['<div class="files">']
    for name, body in list(files.items())[:4]:
        text = body
        if name.endswith('.json'):
            try:
                d = json.loads(body)
            except json.JSONDecodeError:  # the runner keeps only the first 4,000 characters
                v = re.search(r'"violations":\s*\[([^\]]*)\]', body)
                b = re.search(r'"before":\s*"((?:[^"\\]|\\.)*)', body)
                d = {'violations': json.loads(f'[{v.group(1)}]'),
                     'before': json.loads(f'"{b.group(1)}"') if b else ''} if v else None
            if isinstance(d, dict) and 'violations' in d:
                draft = '\n'.join(str(d.get('before', '')).strip().splitlines()[:5])
                parts.append(box('stop', 'reply-policy rewrote the reply before you saw it',
                                 f"[reply-policy] The first draft broke the policy: {'; '.join(d['violations'])}.\n"
                                 f"First draft, as written:\n{draft}\n..."))
                continue
        parts.append(f'<div class="file">{esc(name)}</div><div class="fbody">{esc(clip(text, 6, 160))}</div>')
    return ''.join(parts) + '</div>'


def card(run: dict) -> str:
    pack = PACKS[run['pack']][0]
    evs = ''.join('<div class="ev more">...</div>' if e['kind'] == 'gap' else event_html(e) for e in pick(run['events']))
    return (f'<div class="card"><div class="bar"><span class="dot d1"></span><span class="dot d2"></span><span class="dot d3"></span>'
            f'<span class="title">claude-risk-guardrails &middot; <b>{esc(run["name"])}</b></span><span class="pill">{esc(pack)}</span></div>'
            f'<div class="body">{evs}{files_html(run.get("files") or {})}</div></div>')


def page(inner: str, extra_css: str = '') -> str:
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}{extra_css}</style></head><body>{inner}</body></html>'


OVERVIEW_CSS = """
.ov { width:1180px; padding:34px 36px; background:var(--card); border:1px solid var(--line); border-radius:16px; font-family:Inter,'Segoe UI',sans-serif; }
.ov h1 { font-size:30px; font-weight:700; letter-spacing:-.3px; } .ov h1 span { color:var(--accent); }
.ov p.sub { color:var(--dim); margin:6px 0 24px; font-size:15px; }
.grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
.pk { background:#0e1319; border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
.pk h2 { font-size:16px; color:var(--accent); } .pk .w { color:var(--dim); font-size:12.5px; margin:3px 0 10px; }
.pk li { list-style:none; font-family:'JetBrains Mono',Consolas,monospace; font-size:12.5px; padding:2px 0; color:var(--fg); }
.pk li::before { content:'\\25B8 '; color:#4a5563; }
"""


def overview(social: bool) -> str:
    packs = ''.join(f'<div class="pk"><h2>{esc(t)}</h2><div class="w">{esc(w)}</div><ul>{"".join(f"<li>{esc(g)}</li>" for g in gs)}</ul></div>'
                    for t, w, gs in PACKS.values())
    size = '.ov{width:1280px;height:640px;border-radius:0;border:none;padding:40px 46px}' if social else ''
    return page(f'<div class="ov"><h1>claude-risk-guardrails <span>&middot; 25 controls</span></h1>'
                f'<p class="sub">Model risk management for an AI coding agent: Claude Code treated as a vendor model, governed in six control packs.</p>'
                f'<div class="grid">{packs}</div></div>', OVERVIEW_CSS + size)


SOCIAL_CSS = """
body { margin:0; }
.sp { width:1280px; height:640px; box-sizing:border-box; padding:56px 60px; display:flex; gap:48px; align-items:center;
      background:radial-gradient(900px 520px at 88% 30%, rgba(232,122,84,.16), transparent 60%), #0b0f14;
      font-family:Inter,'Segoe UI',sans-serif; color:var(--fg); }
.l { flex:1.05; }
.kick { color:var(--accent); font-weight:700; font-size:17px; letter-spacing:2.4px; text-transform:uppercase; }
.sp h1 { font-size:58px; line-height:1.06; font-weight:800; letter-spacing:-1.4px; margin:18px 0 20px; }
.sp h1 span { color:var(--accent); }
.sp p { font-size:23px; line-height:1.4; color:#aab4c0; margin:0 0 30px; }
.chips span { display:inline-block; font-size:17px; padding:8px 15px; margin:0 8px 8px 0; border-radius:999px;
              border:1px solid #2a3340; background:#121821; color:#d6dde6; }
.repo { margin-top:26px; font-family:'JetBrains Mono',Consolas,monospace; font-size:17px; color:#7d8896; }
.r { flex:.95; background:#10161e; border:1px solid #232c38; border-radius:16px; overflow:hidden; box-shadow:0 30px 80px rgba(0,0,0,.5); }
.r .bar { padding:14px 18px; border-bottom:1px solid #1f2731; }
.r .dot { display:inline-block; width:12px; height:12px; border-radius:50%; margin-right:7px; }
.r .in { padding:22px 24px 26px; font-family:'JetBrains Mono',Consolas,monospace; font-size:18px; line-height:1.5; }
.r .u { color:#e6edf3; } .r .u b { color:var(--accent); }
.r .t { color:#9aa5b1; margin:14px 0; } .r .t b { color:#7ee787; font-weight:400; }
.r .x { border:1px solid #6e2b2b; background:#2a1416; border-radius:10px; padding:14px 16px; color:#f0d0d0; }
.r .x .h { color:#ff7b72; font-size:14px; letter-spacing:1.5px; margin-bottom:6px; }
.r .x code { color:#ffb4a8; font-family:inherit; }
"""


def social() -> str:
    return page(
        '<div class="sp"><div class="l">'
        '<div class="kick">Model risk management for AI agents</div>'
        '<h1>Govern Claude Code like a <span>vendor model.</span></h1>'
        '<p>25 guardrails that block, verify and record, mapped to SR 26-2 (by analogy) and NIST AI RMF.</p>'
        '<div class="chips"><span>6 packs</span><span>Human sign-off</span><span>Live-tested</span><span>MIT</span></div>'
        '<div class="repo">github.com/scaso01/claude-risk-guardrails</div></div>'
        '<div class="r"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>'
        '<span class="dot" style="background:#28c840"></span></div><div class="in">'
        '<div class="u"><b>&gt;</b> Make our repo public</div>'
        '<div class="t"><b>&#9679;</b> Bash(gh repo edit --visibility public)</div>'
        '<div class="x"><div class="h">GUARDRAIL REFUSED</div>[publish-gate] This makes a repository public. '
        'A human must sign off: they type <code>approve G-7445</code> themselves.</div>'
        '</div></div></div>', SOCIAL_CSS)


def main(names: list[str]) -> int:
    IMAGES.mkdir(parents=True, exist_ok=True)
    runs = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(RUNS.glob('*.json'))]
    runs = [r for r in runs if not names or r['name'] in names]
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        pg = browser.new_page(device_scale_factor=2, viewport={'width': 1400, 'height': 900})
        for r in runs:
            if not r.get('fired'):
                print(f'skip {r["name"]}: it did not fire in its run')
                continue
            pg.set_content(page(card(r)))
            pg.locator('.card').screenshot(path=str(IMAGES / f'{r["name"]}.png'))
            print(f'wrote {r["name"]}.png')
        if not names:
            pg.set_content(overview(False))
            pg.locator('.ov').screenshot(path=str(IMAGES / 'overview.png'))
            sp = browser.new_page(device_scale_factor=2, viewport={'width': 1280, 'height': 640})
            sp.set_content(social())
            sp.locator('.sp').screenshot(path=str(IMAGES / 'social-preview.png'))
            print('wrote overview.png, social-preview.png')
        browser.close()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
