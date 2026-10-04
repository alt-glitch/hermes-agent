"""Aggregate v2 trace-lab runs into a picture of what Hermes actually executes.

Usage (from the v2 worktree):
  uv run --no-project python v2/lab/trace/analyze.py [TRACE_DIR ...] [--root SRC] [--out DIR]

TRACE_DIR defaults to every run under ~/.hermes/v2-traces. --root is the source tree the traces came
from (defaults to the tree that contains the traced hermes_cli/). Writes, into --out
(default ~/.hermes/v2-traces/_report):

  REPORT.md   per run: the processes, what each was launched as, how many Hermes functions it
              entered, and its startup timeline (first entry into each package, in order);
              across runs: per-package share of defined functions ever executed, and the
              modules no run has entered yet.
  data.json   the same, plus the first-call tree edges, for later visual tooling.

Coverage is only as wide as the runs you traced. "Never entered" means "not by anything you did yet".
"""

import argparse
import ast
import collections
import json
import pathlib
import warnings

HOME_TRACES = pathlib.Path.home() / ".hermes" / "v2-traces"
PACKAGES = ("agent", "tools", "hermes_cli", "gateway", "tui_gateway", "cron", "plugins", "pm",
            "acp_adapter", "providers", "hermes_platform")


def load_runs(dirs: list[pathlib.Path]) -> list[dict]:
    runs = []
    for d in dirs:
        procs = []
        for f in sorted(d.glob("*.jsonl")):
            header, events = None, []
            for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a process killed mid-write leaves a torn last line
                if rec.get("kind") == "process":
                    header = rec
                else:
                    events.append(rec)
            if header or events:
                procs.append({"file": f.name, "header": header or {}, "events": events})
        if procs:
            runs.append({"name": d.name, "procs": procs})
    return runs


def guess_root(runs: list[dict]) -> pathlib.Path | None:
    for run in runs:
        for p in run["procs"]:
            for e in p["events"]:
                parts = pathlib.Path(e["file"]).parts
                if "hermes_cli" in parts:
                    return pathlib.Path(*parts[: parts.index("hermes_cli")])
    return None


def rel(path: str, root: pathlib.Path | None) -> str:
    if root is not None:
        try:
            return str(pathlib.Path(path).relative_to(root))
        except ValueError:
            pass
    return path


def area(relpath: str) -> str:
    return relpath.split("/", 1)[0] if "/" in relpath else "(root)"


def inventory(root: pathlib.Path) -> dict[str, set[tuple[str, int]]]:
    """Every function/method defined in the product tree, keyed by relative module path."""
    warnings.filterwarnings("ignore", category=SyntaxWarning)  # invalid escapes are counted by v2/idioms (PY-27)
    inv: dict[str, set[tuple[str, int]]] = {}
    files = list(root.glob("*.py"))
    for pkg in PACKAGES:
        files += [f for f in (root / pkg).rglob("*.py") if "/tests/" not in str(f)]
    for f in files:
        try:
            tree = ast.parse(f.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        defs = {(n.name, n.lineno) for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        inv[str(f.relative_to(root))] = defs
    return inv


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="*", type=pathlib.Path)
    ap.add_argument("--root", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=HOME_TRACES / "_report")
    a = ap.parse_args()
    dirs = a.dirs or sorted(p for p in HOME_TRACES.glob("*") if p.is_dir() and not p.name.startswith("_"))
    runs = load_runs(dirs)
    if not runs:
        raise SystemExit(f"no traces under {dirs or HOME_TRACES}")
    root = a.root or guess_root(runs)
    inv = inventory(root) if root else {}

    executed: dict[str, set[int]] = collections.defaultdict(set)  # relpath -> first lines entered
    entered_modules: set[str] = set()
    edges: collections.Counter = collections.Counter()
    md = ["# v2 trace lab report", "", f"Source root: `{root}`. Runs: {len(runs)}.", ""]
    for run in runs:
        md += [f"## {run['name']}", ""]
        for p in run["procs"]:
            h = p["header"]
            argv = " ".join(h.get("argv") or [])[:160]
            md.append(f"### pid {h.get('pid')} (parent {h.get('ppid')}): `{argv}`")
            md.append(f"python {h.get('python')} · {h.get('mode')} · {len(p['events'])} Hermes functions entered")
            first_by_area: dict[str, tuple[float, str]] = {}
            for e in p["events"]:
                r = rel(e["file"], root)
                executed[r].add(e["line"])
                entered_modules.add(r)
                if e.get("c"):
                    edges[(e["c"], e["f"])] += 1
                ar = area(r)
                if ar not in first_by_area:
                    first_by_area[ar] = (e["t"], e["f"])
            md.append("")
            md.append("| t (s) | package first entered via |")
            md.append("|---:|---|")
            for ar, (t, f) in sorted(first_by_area.items(), key=lambda kv: kv[1][0]):
                md.append(f"| {t:.3f} | `{ar}` ← `{f}` |")
            md.append("")

    md += ["## Coverage across all runs", "", "| package | modules entered / defined | functions entered / defined |",
           "|---|---:|---:|"]
    by_area = collections.defaultdict(lambda: [0, 0, 0, 0])
    never: list[str] = []
    for relpath, defs in inv.items():
        ar = area(relpath)
        lines = {ln for _, ln in defs}
        hit = executed.get(relpath, set())
        by_area[ar][1] += 1
        by_area[ar][3] += len(lines)
        if relpath in entered_modules:
            by_area[ar][0] += 1
            by_area[ar][2] += len(lines & hit)
        else:
            never.append(relpath)
    for ar, (me, md_, fe, fd) in sorted(by_area.items(), key=lambda kv: -kv[1][3]):
        md.append(f"| {ar} | {me} / {md_} | {fe} / {fd} ({(fe / fd * 100 if fd else 0):.0f}%) |")
    md += ["", f"## Modules no traced run has entered ({len(never)})", "",
           "Grouped by package. Not proof of dead code: only of what the traced runs did.", ""]
    never_by_area: dict[str, list[str]] = collections.defaultdict(list)
    for m in sorted(never):
        never_by_area[area(m)].append(m)
    for ar, mods in sorted(never_by_area.items()):
        md.append(f"- **{ar}** ({len(mods)}): " + ", ".join(f"`{m}`" for m in mods[:40]) + (" …" if len(mods) > 40 else ""))

    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "REPORT.md").write_text("\n".join(md) + "\n")
    (a.out / "data.json").write_text(json.dumps({
        "root": str(root), "runs": [{"name": r["name"], "procs": [p["header"] for p in r["procs"]]} for r in runs],
        "executed": {k: sorted(v) for k, v in executed.items()},
        "never_entered": sorted(never),
        "edges": [[c, f, n] for (c, f), n in edges.most_common()],
    }))
    print(f"wrote {a.out / 'REPORT.md'} and data.json ({len(runs)} runs, {len(executed)} modules entered, {len(never)} never)")


if __name__ == "__main__":
    main()
