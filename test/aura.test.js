import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AURA_THRESHOLD, auraPoints, buildAuraRequest, MAX_FRAMES, readAura } from "../lib/aura.js";
import { jpegSize } from "../lib/jpeg.js";
import { fakeJpeg } from "./helpers.js";

const b64 = (buf) => buf.toString("base64");

describe("jpegSize", () => {
  it("reads the size from baseline and progressive frame headers", () => {
    assert.deepEqual(jpegSize(fakeJpeg(427, 320)), { width: 427, height: 320 });
    assert.deepEqual(jpegSize(fakeJpeg(320, 569, 0xc2)), { width: 320, height: 569 });
  });

  it("returns null for anything that isn't a JPEG with a frame header", () => {
    assert.equal(jpegSize(Buffer.from("89504e470d0a1a0a", "hex")), null); // a PNG signature
    assert.equal(jpegSize(fakeJpeg(427, 320).subarray(0, 24)), null); // cut off before the frame header
    assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null); // image data before any frame header
  });
});

describe("buildAuraRequest", () => {
  it("sends the frames as image assets referenced from the state, with the three questions", () => {
    const frame = b64(fakeJpeg(427, 320));
    const { state, questions, assets } = buildAuraRequest({ frames: [frame, frame] });
    assert.deepEqual(Object.keys(assets), ["frame1.jpg", "frame2.jpg"]);
    assert.deepEqual(assets["frame1.jpg"], { type: "image", format: "jpeg", data_base64: frame });
    assert.match(state, /Pacu Jalur/);
    assert.match(state, /oldest first: image:frame1\.jpg image:frame2\.jpg$/);
    assert.deepEqual(
      Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type])),
      { aura: "noul", level: "score", move: "choice" },
    );
  });

  it("only takes 1 to 3 base64 JPEGs of a size the model accepts", () => {
    const ok = b64(fakeJpeg(427, 320));
    const rejects = (body, pattern, status = 400) =>
      assert.throws(() => buildAuraRequest(body), (err) => err.status === status && pattern.test(err.message));
    rejects({}, /1 to 3/);
    rejects({ frames: [] }, /1 to 3/);
    rejects({ frames: Array(MAX_FRAMES + 1).fill(ok) }, /1 to 3/);
    rejects({ frames: ["not base64!"] }, /not base64/);
    rejects({ frames: [b64(Buffer.from("89504e470d0a1a0a00000000", "hex"))] }, /not a JPEG/);
    rejects({ frames: [ok, b64(fakeJpeg(320, 240))] }, /Frame 2 is 320x240/);
    rejects({ frames: [b64(fakeJpeg(1600, 900))] }, /1600x900/);
    rejects({ frames: [b64(Buffer.concat([fakeJpeg(427, 320), Buffer.alloc(400 * 1024)]))] }, /larger than/, 413);
  });
});

describe("readAura", () => {
  const answers = (noul, score, choice = "shades_on") => ({
    aura: { type: "noul", noul },
    level: { type: "score", score, probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.9, 4: 0 } },
    move: { type: "choice", choice, confidence: 0.8, probabilities: { [choice]: 0.8 } },
  });

  it("pays points only when aura is found, up to +1000 for certain Legendary aura", () => {
    assert.deepEqual(readAura(answers(0.98, 2.9)), {
      found: true,
      points: 710,
      aura: 0.98,
      level: 2.9,
      levelName: "Main character",
      move: "shades_on",
      moveConfidence: 0.8,
    });
    assert.equal(readAura(answers(AURA_THRESHOLD - 0.01, 4)).points, 0);
    assert.equal(auraPoints(1, 4), 1000);
    assert.equal(auraPoints(AURA_THRESHOLD, 0), 10);
  });

  it("treats missing or malformed answers as no aura", () => {
    assert.deepEqual(readAura({}), {
      found: false,
      points: 0,
      aura: 0,
      level: 0,
      levelName: "No aura",
      move: null,
      moveConfidence: null,
    });
    assert.equal(readAura({ ...answers(0.9, 3), move: { type: "choice", choice: "moonwalk" } }).move, null);
  });
});
