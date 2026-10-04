"""Mechanical idiom sweep for the v2 branch (stdlib only).

Counts violations of the mechanically detectable idioms in v2/PRINCIPLES.md across the
product tree (the same scope as the code-health audit) and writes:

  v2/idioms/summary.json      counts + top files per idiom (committed)
  v2/idioms/SUMMARY.md        the same as a table (committed)
  v2/idioms/hits/PY-NN.txt    every hit as path:line (gitignored; re-run to regenerate)

Run from the repo root:  uv run --no-project python v2/idioms/sweep.py
Ruff-backed idioms are merged in when v2/idioms/ruff.json exists (see v2/idioms/ruff.sh).
Judgment idioms (marked "judgment" in PRINCIPLES.md) are not counted here; they need readers.
"""

import ast
import collections
import json
import pathlib
import re
import sys
import warnings

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "v2" / "idioms"
PACKAGES = ("agent", "tools", "hermes_cli", "gateway", "tui_gateway", "cron", "plugins", "pm",
            "acp_adapter", "providers", "hermes_platform")
OFF_PATH_ROOT = {"batch_runner.py", "mini_swe_runner.py", "trajectory_compressor.py", "toolset_distributions.py"}
MODE_ATTRS = {"api_mode", "mode", "provider", "kind", "platform", "transport", "backend"}
SUBPROCESS_FNS = {"run", "check_output", "check_call", "call"}


def product_files() -> list[pathlib.Path]:
    files = [p for p in ROOT.glob("*.py") if p.name not in OFF_PATH_ROOT]
    for pkg in PACKAGES:
        files += [p for p in (ROOT / pkg).rglob("*.py") if "/tests/" not in str(p) and "/test_" not in str(p)]
    return sorted(files)


