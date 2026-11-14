/** 解析 unified diff 文本为 [{ file, hunks: [{ header, newStart, lines }] }] */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null, hunk = null;
  for (const line of text.split("\n")) {
    let m;
    if ((m = line.match(/^\+\+\+ b\/(.+)$/))) { cur = { file: m[1], hunks: [] }; files.push(cur); continue; }
    if ((m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/))) {
      hunk = { header: line, newStart: +m[1], lines: [] };
      if (cur) cur.hunks.push(hunk);
      continue;
    }
    if (hunk && cur && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "")) {
      hunk.lines.push(line);
    }
  }
  return files;
}
