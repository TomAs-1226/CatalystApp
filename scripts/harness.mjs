// Serve the REAL CatalystApp frontend with a stubbed Tauri behind it.
//
//   node harness.mjs <app src dir> <project dir> <port>
//
// The app runs in a plain browser by design, but everything that touches the file system is off
// there, so the editor, the tree and the panes can only be looked at, never driven. This serves the
// actual `src/` (no copy — a copy goes stale the moment an agent edits the app) and injects a
// `window.__TAURI__` whose file commands are answered from the real disk, read-only.
//
// Read-only is the point: `ws_write` reports success and writes nothing, so a design pass cannot
// damage a robot project through a browser tab.

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const appSrc = resolve(process.argv[2] || ".");
const projectDir = resolve(process.argv[3] || ".");
const port = Number(process.argv[4] || 5200);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ttf": "font/ttf", ".woff2": "font/woff2", ".map": "application/json",
};

const IGNORED = new Set([".git", "build", "bin", "node_modules", ".gradle", "target", "logs", ".idea", ".vscode"]);
const inside = (p) => resolve(p).startsWith(projectDir);

const LANGUAGES = {
  java: "java", kt: "kotlin", json: "json", gradle: "groovy", md: "markdown", xml: "xml",
  py: "python", js: "javascript", ts: "typescript", toml: "ini", properties: "ini",
};

async function tree(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    if (IGNORED.has(name)) continue;
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    out.push({ name, path, dir: s.isDirectory(), children: null });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

async function files(dir, max, found = []) {
  for (const name of await readdir(dir)) {
    if (found.length >= max || IGNORED.has(name)) continue;
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) await files(path, max, found);
    else found.push(path);
  }
  return found;
}

async function search(dir, query, max, hits = []) {
  const needle = query.toLowerCase();
  for (const name of await readdir(dir)) {
    if (hits.length >= max || IGNORED.has(name)) continue;
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) { await search(path, query, max, hits); continue; }
    if (s.size > 2 * 1024 * 1024) continue;
    const text = await readFile(path, "utf8").catch(() => null);
    if (!text) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (hits.length < max && line.toLowerCase().includes(needle)) {
        hits.push({ path, line: i + 1, text: line });
      }
    });
  }
  return hits;
}

const json = (res, body) => {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/__fs/tree") return json(res, await tree(url.searchParams.get("dir")));
    if (url.pathname === "/__fs/files") return json(res, await files(url.searchParams.get("dir"), 4000));
    if (url.pathname === "/__fs/search") {
      return json(res, await search(url.searchParams.get("dir"), url.searchParams.get("q") || "", 200));
    }
    if (url.pathname === "/__fs/read") {
      const path = url.searchParams.get("path");
      if (!inside(path)) throw new Error("outside the project");
      const text = await readFile(path, "utf8");
      const ext = extname(path).slice(1).toLowerCase();
      return json(res, { path, text, language: LANGUAGES[ext] || "plaintext" });
    }
    if (url.pathname === "/__fs/project") return json(res, { dir: projectDir });
    if (url.pathname === "/__fake-tauri.js") {
      res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
      return res.end(await readFile(new URL("./fake-tauri.js", import.meta.url)));
    }

    let path = join(appSrc, normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, ""));
    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) { path = join(path, "index.html"); info = await stat(path).catch(() => null); }
    if (!info) { res.writeHead(404).end("not found: " + url.pathname); return; }

    if (path.endsWith(`${sep}index.html`) || path.endsWith("/index.html")) {
      // The stub has to be in place before app.js evaluates: core.js reads window.__TAURI__ at
      // module scope, and a module added after it would be a stub nobody ever sees.
      const html = (await readFile(path, "utf8"))
        .replace("</head>", '  <script src="/__fake-tauri.js"></script>\n</head>');
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      return res.end(html);
    }

    res.writeHead(200, {
      "content-type": TYPES[extname(path).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(await readFile(path));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
  }
}).listen(port, () => {
  console.log(`harness: ${appSrc}`);
  console.log(`project: ${projectDir}`);
  console.log(`http://localhost:${port}`);
});
