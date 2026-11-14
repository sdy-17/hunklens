import { test } from "node:test"; import assert from "node:assert";
import http from "node:http"; import assert2 from "node:assert";
import { chatCompletion, chatJson, SYSTEM_PROMPT, buildHunkPrompt } from "../src/server/ai.js";
import { hunkKey, shouldAnalyze, collectHunks } from "../src/server/analyze.js";

test("chatCompletion talks to an OpenAI-compatible mock", async () => {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      assert2.equal(parsed.model, "mock-model");
      assert2.ok(parsed.messages[0].content.includes("代码审查"));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"intent":"x","severity":"info","issues":[],"suggestion":"y","confidence":0.9}' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const out = await chatCompletion(
    { baseURL: "http://127.0.0.1:" + port + "/v1", apiKey: "k", model: "mock-model" },
    [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: buildHunkPrompt({ file: "a.ts", hunk: "-1\n+2" }) }]
  );
  assert.ok(out.includes("intent"));
  srv.close();
});

test("chatJson retries on invalid JSON then succeeds", async () => {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    calls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: calls < 2 ? "not-json{{" : '{"ok":1}' } }] }));
  });
  await new Promise((r) => srv.listen(0, r));
  const out = await chatJson({ baseURL: "http://127.0.0.1:" + srv.address().port, apiKey: "k", model: "m" }, []);
  assert.equal(out.ok, 1);
  assert.ok(calls >= 2);
  srv.close();
});

test("skip patterns and hunkKey", () => {
  assert.ok(!shouldAnalyze("package-lock.json"));
  assert.ok(!shouldAnalyze("dist/bundle.min.js"));
  assert.ok(shouldAnalyze("src/app.tsx"));
  const k1 = hunkKey("r", "main", "dev", "a.ts", "@@ -1 +1 @@", ["+x"]);
  const k2 = hunkKey("r", "main", "dev", "a.ts", "@@ -1 +1 @@", ["+x"]);
  const k3 = hunkKey("r", "main", "dev", "a.ts", "@@ -1 +1 @@", ["+y"]);
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});
