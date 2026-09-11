// A line diff for the Apply preview: what the file on disk says, and what it will say.
//
// The files are a few hundred lines, and the change is usually a handful of them inside one region,
// so trimming the common head and tail and running a plain LCS table on what is left is exact and
// fast. Nothing cleverer is needed, and nothing cleverer would be easier to trust.

export function splitLines(text) {
  if (text == null || text === "") return [];
  const lines = String(text).split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Every line of both texts in order, each marked " " (both), "-" (old only) or "+" (new only). */
export function diffLines(oldText, newText) {
  const A = splitLines(oldText);
  const B = splitLines(newText);
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let endA = A.length;
  let endB = B.length;
  while (endA > head && endB > head && A[endA - 1] === B[endB - 1]) { endA--; endB--; }

  const ops = [];
  for (let k = 0; k < head; k++) ops.push({ op: " ", text: A[k], a: k + 1, b: k + 1 });

  const a = A.slice(head, endA);
  const b = B.slice(head, endB);
  const n = a.length;
  const m = b.length;
  if (n * m > 4e6) {
    // Too big to be worth a table - and never the case for a generated config. Say it plainly.
    a.forEach((text, i) => ops.push({ op: "-", text, a: head + i + 1 }));
    b.forEach((text, j) => ops.push({ op: "+", text, b: head + j + 1 }));
  } else {
    const W = m + 1;
    const L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        ops.push({ op: " ", text: a[i], a: head + i + 1, b: head + j + 1 });
        i++; j++;
      } else if (i < n && (j === m || L[(i + 1) * W + j] >= L[i * W + j + 1])) {
        ops.push({ op: "-", text: a[i], a: head + i + 1 });
        i++;
      } else {
        ops.push({ op: "+", text: b[j], b: head + j + 1 });
        j++;
      }
    }
  }
  for (let k = 0; k < A.length - endA; k++) ops.push({ op: " ", text: A[endA + k], a: endA + k + 1, b: endB + k + 1 });
  return ops;
}

export function stats(ops) {
  let added = 0;
  let removed = 0;
  for (const o of ops) { if (o.op === "+") added++; else if (o.op === "-") removed++; }
  return { added, removed };
}

/** The changed lines with `context` unchanged lines around them, grouped the way `diff -u` does. */
export function hunks(ops, context = 3) {
  const ranges = [];
  ops.forEach((o, k) => {
    if (o.op === " ") return;
    const s = Math.max(0, k - context);
    const e = Math.min(ops.length - 1, k + context);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  });
  // Line numbers where each op sits, so a hunk that starts with an insertion still has an old line.
  const posA = [];
  const posB = [];
  let ca = 0;
  let cb = 0;
  for (const o of ops) {
    posA.push(ca);
    posB.push(cb);
    if (o.op !== "+") ca++;
    if (o.op !== "-") cb++;
  }
  return ranges.map(([s, e]) => {
    const lines = ops.slice(s, e + 1);
    const oldLines = lines.filter((o) => o.op !== "+").length;
    const newLines = lines.filter((o) => o.op !== "-").length;
    return {
      oldStart: oldLines ? posA[s] + 1 : posA[s],
      oldLines,
      newStart: newLines ? posB[s] + 1 : posB[s],
      newLines,
      lines,
    };
  });
}

/** A unified diff as text, for tests and for anyone who wants to paste it somewhere. */
export function unified(oldText, newText, { from = "a", to = "b", context = 3 } = {}) {
  const hs = hunks(diffLines(oldText, newText), context);
  if (!hs.length) return "";
  const out = [`--- ${from}`, `+++ ${to}`];
  for (const h of hs) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) out.push(l.op + l.text);
  }
  return out.join("\n") + "\n";
}
