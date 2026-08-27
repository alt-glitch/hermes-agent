# Installing the OpenTUI fork (`sid/opentui`)

Two audiences:
- **A. New users / coworkers** trying the fork on a fresh-ish machine → the 3-line
  install just below. This is all most people need.
- **B. glitch's personal cutover** (repointing an existing dual install) → the
  detailed, machine-specific steps further down. Skip unless you're glitch.

---

## A. Fresh install (coworkers / anyone) — the simple path

```bash
git clone -b sid/opentui https://github.com/alt-glitch/hermes-agent.git
cd hermes-agent && ./scripts/install.sh         # auto-detects this fork's branch+repo
```
- `install.sh` (no flags) detects it's running from a `sid/opentui` checkout of the
  fork and installs **that** — no `--repo`/`--branch` needed.
- **Update later:** `hermes update` (now follows the current branch = stays on the fork).
- **Already have a stock Hermes install?** `install.sh` defaults `INSTALL_DIR` to
  `~/.hermes/hermes-agent` and will **switch that to the fork**
  (reversible: `cd ~/.hermes/hermes-agent && git checkout main && hermes update --branch main`).
  To keep both side-by-side instead: `./scripts/install.sh --dir ~/.hermes/hermes-opentui`.
- **Launch:** `hermes` (auto-selects OpenTUI on Node ≥ 26.3) or `HERMES_TUI_ENGINE=opentui hermes`.

That's the whole story for new users. Everything below (Section B) is glitch's
one-time machine-specific cutover — not needed for a fresh install.

---

# B. glitch's cutover cheat-sheet — replace the existing dual install with `sid/opentui`

Copy-paste. Reversible. Live setup is **untouched** until you run these.
Originally generated 2026-06-16 and updated 2026-07-17 for the
worktree-aware launcher. **Model: B — replace the
canonical install at `~/.hermes/hermes-agent` with the fork's `sid/opentui`.**

## Your actual topology (read this — it's interconnected)
- **Canonical install:** `~/.hermes/hermes-agent` — a **git checkout** of
  NousResearch on `main`, **venv at `~/.hermes/hermes-agent/venv`**. The **gateway
  runs from here** (`ExecStart=…/.hermes/hermes-agent/venv/bin/python …`).
- **Your `hermes` command:** `~/.local/bin/hermes` is a worktree-aware launcher.
  It uses the managed install outside a Hermes checkout and the current source
  tree inside one. (There may also be `/usr/local/bin/hermes` lower on PATH.)
- **Fork:** `/home/daimon/side-quests/hermes-agent` on `sid/opentui`
  (`origin`=alt-glitch, `upstream`=NousResearch).
- **Data/config/state:** `~/.hermes` (auth, sessions, skills, cron) — **never moves.**

**What "replace" means here:** point `~/.hermes/hermes-agent` at the fork's
`sid/opentui`, rebuild it, and keep the gateway unit on that managed checkout.
The launcher selects it outside development worktrees. After this, one managed
install, one fork branch.

> We do NOT delete `~/.hermes/hermes-agent` and re-clone — it has linked worktrees
> (`/tmp/fable-fix`) and shared git objects. We add the fork as a remote and switch
> branches in place. Cleaner + reversible.

---

## STEP 0 — Optional: pin Node 26.3 for direct engine development
`install.sh` provisions a managed Node when the host Node is too old, and the
launcher re-checks compatibility at runtime. Pinning Node 26 explicitly is still
useful for direct `ui-opentui` development:
```bash
fnm default 26.3.0 && fnm use 26.3.0 && node --version    # must be v26.3.x
# (optional, scoped instead of global default — keeps 25.9 default for other projects:)
#   export HERMES_NODE="$HOME/.local/share/fnm/node-versions/v26.3.0/installation/bin/node"
```

## STEP 1 — Back up everything (rollback insurance)
```bash
cp ~/.config/systemd/user/hermes-gateway.service \
   ~/.config/systemd/user/hermes-gateway.service.bak-$(date +%Y%m%d)
cp ~/.local/bin/hermes ~/.local/bin/hermes.bak-$(date +%Y%m%d)
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

## STEP 4 — Install the worktree-aware `hermes` launcher
Do not repoint a global symlink each time you change checkouts. Generate the
launcher through the same path as `install.sh`:
```bash
bash ~/.hermes/hermes-agent/scripts/write-hermes-launcher.sh \
  ~/.local/bin/hermes ~/.hermes/hermes-agent/venv/bin/hermes \
  /home/daimon/side-quests/hermes-agent /home/daimon/github/hermes-agent
hash -r
```
Outside an explicitly trusted Hermes checkout this runs the managed fork. Inside
the registered fork/upstream clones or any of their linked worktrees it imports
that exact tree (including its Python gateway and terminal UI source — OpenTUI in
the fork, Ink upstream) while reusing the nearest available venv. Verify with:
```bash
cd ~/.hermes/hermes-agent && hermes --version
cd /path/to/a/hermes-worktree && hermes --version
```
`~/.local/bin/hermes` is intentionally a regular script, not a symlink. If
`/usr/local/bin/hermes` shadows it, ensure `~/.local/bin` is earlier on PATH.

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
hermes update                         # follows the managed checkout's current branch
# explicit equivalent:
hermes update --branch sid/opentui
```
The update rebuilds the managed runtime. The worktree-aware launcher remains in
place and automatically selects source when you enter another Hermes checkout.
The maintainer cron keeps `fork/sid/opentui` fresh 2×/day + rebuilds `dist/`.

---

## For OTHERS installing your TUI (fresh machine, via `install.sh --repo`)
The fork's `install.sh` has a `--repo` flag (commit `a4ad46ba1` on `sid/opentui`)
so a clean install lands on the fork, not upstream:
```bash
git clone -b sid/opentui git@github.com:alt-glitch/hermes-agent.git
cd hermes-agent
./scripts/install.sh --repo alt-glitch/hermes-agent --branch sid/opentui
# updates thereafter:  hermes update --branch sid/opentui
```
`--repo` accepts a full git URL or `owner/repo` shorthand and repoints `origin`
at the fork before fetch. When run from this fork checkout, plain `install.sh`
auto-detects its repository and branch; `--repo`/`--branch` are explicit
overrides for scripted installs.

---

## ROLLBACK (back to stock main install)
```bash
cd ~/.hermes/hermes-agent && git checkout main && ~/.local/bin/uv sync
bash ~/.hermes/hermes-agent/scripts/write-hermes-launcher.sh \
  ~/.local/bin/hermes ~/.hermes/hermes-agent/venv/bin/hermes
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
3. **The quiet-quill worktree is NOT touched** — the launcher selects it only
   while your shell is inside that worktree; elsewhere it uses the managed install.
4. **Linked worktree `/tmp/fable-fix`** shares this repo's `.git`. Switching branches
   in `~/.hermes/hermes-agent` is fine (worktrees are independent checkouts), but
   don't `git checkout sid/opentui` *there* while fable-fix also wants it — it's on
   its own branch, so no conflict.
5. **Don't restart the gateway from inside a Hermes agent** (self-kill).
6. **`unset NODE_ENV`** before npm or devDeps get skipped and the build breaks.
7. **`hermes update` defaults to `main`** — always `--branch sid/opentui` (or the
   wrapper). Forgetting this would yank your install back toward upstream main.
