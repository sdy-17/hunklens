/** 解析 unified diff 文本为 [{ file, hunks: [{ header, newStart, lines }] }]
 *  注意：diff 文本以换行结尾时 split 会产生一个末尾空串，它不是 diff 行，必须丢弃，
 *  否则会渲染出一行幽灵空行（并让 AI 多分析一行）。 */
export function parseUnifiedDiff(text) {
  const files = [];
  const rows = text.split("\n");
  let cur = null, hunk = null;
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i];
    const isLast = i === rows.length - 1;
    let m;
    if ((m = line.match(/^\+\+\+ b\/(.+)$/))) { cur = { file: m[1], hunks: [] }; files.push(cur); continue; }
    if ((m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/))) {
      hunk = { header: line, newStart: +m[1], lines: [] };
      if (cur) cur.hunks.push(hunk);
      continue;
    }
    if (!hunk || !cur) continue;
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || (line === "" && !isLast)) {
      hunk.lines.push(line);
    }
  }
  return files;
}
