# 08 Session state store (SQLite) and other stores

Revision `origin/main` = `ea81748579`. Reference SHAs: sqlite-utils 6bc1d33, datasette cec5e6b, cpython 9d22a53.

Supporting notes: `notes/08-state-locks.md` (per-module provenance), `notes/08-state-stores.md` (store inventory), `notes/08-state-graph.txt` (AST import graph from `scripts/08_state_graph.py`).

## TL;DR

- SessionDB is one class assembled from 15 mixins in 16 files (482 methods, 229 public). The 33-file facade split spread a god class over many files; it did not produce modules.
- Biggest kill: the WAL-generation-loss defence stack (lockguard, retired-generation capture, unclosed-handle pinning, about 800-1,000 lines). It exists because Python 3.11 cannot arm SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, but pyproject says 3.11 is never a runtime.
- Biggest simplification: one SQLite access layer (opener, write transaction with retry, migrations, integrity/quarantine) shared by state.db, kanban.db and the 14 other SQLite files, instead of three write-txn helpers and a second 1,247-line kanban copy of the machinery.
- Low-hanging fruit: 4 (STA-01, STA-03, STA-04, STA-05).
- Seam answer: no. About 5 tables are the essential model. 36% of the 20,228 lines is connection-safety and recovery machinery. In-process ad hoc connections were already collapsed by the registry, so most of what remains defends cross-process hazards. A datasette write thread does not remove those. Hermes runs 16 SQLite databases plus at least 30 JSON/YAML state files.

## What this area is

Scope: `hermes_state.py`, `hermes_state_*.py (32 siblings)`, `hermes_cli/sqlite_util.py`, `hermes_cli/sqlite_safe_read.py`, `hermes_cli/kanban_db_connect.py`, `gateway/delivery_ledger.py`, `tools/async_delegation.py`, `other sqlite3.connect sites and JSON state writers (inventory)`. The 33 `hermes_state*.py` root files are 20,228 lines.

Line split of the 33 files (wc -l, grouped by me):

| group | files | lines |
|---|---|---|
| data access mixins/helpers | sessions, messages, search, fts, titles, usage, portability, compression, gateway, telegram, coverage, rewind, timeline, identity, ids, user_copy, profile_repair | 10,218 |
| schema + migrations | schema, common | 2,695 |
| connection safety, holders, WAL, repair, health, registry, errors | dbfile, holders, lockguard, lockowners, pidns, guard, readpool, wal, repair, health, maintenance, registry, errors | 5,620 |
| facade (connection lifecycle, write loop, generation checks) | hermes_state.py | 1,695 |

Entry points: `hermes_state_registry.acquire()` (66 references in 39 non-test files per `rg -n '\bhermes_state_registry\b'`; long-lived processes) and bare `SessionDB(...)` (one-shots, mostly `read_only=True`). `AsyncSessionDB` wraps a SessionDB for the gateway.

State.db tables (`hermes_state_common.py:373-620` plus lazy ones): schema_version, system_prompts, sessions, messages, session_model_usage, state_meta, gateway_routing, gateway_hygiene_state, conversation_generations, gateway_heartbeats, compression_locks, session_turn_leases, async_delegations, messages_fts / messages_fts_trigram / messages_fts_cjk, plus lazily created telegram_dm_topic_mode, telegram_dm_topic_bindings (`hermes_state_telegram.py`) and delivery_obligations (`gateway/delivery_ledger.py`). Only the first five plus FTS are session/message data; the rest is other subsystems' coordination state co-located in the same file.

Connection model (today): one writer connection per path per process (registry), `check_same_thread=False, timeout=1.0, isolation_level=None` (`hermes_state.py:786-805`), explicit `BEGIN IMMEDIATE` with time-based jittered retry (20 s / 60 s transcript / 0.5 s activity, `hermes_state.py:482`); a bounded `mode=ro` read pool (8 per file, 24 per process, `hermes_state_readpool.py:35,44`); a per-instance `threading.Lock` (`hermes_state.py:594`). Across processes only SQLite's WAL lock serialises writes; flocks guard repair and startup quarantine.

