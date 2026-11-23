import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDecisionClient, DecisionError } from "../lib/decisions.js";

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { impl, calls };
}

const auth = async () => ({ Authorization: "Bearer tok" });

describe("createDecisionClient", () => {
  it("posts the state, questions and image assets to the Foundry systemone endpoint", async () => {
    const { impl, calls } = fakeFetch(200, {
      model: "microsoft-decision-1.1",
      answers: { aura: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 1160, output_tokens: 3 },
    });
    const client = createDecisionClient({
      endpoint: "https://res.cognitiveservices.azure.com/",
      deployment: "decision-1.1",
      getHeaders: auth,
      fetchImpl: impl,
    });
    const questions = { aura: { type: "noul", instructions: "Aura?" } };
    const assets = { "frame1.jpg": { type: "image", format: "jpeg", data_base64: "AAAA" } };
    const result = await client.ask({ state: "Frame: image:frame1.jpg", questions, assets });

    assert.equal(calls[0].url, "https://res.cognitiveservices.azure.com/providers/microsoft/v1/systemone");
    assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "decision-1.1", state: "Frame: image:frame1.jpg", questions, assets });
    assert.deepEqual(result.answers, { aura: { type: "noul", noul: 0.9 } });
    assert.equal(result.usage.input_tokens, 1160);
  });

  it("turns HTTP errors, timeouts and odd payloads into DecisionError", async () => {
    const ask = (fetchImpl) =>
      createDecisionClient({ endpoint: "https://x", deployment: "d", getHeaders: auth, fetchImpl }).ask({ state: "s", questions: {} });

    await assert.rejects(ask(fakeFetch(429, { error: { message: "Too many requests", code: "429" } }).impl), (err) => {
      assert.ok(err instanceof DecisionError);
      return err.status === 429 && err.message === "Too many requests";
    });
    const timeout = async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    };
    await assert.rejects(ask(timeout), { code: "timeout" });
    await assert.rejects(ask(fakeFetch(200, { answers: [] }).impl), /unexpected payload/);
  });
});
