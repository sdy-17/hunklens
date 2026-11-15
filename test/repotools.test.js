import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  searchRepo,
  findDefinition,
  readFileSlice,
  identifiersFromHunk,
  importLinks,
  relatedContext,
  localToolSpecs,
  runLocalTool,
} from "../src/server/repotools.js";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** 一个小仓库：服务 -> 仓储层 -> 工具层，用来验证「跨文件找关联业务代码」 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunklens-repo-"));
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "order-store.js"), [
    "export function createOrderStore(db) {",
    "  const store = { db };",
    "  store.saveOrder = (order) => db.insert(order);",
    "  return store;",
    "}",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "src", "order-service.js"), [
    'import { createOrderStore } from "./order-store.js";',
    "",
    "export function submitOrder(db, order) {",
    "  const store = createOrderStore(db);",
    "  return store.saveOrder(order);",
    "}",
    "",
    "export class OrderService {",
    "  constructor(db) { this.db = db; }",
    "  submit(order) { return submitOrder(this.db, order); }",
    "}",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "src", "checkout.ts"), [
    'import { OrderService } from "./order-service.js";',
    "export function checkout(db, cart) {",
    "  const service = new OrderService(db);",
    "  return service.submit(cart);",
    "}",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = submitOrder;\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "submitOrder 的调用方还没迁移\n");
  // 本地缓存目录就算被误提交进仓库，也不该污染上下文
  fs.mkdirSync(path.join(dir, ".npmcache", "_cacache"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".npmcache", "_cacache", "noise.js"), "export const submitOrder = 1;\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

test("searchRepo 只扫已跟踪文件，跳过 node_modules", async () => {
  const repo = fixture();
  try {
    const rows = await searchRepo(repo, { query: "submitOrder" });
    const files = rows.map((r) => r.file);
    assert.ok(files.includes("src/order-service.js"));
    assert.ok(files.includes("notes.txt"), "普通文本文件里的调用方说明也该被搜到");
    assert.ok(files.every((f) => !f.startsWith("node_modules/")));
    assert.ok(!files.some((f) => f.includes(".npmcache")), "误提交的缓存目录不该进上下文");
    assert.ok(rows.every((r) => r.line > 0 && r.text.length > 0));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("searchRepo 按词匹配，不给前缀噪声；空查询返回空", async () => {
  const repo = fixture();
  try {
    const exact = await searchRepo(repo, { query: "submit" });
    assert.ok(exact.length > 0);
    // notes.txt 里只有 submitOrder，没有独立的 submit：按词匹配就不该命中它
    assert.ok(exact.every((r) => r.file !== "notes.txt"), "按词匹配，submit 不应命中 submitOrder");
    assert.deepEqual(await searchRepo(repo, { query: "" }), []);
    const scoped = await searchRepo(repo, { query: "checkout", include: "src/" });
    assert.ok(scoped.every((r) => r.file.startsWith("src/")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("readFileSlice 带行号、按需截取，并拒绝仓库外路径", () => {
  const repo = fixture();
  try {
    const slice = readFileSlice(repo, "src/order-service.js", { start: 3, lines: 3 });
    assert.equal(slice.from, 3);
    assert.equal(slice.to, 5);
    assert.equal(slice.total, 11);
    assert.match(slice.text.split("\n")[0], /^\s*3\| export function submitOrder/);
    assert.throws(() => readFileSlice(repo, "../../etc/passwd"), /仓库内/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("identifiersFromHunk 优先挑业务符号，过滤语言关键字与常见变量名", () => {
  const syms = identifiersFromHunk([
    "+  const store = createOrderStore(db);",
    "+  return store.saveOrder(order);",
    "-  return submitOrder(db, order);",
  ]);
  assert.ok(syms.includes("createOrderStore"));
  assert.ok(syms.includes("saveOrder"));
  assert.ok(syms.includes("submitOrder"));
  for (const noise of ["const", "return"]) {
    assert.ok(!syms.includes(noise), noise + " 不该被当作业务符号");
  }
  // 定义 + 调用点权重大：出现在被调用位置（后跟括号）的符号排在最前
  assert.deepEqual(syms.slice(0, 2), ["createOrderStore", "saveOrder"]);
});

test("importLinks 解析相对 import 并读出导出名", () => {
  const repo = fixture();
  try {
    const lines = fs.readFileSync(path.join(repo, "src", "order-service.js"), "utf8").split("\n");
    const links = importLinks(repo, "src/order-service.js", lines);
    assert.equal(links.length, 1);
    assert.equal(links[0].file, "src/order-store.js");
    assert.ok(links[0].exports.includes("createOrderStore"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("relatedContext 把同一改动牵动的其它文件片段拼给模型", async () => {
  const repo = fixture();
  try {
    const lines = [
      "+  const store = createOrderStore(db);",
      "+  return store.saveOrder(order);",
    ];
    const rel = await relatedContext(repo, "src/order-service.js", lines, {
      fileLines: fs.readFileSync(path.join(repo, "src", "order-service.js"), "utf8").split("\n"),
    });
    assert.ok(rel.symbols.includes("createOrderStore"));
    assert.ok(rel.files.includes("src/order-store.js"));
    assert.match(rel.text, /order-store\.js:\d+-\d+/);
    assert.match(rel.text, /本文件依赖的模块/);
    assert.ok(rel.text.length <= 3200 + 600, "总长度受 budget 约束");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("relatedContext 只命中改动文件自身时返回空字符串", async () => {
  const repo = fixture();
  try {
    const rel = await relatedContext(repo, "src/order-service.js", ["+  // nothingToSeeHere12345"]);
    assert.equal(rel.text, "");
    assert.equal(rel.files.length, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("findDefinition 只留下定义行，不做无谓命中", async () => {
  const repo = fixture();
  try {
    const rows = await findDefinition(repo, "OrderService");
    assert.equal(rows.length, 1);
    assert.match(rows[0].text, /export class OrderService/);
    assert.deepEqual(await findDefinition(repo, "noSuchSymbolAnywhere"), []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("localToolSpecs / runLocalTool 契约一致（名字、必填参数、可读输出）", async () => {
  const repo = fixture();
  try {
    const specs = localToolSpecs();
    assert.deepEqual(specs.map((s) => s.function.name), ["search_repo", "read_file", "find_definition"]);
    assert.ok(specs.every((s) => s.function.description && s.function.parameters.type === "object"));

    const hit = await runLocalTool(repo, "search_repo", { query: "submitOrder" });
    assert.match(hit, /src\/order-service\.js:\d+/);

    const listed = await runLocalTool(repo, "find_definition", { symbol: "submitOrder" });
    assert.match(listed, /export function submitOrder/);

    const read = await runLocalTool(repo, "read_file", { path: "src/order-store.js", lines: 2 });
    assert.match(read, /共 5 行/);

    assert.equal(await runLocalTool(repo, "search_repo", { query: "zzzNothingHere" }), "没有匹配结果");
    assert.match(await runLocalTool(repo, "read_file", { path: "../outside.txt" }), /读取失败/);
    await assert.rejects(() => runLocalTool(repo, "rm_rf", {}), /未知工具/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
