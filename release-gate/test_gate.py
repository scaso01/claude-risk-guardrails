"""Tests for gate.py. Run: python -m unittest discover -s release-gate"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import gate  # noqa: E402

HEADER = "case_id,segment,kind,outcome,severity,tested_on,note\n"


def limits_doc(**overrides) -> dict:
    doc = {
        "feature": "test feature", "version": "1", "set_on": "2026-01-01", "confidence": 0.95,
        "segments": {"a": {"max_failure_rate": 0.05}},
        "max_failures_by_severity": {"critical": 0, "high": 0},
    }
    doc.update(overrides)
    return doc


def rows(segment: str, passes: int, fails: int = 0, severity: str = "medium",
         kind: str = "representative", start: int = 0, day: str = "2026-01-05") -> str:
    out = []
    for i in range(passes):
        out.append(f"{segment}-{start + i},{segment},{kind},pass,,{day},")
    for i in range(fails):
        out.append(f"{segment}-f{start + i},{segment},{kind},fail,{severity},{day},")
    return "".join(line + "\n" for line in out)


class GateCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_gate(self, csv_body: str, limits: dict, *extra: str) -> tuple[int, str, str]:
        results = self.dir / "results.csv"
        results.write_text(HEADER + csv_body, encoding="utf-8")
        lim = self.dir / "limits.json"
        lim.write_text(json.dumps(limits), encoding="utf-8")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gate.main([str(results), str(lim), *extra])
        return code, out.getvalue(), err.getvalue()


class Bounds(unittest.TestCase):
    def test_zero_failures_matches_closed_form(self) -> None:
        for n in (1, 30, 100, 1000):
            self.assertAlmostEqual(gate.upper_bound(0, n, 0.95), 1 - 0.05 ** (1 / n), places=12)

    def test_upper_bound_leaves_alpha_in_lower_tail(self) -> None:
        for k, n in ((1, 10), (4, 300), (9, 200), (50, 100)):
            p = gate.upper_bound(k, n, 0.95)
            self.assertAlmostEqual(gate.binomial_cdf(k, n, p), 0.05, places=9)

    def test_lower_bound_leaves_alpha_in_upper_tail(self) -> None:
        for k, n in ((1, 10), (4, 300), (10, 40), (99, 100)):
            p = gate.lower_bound(k, n, 0.95)
            self.assertAlmostEqual(1 - gate.binomial_cdf(k - 1, n, p), 0.05, places=9)

    def test_edges(self) -> None:
        self.assertEqual(gate.upper_bound(5, 5, 0.95), 1.0)
        self.assertEqual(gate.upper_bound(0, 0, 0.95), 1.0)
        self.assertEqual(gate.lower_bound(0, 50, 0.95), 0.0)

    def test_clean_cases_needed_is_the_smallest_sufficient_n(self) -> None:
        for limit in (0.1, 0.05, 0.01):
            n = gate.clean_cases_needed(limit, 0.95)
            self.assertLessEqual(gate.upper_bound(0, n, 0.95), limit)
            self.assertGreater(gate.upper_bound(0, n - 1, 0.95), limit)


class Verdicts(GateCase):
    def test_pass(self) -> None:
        code, out, _ = self.run_gate(rows("a", 120), limits_doc())
        self.assertEqual(code, gate.PASS)
        self.assertIn("Verdict: PASS", out)

    def test_too_few_cases_is_not_enough_evidence(self) -> None:
        code, out, _ = self.run_gate(rows("a", 40), limits_doc())
        self.assertEqual(code, gate.NOT_ENOUGH)
        self.assertIn("needs 59 cases; has 40", out)

    def test_cases_needed_accounts_for_failures_already_seen(self) -> None:
        code, out, _ = self.run_gate(rows("a", 38, 2), limits_doc())
        self.assertEqual(code, gate.NOT_ENOUGH)
        n = gate.cases_needed(2, 0.05, 0.95)
        self.assertLessEqual(gate.upper_bound(2, n, 0.95), 0.05)
        self.assertGreater(gate.upper_bound(2, n - 1, 0.95), 0.05)
        self.assertIn(f"needs {n} cases if no more fail; has 40", out)

    def test_min_cases_floor(self) -> None:
        lim = limits_doc(segments={"a": {"max_failure_rate": 0.05, "min_cases": 200}})
        code, out, _ = self.run_gate(rows("a", 120), lim)
        self.assertEqual(code, gate.NOT_ENOUGH)
        self.assertIn("needs 200 cases; has 120", out)

    def test_enough_cases_but_too_many_failures_fails(self) -> None:
        code, _, _ = self.run_gate(rows("a", 191, 9), limits_doc())
        self.assertEqual(code, gate.FAIL)

    def test_clear_failure_in_small_group_fails(self) -> None:
        code, _, _ = self.run_gate(rows("a", 30, 10), limits_doc())
        self.assertEqual(code, gate.FAIL)

    def test_segment_with_limit_but_no_cases(self) -> None:
        lim = limits_doc(segments={"a": {"max_failure_rate": 0.05}, "b": {"max_failure_rate": 0.05}})
        code, out, _ = self.run_gate(rows("a", 120), lim)
        self.assertEqual(code, gate.NOT_ENOUGH)
        self.assertIn("has 0", out)

    def test_adverse_cases_do_not_count_toward_rates(self) -> None:
        body = rows("a", 120) + rows("a", 0, 30, severity="low", kind="adverse", start=500)
        code, out, _ = self.run_gate(body, limits_doc())
        self.assertEqual(code, gate.PASS)
        self.assertIn("30 adverse, 30 of them failed", out)

    def test_any_critical_failure_fails(self) -> None:
        body = rows("a", 500) + rows("a", 0, 1, severity="critical", kind="adverse", start=900)
        code, out, _ = self.run_gate(body, limits_doc())
        self.assertEqual(code, gate.FAIL)
        self.assertIn("a-f900", out)

    def test_critical_cap_defaults_to_zero(self) -> None:
        lim = limits_doc()
        del lim["max_failures_by_severity"]
        code, _, _ = self.run_gate(rows("a", 500, 1, severity="critical"), lim)
        self.assertEqual(code, gate.FAIL)

    def test_medium_has_no_cap_unless_set(self) -> None:
        body = rows("a", 500) + rows("a", 0, 40, severity="medium", kind="adverse", start=900)
        code, out, _ = self.run_gate(body, limits_doc())
        self.assertEqual(code, gate.PASS)
        self.assertIn("(no limit)", out)

    def test_limits_dated_after_testing_fail(self) -> None:
        code, out, _ = self.run_gate(rows("a", 120), limits_doc(set_on="2026-01-06"))
        self.assertEqual(code, gate.FAIL)
        self.assertIn("after testing began", out)

    def test_same_day_passes_with_a_note(self) -> None:
        code, out, _ = self.run_gate(rows("a", 120), limits_doc(set_on="2026-01-05"))
        self.assertEqual(code, gate.PASS)
        self.assertIn("cannot show which came first", out)

    def test_example_files(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = gate.main([str(HERE / "example" / "results.csv"), str(HERE / "example" / "limits.json")])
        self.assertEqual(code, gate.FAIL)
        report = out.getvalue()
        self.assertRegex(report, r"email-en .* PASS")
        self.assertRegex(report, r"chat-en .* FAIL")
        self.assertRegex(report, r"email-es .* NOT ENOUGH EVIDENCE")


class BadInput(GateCase):
    def assert_cannot_run(self, body: str, limits: dict | None = None, message: str = "") -> None:
        code, out, err = self.run_gate(body, limits or limits_doc())
        self.assertEqual(code, gate.CANNOT_RUN)
        self.assertEqual(out, "")
        self.assertIn(message, err)

    def test_segment_without_limit(self) -> None:
        self.assert_cannot_run(rows("a", 120) + rows("zz", 5, start=900), message="no limit set")

    def test_duplicate_case_id(self) -> None:
        self.assert_cannot_run(rows("a", 2) + rows("a", 1), message="appears twice")

    def test_empty_file(self) -> None:
        self.assert_cannot_run("", message="no test cases")

    def test_failure_without_severity(self) -> None:
        self.assert_cannot_run("x1,a,representative,fail,,2026-01-05,\n", message="needs severity")

    def test_pass_with_severity(self) -> None:
        self.assert_cannot_run("x1,a,representative,pass,low,2026-01-05,\n", message="has no severity")

    def test_bad_kind(self) -> None:
        self.assert_cannot_run("x1,a,demo,pass,,2026-01-05,\n", message="kind must be")

    def test_bad_date(self) -> None:
        self.assert_cannot_run("x1,a,representative,pass,,05/01/2026,\n", message="YYYY-MM-DD")

    def test_bad_rate(self) -> None:
        self.assert_cannot_run(rows("a", 5), limits_doc(segments={"a": {"max_failure_rate": 5}}),
                               message="max_failure_rate")

    def test_severity_caps_not_an_object(self) -> None:
        self.assert_cannot_run(rows("a", 5), limits_doc(max_failures_by_severity=[]),
                               message="must be an object")

    def test_non_utf8_file_from_excel(self) -> None:
        results = self.dir / "results.csv"
        results.write_bytes((HEADER + "x1,a,representative,fail,low,2026-01-05,café menu\n")
                            .encode("cp1252"))
        lim = self.dir / "limits.json"
        lim.write_text(json.dumps(limits_doc()), encoding="utf-8")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = gate.main([str(results), str(lim)])
        self.assertEqual(code, gate.CANNOT_RUN)
        self.assertIn("UTF-8", err.getvalue())

    def test_unexpected_error_is_never_a_verdict(self) -> None:
        original = gate.evaluate
        gate.evaluate = lambda *a: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = gate.main(["x.csv", "y.json"])
        finally:
            gate.evaluate = original
        self.assertEqual(code, gate.CANNOT_RUN)
        self.assertIn("no verdict given", err.getvalue())

    def test_missing_column(self) -> None:
        results = self.dir / "results.csv"
        results.write_text("case_id,segment\nx1,a\n", encoding="utf-8")
        lim = self.dir / "limits.json"
        lim.write_text(json.dumps(limits_doc()), encoding="utf-8")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = gate.main([str(results), str(lim)])
        self.assertEqual(code, gate.CANNOT_RUN)
        self.assertIn("missing columns", err.getvalue())


class Record(GateCase):
    def test_record_holds_the_run_facts(self) -> None:
        body = (rows("a", 191, 9)
                + "x1,a,adverse,fail,high,2026-01-05,hidden text | lowered priority\n")
        record = self.dir / "record.md"
        code, out, err = self.run_gate(body, limits_doc(), "--record", str(record))
        self.assertEqual(code, gate.FAIL)
        self.assertIn("Verdict: FAIL", out)
        self.assertIn("Decision record written", err)
        text = record.read_text(encoding="utf-8")
        self.assertIn(gate.sha256(self.dir / "results.csv"), text)
        self.assertIn(gate.sha256(self.dir / "limits.json"), text)
        self.assertIn("**FAIL** (exit 2)", text)
        self.assertIn("| a | 200 | 9 | 4.50% |", text)
        self.assertIn("| F1 | a-f0, a-f1", text)
        self.assertIn("| F2 | x1 | high | hidden text \\| lowered priority |", text)
        self.assertIn("Approve is not open on this run", text)
        self.assertIn("| Failure rate, a | above 5.00% | | |", text)

    def test_record_on_a_pass(self) -> None:
        record = self.dir / "record.md"
        code, _, _ = self.run_gate(rows("a", 120), limits_doc(), "--record", str(record))
        self.assertEqual(code, gate.PASS)
        text = record.read_text(encoding="utf-8")
        self.assertIn("The gate passed. Approve only if every finding above is closed.", text)
        self.assertIn("The gate found no broken rule.", text)
        self.assertNotIn("| F1 |", text)

    def test_record_is_never_overwritten(self) -> None:
        record = self.dir / "record.md"
        record.write_text("signed by the approver", encoding="utf-8")
        code, out, err = self.run_gate(rows("a", 120), limits_doc(), "--record", str(record))
        self.assertEqual(code, gate.CANNOT_RUN)
        self.assertEqual(out, "")
        self.assertIn("never overwrites", err)
        self.assertEqual(record.read_text(encoding="utf-8"), "signed by the approver")

    def test_example_record_matches_example_inputs(self) -> None:
        text = (HERE / "example" / "decision-record.md").read_text(encoding="utf-8")
        for name in ("results.csv", "limits.json"):
            self.assertIn(gate.sha256(HERE / "example" / name), text)


class JsonOutput(GateCase):
    def test_stdout_is_one_json_result(self) -> None:
        code, out, err = self.run_gate(rows("a", 120, 1), limits_doc(), "--json")
        doc = json.loads(out)
        self.assertEqual(doc["schema"], "release-gate/result/v1")
        names = {(m["name"], m.get("segment")) for m in doc["metrics"]}
        self.assertIn(("failure_rate_upper", "a"), names)
        self.assertIn("Verdict:", err)
        verdict = [m["value"] for m in doc["metrics"] if m["name"] == "gate_verdict"]
        self.assertEqual(verdict, [code])


if __name__ == "__main__":
    unittest.main()
