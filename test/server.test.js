import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { fakeJpeg } from "./helpers.js";

// The app talks to a fake Foundry endpoint, so the tests never call the real model.
const PORT = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
const upstream = [];
let foundry;
let server;

before(async () => {
  foundry = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      upstream.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "microsoft-decision-1.1",
          answers: {
            aura: { type: "noul", noul: 0.9 },
            level: { type: "score", score: 3.2, probabilities: { 3: 0.8, 4: 0.2 } },
            move: { type: "choice", choice: "boat_kid_wave", probabilities: { boat_kid_wave: 0.7 } },
          },
          usage: { input_tokens: 1160, output_tokens: 3 },
        }),
      );
    });
  });
  await new Promise((resolve) => foundry.listen(0, "127.0.0.1", resolve));

  server = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      FOUNDRY_ENDPOINT: `http://127.0.0.1:${foundry.address().port}`,
      FOUNDRY_DEPLOYMENT: "decision-1.1",
      FOUNDRY_API_KEY: "test-key",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => String(chunk).includes("running at") && resolve());
    server.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
});

after(() => {
  server.kill();
  foundry.close();
});

const post = (body, headers = { Origin: base }) =>
  fetch(`${base}/api/aura`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

describe("server", () => {
  it("serves the app with a locked-down page policy, but never .env, the server or lib/", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(page.headers.get("permissions-policy"), /camera=\(self\)/);
    for (const path of ["/app.js", "/style.css"]) assert.equal((await fetch(base + path)).status, 200, path);
    for (const path of ["/.env", "/server.js", "/lib/aura.js", "/package.json", "/public/app.js", "/%2e%2e/.env"]) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
  });

  it("only takes aura checks from the app's own page", async () => {
    assert.equal((await post("{}", {})).status, 403);
    assert.equal((await post("{}", { Origin: "https://evil.example" })).status, 403);
    assert.equal(upstream.length, 0);
  });

  it("sends the frames to the model as image assets and returns the verdict", async () => {
    const frame = fakeJpeg(427, 320).toString("base64");
    const res = await post(JSON.stringify({ frames: [frame, frame] }));
    assert.equal(res.status, 200);
    const verdict = await res.json();
    assert.equal(verdict.found, true);
    assert.equal(verdict.points, 720);
    assert.equal(verdict.levelName, "Main character");
    assert.equal(verdict.move, "boat_kid_wave");

    const [call] = upstream;
    assert.equal(call.url, "/providers/microsoft/v1/systemone");
    assert.equal(call.headers["api-key"], "test-key");
    assert.equal(call.body.model, "decision-1.1");
    assert.deepEqual(Object.keys(call.body.assets), ["frame1.jpg", "frame2.jpg"]);
    assert.deepEqual(Object.keys(call.body.questions), ["aura", "level", "move"]);
  });

  it("rejects bad frames without calling the model", async () => {
    const calls = upstream.length;
    assert.equal((await post(JSON.stringify({ frames: [] }))).status, 400);
    assert.equal((await post(JSON.stringify({ frames: [fakeJpeg(200, 150).toString("base64")] }))).status, 400);
    assert.equal((await post("frames", { Origin: base, "Content-Type": "text/plain" })).status, 415);
    assert.equal(upstream.length, calls);
    assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), {
      configured: true,
      model: "Microsoft-Decision-1.1 (decision-1.1)",
      keySource: "FOUNDRY_API_KEY",
    });
  });
});
