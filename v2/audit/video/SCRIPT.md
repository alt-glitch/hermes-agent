# SCRIPT — hermes-agent code health walkthrough

Generated from scripts/storyboard_src.py. Edit there, not here.

## Cold open: what was audited (Frame 1)

**words:** 82

    Hermes Agent runs one agent core behind a command line, a terminal UI, a desktop app, twenty messaging platforms and a cron scheduler. The Python behind the parts a user actually runs is about eight hundred and four thousand lines. We read all of it against fifteen questions and recorded one hundred and seventy-three structural findings. This video shows where the code lives, what is wrong with it, what other well-run Python projects do instead, and the order to fix it in.

## Scope: what counts and what does not (Frame 2)

**words:** 65

    First, the boundary. In scope: the agent package, the tools, the hermes CLI package, the messaging gateway, the T U I backend, cron, plugins, and P M, the package manager. Out of scope on purpose: the desktop app, tests, scripts, evals, the training environments and the skills. Those either do not run when you use Hermes, or they have owners and rules of their own.

## Method: fifteen readers, references, IDs (Frame 3)

**words:** 101

    Fifteen readers each took one area, read the code against the repository's own rules, and compared it with reference projects: Simon Willison's L L M and datasette, Hynek's attrs, structlog, svcs and stamina, H T T P X, pydantic A I, Home Assistant, any I O, pluggy, inspect A I and pydantic settings. Every finding has an I D: three letters for the area and a number, such as C F G for config or L A Y for layout. Each one carries a file and line, the change that fixes it, and the reference file that shows the target shape.

## Where the code lives (Frame 4)

**words:** 71

    Here is where the code lives. The hermes CLI package is the largest, at two hundred and sixty thousand lines. Then agent at one hundred and thirty-two thousand, tools at one hundred and twenty-two thousand, gateway at ninety-five thousand and plugins at eighty-two thousand. The T U I backend is forty-three thousand, cron eighteen thousand and P M twelve thousand. Another thirty thousand lines are loose modules in the repository root.

## One request, end to end (Frame 5)

**words:** 83

    A request always takes the same path. A surface receives it: the command line, the T U I, a Telegram or Discord message, a cron tick, the dashboard, or an editor over A C P. The surface builds an A I Agent, defined in run agent dot p y, and calls run conversation. The agent calls a model, runs tools, and writes the transcript to SQLite through a class called Session D B. Each of those boxes is where this audit found problems.

## Inside one turn (Frame 6)

**words:** 75

    Inside the agent, one turn is a loop in conversation loop dot p y. Each phase has its own file: turn preflight, turn A P I call, turn tool round, turn final response, turn finalizer. Tool calls go through tool executor dot p y. The system prompt is built once by prompt builder and has to stay byte-identical for the whole conversation, because prompt caching depends on it. Context compression is the one allowed exception.

## hermes_cli is not a CLI (Frame 7)

**words:** 52

    The hermes CLI package looks like the command line code. Only twenty-three percent of it is. Thirty-one percent is core library that the agent, tools and gateway import at runtime: config, auth, providers, plugins and profiles. Thirty-six percent is servers and services: the dashboard backend, the updater, kanban, and gateway service management.

## The gateway and its adapters (Frame 8)

**words:** 75

    The messaging gateway starts in gateway slash run dot p y. Its main class, Gateway Runner, is assembled from eighteen mixins with nine hundred and fifty-nine methods. Each platform is an adapter on top of a shared base class in gateway slash platforms slash base dot p y. The biggest adapters live in plugins slash platforms: Discord at seven thousand five hundred lines, Telegram at seven thousand four hundred, Slack at six thousand nine hundred.

## State, TUI, cron and PM (Frame 9)

**words:** 83

    Four more systems complete the map. Sessions and messages live in a SQLite file, state dot d b, behind Session D B, which is spread across thirty-three hermes state modules in the repository root. The T U I and the desktop app talk JSON R P C to the T U I gateway's server module. Cron runs jobs from cron slash scheduler dot p y. And P M owns Python environments: every install, update and optional dependency ends in one function, sync venv.

## LAY-01: one import cycle (Frame 10)

**words:** 67

    Now the findings. L A Y zero one: the packages have no layers. Draw an arrow every time one package imports another, and sixteen of seventeen package groups end up in a single cycle. The code avoids failing at import time by moving imports inside functions. There are fourteen thousand and eighteen of them. You cannot read, test or extract any one package without loading the rest.

## LAY-02: the CLI package is the core (Frame 11)

**words:** 69

    L A Y zero two is the root of that cycle. Code below the command line imports one hundred and fourteen hermes CLI modules. The config module alone is imported at about eight hundred and fifty places, and it imports agent dot secret scope back. Six library modules even insert the repository root into sys dot path when they are imported, cron slash scheduler dot p y among them.

