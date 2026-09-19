#!/usr/bin/env python3
"""Build a graphify knowledge graph for a project, structurally, with no LLM and no network.

Called by the Catalyst MCP server's `catalyst_graph_build` tool. It is a thin driver over
graphify's own functions - detect, extract, build, cluster, export - rather than a reimplementation
of them, so the graph it writes is the same shape graphify writes for itself and every reader
downstream (graphify's own CLI, its MCP server, the Catalyst MCP server) can read it.

Structural only: the AST pass over code files. graphify's full pipeline also has a semantic pass
that reads docs and papers through an LLM, and that is deliberately not done here - an MCP tool
that quietly spent an agent's tokens on a hundred files would be a bad surprise. Code is where the
structure is, and the AST pass is free, deterministic and offline.

Usage:  build_graph.py <project-root> [--out <graphify-out dir>] [--json]
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


def git_commit(root: Path):
    """The commit this graph describes, when the project is a git repo."""
    try:
        out = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=10)
        return out.stdout.strip() or None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--out", default=None, help="output directory (default <root>/graphify-out)")
    ap.add_argument("--json", action="store_true", help="emit a machine-readable summary")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2

    out_dir = Path(args.out).resolve() if args.out else root / "graphify-out"
    out_dir.mkdir(parents=True, exist_ok=True)
    graph_path = out_dir / "graph.json"

    started = time.time()
    try:
        from graphify.detect import detect
        from graphify.extract import collect_files, extract
        from graphify.build import build
        from graphify.cluster import cluster, label_communities_by_hub
        from graphify.export import to_json
    except ImportError as e:
        print(f"graphify is not importable from this interpreter: {e}", file=sys.stderr)
        return 3

    # What is here. detect() classifies by type; only code goes through the AST pass.
    found = detect(root, cache_root=out_dir)
    code = found.get("files", {}).get("code", [])
    if not code:
        msg = (f"no code files under {root}. detect() saw: "
               + ", ".join(f"{k} {len(v)}" for k, v in found.get("files", {}).items() if v))
        print(msg, file=sys.stderr)
        return 4

    # collect_files expands directories; detect already returns files, but a mixed list is fine.
    paths = []
    for f in code:
        p = Path(f)
        paths.extend(collect_files(p, root=root) if p.is_dir() else [p])

    extraction = extract(paths, cache_root=out_dir, root=root)
    graph = build([extraction], root=root)
    communities = cluster(graph)
    labels = label_communities_by_hub(graph, communities)
    to_json(graph, communities, str(graph_path), force=True,
            built_at_commit=git_commit(root), community_labels=labels)

    summary = {
        "ok": True,
        "root": str(root),
        "graph": str(graph_path),
        "files": len(paths),
        "nodes": graph.number_of_nodes(),
        "edges": graph.number_of_edges(),
        "communities": len(communities),
        "seconds": round(time.time() - started, 1),
        "note": "structural (AST) pass only - no LLM, no network",
    }
    if args.json:
        print(json.dumps(summary))
    else:
        print(f"Built {summary['nodes']} nodes and {summary['edges']} edges from {summary['files']} "
              f"code files in {summary['seconds']}s -> {graph_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