| module | lines | owns |
|---|---|---|
| `hermes_state.py` | 1,695 | SessionDB facade: __init__, writer/reader connection lifecycle, _execute_write retry loop, generation/replace detection, close; AsyncSessionDB to_thread proxy |
| `hermes_state_messages.py` | 1,983 | SessionMessagesMixin (89 methods): append/replace/load transcripts, write guards, row identity |
| `hermes_state_sessions.py` | 1,814 | SessionSessionsMixin (65 methods): session rows, list/lineage/export |
| `hermes_state_schema.py` | 1,367 | SessionSchemaMixin: _init_schema, 10 version gates, per-open heal functions, two FTS layouts |
| `hermes_state_search.py` | 1,361 | SessionSearchMixin (54 methods): FTS5 search and recovery |
| `hermes_state_common.py` | 1,328 | SCHEMA_SQL (13 tables + FTS DDL), shared SQL helpers, flock helper; imports agent.context_compressor at module level |
| `hermes_state_repair.py` | 1,160 | schema surgery strategy table, writability preflight, cross-process repair flock |
| `hermes_state_dbfile.py` | 849 | header probes, quarantine, deleted-WAL holder scans (procfs/libproc), retired-generation capture, the one sqlite3.connect |
| `hermes_state_holders.py` | 660 | which other PIDs hold state.db/-wal/-shm open; refuse/defer maintenance |
| `hermes_state_wal.py` | 647 | journal-mode policy, WAL fallback on network FS, config pragmas; shared by kanban and plugins |
| `hermes_state_registry.py` | 478 | one shared SessionDB per resolved path per process, refcounted (#90837) |
| `hermes_cli/kanban_db_connect.py` | 1,247 | kanban.db opener: its own retry, integrity, quarantine, REINDEX repair, flocks |

## How it works end to end

### A long-lived process (agent, gateway, TUI) opens state.db for the first time

Trigger: AIAgent init with persistence on (run_agent.py acquires the shared handle).

Inputs: `db_missing_or_bad_header` (bool, default False): state.db does not exist yet, or its first 100 bytes are not a SQLite header; `schema_malformed` (bool, default False): the first statement fails with a malformed sqlite_master; `wal_active` (bool, default True): WAL was applied and confirmed on disk (false on NFS/SMB fallback)

1. `run_agent.py::AIAgent (session db acquire)` (`run_agent.py:324`): imports hermes_state_registry.acquire and takes the process-shared SessionDB
2. `hermes_state_registry.py::acquire` (`hermes_state_registry.py:195`): resolves the path, checks the file inode against the cached generation, opens a new SessionDB if none or replaced → STA-02
3. `hermes_state.py::SessionDB.__init__` (`hermes_state.py:578`): runs the pytest guard, builds the read pool and per-path read budget, then opens the writer → STA-02
4. `hermes_state.py::SessionDB._open_writer` (`hermes_state.py:675`): mkdir under hermes home, preflight writability
5. `hermes_state_dbfile.py::quarantine_cross_process_lock` (`hermes_state_dbfile.py:656`): takes a cross-process flock and quarantines an invalid file before connect *(when `db_missing_or_bad_header` = True)*
6. `hermes_state.py::SessionDB._connect_and_init` (`hermes_state.py:812`): refuses to connect while another process holds a deleted WAL generation (procfs/libproc scan) → STA-01
7. `hermes_state.py::SessionDB._open_writer_conn` (`hermes_state.py:786`): connects with timeout=1.0, isolation_level=None, applies WAL with fallback, config pragmas, foreign_keys, CJK tokenizer → STA-04
8. `hermes_state_dbfile.py::_connect_tracked_db` (`hermes_state_dbfile.py:603`): the only sqlite3.connect for state.db; registers the fd so Hermes's own byte probes do not cancel SQLite's POSIX locks → STA-01
9. `hermes_state_wal.py::apply_wal_with_fallback` (`hermes_state_wal.py:254`): sets journal_mode=WAL or falls back to DELETE on locking-protocol errors
10. `hermes_state_schema.py::SessionSchemaMixin._init_schema` (`hermes_state_schema.py:922`): runs SCHEMA_SQL, version-gated data migrations, per-open heals, FTS init; on every open in every process → STA-06
11. `hermes_state_repair.py::repair_state_db_schema` (`hermes_state_repair.py:857`): backs up and repairs sqlite_master in place, then reconnects once *(when `schema_malformed` = True)*
12. `hermes_state_lockguard.py::hold` (`hermes_state_lockguard.py:146`): re-takes SQLite's two WAL lock ranges as OFD locks so a stray close() cannot cancel them *(when `wal_active` = True)* → STA-01

### The agent persists a turn's new messages to state.db

Trigger: end of a turn (CLI, gateway, TUI): AIAgent._persist_session.

Inputs: `other_process_holds_write_lock` (bool, default False): another Hermes process holds the WAL write lock (gateway, Desktop serve, CLI, TUI worker); `compression_running` (bool, default False): another holder owns this session's compression_locks row

1. `agent/session_persistence.py::_persist_session` (`agent/session_persistence.py:435`): under the per-agent persist lock, drops scaffolding and flushes
2. `agent/session_persistence.py::_flush_messages_to_session_db` (`agent/session_persistence.py:469`): selects un-flushed messages by marker and builds rows
3. `agent/session_persistence.py::_db_flush_write` (`agent/session_persistence.py:290`): calls append_messages_batch with compression-lock and turn-lease holders → STA-07
4. `hermes_state_messages.py::SessionMessagesMixin.append_messages_batch` (`hermes_state_messages.py:449`): builds the write callback for one transaction
5. `hermes_state_messages.py::SessionMessagesMixin._check_transcript_write_guards` (`hermes_state_messages.py:201`): inside the txn: checks compression lock and turn lease rows (PID-liveness reclaim) → STA-07
6. `agent/transcript_repair.py::resolve_and_repair_transcript_batch` (`agent/transcript_repair.py:110`): agent-domain transcript repair, imported and run inside the storage write transaction → STA-03
7. `hermes_state_messages.py::SessionMessagesMixin._execute_transcript_write` (`hermes_state_messages.py:487`): snapshots and restores caller row-state on each attempt, 60s patience
8. `hermes_state.py::SessionDB._execute_write` (`hermes_state.py:993`): takes self._lock, BEGIN IMMEDIATE (hermes_state.py:1030), runs fn, commits → STA-08
9. `hermes_state.py::SessionDB._sleep_before_write_retry` (`hermes_state.py:1435`): jittered sleep and retry of the whole callback until the patience deadline *(when `other_process_holds_write_lock` = True)*
10. `hermes_state_lockowners.py::log_write_lock_holders` (`hermes_state.py:1077`): on patience exhausted, parses /proc/locks to name the holder PID, then raises 'database is locked' *(when `other_process_holds_write_lock` = True)*
11. `hermes_state.py::SessionDB._execute_write (compression branch)` (`hermes_state.py:1048`): waits up to 5s for a foreign compression lock, then refuses *(when `compression_running` = True)* → STA-07
12. `hermes_state.py::SessionDB._try_wal_checkpoint` (`hermes_state.py:1044`): PASSIVE checkpoint every 50 successful writes → STA-01
13. `hermes_state_usage.py::SessionUsageMixin.flush_token_counts` (`hermes_state_usage.py:147`): drains the token-accounting writer thread's queue → STA-08

## Findings

### STA-01: A Python-3.11 workaround stack defends against WAL-file deletion that one connection flag on the 3.14 runtime prevents

- severity **high**, effort **M**, kind `kill`, low_hanging true, loc_delta -900, depends_on ['STA-04']
- evidence: `pyproject.toml:611`, `hermes_state.py:1351`, `hermes_state.py:1390`, `hermes_state.py:718`, `hermes_state_lockguard.py:1`, `hermes_state_dbfile.py:355`, `hermes_state_dbfile.py:514`, `hermes_cli/sqlite_safe_read.py:1`, `hermes_state_errors.py:225`

**Problem (today).** SQLite deletes -wal/-shm when the last connection closes and wins the close-time checkpoint. Any in-process close() of a raw fd on state.db cancels this process's POSIX locks, so a sibling's close can unlink a live writer's WAL; the writer then halts with DeletedWalGenerationError. Hermes answers with four layers: OFD re-locking (hermes_state_lockguard.py, 197 lines), an fd registry for its own byte probes (hermes_cli/sqlite_safe_read.py, 257 lines), procfs/libproc scans for deleted sidecars plus a forensic capture of the retired generation (hermes_state_dbfile.py:355-600), and pinning the quarantined connection unclosed (hermes_state.py:1381-1424). The commit that added lockguard (75e155ab09) gives the reason: it 'Works on Python 3.11 (where sqlite3 cannot arm SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)'. pyproject.toml:611 says '3.11 is an install bridge for pre-PM updaters, never a runtime', and the lock covers 3.14 only. Today the flag is armed only on quarantined handles (hermes_state.py:1351). This is the largest class of state.db incidents in six weeks of fixes (#90837, #102827, #103339, #109841, #110054, #118269), and every contributor touching state.db has to learn the generation model.

**Move (proposal).** Arm conn.setconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, True) on every state.db connection in _connect_tracked_db (writer, readers, delivery_ledger, async_delegation). Make checkpointing explicit and owned (the existing PASSIVE every-50-writes plus maintenance). Delete hermes_state_lockguard.py, the pin/retire-unclosed path (hermes_state.py:1351-1424, _prepare_connection_retirement at hermes_state_dbfile.py:36), and capture_retired_wal_generation. Shrink the deleted-sidecar scans into one doctor diagnostic for non-Hermes openers. Stop raw byte probes of a live file so sqlite_safe_read's live-connection registry can go (probe only before the first connect in the process).