## Smaller files, same god objects (Frame 12)

**words:** 75

    L A Y zero four and A G T zero one. The September refactor split every large file into a facade plus topic files. The files got smaller. The objects did not. A I Agent has three hundred and seventy-one attributes, written from fifty-seven files. The CLI class has seventeen mixins, Gateway Runner eighteen, Session D B fifteen. The topic files reach back into the facade on purpose, so that tests can patch names there.

## TUI-01: bind_module (Frame 13)

**words:** 77

    T U I zero one is the extreme case. A function called bind module copies every handler from forty-five sibling modules onto server dot p y and swaps their globals. The handlers then call helpers like underscore ok and underscore err without importing them. Ruff reports about two thousand seven hundred undefined names in that package. The first fix is mechanical: rewrite those calls as explicit reads from the server module, which keeps every test patch working.

## Reference: typed run state, svcs containers (Frame 14)

**words:** 74

    Compare pydantic A I. Its agent loop passes two typed dataclasses to every step: Graph Agent State for what changes during a run, and Graph Agent Deps for what does not. svcs gives each request a container that hands out typed services, so a test replaces a service instead of patching a module global. Hermes already groups the agent's state into five tables inside init agent. It then flattens them back onto the object.

## CFG-01: a profile is not an object (Frame 15)

**words:** 80

    C F G zero one, rated critical. A profile is a home directory with its own config, secrets and terminal policy. In the code, which profile a piece of work belongs to is spread over six context variables, three process globals and O S dot environ. Seven hand-written binders each set a different subset. This is the largest bug class in the repository's history: three hundred and sixty-six fix commits and three hundred and five issues about the wrong profile.

## Fix: one ProfileScope value (Frame 16)

**words:** 70

    The fix is one value. A frozen Profile Scope holding the home, the settings, the secrets and the terminal policy, built by one factory and bound by one context variable. Code reads scope dot settings and scope dot secret. O S dot environ stops being a way to pass configuration. structlog's contextvars module shows the binding pattern, and svcs shows how a per-scope container opens and closes as a unit.

## CFG-02 / CFG-03: config is a dictionary (Frame 17)

**words:** 74

    C F G zero two. Config is a dictionary. DEFAULT CONFIG describes it by example, and more than ten side tables fill in the gaps. Readers call load config four hundred and ninety-six times and guard every read with dot get. C F G zero three shows what that costs. The classic command line keeps its own defaults table, which caps a turn at five hundred iterations, while every other surface defaults to unlimited.

## Reference: pydantic-settings (Frame 18)

**words:** 60

    pydantic settings shows the target. One typed model per section. Defaults and types are declared once, on the class. Sources are one ordered list: defaults, then the file, then overrides. Model fields set tells you whether the user set a value, which removes the need for a second loader that skips defaults. pydantic is already a core dependency of Hermes.

## PRV-01 / PRV-02: no model interface (Frame 19)

**words:** 76

    P R V zero one and zero two, both critical. There is no model interface. The main loop chooses the wire format with A P I mode comparisons in one hundred and two places across twenty-eight files. Side tasks such as titles and compression go through auxiliary client dot p y, eight thousand four hundred lines with its own resolver, client cache, retries and fallback. The main agent builds its own client through that file too.

## TLS-01 / CLI-01: tools and commands (Frame 20)

**words:** 72

    The same gap shows up for tools and commands. T L S zero one: a tool can come from seven sources, and the two dispatchers check those sources in different orders. C L I zero one: a slash command is a method on four different objects, so slash help has four implementations, and the T U I runs some commands inside a hidden copy of the CLI and replays what they did.

## Reference: Model, toolsets, commands as data (Frame 21)

**words:** 65

    pydantic A I defines a Model base class with two methods, request and request stream, and one subclass per wire format. Fallback is itself a Model that wraps other models. Tools come in toolsets that can be combined and filtered, and every tool call receives a run context. Textual treats a command as data and a callback; the command palette only lists and runs it.

## Registries copied by hand (Frame 22)

**words:** 85

    Where a registry does exist, other code copies it by hand. C L I zero two: the command registry is restated by about twenty-six lists of slash names, and they already disagree. A C P accepts slash reset but not slash new. T L S zero three: the browser tools register under toolset names the table does not know. In L L M, a command's name, help and handler are declared once, on the function, and plugins add commands through one hook. Nothing restates them.

## CON-01 / CON-02: nothing owns threads or shutdown (Frame 23)

**words:** 76

    C O N zero one and zero two. Nothing owns threads or shutdown. There are two hundred and forty-six bare thread constructions, two hundred and forty-three of them daemon threads, and one hundred and twenty-six are started and never referenced again. Each runtime keeps its own hand-written teardown list and then calls O S underscore exit. Gateway stop alone is two thousand three hundred lines of phase ordering and about fifteen counters of work in progress.

