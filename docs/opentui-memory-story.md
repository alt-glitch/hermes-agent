# How the OpenTUI transcript got from 686MB to ~300MB — the full story

*For: glitch. Branch: `feat/opentui-memory-window`. Everything here is measured,
not vibes; every number has a result JSON in the **tui-bench** repo's `results/`
(`github.com/NousResearch/tui-bench`). The 686→300MB campaign predates the
current `@opentui/core@0.4.1` native-Yoga runtime. WASM-ratchet explanations
below are retained as historical root-cause context, not as a claim about the
currently pinned 0.4.1 allocator.*

---

## 1. The cast of characters (the primitives, bottom-up)

To understand where the memory went, you need to know who's holding it. Six
layers, from the screen up:

**The terminal grid.** Your terminal is a spreadsheet of character cells.
Nobody pays per-message here — tmux holds ~5MB flat no matter how long the
session is (we measured). The terminal is never the problem.

**The OpenTUI native renderer (Zig).** A compiled library that owns the
"frame buffer" — the grid of cells about to be painted. Every piece of text the
TUI shows lives in a native **TextBuffer** (the characters + their colors),
viewed through a **TextBufferView**, styled by a **SyntaxStyle**. Each of those
is a **native handle** — a ticket into one global table that has only **65,535
slots, total, ever** (16-bit indices — like a coat check with 65k hooks).
Destroying a renderable returns its tickets, so the constraint is not "how much
have you ever created" but **"how much is alive right now."**

**Renderables.** OpenTUI's UI objects — `<text>`, `<box>`, `<markdown>`,
`<code>`, `<scrollbox>`. One transcript row (a message with its tool calls,
markdown, code blocks, copy chips) is a *tree* of these: **~16 text renderables
≈ 47 native handles ≈ ~250–340KB of RSS, per row.** This is the number that
drives everything. 1,400 mounted rows × 47 handles = table full = the crash we
root-caused last week.

**Yoga (the layout engine).** Every renderable also has a Yoga node — the
flexbox calculator that decides where boxes go. During the original campaign,
OpenTUI used **WebAssembly** Yoga: its linear memory could grow but never shrink
back to the OS, so transient mounted peaks permanently raised the floor. In
0.4.1 Yoga nodes are native Zig/FFI allocations and can be released. Windowing
still matters because mounted renderables retain native handles, text buffers,
and layout work even without the old WASM ratchet.

**Solid (the view framework).** Renders each store message into a row via
`<For>`. The property we exploit: Solid mounts/unmounts *surgically* — remove a
row from what the component returns and Solid destroys exactly that row's
renderables (returning its handles and freeing its Yoga nodes), touching
nothing else. No virtual-DOM diffing, no collateral re-renders.

**V8 (the JavaScript engine) + the store.** The store keeps every message as JS
strings/objects. V8's garbage collector is *lazy by design*: with the default
8GB ceiling we launch with, it sees no reason to clean up aggressively, so RSS
includes a lot of "collectible but not yet collected" garbage. Cheap to fix,
worth real MB (measured below).

**The scrollbox.** One detail that fooled everyone at some point:
`viewportCulling` (on by default) skips *drawing* offscreen rows — but they stay
fully **mounted**: handles held, Yoga nodes alive, memory paid. Culling saves
paint time, not memory. That misunderstanding is half the reason the "rolling
store cap" was expected to be enough, and wasn't.

## 2. Why it was 686MB

Simple arithmetic. The old TUI mounted **every message in the store** as a full
renderable tree. 2,000 messages × ~16 renderables × (handles + Yoga nodes +
text buffers + V8 objects) ≈ 670–690MB, growing ~300MB per 1,000 messages. And
at ~1,400 rows the handle table filled: first a hard crash (exit 7), then —
after our containment fix — survival with **unstyled text** past that point,
plus a cap clamped from 3,000 rows down to 1,000 as the price of not crashing.

Ink, meanwhile, sat at ~234MB at the same workload, because Ink only ever
mounts the rows near your viewport (~84–400 live nodes). Its memory is the
*data* plus some caches — not the *view*.

## 3. The decisions, in order

### Decision 1: virtualize the view, don't starve the store

Two ways to cut view memory: keep fewer messages (opencode's answer — they keep
100 and delete the rest from memory; transcript truth lives on their server), or
keep all messages but only *materialize* the ones near the viewport. You vetoed
the first (your p90 session is 182 messages — a 100-row store truncates normal
sessions), so: **windowing**. Notably the OpenTUI devs confirmed this week that
framework-level virtualization is the intended path — the engine doesn't ship
it out of the box, and opencode never built it. We did.

### Decision 2: exact heights, recorded at unmount — never estimates in your face

This is the load-bearing idea, and it's where we beat Ink at its own game.

