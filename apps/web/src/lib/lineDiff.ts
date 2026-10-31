/**
 * Line diff for the UI (script versions, config history): longest common subsequence over lines after
 * trimming the common prefix and suffix. Inputs whose changed middle is too large for the O(n·m)
 * table fall back to "all old lines removed, all new lines added" for that middle part.
 */

export type DiffLine =
  | { type: 'same'; text: string; oldNo: number; newNo: number }
  | { type: 'del'; text: string; oldNo: number }
  | { type: 'add'; text: string; newNo: number };

export type DiffRow = DiffLine | { type: 'skip'; count: number };

/** Largest LCS table (cells) computed exactly */
export const MAX_LCS_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing newline is not an extra empty line
  return lines;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 });

  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_LCS_CELLS) {
    for (let i = start; i < endA; i++) out.push({ type: 'del', text: a[i], oldNo: i + 1 });
    for (let j = start; j < endB; j++) out.push({ type: 'add', text: b[j], newNo: j + 1 });
  } else if (n > 0 || m > 0) {
    // lcs[i][j] = LCS length of a[start+i..endA) and b[start+j..endB)
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        out.push({ type: 'same', text: a[start + i], oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        out.push({ type: 'del', text: a[start + i], oldNo: start + i + 1 });
        i++;
      } else {
        out.push({ type: 'add', text: b[start + j], newNo: start + j + 1 });
        j++;
      }
    }
  }

  const shift = endB - endA; // suffix line numbers in `after` are offset by the length difference
  for (let i = endA; i < a.length; i++) out.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 + shift });
  return out;
}

export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

/** Keep `context` unchanged lines around each change; longer unchanged runs become one `skip` row. */
export function withContext(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.type === 'same') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped > 0) out.push({ type: 'skip', count: skipped });
      skipped = 0;
      out.push(l);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ type: 'skip', count: skipped });
  return out;
}