**Reference.** `.repos/datasette/datasette/database.py:175`: connections are opened in one place (connect(write=...)) with all per-connection settings applied there; there is no second opener

**Risk.** Depends on SQLite semantics: with NO_CKPT_ON_CLOSE, sqlite3WalClose must skip both the checkpoint and the unlink (UNVERIFIED). Non-Hermes openers (sqlite3 CLI, DB browsers, backup tools) can still unlink the WAL on their last close, so keep detection in doctor. The 3.11 bridge must never import hermes_state at runtime. Preserve: no transcript loss when another process closes; a durable WAL is checkpointed regularly. Tests that exercise lockguard or capture are deleted with the code.

### STA-02: SessionDB is one god class of 15 mixins across 16 files that share 91 private attributes

- severity **high**, effort **L**, kind `restructure`, low_hanging false, loc_delta -1500, depends_on []
- evidence: `hermes_state.py:459`, `hermes_state.py:578`, `hermes_state_messages.py:13`, `hermes_state_repair.py:843`, `hermes_state_registry.py:195`, `hermes_state_readpool.py:1`

**Problem (today).** class SessionDB(SessionSessionsMixin, ... SessionProfileRepairMixin) at hermes_state.py:459 combines 15 mixins: 482 methods, 229 public (AST count, scripts/08_state_graph.py). The facade uses 91 distinct self._ attributes; mixins reach the same private state (messages 66, search 77, schema 58). Eleven siblings late-import 20 private names back from the facade (for example hermes_state_messages.py imports _strip_stale_tool_call_markers, _compression_lock_holder_process_is_dead and 5 others). Every mixin can call every other mixin's private helpers, so no file is a unit with a narrow interface. The read-gate test can only cover 4 of the 16 class files. A reader must open the facade plus whichever mixins share an attribute to follow any write. This is the shape AGENTS.md calls 'facade + siblings', and here it moved 17k lines into 33 files without creating boundaries.

