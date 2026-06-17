# Cutover cheat-sheet — install `sid/opentui` as your real `hermes` (replaces the canonical install)

Copy-paste. Reversible. Live setup is **untouched** until you run these.
Generated 2026-06-16 with your actual machine state. **Model: B — replace the
canonical install at `~/.hermes/hermes-agent` with the fork's `sid/opentui`.**

## Your actual topology (read this — it's interconnected)
- **Canonical install:** `~/.hermes/hermes-agent` — a **git checkout** of
  NousResearch on `main`, **venv at `~/.hermes/hermes-agent/venv`**. The **gateway
  runs from here** (`ExecStart=…/.hermes/hermes-agent/venv/bin/python …`).
- **Your `hermes` command:** `~/.local/bin/hermes` → symlinks into the **quiet-quill
  worktree** (`/home/daimon/github/worktrees/.../quiet-quill/hermes-agent/.venv`) —
  a SEPARATE clone (NousResearch). (There's also a `/usr/local/bin/hermes` lower on PATH.)
- **Fork:** `/home/daimon/side-quests/hermes-agent` on `sid/opentui`
  (`origin`=alt-glitch, `upstream`=NousResearch).
- **Data/config/state:** `~/.hermes` (auth, sessions, skills, cron) — **never moves.**

**What "replace" means here:** point `~/.hermes/hermes-agent` at the fork's
`sid/opentui`, rebuild it, and repoint BOTH the gateway unit and your `hermes`
command at it. After this, one install, one branch, the fork.

> We do NOT delete `~/.hermes/hermes-agent` and re-clone — it has linked worktrees
> (`/tmp/fable-fix`) and shared git objects. We add the fork as a remote and switch
> branches in place. Cleaner + reversible.

---

## STEP 0 — Node 26.3 must be the default (do FIRST; silent-Ink trap otherwise)
`install.sh` does NOT install Node; it only *finds* one ≥26.3. The launcher
re-checks at runtime. Your fnm default is **v25.9.0** → too old → OpenTUI silently
falls back to Ink at both install and run. Fix:
```bash
fnm default 26.3.0 && fnm use 26.3.0 && node --version    # must be v26.3.x
# (optional, scoped instead of global default — keeps 25.9 default for other projects:)
#   export HERMES_NODE="$HOME/.local/share/fnm/node-versions/v26.3.0/installation/bin/node"
```

## STEP 1 — Back up everything (rollback insurance)
```bash
cp ~/.config/systemd/user/hermes-gateway.service \
   ~/.config/systemd/user/hermes-gateway.service.bak-$(date +%Y%m%d)
readlink ~/.local/bin/hermes > ~/.local/bin/hermes.symlink.bak-$(date +%Y%m%d)
cd ~/.hermes/hermes-agent && git branch backup/pre-opentui-$(date +%Y%m%d)   # tag current main state
git stash list; git status --short | head    # note any uncommitted state here
```

## STEP 2 — Point the canonical install at the fork's `sid/opentui`
```bash
cd ~/.hermes/hermes-agent
git remote add fork git@github.com:alt-glitch/hermes-agent.git 2>/dev/null || \
  git remote set-url fork git@github.com:alt-glitch/hermes-agent.git
git fetch fork sid/opentui
git checkout -B sid/opentui fork/sid/opentui     # switch this install to the fork branch
git branch --set-upstream-to=fork/sid/opentui sid/opentui
git log --oneline -1                              # should show the copy-button tip
```

## STEP 3 — Rebuild the install (Python deps + TUI bundle)
```bash
cd ~/.hermes/hermes-agent
~/.local/bin/uv sync --extra dev --extra messaging       # refresh venv for the new tree
export PATH="$HOME/.local/share/fnm/node-versions/v26.3.0/installation/bin:$PATH"
unset NODE_ENV
(cd ui-opentui && npm install --no-audit --no-fund && node scripts/build.mjs)   # dist/main.js
ls -la ui-opentui/dist/main.js                            # confirm built
```

## STEP 4 — Repoint your `hermes` command at the canonical install
Your command currently points at the quiet-quill worktree; move it to the
(now-fork) canonical install so CLI + gateway agree:
```bash
ln -sf ~/.hermes/hermes-agent/venv/bin/hermes ~/.local/bin/hermes
hash -r; hermes --version && readlink -f ~/.local/bin/hermes   # → ~/.hermes/hermes-agent/venv/...
```
(If `/usr/local/bin/hermes` shadows it on PATH, either remove that or ensure
`~/.local/bin` is earlier in PATH.)

## STEP 5 — Restart the gateway (already points at ~/.hermes/hermes-agent/venv — no unit edit needed!)
The gateway `ExecStart` already uses `~/.hermes/hermes-agent/venv/bin/python`, and
that venv now belongs to the fork. So just restart:
```bash
systemctl --user daemon-reload
systemctl --user restart hermes-gateway.service     # FROM A SHELL, never inside an agent
systemctl --user status hermes-gateway.service --no-pager | head -5
```
(If the gateway can't find Node 26.3 at runtime, add under `[Service]`:
`Environment=HERMES_NODE=/home/daimon/.local/share/fnm/node-versions/v26.3.0/installation/bin/node`,
then daemon-reload + restart.)

## STEP 6 — Launch
```bash
node --version            # v26.3.x
hermes                    # auto-selects OpenTUI; or force: HERMES_TUI_ENGINE=opentui hermes
```

## STEP 7 — Updating later
```bash
cd ~/.hermes/hermes-agent && git pull fork sid/opentui && \
  ~/.local/bin/uv sync && (cd ui-opentui && node scripts/build.mjs)
# OR via the CLI (defaults to main — must pass the branch):
hermes update --branch sid/opentui
# zsh wrapper so bare `hermes update` follows the fork:
#   hermes() { if [ "$1" = update ]; then shift; command hermes update --branch sid/opentui "$@"; else command hermes "$@"; fi; }
```
The maintainer cron keeps `fork/sid/opentui` fresh 2×/day + rebuilds `dist/`.

---

## For OTHERS installing your TUI (fresh machine, via `install.sh --repo`)
The fork's `install.sh` has a `--repo` flag (commit `a4ad46ba1` on `sid/opentui`)
so a clean install lands on the fork, not upstream:
```bash
fnm install 26.3.0 && fnm default 26.3.0    # Node 26.3 (or OpenTUI → Ink fallback)
git clone -b sid/opentui git@github.com:alt-glitch/hermes-agent.git
cd hermes-agent
./scripts/install.sh --repo alt-glitch/hermes-agent --branch sid/opentui
# updates thereafter:  hermes update --branch sid/opentui
```
`--repo` accepts a full git URL or `owner/repo` shorthand and repoints `origin`
at the fork before fetch. Plain `install.sh` (no `--repo`) still installs upstream
main — the default is unchanged.

---

## ROLLBACK (back to stock main install)
```bash
cd ~/.hermes/hermes-agent && git checkout main && ~/.local/bin/uv sync
ln -sf /home/daimon/github/worktrees/hermes-agent/quiet-quill/hermes-agent/.venv/bin/hermes ~/.local/bin/hermes
cp ~/.config/systemd/user/hermes-gateway.service.bak-* ~/.config/systemd/user/hermes-gateway.service
systemctl --user daemon-reload && systemctl --user restart hermes-gateway.service
fnm default 25.9.0    # only if you want the old node default back
```

---

## ⚠️ Things to account for (you asked)
1. **It DOES replace your running install** — `~/.hermes/hermes-agent` flips from
   NousResearch/`main` to the fork/`sid/opentui`, and your `hermes` command + gateway
   both end up on the fork. That's the intent of model B.
2. **`~/.hermes` data is untouched** — auth, sessions, skills, cron all survive (only
   the *code* checkout's branch + venv change).
3. **The quiet-quill worktree is NOT touched** — your old CLI source still exists
   there; rollback STEP just re-points the symlink back to it.
4. **Linked worktree `/tmp/fable-fix`** shares this repo's `.git`. Switching branches
   in `~/.hermes/hermes-agent` is fine (worktrees are independent checkouts), but
   don't `git checkout sid/opentui` *there* while fable-fix also wants it — it's on
   its own branch, so no conflict.
5. **Don't restart the gateway from inside a Hermes agent** (self-kill).
6. **`unset NODE_ENV`** before npm or devDeps get skipped and the build breaks.
7. **`hermes update` defaults to `main`** — always `--branch sid/opentui` (or the
   wrapper). Forgetting this would yank your install back toward upstream main.
