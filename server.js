// Aura Farming server: serves the web app and asks Microsoft-Decision-1.1 on Microsoft Foundry whether the
// player in the webcam frames is aura farming. Credentials never reach the browser, and frames are never
// stored or logged: each one lives only for the request that carries it.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuraInputError, buildAuraRequest, MAX_FRAME_BYTES, MAX_FRAMES, readAura } from "./lib/aura.js";
import { createDecisionClient, DecisionError, MODEL_NAME } from "./lib/decisions.js";
import { foundryAuth, resolveFoundryConfig } from "./lib/foundry.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  // Optional, git-ignored settings (FOUNDRY_ENDPOINT, ...). Real environment variables win.
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
}

const PORT = Number(process.env.PORT) || 8742;
const HOST = process.env.HOST || "127.0.0.1";
const VERBOSE = process.env.LOG_DECISIONS === "1";
// Caps so a server left running can't run up an unbounded bill.
const MAX_IN_FLIGHT = 16;
const DAILY_CALL_LIMIT = Number(process.env.DAILY_CALL_LIMIT) || 20_000;
const MAX_BODY_BYTES = Math.ceil((MAX_FRAMES * MAX_FRAME_BYTES * 4) / 3) + 4096;
const NOT_CONFIGURED = "FOUNDRY_ENDPOINT is not configured on the server";

const PUBLIC = path.join(ROOT, "public");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
};

const foundry = resolveFoundryConfig();
const MODEL = `${MODEL_NAME} (${foundry.deployment})`;
const getHeaders = foundryAuth(foundry);
const client = foundry.endpoint
  ? createDecisionClient({ endpoint: foundry.endpoint, deployment: foundry.deployment, getHeaders, timeoutMs: 10_000 })
  : null;
// Fetch the first Entra ID token at startup so the first check doesn't wait for it.
if (client) getHeaders().catch((err) => console.warn(`[auth] ${err.message}`));

const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

let inFlight = 0;
const stats = { calls: 0, errors: 0, inputTokens: 0, latencyMs: 0 };
const daily = { date: "", calls: 0 };

function dailyLimitReached() {
  const date = new Date().toISOString().slice(0, 10);
  if (date !== daily.date) Object.assign(daily, { date, calls: 0 });
  return daily.calls >= DAILY_CALL_LIMIT;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      req.resume();
      reject(new AuraInputError("Expected Content-Type: application/json", 415));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) return chunks.push(chunk);
      req.removeAllListeners("data");
      req.resume();
      reject(new AuraInputError("Payload too large", 413));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AuraInputError("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Only the app's own page may spend model calls. Browsers always send Origin with a POST from fetch(), so a
// missing or foreign Origin isn't the app; on loopback the Host check also blocks DNS rebinding.
function isTrustedRequest(req) {
  const host = req.headers.host ?? "";
  if (LOOPBACK && !ALLOWED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function handleAura(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "Forbidden origin" });
  if (!client) return sendJson(res, 503, { error: NOT_CONFIGURED });
  if (inFlight >= MAX_IN_FLIGHT) return sendJson(res, 429, { error: "Too many checks in flight" });
  if (dailyLimitReached()) return sendJson(res, 429, { error: "Daily aura check limit reached" });
  // Take the slot and the day's call before the first await, so a burst of requests can't all slip under the caps.
  inFlight++;
  daily.calls++;
  try {
    let request;
    try {
      request = buildAuraRequest(await readJson(req, MAX_BODY_BYTES));
    } catch (err) {
      daily.calls = Math.max(0, daily.calls - 1);
      return sendJson(res, err.status ?? 400, { error: err.message });
    }
    const result = await client.ask(request);
    stats.calls++;
    stats.latencyMs += result.latencyMs;
    stats.inputTokens += result.usage?.input_tokens ?? 0;
    const verdict = readAura(result.answers);
    if (VERBOSE) console.log(`[aura] ${result.latencyMs}ms ${JSON.stringify(verdict)}`);
    return sendJson(res, 200, {
      ...verdict,
      latencyMs: result.latencyMs,
      inputTokens: result.usage?.input_tokens ?? null,
      model: result.model,
    });
  } catch (err) {
    stats.errors++;
    const upstream = err instanceof DecisionError;
    console.warn(`[aura] check failed: ${err.message}${upstream && err.status ? ` (HTTP ${err.status})` : ""}`);
    const status = upstream ? (err.status === 429 ? 429 : 502) : 500;
    return sendJson(res, status, { error: upstream ? err.message : "Internal server error", code: upstream ? err.code : null });
  } finally {
    inFlight--;
  }
}

async function serveStatic(pathname, req, res) {
  const entry = STATIC[pathname];
  if (!entry) return sendJson(res, 404, { error: "Not found" });
  const [file, type] = entry;
  try {
    const data = await readFile(path.join(PUBLIC, file));
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...(file === "index.html" ? PAGE_HEADERS : {}),
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/api/status") {
      return sendJson(res, 200, { configured: Boolean(client), model: MODEL, keySource: foundry.authSource });
    }
    if (pathname === "/api/aura") return await handleAura(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    return await serveStatic(pathname, req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
  }
});
// Frames are small: a client that takes longer than this to send one is stuck or stalling.
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

server.listen(PORT, HOST, () => {
  console.log(`Aura Farming is running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(
    client
      ? `Aura is judged by ${MODEL} at ${foundry.endpoint} (auth: ${foundry.authSource})`
      : "FOUNDRY_ENDPOINT not set: the app loads, but aura checks return 503.",
  );
});

const summary = setInterval(() => {
  if (!stats.calls && !stats.errors) return;
  const avg = stats.calls ? Math.round(stats.latencyMs / stats.calls) : 0;
  const cost = (stats.inputTokens / 1e6) * 0.04;
  console.log(
    `[aura] ${stats.calls} checks, ${stats.errors} errors, avg ${avg} ms, ${stats.inputTokens} input tokens (~$${cost.toFixed(4)})`,
  );
  Object.assign(stats, { calls: 0, errors: 0, inputTokens: 0, latencyMs: 0 });
}, 30_000);
summary.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
