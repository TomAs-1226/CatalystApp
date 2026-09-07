# Catalyst MCP server

A small stdio server that gives an AI agent four things: Catalyst's own tools, the Catalyst
documentation, a knowledge graph of the library, and the ability to build and query a knowledge graph
of **your** project - plus a door to the projects you have imported into the app.

No npm dependencies, no network. Plain Node reading plain JSON.

```json
{
  "mcpServers": {
    "catalyst": { "command": "node", "args": ["<path to>/resources/mcp/server.js"] }
  }
}
```

The desktop app shows the real path on its **Connect an AI agent** page, ready to copy.

## Why this exists when graphify has its own MCP server

graphify does ship one (`graphify-mcp`), and when it runs it is good. On a stock `uv tool install`
it can fail at startup with `ModuleNotFoundError: No module named 'mcp'`, because the tool's virtual
environment has no MCP package in it. A graph reader that will not start is worth nothing at the
moment an agent needs it.

This server has no dependency that can be missing. It also does two things graphify's does not:

- it **builds** a graph, not only serves an existing one, and
- it reads the bundled Catalyst graph and your project's graph through the same tools, so an agent
  does not need to know which shape it is holding.

If graphify's own server works for you, use it for graph reading. This one still carries the
Catalyst tools and the builder.

## Tools

**Catalyst**

| | |
|---|---|
| `catalyst_motor_specs` | MotorType specs, or the whole list |
| `catalyst_gear_calc` | Output speed and torque through a reduction |
| `catalyst_build_mechanism` | Ready-to-paste Java for a mechanism config |
| `catalyst_can_conflicts` | Duplicate CAN ids, per bus |

**Documentation** — 31 pages bundled with the app, so they are there whether or not a library
checkout is on the machine.

| | |
|---|---|
| `catalyst_docs_search` | Find the intended API. Search this *before* writing Catalyst code |
| `catalyst_docs_read` | A whole page, one section of it, or the list of pages |

A multi-word query must match every term to count as a hit, and pages that use the terms close
together rank above pages that merely contain all of them. An OR-ed query reported 26 of 30 pages,
which is the same as reporting nothing.

**Knowledge graph** — every one takes an optional `graph:` argument: a project root, a
`graphify-out` directory, a path to a `graph.json`, or `"bundled"` (the default) for the shipped
Catalyst graph.

| | |
|---|---|
| `catalyst_graph_overview` | Size, areas, and the most-connected nodes. Start here. |
| `catalyst_graph_search` | Find something by name; returns file and line |
| `catalyst_graph_neighbors` | What it connects to, grouped by relation |
| `catalyst_graph_path` | The shortest chain between two things |
| `catalyst_graph_file` | What a file defines, and what it reaches outside itself |
| `catalyst_graph_build` | Build or refresh a project's graph |

**Your projects** — the app's Projects page registers them; this server reads that registry.

| | |
|---|---|
| `catalyst_projects` | Where the user's projects are, and whether you may write |
| `catalyst_project_files` | A project's source files |
| `catalyst_write_file` | Write a file, inside a granted project only |
| `catalyst_edit_file` | Replace exact text, refusing anything ambiguous |

**Source**

| | |
|---|---|
| `catalyst_source_search` | Regex with context, skipping build output and binaries |
| `catalyst_source_read` | A file, or just the part around one symbol |

The intended order is projects, docs, graph, source - and the server says so at connect time, in
MCP's `instructions` field, because that is the only place to tell an agent anything before it has
called a tool. Ask the graph where something lives, then read only that; it is much cheaper than
grepping a repository blind.

The instructions also name the renames that catch a model out. Catalyst 2.x is a WPILib 2027 /
Commands v3 library, and 1.x is what dominates the training data: an agent writing from memory
reaches for `SubsystemBase`, `CommandScheduler.getInstance()`, `ChassisSpeeds` and
`Timer.getFPGATimestamp()`, none of which exist here.

## Writing to the user's code

Reading is always allowed. Writing has exactly three rules, and they are small on purpose:

1. The path must resolve **inside** a registered project root. Containment is checked against the
   resolved real path, so `..` and symlinks are caught by the same test rather than by special cases.
2. That project's **let agents write** switch must be on. It defaults to off, and the only thing that
   turns it on is a person clicking it in the app.
3. Even inside a granted project, `.git`, `build`, `target`, `node_modules`, `.gradle` and
   `graphify-out` are refused. Nothing an agent legitimately edits lives there.

The app is where consent is given, `projects.json` is where it is recorded, and this server refuses
anything the registry does not cover. `catalyst_edit_file` additionally refuses an edit whose target
text is missing or appears more than once — an ambiguous edit is the one that silently lands in the
wrong place.

## Building a graph

`catalyst_graph_build` runs the **structural** pass only — graphify's AST extraction over code
files. No LLM, no network, no token cost, and a few seconds for a mid-sized repository. graphify's
full pipeline also reads docs and papers through a language model; an MCP tool that quietly spent an
agent's budget on a hundred files would be a bad surprise, so that is left to `/graphify` itself.

It needs graphify installed for some Python the server can find (`uv tool install graphifyy`, or
`pip install graphifyy`). Without it, the tool says so plainly and the reading tools still work on
any `graph.json` that already exists.

The builder is `build_graph.py`, a thin driver over graphify's own `detect`, `extract`, `build`,
`cluster` and `export` — not a reimplementation — so the file it writes is the same shape graphify
writes for itself, and graphify's own CLI and MCP server can read it.

## The bundled graph

`data/graph.json` is a structural graph of the Catalyst library source, refreshed when the app is
released, with areas named by Java package. It is reachable only through this server and is never
shown in the app UI.

Honest note: it is a plain file on disk, so a determined user could open it. "Agent-only" means
served through the agent channel rather than surfaced in the UI — not cryptographically secret.

## `package.json`

The one in this directory exists only to declare `"type": "commonjs"`. The app's own `package.json`
above it declares `"type": "module"`, which would otherwise make every `.js` here an ES module and
break `require` — the server runs fine from an installed app, where no such file is above it, and
fails when run from the repository. One file removes the difference.
