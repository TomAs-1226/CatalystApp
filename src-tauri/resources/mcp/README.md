# Catalyst MCP server

A small stdio server that gives an AI agent three things: Catalyst's own tools, a knowledge graph of
the Catalyst library, and the ability to build and query a knowledge graph of **your** project.

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

**Source**

| | |
|---|---|
| `catalyst_source_search` | Regex with context, skipping build output and binaries |
| `catalyst_source_read` | A file, or just the part around one symbol |

The intended order is graph first, source second: ask the graph where something lives, then read
only that. It is much cheaper than grepping a repository blind.

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
