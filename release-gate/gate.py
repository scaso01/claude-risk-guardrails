#!/usr/bin/env python3
"""Release gate for an AI feature or model: test results in, a verdict out.

Usage:
    python gate.py RESULTS.csv LIMITS.json            human report on stdout
    python gate.py RESULTS.csv LIMITS.json --json     one JSON object on stdout,
                                                      human report on stderr
    python gate.py RESULTS.csv LIMITS.json --record decision-record.md
                                                      also write a decision record
                                                      filled in from the run

Exit codes: 0 pass, 1 not enough evidence, 2 fail, 3 could not run (bad input).
Python 3.9+, standard library only.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path

PASS, NOT_ENOUGH, FAIL, CANNOT_RUN = 0, 1, 2, 3
LABELS = {PASS: "PASS", NOT_ENOUGH: "NOT ENOUGH EVIDENCE", FAIL: "FAIL"}
LEVELS = ("critical", "high", "medium", "low")
KINDS = ("representative", "adverse")
COLUMNS = ("case_id", "segment", "kind", "outcome", "severity", "tested_on")


class InputError(Exception):
    """The inputs are malformed, so no verdict can be given."""


@dataclass
class SegmentResult:
    segment: str
    cases: int
    failures: int
    limit: float
    min_cases: int
    upper: float
    status: int
    clean_cases_needed: int | None = None
    failed_ids: list[str] = field(default_factory=list)

    @property
    def observed(self) -> float:
        return self.failures / self.cases if self.cases else 0.0


@dataclass
class GateResult:
    feature: str
    version: str
    confidence: float
    segments: list[SegmentResult]
    severity_counts: dict[str, int]
    severity_limits: dict[str, int | None]
    severe_case_ids: dict[str, list[str]]
    adverse_cases: int
    adverse_failures: int
    limits_set_on: dt.date
    testing_began: dt.date
    date_status: int
    hashes: dict[str, str]
    results_name: str
    limits_name: str
    case_notes: dict[str, str]
    notes: list[str] = field(default_factory=list)

    @property
    def verdict(self) -> int:
        over = [FAIL for sev, n in self.severity_counts.items()
                if over_limit(n, self.severity_limits[sev])]
        return max([s.status for s in self.segments] + [self.date_status] + over, default=PASS)


def over_limit(count: int, cap: int | None) -> bool:
    return cap is not None and count > cap


def binomial_cdf(k: int, n: int, p: float) -> float:
    """P(X <= k) for X ~ Binomial(n, p)."""
    if p <= 0.0:
        return 1.0
    if p >= 1.0:
        return 1.0 if k >= n else 0.0
    log_p, log_q = math.log(p), math.log1p(-p)
    base = math.lgamma(n + 1)
    total = 0.0
    for i in range(k + 1):
        total += math.exp(base - math.lgamma(i + 1) - math.lgamma(n - i + 1)
                          + i * log_p + (n - i) * log_q)
    return min(total, 1.0)


def upper_bound(failures: int, cases: int, confidence: float) -> float:
    """One-sided exact (Clopper-Pearson) upper confidence bound on the failure rate."""
    if cases <= 0:
        return 1.0
    if failures >= cases:
        return 1.0
    alpha = 1.0 - confidence
    if failures == 0:
        return 1.0 - alpha ** (1.0 / cases)
    lo, hi = failures / cases, 1.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if binomial_cdf(failures, cases, mid) > alpha:
            lo = mid
        else:
            hi = mid
    return hi


def lower_bound(failures: int, cases: int, confidence: float) -> float:
    """One-sided exact (Clopper-Pearson) lower confidence bound on the failure rate."""
    if failures <= 0 or cases <= 0:
        return 0.0
    alpha = 1.0 - confidence
    if failures >= cases:
        return alpha ** (1.0 / cases)
    lo, hi = 0.0, failures / cases
    for _ in range(200):
        mid = (lo + hi) / 2
        if binomial_cdf(failures - 1, cases, mid) > 1.0 - alpha:
            lo = mid
        else:
            hi = mid
    return lo


def clean_cases_needed(limit: float, confidence: float) -> int:
    """Smallest number of cases that, with zero failures, puts the upper bound at or under the limit."""
    if limit <= 0.0:
        raise InputError("max_failure_rate must be above 0")
    if limit >= 1.0:
        return 1
    n = math.ceil(math.log(1.0 - confidence) / math.log1p(-limit))
    while upper_bound(0, n, confidence) > limit:
        n += 1
    while n > 1 and upper_bound(0, n - 1, confidence) <= limit:
        n -= 1
    return n


def cases_needed(failures: int, limit: float, confidence: float) -> int:
    """Smallest total number of cases that clears the limit if no further case fails."""
    lo = max(clean_cases_needed(limit, confidence), failures + 1)
    if upper_bound(failures, lo, confidence) <= limit:
        return lo
    hi = lo * 2
    while upper_bound(failures, hi, confidence) > limit:
        hi *= 2
    while lo < hi:
        mid = (lo + hi) // 2
        if upper_bound(failures, mid, confidence) <= limit:
            hi = mid
        else:
            lo = mid + 1
    return lo


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_date(value: str, where: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value.strip())
    except ValueError:
        raise InputError(f"{where}: {value!r} is not a YYYY-MM-DD date") from None


def load_limits(path: Path) -> dict:
    try:
        limits = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise InputError(f"{path.name} is not valid JSON: {exc}") from None
    for key in ("feature", "version", "set_on", "confidence", "segments"):
        if key not in limits:
            raise InputError(f"{path.name} is missing {key!r}")
    confidence = limits["confidence"]
    if not isinstance(confidence, (int, float)) or not 0.5 <= confidence < 1.0:
        raise InputError(f"{path.name}: confidence must be a number from 0.5 to below 1")
    if not isinstance(limits["segments"], dict) or not limits["segments"]:
        raise InputError(f"{path.name}: segments must name at least one segment")
    for name, rule in limits["segments"].items():
        rate = rule.get("max_failure_rate") if isinstance(rule, dict) else None
        if not isinstance(rate, (int, float)) or not 0.0 < rate < 1.0:
            raise InputError(f"{path.name}: segment {name!r} needs max_failure_rate between 0 and 1")
        min_cases = rule.get("min_cases", 0)
        if not isinstance(min_cases, int) or min_cases < 0:
            raise InputError(f"{path.name}: segment {name!r} min_cases must be a whole number")
    severity_limits = limits.get("max_failures_by_severity", {})
    if not isinstance(severity_limits, dict):
        raise InputError(f"{path.name}: max_failures_by_severity must be an object like "
                         '{"critical": 0, "high": 0}')
    for sev, n in severity_limits.items():
        if sev not in LEVELS or not isinstance(n, int) or n < 0:
            raise InputError(f"{path.name}: max_failures_by_severity has a bad entry {sev!r}: {n!r}")
    return limits


def load_results(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as src:
        table = csv.DictReader(src)
        missing = [c for c in COLUMNS if c not in (table.fieldnames or [])]
        if missing:
            raise InputError(f"{path.name} is missing columns: {', '.join(missing)}")
        rows = list(table)
    if not rows:
        raise InputError(f"{path.name} has no test cases")
    seen: set[str] = set()
    for line, row in enumerate(rows, start=2):
        case_id = (row["case_id"] or "").strip()
        if not case_id:
            raise InputError(f"{path.name} line {line}: case_id is empty")
        if case_id in seen:
            raise InputError(f"{path.name} line {line}: case_id {case_id!r} appears twice")
        seen.add(case_id)
        for col in COLUMNS:
            row[col] = (row[col] or "").strip()
        row["kind"], row["outcome"], row["severity"] = (
            row["kind"].lower(), row["outcome"].lower(), row["severity"].lower())
        if row["kind"] not in KINDS:
            raise InputError(f"{path.name} line {line}: kind must be representative or adverse")
        if row["outcome"] not in ("pass", "fail"):
            raise InputError(f"{path.name} line {line}: outcome must be pass or fail")
        if row["outcome"] == "fail" and row["severity"] not in LEVELS:
            raise InputError(f"{path.name} line {line}: a failed case needs severity "
                             "critical, high, medium or low")
        if row["outcome"] == "pass" and row["severity"]:
            raise InputError(f"{path.name} line {line}: a passed case has no severity")
        if not row["segment"]:
            raise InputError(f"{path.name} line {line}: segment is empty")
        row["tested_on_date"] = parse_date(row["tested_on"], f"{path.name} line {line}")
    return rows


def evaluate(results_path: Path, limits_path: Path) -> GateResult:
    limits = load_limits(limits_path)
    rows = load_results(results_path)
    confidence = float(limits["confidence"])
    rules = limits["segments"]

    unknown = sorted({r["segment"] for r in rows if r["kind"] == "representative"} - set(rules))
    if unknown:
        raise InputError("no limit set for segment(s): " + ", ".join(unknown))

    segments = []
    for name, rule in rules.items():
        reps = [r for r in rows if r["kind"] == "representative" and r["segment"] == name]
        cases = len(reps)
        failures = sum(r["outcome"] == "fail" for r in reps)
        limit = float(rule["max_failure_rate"])
        min_cases = int(rule.get("min_cases", 0))
        upper = upper_bound(failures, cases, confidence)
        needed = clean_cases_needed(limit, confidence)
        if cases >= max(min_cases, 1) and upper <= limit:
            status, shortfall = PASS, None
        elif lower_bound(failures, cases, confidence) > limit:
            status, shortfall = FAIL, None
        elif cases < min_cases or cases < needed:
            status = NOT_ENOUGH
            shortfall = max(cases_needed(failures, limit, confidence), min_cases)
        else:
            status, shortfall = FAIL, None
        failed_ids = [r["case_id"] for r in reps if r["outcome"] == "fail"]
        segments.append(SegmentResult(name, cases, failures, limit, min_cases, upper, status,
                                      shortfall, failed_ids))

    failed = [r for r in rows if r["outcome"] == "fail"]
    severity_counts = {sev: sum(r["severity"] == sev for r in failed) for sev in LEVELS}
    configured = limits.get("max_failures_by_severity", {})
    severity_limits = {sev: configured.get(sev, 0 if sev == "critical" else None)
                       for sev in LEVELS}
    severe_case_ids = {sev: [r["case_id"] for r in failed if r["severity"] == sev]
                       for sev in ("critical", "high")}
    case_notes = {r["case_id"]: (r.get("note") or "").strip()
                  for r in failed if r["severity"] in ("critical", "high")}

    set_on = parse_date(str(limits["set_on"]), f"{limits_path.name} set_on")
    began: dt.date = min(r["tested_on_date"] for r in rows)
    notes = []
    if set_on > began:
        date_status = FAIL
        notes.append(f"Limits are dated {set_on}, after testing began on {began}. "
                     "Limits must be fixed before anyone sees results.")
    elif set_on == began:
        date_status = PASS
        notes.append(f"Limits and the first test share the date {set_on}; "
                     "the dates alone cannot show which came first.")
    else:
        date_status = PASS

    adverse = [r for r in rows if r["kind"] == "adverse"]
    return GateResult(
        feature=str(limits["feature"]), version=str(limits["version"]), confidence=confidence,
        segments=segments, severity_counts=severity_counts, severity_limits=severity_limits,
        severe_case_ids=severe_case_ids, adverse_cases=len(adverse),
        adverse_failures=sum(r["outcome"] == "fail" for r in adverse),
        limits_set_on=set_on, testing_began=began, date_status=date_status,
        hashes={results_path.name: sha256(results_path), limits_path.name: sha256(limits_path)},
        results_name=results_path.name, limits_name=limits_path.name, case_notes=case_notes,
        notes=notes,
    )


def pct(x: float) -> str:
    return f"{x * 100:.2f}%"


def shortfall_text(s: SegmentResult) -> str:
    condition = " if no more fail" if s.failures else ""
    return f"needs {s.clean_cases_needed} cases{condition}; has {s.cases}"


def report(g: GateResult) -> str:
    conf = f"{g.confidence * 100:g}%"
    lines = [f"Release gate: {g.feature} {g.version}", ""]
    lines += [f"  sha256 {digest}  {name}" for name, digest in g.hashes.items()]
    lines += ["", f"Limits set {g.limits_set_on}; testing began {g.testing_began}: "
              f"{LABELS[g.date_status]} (checks the typed dates only)"]
    lines += ["", f"Representative cases, failure rate with a one-sided {conf} exact upper bound",
              f"  {'segment':<16}{'cases':>7}{'fails':>7}{'observed':>10}{'upper':>9}{'limit':>8}  result"]
    for s in g.segments:
        result = LABELS[s.status]
        if s.clean_cases_needed:
            result += f" ({shortfall_text(s)})"
        lines.append(f"  {s.segment:<16}{s.cases:>7}{s.failures:>7}{pct(s.observed):>10}"
                     f"{pct(s.upper):>9}{pct(s.limit):>8}  {result}")
    lines += ["", f"Failures by severity, all {sum(s.cases for s in g.segments) + g.adverse_cases} cases "
              f"({g.adverse_cases} adverse, {g.adverse_failures} of them failed)"]
    for sev in LEVELS:
        n, cap = g.severity_counts[sev], g.severity_limits[sev]
        ids = g.severe_case_ids.get(sev, [])
        allowed = "no limit" if cap is None else f"allowed {cap}"
        flag = "FAIL" if over_limit(n, cap) else "ok"
        lines.append(f"  {sev:<9}{n:>4}  ({allowed})  {flag}" + (f"  {', '.join(ids)}" if ids else ""))
    if g.notes:
        lines += [""] + [f"Note: {n}" for n in g.notes]
    lines += ["", f"Verdict: {LABELS[g.verdict]} (exit {g.verdict})"]
    return "\n".join(lines)


def result_json(g: GateResult) -> dict:
    metrics = []
    for s in g.segments:
        metrics += [
            {"name": "cases", "value": s.cases, "segment": s.segment},
            {"name": "failure_rate", "value": round(s.observed, 6), "segment": s.segment},
            {"name": "failure_rate_upper", "value": round(s.upper, 6), "segment": s.segment},
        ]
    metrics += [{"name": f"{sev}_failures", "value": n} for sev, n in g.severity_counts.items()]
    metrics.append({"name": "gate_verdict", "value": g.verdict})
    messages = [f"sha256 {d} {name}" for name, d in g.hashes.items()] + g.notes
    messages.append(f"verdict {LABELS[g.verdict]}; upper bounds are one-sided "
                    f"{g.confidence * 100:g}% exact (Clopper-Pearson)")
    return {"schema": "release-gate/result/v1", "test": "release-gate",
            "metrics": metrics, "messages": messages}


def cell(text: str) -> str:
    return " ".join(text.split()).replace("|", "\\|")


def allowed_text(cap: int | None) -> str:
    return "no limit" if cap is None else str(cap)


def findings(g: GateResult) -> list[tuple[str, str, str]]:
    """(case IDs, severity, what went wrong) for every rule the run broke."""
    found = []
    if g.date_status == FAIL:
        found.append(("", "", f"Limits dated {g.limits_set_on}, after testing began on {g.testing_began}"))
    for s in g.segments:
        if s.status == NOT_ENOUGH:
            found.append((", ".join(s.failed_ids), "",
                          f"{s.segment}: not enough evidence ({shortfall_text(s)})"))
        elif s.status == FAIL:
            found.append((", ".join(s.failed_ids), "",
                          f"{s.segment}: {s.failures} of {s.cases} failed ({pct(s.observed)}); upper "
                          f"bound {pct(s.upper)} is over the {pct(s.limit)} limit"))
    for sev in ("critical", "high"):
        found += [(cid, sev, g.case_notes.get(cid) or "No note in the results file")
                  for cid in g.severe_case_ids[sev]]
    for sev in ("medium", "low"):
        n, cap = g.severity_counts[sev], g.severity_limits[sev]
        if over_limit(n, cap):
            found.append(("", sev, f"{n} {sev} failures; {cap} allowed"))
    return found


def decision_record(g: GateResult, command: str, today: dt.date) -> str:
    """The decision record with every fact from the run filled in; judgments left blank."""
    verdict = LABELS[g.verdict]
    out = [
        "# Release decision record",
        "",
        f"Filled in by `gate.py` on {today} from the run in section 4. Blank fields need a",
        "person. Keep this file with the commit that holds the gate's inputs.",
        "",
        "## 1. What is being released",
        "",
        f"- Feature or model, and version: {g.feature} {g.version}",
        "- What it does, in one sentence:",
        "- Who uses it and what they rely on it for:",
        "- Risk tier and the reason for it:",
        "",
        "## 2. Who is accountable",
        "",
        "| Role | Name | Must be different from |",
        "|---|---|---|",
        "| Owner (built or sponsors it) | | |",
        "| Independent reviewer (ran the gate) | | Owner |",
        "| Approver | | Owner |",
        "",
        "## 3. Limits",
        "",
        f"- File: `{g.limits_name}`, SHA-256 `{g.hashes[g.limits_name]}`",
        "- Commit:",
        f"- Date set: {g.limits_set_on}",
        "- Approved by:",
        "- Why these limits (what a failure costs the user):",
        "",
        "| Group | Max failure rate | Minimum cases |",
        "|---|---:|---:|",
    ]
    out += [f"| {cell(s.segment)} | {pct(s.limit)} | {s.min_cases} |" for s in g.segments]
    out += ["", "| Severity | Failures allowed |", "|---|---:|"]
    out += [f"| {sev} | {allowed_text(g.severity_limits[sev])} |" for sev in LEVELS]
    out += [
        "",
        "## 4. Gate run",
        "",
        f"- Date: {today}",
        "- Run by:",
        f"- Command: `{command}`",
        f"- Results: `{g.results_name}`, SHA-256 `{g.hashes[g.results_name]}`",
        f"- Verdict: **{verdict}** (exit {g.verdict})",
        f"- Limits set {g.limits_set_on}; testing began {g.testing_began}: {LABELS[g.date_status]}",
    ]
    out += [f"- Note: {cell(n)}" for n in g.notes]
    out += [
        "- How the representative sample was drawn, and how grading was checked:",
        "",
        f"Representative cases, one-sided {g.confidence * 100:g}% exact upper bound:",
        "",
        "| Group | Cases | Failures | Observed | Upper bound | Limit | Result |",
        "|---|---:|---:|---:|---:|---:|---|",
    ]
    for s in g.segments:
        result = LABELS[s.status] + (f" ({shortfall_text(s)})" if s.clean_cases_needed else "")
        out.append(f"| {cell(s.segment)} | {s.cases} | {s.failures} | {pct(s.observed)} | "
                   f"{pct(s.upper)} | {pct(s.limit)} | {result} |")
    total = sum(s.cases for s in g.segments) + g.adverse_cases
    out += ["", f"Failures by severity, all {total} cases ({g.adverse_cases} adverse, "
                f"{g.adverse_failures} of them failed):",
            "", "| Severity | Failures | Allowed | Result |", "|---|---:|---:|---|"]
    for sev in LEVELS:
        n, cap = g.severity_counts[sev], g.severity_limits[sev]
        out.append(f"| {sev} | {n} | {allowed_text(cap)} | {'FAIL' if over_limit(n, cap) else 'ok'} |")

    found = findings(g)
    out += ["", "## 5. Findings", ""]
    if found:
        out += ["The gate lists every rule this run broke. Merge rows that share a cause, so each",
                "row is one distinct problem, and add any problem the gate cannot see."]
    else:
        out += ["The gate found no broken rule. Add any problem it cannot see, one row per",
                "distinct problem."]
    out += ["",
            "| ID | Case IDs | Severity | What went wrong | What the product should have done "
            "| Owner | Fix due | Verified by, and how |",
            "|---|---|---|---|---|---|---|---|"]
    out += [f"| F{i} | {cell(ids)} | {sev} | {cell(what)} | | | | |"
            for i, (ids, sev, what) in enumerate(found, start=1)]
    out.append("| | | | | | | | |")

    out += ["", "## 6. Decision", ""]
    if g.verdict == PASS:
        out.append("The gate passed. Approve only if every finding above is closed.")
    else:
        out.append(f"The gate's verdict is {verdict}, so Approve is not open on this run.")
    out += [
        "",
        "Tick one:",
        "",
        "- [ ] **Approve.** The gate passed and no finding is open.",
        "- [ ] **Approve with conditions.** Each condition below is met and verified before",
        "  release, not after. If any is not, the decision reverts to Do not approve.",
        "- [ ] **Do not approve.** Say what evidence would change this.",
        "",
        "| Condition | Evidence it is met | Verified by | Date |",
        "|---|---|---|---|",
        "| | | | |",
        "",
        "Approval lapses on (date):",
        "",
        "## 7. After release",
        "",
        "Thresholds start at the release limits; tighten any that needs an earlier warning.",
        "",
        "| What is watched | Threshold that triggers action | Action | Owner |",
        "|---|---|---|---|",
    ]
    out += [f"| Failure rate, {cell(s.segment)} | above {pct(s.limit)} | | |" for s in g.segments]
    out += [f"| {sev} failures | more than {cap} | | |"
            for sev in LEVELS if (cap := g.severity_limits[sev]) is not None]
    out += [
        "",
        "Re-review is required when any of these change: the model or its vendor version, its",
        "instructions or prompts, its data sources, its tools or permissions, the groups it serves,",
        "or a monitoring threshold is crossed.",
        "",
        "## 8. Sign-off",
        "",
        "| Role | Name | Date |",
        "|---|---|---|",
        "| Owner | | |",
        "| Independent reviewer | | |",
        "| Approver | | |",
    ]
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Release gate for an AI feature or model.")
    parser.add_argument("results", type=Path, help="CSV of test cases")
    parser.add_argument("limits", type=Path, help="JSON of limits fixed before testing")
    parser.add_argument("--json", action="store_true",
                        help="print one release-gate/result/v1 JSON object on stdout")
    parser.add_argument("--record", type=Path, metavar="PATH",
                        help="also write a decision record filled in from this run "
                             "(never overwrites an existing file)")
    args = parser.parse_args(argv)
    given = sys.argv[1:] if argv is None else argv
    try:
        g = evaluate(args.results, args.limits)
    except UnicodeDecodeError:
        print("Could not run the gate: save the input files as UTF-8 "
              "(in Excel: CSV UTF-8)", file=sys.stderr)
        return CANNOT_RUN
    except (InputError, OSError, csv.Error) as exc:
        print(f"Could not run the gate: {exc}", file=sys.stderr)
        return CANNOT_RUN
    except Exception:
        traceback.print_exc()
        print("Could not run the gate: unexpected error above; no verdict given", file=sys.stderr)
        return CANNOT_RUN
    if args.record:
        command = "gate.py " + " ".join(f'"{a}"' if " " in a else a for a in given)
        try:
            with args.record.open("x", encoding="utf-8", newline="\n") as out:
                out.write(decision_record(g, command, dt.date.today()))
        except FileExistsError:
            print(f"Could not run the gate: {args.record} already exists, and the gate never "
                  "overwrites a decision record", file=sys.stderr)
            return CANNOT_RUN
        except OSError as exc:
            print(f"Could not run the gate: cannot write the decision record: {exc}", file=sys.stderr)
            return CANNOT_RUN
        print(f"Decision record written to {args.record}", file=sys.stderr)
    if args.json:
        print(report(g), file=sys.stderr)
        print(json.dumps(result_json(g)))
    else:
        print(report(g))
    return g.verdict


if __name__ == "__main__":
    sys.exit(main())