The hard problem of any virtualized list: an unmounted row still needs to
occupy its correct *height*, or the scrollbar lies and content jumps. Ink
solves it by **guessing** heights and correcting after measurement — those
corrections are precisely the 83–101ms scroll stutters you hate. You explicitly
vetoed "estimate-correction jank" as a model.

Our advantage: OpenTUI lays out with real, queryable heights. So when a row
scrolls out of the window, we record its **exact laid-out height** (an
`onSizeChange` hook fires inside layout, pre-paint) and replace the row with an
empty `<box height={exactly-that}/>` — a **spacer**: one Yoga node, zero text
buffers, zero native handles. Think of a bookshelf where books you're not
reading are swapped for cardboard sleeves cut to *exactly* the book's
thickness: the shelf never shifts, and you can't tell from across the room.

The window is your viewport ± one viewport of margin (plus hysteresis so it
doesn't thrash at the edges). Scroll near a spacer and the real row remounts —
at the recorded height, so nothing moves.

And one **law**, written into the code as `correctionIsLegal`: a spacer's
height may only ever be corrected where you *cannot see it* — fully above the
viewport (with the scroll position compensated in the same frame, so the world
doesn't move) or fully below it. A correction that would shift visible content
is forbidden, structurally. Jank isn't tuned down; it's outlawed.

### Decision 3 (the S2 insight): adjudicate on *append*, not just on scroll

S1 alone got 686 → 518MB. Why not more? Because of *when* windowing decided.
S1 re-decided the window when you **scrolled**. But during a streaming burst —
an agent turn dumping hundreds of rows — you don't scroll; rows arrive, each
mounting fully, and only get demoted later. That transient pile-up is mostly
invisible in steady-state numbers. On the historical Yoga-WASM runtime the
transient peak was permanent; on 0.4.1 it is releasable but still creates
avoidable RSS, handle pressure, and layout latency.

S2 makes the window recompute on **transcript growth**: while you're pinned at
the bottom, the window anchors to the content *bottom*, so a row that falls
more than a margin behind the live edge becomes a spacer the moment it's
measured — not whenever you next scroll. Measured result: across a 1,500-row
burst, the peak number of simultaneously-mounted rows is **31**.

Same trick for **resume**: opening a 2,000-message session used to mount all of
it (transient peak again — paid forever). Now resume mounts only the bottom
window; everything above starts as spacers using a line-count estimate, and an
idle-time "measure march" quietly mounts ten rows at a time near the window
edge, records their true heights, and swaps them back — all outside the
viewport, all invisible by the law above.

### Decision 4: rows that must never be windowed

Windowing has to know what it's not allowed to touch:
- **Streaming rows** — the native markdown renderer streams incrementally;
  unmounting mid-stream would restart it visibly.
- **The bottom 30 rows** — the region you actually live in.
- **Rows under a mouse selection** — the review caught that a lingering
  highlight originally froze windowing *forever* (memory regrowing silently).
  Fixed: only an active drag pauses swaps, and selected rows get pinned, so
  copy is byte-exact while everything else keeps windowing.

### Decision 5: give back the scrollback (cap 1,000 → 3,000)

The 1,000-row clamp existed only because mounted-rows == stored-rows and the
handle table dies at ~1,400. With windowing, mounted ≈ 31 regardless of store
size — so the cap went back to the originally-shipped 3,000. It's
windowing-aware: the `HERMES_TUI_WINDOWING=0` escape hatch (which mounts
everything again) keeps the safe 1,000.

### Decision 6 (measured, not yet shipped as default): right-size the V8 heap

Running the windowed TUI with a 512MB heap ceiling instead of 8GB forced V8 to
actually collect: another −90MB with zero latency cost. That lower default
remains unshipped backlog; the current launcher still defaults to 8,192MB when
no tighter config/cgroup ceiling applies.

## 4. The scoreboard

These measurements were taken during the windowing campaign, before the 0.4.1
native-Yoga upgrade. At 2,000 messages (your real p99 session size — yes, we
checked your DB: median session is 20 messages, p99 is 1,941):

| | peak memory | scroll p99 (slowest 1-in-100) |
|---|---|---|
| OpenTUI before | 686MB | 16ms |
| + S1 windowing | 518MB | 16ms |
| + S2 append/resume windowing | **300–375MB** | **6ms** |
| Ink (reference) | 229–246MB | ~100ms |

At the **3,000-message stress** with the restored triple-size scrollback:
**360MB, fully styled, scroll p99 8ms** — a workload that six days ago crashed
the process, and three days ago survived only by dropping syntax colors.

Scroll got *faster* because there are simply fewer live renderables to walk.
The determinism gate stayed **byte-identical** — the windowed TUI's settled
frame is provably the same pixels as before. And the live smoke (2,000-message
session: full sweep to the top, resize storm, back to bottom) returned a frame
pixel-identical to boot, with deep history fully syntax-highlighted — something
the pre-windowing TUI literally could not do.

## 5. What's honestly still open

### The busy-input queue has its own bounded memory contract

The f7c9 parity batch adds an explicit renderer-side envelope for input authored
while a turn is running. It is separate from transcript windowing, but follows
the same rule: retain the user's data without letting the mounted native tree or
the renderer heap grow without a ceiling.

- The client queue accepts at most **100 rows** and **4,194,304 UTF-16 code
  units** in total (`String.length`, so astral characters consume two code
  units). Rejected or definitely failed steer attempts return to that same
  bounded queue; they cannot silently overbook it.
- The contract intentionally matches f7c9 Ink's best-effort delivery. A steer
  ACK means only that the live process accepted the text in memory. Ambiguous
  prompt or steer delivery is reported as uncertain after recovery and is never
  auto-replayed; unsent queue rows and the composer draft remain client-owned.
- Only **three queue rows** mount. The preview reads a bounded prefix, and the
  active edit row is kept inside that three-row window. A 100-row queue therefore
  adds strings to the store, not 100 native row trees.
- Native textarea work is capped separately at **16,384 UTF-16 code units**.
  Larger queued rows remain selectable, sendable, and deletable, but show “too
  large to edit” instead of being copied into the native buffer. Local
  Up-history also omits bodies above this ceiling; the authoritative
  transcript/session still keeps the submitted body.
- Two empty Enter presses within 450 ms interrupt a busy turn or send the next
  queued row while idle. Up/Down
  selects rows, Enter sends an edit, Ctrl+X deletes, Esc cancels, and confirmed
  `/queue --clear` provides a bulk-discard path.
- `display.busy_input_mode` lives in `config.yaml`, defaults to `queue` for the
  full-screen TUI, and is rehydrated after the existing five-second config-mtime
  poll detects a change. The poll is an Effect-scoped fiber, not a render loop.

One safety divergence is deliberate for this milestone: a queued row is always
sent as a **model prompt**. Ink may reinterpret a queued `!command` or other
syntax when it drains; OpenTUI will not do that until the queue stores typed
provenance for prompt, skill, slash, and shell entries. This prevents surprising
local execution, but it means `/queue`, `/steer`, `/busy`, `/undo`, `/retry`, and
the aggregate Busy Queue UX remain **Thinner** pending a real-PTY parity pass.

The repeatable component benchmark is `ui-opentui/scripts/queue-bench.tsx`.
Three fresh Node 26.3 runs on the target device measured:

- 100-row mount/update: **7.791 / 7.987 / 8.067 ms**, while the native tree stayed
  exactly **41 → 41 renderables**; active native allocations moved 258 → 278 and
  retained JS heap moved only 16.3 → 16.6 MiB while adding the 97 stored strings;
- selection of a **4,194,303-code-unit** row: **5.067 / 5.136 / 5.275 ms**,
  leaving external memory at **5.3 MiB**; retained JS heap rose from 16.6 to
  24.8 MiB because the store intentionally owns the full two-byte Unicode body;
- 20 key-driven edit/cancel cycles at 16,384 code units: per-run p95
  **59.522 / 62.335 / 64.015 ms**, with post-GC external memory back at
  **5.3 MiB**;
- whole fresh-process peak RSS: **126,300 / 127,148 / 127,500 KiB**, zero swaps,
  and 1.64–1.66 s wall time.

Focused tests cover fixed three-row mounting, constant renderable growth at 100
rows, overflow rejection, reservation accounting, queue edit/send/delete,
double-empty Enter, and deferred agent-build failure recovery. The full
`npm run check` total is recorded only after the complete batch gate, so this is
not a release-complete claim.

- The remaining ~60–120MB over Ink is mostly the **store's JS strings** and
  process baseline — the view is no longer the problem. The structural fix is
  the **thin renderer** (W1): bodies live in the Python gateway (which already
  has them in SQLite); the TUI keeps ~300-byte stubs and fetches bodies only
  for the window. That also fixes the class of problem neither engine handles
  today: a single 10MB tool output.
- Two accepted, documented limits: scrollbar-*jumping* deep into a freshly
  resumed session can land on estimate-height rows that snap to true height as
  they enter view (normal scrolling doesn't — the margin pre-measures; the idle
  march erodes the exposure over time), and a tool you expanded, scrolled far
  away from, then returned to will have re-collapsed (state is component-local;
  hoisting it to the store is queued).
- Everything is behind `HERMES_TUI_WINDOWING` (default on, `0` = bit-exact old
  behavior) — a one-env escape hatch if anything feels off in real use.

*Where to verify: the **tui-bench** repo's `results/` (`github.com/NousResearch/tui-bench`; every number above), the design+gates doc
`docs/plans/opentui-transcript-windowing.md`, tests in
`ui-opentui/src/test/window.test.ts` and `transcriptWindow.test.tsx` (the
zero-jank invariants are literal assertions: identical scrollHeight windowed
vs not, byte-stable frames across corrections).*