**Move (proposal).** Split by composition, not inheritance. (1) StateStore: owns the path, the writer connection, the read pool, write(fn, patience) and read(fn), close. It is the only object holding a connection. (2) Repositories that take a StateStore: Sessions, Messages (append/replace/load), Search (FTS), Usage, Titles, GatewayRouting, Leases (compression locks + turn leases), Portability, Maintenance. Each repository has public methods only and no shared private state. SessionDB stays as a thin aggregate exposing .sessions, .messages and so on during migration. Move the 33 root modules into a hermes_state/ package (store.py, schema.py, repos/*.py, safety/*.py).

**Reference.** `.repos/sqlite-utils/sqlite_utils/db.py:538`: Database owns the connection and helpers; db.table(name) (db.py:1006) returns a Table that does per-table work through the Database, with no mixin inheritance

**Risk.** Tests patch facade names (AGENTS.md 'patch where production reads'); moving names breaks those test seams and every monkeypatch on hermes_state must be repointed. The ~229 public methods are called from gateway, tui_gateway, hermes_cli, agent; the aggregate keeps them working during migration. Preserve: one writer per path per process and the read/write lock split.

### STA-03: The storage layer imports the agent at module level and classifies messages by SQL LIKE over content

- severity **high**, effort **M**, kind `boundary`, low_hanging true, loc_delta -300, depends_on []
- evidence: `hermes_state_common.py:15`, `hermes_state_common.py:16`, `hermes_state_messages.py:13`, `hermes_state_messages.py:468`, `hermes_state_rewind.py:1`, `hermes_state_profile_repair.py:1`, `agent/skill_commands.py:67`

**Problem (today).** hermes_state*.py contains 52 import statements of agent/, gateway/, hermes_cli/ and tools/, 14 of them at module level (rg '^(from|import) (agent|gateway|tools|hermes_cli)' hermes_state*.py). hermes_state_common.py:16 imports agent.context_compressor (5,971 lines) at import time, so anything that imports hermes_state loads the compressor. Storage SQL encodes agent formats: summary prefixes and merge delimiters from the compressor, SKILL_SCAFFOLD_SQL_LIKE (agent/skill_commands.py:67) used as a LIKE pattern over message content (9 uses). The append transaction runs agent.transcript_repair.resolve_and_repair_transcript_batch inside BEGIN IMMEDIATE (hermes_state_messages.py:468), so agent logic holds the cross-process write lock. hermes_state_profile_repair.py imports gateway.session private _session_key_namespace. Changing a prompt prefix in agent/ silently changes what storage queries return.

**Move (proposal).** Persist the classification at write time: a message 'kind' column (summary, skill_scaffold, compaction_marker, normal) set by the agent when it creates the message. Queries filter on kind; the LIKE patterns and all agent imports leave storage. The agent repairs the batch before calling messages.append(rows); storage only inserts. A one-time data migration backfills kind for existing rows using today's LIKE patterns, then those constants are deleted from storage. Enforce with an import-linter contract: hermes_state may not import agent, gateway, tools, tui_gateway.

**Reference.** `.repos/sqlite-utils/sqlite_utils/db.py:5031`: Table.upsert takes plain records and columns; the access layer knows nothing about the meaning of the rows

**Risk.** Transcript repair currently sees rows committed by other processes inside the same transaction; moving it out needs a read-then-append with a conflict check (or keeps a small storage-side hook typed as a callable passed by the caller). Backfill on large DBs must be chunked. Preserve: search results and pickers hide scaffolding exactly as today.

### STA-04: state.db has writers outside SessionDB with conflicting settings and table definitions

- severity **high**, effort **M**, kind `collapse`, low_hanging true, loc_delta -250, depends_on ['STA-02']
- evidence: `gateway/delivery_ledger.py:184`, `tools/async_delegation.py:114`, `plugins/platforms/a2a/adapter.py:136`, `hermes_state_gateway.py:152`, `hermes_state_common.py:582`, `hermes_state_telegram.py:120`

**Problem (today).** Three modules open state.db with their own connections. gateway/delivery_ledger.py:184 uses open_db with wal=True and creates delivery_obligations. tools/async_delegation.py:114 uses open_db with wal=False and runs reconcile_state_schema from its own initializer. plugins/platforms/a2a/adapter.py:136-150 runs raw sqlite3.connect(db, timeout=5) and UPDATE sessions with no write retry, no registry and no SessionDB guards. Table ownership is split too: async_delegations is defined both in SCHEMA_SQL (hermes_state_common.py:582, with a comment that it mirrors the tool's own DDL after drift #94691) and in the tool; telegram topic tables and delivery_obligations are created lazily by their features, so gateway code must introspect live columns before every identity query (hermes_state_gateway.py:152-170, #113757). The result: the same file has three PRAGMA policies, and its schema is not described by schema_version.

**Move (proposal).** One opener and one schema owner for state.db. Every table that lives in state.db is declared in the schema module (or registered by its owner through one migration registry), applied at open. delivery_ledger and async_delegation become repositories on the shared StateStore (STA-02) instead of opening their own connections. The a2a adapter calls a SessionDB method (set title / lookup) through the profile's registry handle. Delete _optional_table_columns and its column-gated SQL once every table exists at open.

**Reference.** `.repos/datasette/datasette/database.py:537`: _send_to_write_thread: every write to a database goes through the Database object's single write path, never a side connection

**Risk.** Creating the telegram tables at startup changes the documented 'deferred until /topic opt-in' behaviour (hermes_state_telegram.py:120); the tables can be created empty without changing bot behaviour. The delivery ledger deliberately uses the process home, not the served profile (gateway/delivery_ledger.py:170); keep that path choice. Preserve: owner-only file modes (_secure_state_db_files).

### STA-05: Kanban, cron and plugin DBs re-implement the SQLite store machinery; three write-transaction helpers disagree

- severity **high**, effort **M**, kind `collapse`, low_hanging true, loc_delta -700, depends_on []
- evidence: `hermes_cli/kanban_db_connect.py:1168`, `hermes_cli/kanban_db_connect.py:458`, `hermes_cli/kanban_db_connect.py:346`, `hermes_cli/kanban_db_connect.py:84`, `hermes_cli/sqlite_util.py:99`, `hermes_state.py:993`, `hermes_state_repair.py:857`

**Problem (today).** hermes_cli/kanban_db_connect.py (1,247 lines) carries its own busy retry (_execute_boundary_with_retry :1168, 5 attempts, 20-150 ms jitter), integrity probe (:420-:426), corrupt backup and pruning (:314, :346), REINDEX repair (:458, repair_db :569), header validation with TLS-record detection (:251-:265), and flock helpers (:84-:200). state.db has the same concepts in hermes_state_repair.py, hermes_state_dbfile.py and _execute_write (time-based patience). hermes_cli/sqlite_util.py:99 write_txn has no retry at all and is used by projects.db, cron DBs and shared_metrics. Of the 15 non-state SQLite files, response_store.db sets no busy_timeout, metrics.sqlite3 and retaindb_queue.db never set WAL (inventory notes/08-state-stores.md). Every fix in one copy (131 sqlite-locking fix commits in the gist) must be re-found in the others.

**Move (proposal).** Extract one internal package (hermes_sqlite/ or hermes_state/sqlite/) with: open(path, profile) applying WAL fallback, busy_timeout, synchronous and NO_CKPT_ON_CLOSE; write(conn, fn, patience) with the time-based jitter loop now in SessionDB._execute_write; integrity_check/quarantine/backup; repair_lock(path). SessionDB, kanban_db_connect, open_db users and the plugin_storage API all use it. kanban_db_connect.py shrinks to kanban schema and migrations.

**Reference.** `.repos/sqlite-utils/sqlite_utils/db.py:1206`: connection-level policy (enable_wal, transactions) lives on the one Database object every table uses

**Risk.** Kanban's 5-attempt budget and state.db's 20/60s patience serve different call sites; the shared helper must take patience as a parameter. Kanban workers open per-operation connections; a shared opener must keep that working. Preserve: kanban corruption backups and doctor output.

### STA-06: Schema evolution is a version ladder plus per-open heals, two FTS layouts and a JSON column cache

- severity **medium**, effort **M**, kind `restructure`, low_hanging false, loc_delta -500, depends_on ['STA-04']
- evidence: `hermes_state_common.py:283`, `hermes_state_schema.py:1018`, `hermes_state_schema.py:1110`, `hermes_state_schema.py:833`, `hermes_state_schema.py:864`, `hermes_state_schema.py:751`, `hermes_state_schema.py:1011`

**Problem (today).** SCHEMA_VERSION = 31 (hermes_state_common.py:283). _run_data_migrations is a chain of 10 'if current_version < N' gates (hermes_state_schema.py:1018-1110). Heal functions (_heal_gateway_routing_pk :833, _heal_session_model_usage_pk :864) and FTS trigger migrations run on every open in every process because earlier gates 'never re-ran' (comments at :955, :968). The FTS code carries both the legacy inline layout and the v23 external-content layout (_FTS_DDL[legacy_layout]), so every FTS repair path branches on 'legacy'. A schema_columns.json cache is written beside the DB with its own mkstemp/replace (:745-751). The function comment at :1011-1016 keeps superseded v11 text 'only for source archaeology'. Every process pays DDL and introspection at open; every new column touches three places.

**Move (proposal).** Replace the integer ladder with named, ordered migrations recorded in a migrations table (applied once, never re-run), including a final 'force v23 FTS layout' migration. Then delete the legacy FTS branch, the per-open heal functions, the schema_columns.json cache and the archaeology comments. Open-time work becomes: compare applied migrations with the list; run the missing ones under the repair lock.

**Reference.** `.repos/sqlite-utils/sqlite_utils/migrations.py:18`: Migrations: named migration functions recorded in a _sqlite_migrations table, each applied once

**Risk.** Very old stores (pre-v23) must still upgrade: the forced-layout migration has to handle them once. Heals exist because some installs wrote bad PKs after the gate had passed; their one-time fix must be a named migration that runs on those stores. Preserve: fresh install and upgrade both reach the same schema.

### STA-07: Leases and locks in state.db reclaim by PID liveness, which needed a PID-namespace module

- severity **medium**, effort **M**, kind `restructure`, low_hanging false, loc_delta -250, depends_on ['STA-02']
- evidence: `hermes_state.py:137`, `hermes_state_pidns.py:109`, `hermes_state_common.py:568`, `hermes_state_common.py:575`, `hermes_state_common.py:559`, `agent/turn_facade_lease.py:17`

**Problem (today).** compression_locks, session_turn_leases (both with expires_at) and gateway_heartbeats are coordination primitives stored in state.db. Holders are strings like 'pid=<n>:pidns=<inode>'. Reclaim parses the PID with a regex and probes liveness with psutil or os.kill (hermes_state.py:137-180). Containers sharing a volume see each other's PIDs as dead, so 6c6ce6149e added hermes_state_pidns.py with two policies for stamped and unstamped holders. Async delegations carry owner_pid/owner_started_at too (hermes_state_common.py:582). PID probing is the 'never infer identity from processes' class AGENTS.md warns about, and the gist counts 245 race/TOCTOU fixes.

**Move (proposal).** Make leases TTL-only with heartbeat renewal: the holder renews expires_at while alive (the turn and compression loops already run periodic work); anyone may take a lease whose expires_at passed. Holders become opaque UUIDs. Delete _compression_lock_holder_process_is_dead, hermes_state_pidns.py and the holder-string regex. Put the lease operations in one Leases repository (STA-02).

**Reference.** none applies

**Risk.** Crash recovery latency rises from 'immediately when the PID is gone' to one renewal window; the TTL must be short (tens of seconds) with renewal, not today's 300 s turn-lease TTL. Product decision: UNVERIFIED that a 30 s reclaim delay is acceptable. Preserve: a live sibling's turn is never taken over.

### STA-08: In-process writes use a shared lock, a to_thread proxy and a separate token-writer thread instead of one write thread

- severity **medium**, effort **M**, kind `restructure`, low_hanging false, loc_delta -200, depends_on ['STA-02']
- evidence: `hermes_state.py:594`, `hermes_state.py:1682`, `hermes_state_usage.py:119`, `hermes_state_readpool.py:35`, `gateway/run.py:3782`

**Problem (today).** Writes from any thread take SessionDB._lock (hermes_state.py:594) and run on the caller's thread. Async callers go through AsyncSessionDB, a __getattr__ proxy that wraps every attribute in asyncio.to_thread (hermes_state.py:1682-1695), so it has no types and makes reads and writes look the same. Token accounting runs a separate daemon writer thread with idle retirement (hermes_state_usage.py:119). Reads borrow from a bounded pool with per-path permits (hermes_state_readpool.py, 259 lines) and fall back to the writer lock when out of permits. Three mechanisms serialize the same writer connection.

**Move (proposal).** Adopt datasette's shape for the in-process half: one write thread per StateStore that owns the writer connection and drains a queue of (fn, future, patience); sync callers block on the future, async callers await it. Token accounting enqueues to the same thread (delete the token-writer thread). AsyncSessionDB becomes typed async methods on the repositories that call store.write/store.read. The read pool stays (it is the correct shape), but its fallback to the writer lock goes.

**Reference.** `.repos/datasette/datasette/database.py:570`: _execute_writes: one thread owns the write connection and drains a queue; execute_write_fn (database.py:431) returns the result to the awaiting caller

**Risk.** This does not touch cross-process contention: BEGIN IMMEDIATE retry stays inside the write thread. A wedged write blocks every queued writer in the process; keep per-task patience and a thread watchdog. Shutdown must drain the queue (cpython Lib/concurrent/futures/thread.py:17-37 joins workers at exit).

### STA-09: JSON state files have 10 private atomic writers, several non-atomic writers and 30 files with their own flock

- severity **medium**, effort **M**, kind `collapse`, low_hanging false, loc_delta -300, depends_on []
- evidence: `utils.py:289`, `tools/environments/base.py:205`, `gateway/restart_loop_guard.py:56`, `pm/filesystem.py:67`, `cron/jobs.py:1550`, `hermes_state_schema.py:751`, `hermes_cli/update_completion.py:19`

**Problem (today).** utils.py:289 _atomic_write is the canonical writer (94 atomic_json_write call sites). Ten other modules hand-roll temp-file-and-replace, some without fsync and with fixed tmp names (hermes_cli/update_completion.py:19, gateway/dead_targets.py, cron/jobs.py:1550-1600 re-implements it using utils primitives). Some state files are written with plain write_text: sandbox snapshot stores (tools/environments/base.py:205), restart_loop.json (gateway/restart_loop_guard.py:56), pet.json. Thirty files call fcntl.flock directly; there is no shared file-lock helper (inventory notes/08-state-stores.md §5). The gist counts 30+43 fixes for state-file writes.

**Move (proposal).** One JsonStateFile(path, lock=True) type in utils: read() returns the parsed dict or default, update(fn) takes a cross-process lock, reads, applies fn, and writes atomically. Replace the 10 private writers and the non-atomic ones. pm/filesystem.py:67 can stay separate only if pm must not import utils (state why in its docstring).

**Reference.** `.repos/sqlite-utils/sqlite_utils/db.py:538`: one access object per store owns read/write semantics; callers never handle temp files or locks

**Risk.** Some files are read by other processes expecting exact formatting (indent, key order); keep the dump options. Windows lock semantics (msvcrt) must be in the helper. Preserve 0600 modes on secret-bearing files.

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `hermes_state_lockguard.py` | OFD re-locking exists because 3.11 cannot arm NO_CKPT_ON_CLOSE (75e155ab09); runtime is 3.14 | 0 | `only importer hermes_state.py:58; pyproject.toml:611` |
| `hermes_state.py::SessionDB._pin_connection / _settle_lost_generation_locked / _disable_close_time_checkpoint (quarantine-only arming)` | retire-unclosed path for runtimes without setconfig | 1 | `hermes_state.py:1351-1424` |
| `hermes_state_dbfile.py::capture_retired_wal_generation and _prepare_connection_retirement` | forensics for a failure class STA-01 removes | 1 | `hermes_state_dbfile.py:36, :514` |
| `hermes_state_pidns.py` | only needed because leases reclaim by PID liveness (STA-07) | 2 | `agent/conversation_compression.py:38, agent/turn_facade_lease.py:17` |
| `hermes_state_gateway.py::_optional_table_columns` | column introspection for lazily created tables (STA-04) | 1 | `hermes_state_gateway.py:152-170` |
| `hermes_state_schema.py legacy inline FTS layout branch, per-open heals, schema_columns.json cache` | superseded by v23; a named one-time migration replaces them (STA-06) | n/a | `hermes_state_schema.py:149, :833, :864, :745-751, :1011-1016` |
| `plugins/platforms/a2a/adapter.py::_state_db raw UPDATE` | bypasses SessionDB, registry and write retry | 3 | `plugins/platforms/a2a/adapter.py:136-150` |
| `hermes_cli/kanban_db_connect.py retry/integrity/repair copies` | duplicates state.db machinery (STA-05) | n/a | `hermes_cli/kanban_db_connect.py:84-200, :251-569, :1161-1237` |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| `hermes_state.py`; `15 Session*Mixin files` | StateStore + per-aggregate repositories in a hermes_state/ package | ~1500 | `hermes_state.py:459` |
| `SessionDB._execute_write`; `kanban_db_connect._execute_boundary_with_retry`; `sqlite_util.write_txn` | one write(conn, fn, patience) helper | ~150 | `hermes_state.py:993, hermes_cli/kanban_db_connect.py:1168, hermes_cli/sqlite_util.py:99` |
| `hermes_state_repair/dbfile integrity+quarantine`; `kanban_db_connect integrity+backup+reindex` | one integrity/quarantine module | ~450 | `hermes_state_repair.py:857, hermes_cli/kanban_db_connect.py:346-569` |
| `SessionDB writer`; `delivery_ledger._connect`; `async_delegation._connect`; `a2a _state_db` | one state.db opener and schema owner | ~250 | `gateway/delivery_ledger.py:184, tools/async_delegation.py:114, plugins/platforms/a2a/adapter.py:136` |
| `SessionDB._lock`; `AsyncSessionDB proxy`; `token-writer thread` | one write thread + queue per store | ~200 | `hermes_state.py:594, :1682; hermes_state_usage.py:119` |
| `utils._atomic_write`; `10 private atomic writers`; `30 direct flock users` | JsonStateFile with update(fn) | ~300 | `utils.py:289, notes/08-state-stores.md §5a` |
| `10 version gates`; `per-open heals`; `two FTS layouts` | named migrations table | ~500 | `hermes_state_schema.py:1018-1110` |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| sqlite-utils | `.repos/sqlite-utils/sqlite_utils/db.py:538` | Database owns the connection; Table objects (db.py:1006) do per-table work by composition | STA-02 StateStore + repositories |
| sqlite-utils | `.repos/sqlite-utils/sqlite_utils/migrations.py:18` | named migrations recorded in a table, applied once | STA-06 |
| sqlite-utils | `.repos/sqlite-utils/sqlite_utils/db.py:5031` | upsert of plain records; access layer is meaning-free | STA-03 |
| datasette | `.repos/datasette/datasette/database.py:570` | one write thread per database draining a queue; readers use separate mode=ro connections | STA-08 |
| datasette | `.repos/datasette/datasette/database.py:175` | single connect(write=) applies all connection policy | STA-01, STA-04, STA-05 |
| cpython | `.repos/cpython/Lib/concurrent/futures/thread.py:17` | worker threads registered for join at interpreter exit | STA-08 write-thread shutdown |

## Answer to the seam question

No. The essential data model is about five tables: sessions, messages (with FTS5), system_prompts, session_model_usage and state_meta. A sqlite-utils-shaped access layer (one store object, repositories, named migrations) would cover them. Today the 33 files split roughly as follows. About 10.2k lines are data access in 17 mixin/helper files. About 2.7k lines are schema and migrations. About 5.6k lines are connection safety, holder scans, WAL policy, repair, health and registry, plus 1.7k lines in the facade, mostly connection lifecycle; together that is 36%. The brief's hypothesis is half right. In-process ad hoc connections were the cause of #90837, and the registry (hermes_state_registry.py) already fixed that: only about 4 writable bare SessionDB() constructions remain outside the registry. A datasette single write thread would tidy the in-process write path (STA-08) but would not delete holders, lockowners, pidns or repair. Those defend cross-process hazards: at least 4 processes (gateway, Desktop serve, CLI sessions, TUI worker, plus kanban workers) open state.db. The larger deletion is STA-01: arming NO_CKPT_ON_CLOSE on the 3.14 runtime removes the deleted-WAL-generation class that lockguard, capture and pinning defend. Removing cross-process access entirely would need one process to own state.db and serve the others over RPC, which is an XL re-architecture and not proposed here. Store count: 16 SQLite databases (state.db; kanban.db per board; projects.db; cron executions, deliveries and notepad; verification_evidence; shared-state; response_store; runs_idempotency; discord recovery; metrics; holographic memory; retaindb queue; matrix crypto; plugin-data/*), at least 30 hand-verified JSON/YAML state files, and 179 candidate state-file names as an upper bound.

Hypothesis check, with code: the brief guessed the lock/holder machinery exists because many processes open the same file with ad hoc connections. In-process, that was true and is fixed: `hermes_state_registry.py` (db339f0051, #90837) gives one writer per path, and call sites carry comments refusing bare `SessionDB()` (`hermes_cli/goals.py:603`, `hermes_cli/kanban_db_dispatch.py:2732`, `hermes_cli/cli_init_mixin.py:328`). Cross-process, it is structural: 923d86e099 names four standing processes on one state.db. The remaining ad hoc writers are the three side openers in STA-04.

## Cross-seam notes

- **01-layout** `setup.py:87`: 33 hermes_state*.py modules ship as top-level py_modules; a hermes_state/ package is the target
- **09-concurrency** `hermes_state.py:1682`: AsyncSessionDB wraps every attribute in asyncio.to_thread via __getattr__; token-writer daemon thread per SessionDB
- **09-concurrency** `hermes_state_usage.py:119`: token-writer thread with idle retirement
- **10-gateway** `gateway/run.py:3782`: gateway caches one AsyncSessionDB per profile path as a property resolved per access
- **11-plugins** `plugins/platforms/a2a/adapter.py:136`: a2a adapter writes to another profile's state.db with raw sqlite3 and UPDATE sessions
- **13-tui-cron** `cron/jobs.py:1550`: cron owns 3 SQLite DBs plus jobs.json with a hand-rolled atomic writer and its own flock
- **07-config** `hermes_state_wal.py:18`: storage layer reads config (load_config_readonly) inside WAL policy and repair
- **06-tools** `tools/environments/base.py:205`: sandbox snapshot stores written non-atomically
- **14-errors-obs** `hermes_state.py:459`: the locked-readers gate test scans 4 of 16 SessionDB class files; its docstring says 3 mixins (test code, out of scope; reported by delegated reader)
- **15-kill** `hermes_state_schema.py:1011`: superseded v11 FTS migration text kept 'only for source archaeology'

## UNVERIFIED

- UNVERIFIED: SQLite semantics for STA-01: that with SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE set, the last close skips both the checkpoint and the -wal/-shm unlink. Verify by reading sqlite3WalClose in SQLite wal.c and the pager close path, or with a live two-process repro on 3.14.
- UNVERIFIED: That no supported path imports hermes_state on a 3.11 interpreter (pyproject.toml:611 says 3.11 is an install bridge only). Verify by tracing the pre-PM updater and hermes_bootstrap.py imports.
- UNVERIFIED: Kanban worker processes each open state.db (spawn command line not traced); cron running only inside the gateway.
- UNVERIFIED: 179 JSON/YAML state-file names is a heuristic upper bound from a delegated scan; about 30 were hand-verified by that reader. I re-opened 3 (tools/environments/base.py:205, gateway/restart_loop_guard.py:56, pm/filesystem.py:67).
- UNVERIFIED: Per-module provenance (commit hashes, issue numbers, caller counts) for holders/lockguard/lockowners/pidns/guard/readpool/wal/dbfile/repair/health/maintenance/registry comes from a delegated reader (notes/08-state-locks.md); I re-read commit 75e155ab09 and the lockguard, NO_CKPT, write-path and registry code myself.
- UNVERIFIED: The locked-readers gate gap (4 of 16 files scanned) was read by the delegated reader; I did not open the test file.
- UNVERIFIED: Whether a 30 s TTL-only lease reclaim (STA-07) is acceptable product behaviour.
- UNVERIFIED: All loc_delta values are estimates from module sizes, not drafts.
- UNVERIFIED: Matrix crypto.db pragmas are owned by mautrix and were not checked.