## Reference: Home Assistant stages, anyio task groups (Frame 24)

**words:** 73

    Home Assistant handles this with one rule. Work is registered with the core, and the core stops it in named stages, each with a timeout, logging whatever is still running. Subsystems add their own shutdown jobs. any I O adds task groups and a blocking portal for crossing between threads and the event loop. The proposal for Hermes is one lifecycle module with four stages, and one owned way to start a thread.

## ERR-01 / ERR-03: errors as strings, retries by hand (Frame 25)

**words:** 85

    E R R zero one and zero three. Errors are turned into strings and parsed again downstream by at least nine substring classifiers that use five different vocabularies. There are about ninety-five hand-written retry loops, while tenacity is pinned as a core dependency that nothing imports. stamina wraps that same library in one retry context with a typed on condition and a switch for tests. And where H T T P X uses one configured client, Hermes builds clients in one hundred and one places.

## STA-01 / STA-05: storage (Frame 26)

**words:** 99

    S T A zero one. The storage code is about twenty thousand lines, and about a third of it is connection safety and recovery. The largest part guards against SQLite deleting the write-ahead log of a live process. It was written for Python three point eleven, which cannot set the flag that prevents this. Hermes only runs on three point fourteen, where one connection setting should replace most of it. That needs a two-process test before anything is deleted. S T A zero five: kanban, cron and plugins each re-implement the same SQLite setup, and three write-transaction helpers disagree.

## Reference: sqlite-utils and datasette (Frame 27)

**words:** 58

    sqlite utils keeps the connection policy on one Database object that every table uses. datasette opens every connection in one function and sends all writes through one writer thread. Applied to Hermes: one connection factory and one write-transaction helper for every SQLite file the product owns, and kanban, cron and plugins call it instead of carrying their own.

## PM: a good core, an inverted shell (Frame 28)

**words:** 95

    P M, the package manager, has a good core: a pinned, hash-checked tool store and one place that builds u v commands. The layer around it is inverted. P M C zero two: the worker interface is written out in three files that must match by hand. P M F zero one: P M syncs and the updater both write the same latest dot JSON, so a lazy text-to-speech install replaces the update record the dashboard shows. P M F zero seven: the update lock checks and then writes, so it is not a lock.

## Fix: the PM target shape (Frame 29)

**words:** 70

    The target is small: one Install value, one Store, one Generations primitive and one operation registry, behind a public A P I of six names. Home Assistant installs an integration's requirements once, under a lock, through one function. jupyter client sends every message through one typed envelope, which would replace the three hand-mirrored worker files. And one product decision unlocks the largest deletion: the oldest release the updater still supports.

## Kill list: code that should leave (Frame 30)

**words:** 75

    Some code should leave the tree. K I L ten: about two thousand four hundred lines of research and data-generation runners, such as batch runner and trajectory compressor, are installed as top-level Python modules next to the product. Four vendor plugins sit in the tree against the repository's own rule. The truly dead code is small: seven functions and a few modules nothing imports, about eight hundred and fifty lines once test-only code is counted.

## The same helper, dozens of times (Frame 31)

**words:** 82

    Canonical helpers exist, and most code does not use them. Atomic file writes are re-implemented about fifty-three times next to the shared helper in utils, most of them with fixed temporary names and no fsync. There are thirty-one private true-or-false parsers, and forty-four inline checks ignore the word on, including one that gates allowing all users. Twenty-four git wrappers bypass the shared one, and three have no timeout. One callback re-implements the S S R F check without resolving D N S.

## What the reference projects share (Frame 32)

**words:** 61

    Across the reference projects, the same five habits repeat. A small core with a short public surface. Typed values for state and config. One registry per concept, with plugins adding entries through hooks. Lifecycles that are owned and stopped in stages. Policies such as retries and H T T P timeouts, decided once. Today Hermes does none of these by default.

## Order of work (Frame 33)

**words:** 91

    The order matters. First, land the maintainer's ratchet engine, so that nothing in the following steps can regress. Then delete code that has no callers. Then fix the hazards this audit found: the update records, the update lock, the CLI turn cap and the duplicated S S R F check. Then collapse the duplicates. In the second month, introduce the typed boundaries, starting with Profile Scope and Hermes Settings. The re-architecture comes last: a model interface, one tool abstraction, a command layer that every surface shares, and a typed adapter contract.

## Close: six missing pieces (Frame 34)

**words:** 64

    Most of the code's size comes from duplication around six missing pieces: a profile object, typed config, a model interface, a tool abstraction, a shared command layer and a typed adapter contract. Add them, and most of the duplicates become mechanical to remove. Every finding, flow and reference in this video is in the audit page and the lab directory, with file and line.
