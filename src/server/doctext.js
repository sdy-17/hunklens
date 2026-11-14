import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".text", ".json", ".yaml", ".yml", ".rst", ".adoc", ".csv", ".log", ".xml", ".js", ".ts", ".sql"]);
const OFFICE_EXT = new Set([".docx", ".doc", ".rtf", ".odt", ".rtfd", ".html", ".htm", ".webarchive"]);

/** 从上传的需求文档中抽取纯文本。文本类直接读；Office/RTF/HTML 走 macOS textutil；PDF 尝试 pypdf。 */
export function extractDocumentText(filePath, name) {
  const ext = path.extname(String(name || filePath)).toLowerCase();
  if (TEXT_EXT.has(ext)) return fs.readFileSync(filePath, "utf8");
  if (OFFICE_EXT.has(ext)) {
    try {
      return execFileSync("textutil", ["-convert", "txt", "-stdout", filePath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      throw new Error("无法解析 " + ext + " 文档（textutil 失败）");
    }
  }
  if (ext === ".pdf") {
    const script = ["import sys", "import pypdf", "r = pypdf.PdfReader(sys.argv[1])", "out = []", "for p in r.pages:", "    out.append(p.extract_text() or '')", "print('\\n'.join(out))"].join("\n");
    try {
      return execFileSync("python3", ["-c", script, filePath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      throw new Error("PDF 解析需要 python3 + pypdf（pip3 install pypdf）");
    }
  }
  // 未知扩展名：按 UTF-8 文本兜底
  return fs.readFileSync(filePath, "utf8");
}