def dotted(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:  # noqa: BLE001 -- unparse of odd nodes; a name is only used for matching
        return ""


class Sweep(ast.NodeVisitor):
    def __init__(self, rel: str, hits: dict[str, list[str]]):
        self.rel, self.hits, self.fn_depth = rel, hits, 0

    def hit(self, idiom: str, node: ast.AST) -> None:
        self.hits[idiom].append(f"{self.rel}:{getattr(node, 'lineno', 0)}")

    def _in_function(self, node: ast.AST) -> None:
        self.fn_depth += 1
        self.generic_visit(node)
        self.fn_depth -= 1

    def visit_FunctionDef(self, node):  # noqa: N802
        self._in_function(node)

    def visit_AsyncFunctionDef(self, node):  # noqa: N802
        self._in_function(node)

    def visit_ImportFrom(self, node):  # noqa: N802
        if node.module == "__future__" and any(a.name == "annotations" for a in node.names):
            self.hit("PY-02", node)
        if self.fn_depth:
            self.hit("PY-07", node)

    def visit_Import(self, node):  # noqa: N802
        if self.fn_depth:
            self.hit("PY-07", node)

    def visit_Global(self, node):  # noqa: N802
        self.hit("PY-13", node)

    def visit_Assign(self, node):  # noqa: N802
        for t in node.targets:
            d = dotted(t)
            if d == "sys.path":
                self.hit("PY-08", node)
            if d.startswith("os.environ["):
                self.hit("PY-16w", node)
        self.generic_visit(node)

    def visit_Call(self, node):  # noqa: N802
        f = dotted(node.func)
        kw = {k.arg for k in node.keywords}
        if f in ("sys.path.insert", "sys.path.append", "sys.path.extend"):
            self.hit("PY-08", node)
        if f in ("threading.Thread", "Thread"):
            self.hit("PY-14", node)
            if any(k.arg == "daemon" and isinstance(k.value, ast.Constant) and k.value.value is True for k in node.keywords):
                self.hit("PY-14d", node)
        if f == "os._exit":
            self.hit("PY-15", node)
        if f in ("os.environ.get", "os.getenv"):
            self.hit("PY-16", node)
        if f in ("os.environ.setdefault", "os.environ.update", "os.environ.pop", "os.putenv"):
            self.hit("PY-16w", node)
        if f.startswith("subprocess.") and f.split(".", 1)[1] in SUBPROCESS_FNS and "timeout" not in kw:
            self.hit("PY-21", node)
        if f in ("requests.get", "requests.post", "httpx.get", "httpx.post", "httpx.Client", "httpx.AsyncClient",
                 "requests.Session", "aiohttp.ClientSession", "urllib.request.urlopen"):
            self.hit("PY-21c", node)
        self.generic_visit(node)

    def visit_Subscript(self, node):  # noqa: N802
        if isinstance(node.ctx, ast.Load) and dotted(node.value) == "os.environ":
            self.hit("PY-16", node)
        self.generic_visit(node)

    def visit_ExceptHandler(self, node):  # noqa: N802
        t = dotted(node.type) if node.type else ""
        if not node.type or t in ("Exception", "BaseException") or "Exception," in t or ", Exception" in t:
            self.hit("PY-17", node)
            body = [s for s in node.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
            if all(isinstance(s, (ast.Pass, ast.Continue)) for s in body):
                self.hit("PY-17s", node)
        self.generic_visit(node)

    def visit_Compare(self, node):  # noqa: N802
        if any(isinstance(op, (ast.In, ast.NotIn)) for op in node.ops):
            for c in node.comparators:
                if isinstance(c, ast.Call) and dotted(c.func) == "str" and isinstance(node.left, ast.Constant):
                    self.hit("PY-18", node)
        if any(isinstance(op, (ast.Eq, ast.NotEq)) for op in node.ops):
            left = node.left
            if isinstance(left, ast.Attribute) and left.attr in MODE_ATTRS and all(
                    isinstance(c, ast.Constant) and isinstance(c.value, str) for c in node.comparators):
                self.hit("PY-04", node)
        self.generic_visit(node)

    def visit_For(self, node):  # noqa: N802
        tgt = dotted(node.target).lower()
        if dotted(node.iter).startswith("range(") and re.search(r"attempt|retr|tries", tgt):
            self.hit("PY-20", node)
        self.generic_visit(node)

    def visit_ClassDef(self, node):  # noqa: N802
        if node.name.endswith("Mixin"):
            self.hit("PY-23", node)
        if len(node.bases) >= 5:
            self.hit("PY-23b", node)
        self.generic_visit(node)

    def visit_AnnAssign(self, node):  # noqa: N802
        self._ann(node.annotation)
        self.generic_visit(node)

    def visit_arg(self, node):  # noqa: N802
        if node.annotation is not None:
            self._ann(node.annotation)

    def _ann(self, ann):
        s = dotted(ann).replace(" ", "")
        if "dict[str,Any]" in s or "Dict[str,Any]" in s:
            self.hit("PY-05", ann)


TEXT_PATTERNS = {"PY-26": re.compile(r"(monkeypatch|tests? (can )?patch|so tests|for tests to patch)", re.I)}


def main() -> None:
    hits: dict[str, list[str]] = collections.defaultdict(list)
    sizes = {}
    for p in product_files():
        rel = str(p.relative_to(ROOT))
        text = p.read_text(encoding="utf-8", errors="replace")
        lines = text.count("\n") + 1
        sizes[rel] = lines
        if lines > 1000:
            hits["PY-11"].append(f"{rel}:1 ({lines} lines)")
        if "/" not in rel:
            hits["PY-06"].append(f"{rel}:1")
        for i, line in enumerate(text.splitlines(), 1):
            for idiom, rx in TEXT_PATTERNS.items():
                if line.lstrip().startswith("#") and rx.search(line):
                    hits[idiom].append(f"{rel}:{i}")
        try:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                tree = ast.parse(text, filename=rel)
            for w in caught:
                hits["PY-27"].append(f"{rel}:{getattr(w, 'lineno', 0)} {w.category.__name__}: {w.message}")
        except SyntaxError as exc:
            print(f"skip {rel}: {exc}", file=sys.stderr)
            continue
        Sweep(rel, hits).visit(tree)

    ruff = OUT / "ruff.json"
    ruff_map = {"PY-03": ("UP006", "UP007", "UP035", "UP045"), "PY-17": ("E722",), "PY-19": ("G004", "T201"),
                "PY-22": ("PTH",), "PY-11c": ("C901",)}
    if ruff.exists():
        for d in json.loads(ruff.read_text()):
            code = d.get("code") or ""
            rel = str(pathlib.Path(d["filename"]).resolve().relative_to(ROOT))
            for idiom, codes in ruff_map.items():
                if any(code == c or (c == "PTH" and code.startswith("PTH")) for c in codes):
                    if idiom == "PY-17":
                        continue  # already counted by the AST pass (bare except is part of PY-17)
                    hits[idiom].append(f"{rel}:{d['location']['row']} {code}")

    (OUT / "hits").mkdir(parents=True, exist_ok=True)
    summary = {}
    for idiom in sorted(hits):
        rows = hits[idiom]
        (OUT / "hits" / f"{idiom}.txt").write_text("\n".join(rows) + "\n")
        per_file = collections.Counter(r.split(":", 1)[0] for r in rows)
        per_area = collections.Counter(r.split("/", 1)[0] if "/" in r.split(":", 1)[0] else "(root)" for r in rows)
        summary[idiom] = {"count": len(rows), "files": len(per_file), "top_files": per_file.most_common(12),
                          "by_area": dict(per_area.most_common())}
    meta = {"root": str(ROOT), "files_scanned": len(sizes), "lines_scanned": sum(sizes.values())}
    (OUT / "summary.json").write_text(json.dumps({"meta": meta, "idioms": summary}, indent=1))
    md = ["# Idiom sweep (mechanical)", "", f"{meta['files_scanned']} product files, {meta['lines_scanned']:,} lines. "
          "Generated by `v2/idioms/sweep.py`; per-hit lists in `v2/idioms/hits/` (gitignored).", "",
          "| idiom | hits | files | top areas |", "|---|---:|---:|---|"]
    for idiom, s in summary.items():
        areas = ", ".join(f"{a} {n}" for a, n in list(s["by_area"].items())[:4])
        md.append(f"| {idiom} | {s['count']:,} | {s['files']:,} | {areas} |")
    (OUT / "SUMMARY.md").write_text("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
