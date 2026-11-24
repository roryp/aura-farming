import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { AURA_LEVELS, MOVES, POINTS_PER_LEVEL } from "../lib/aura.js";

const read = (file) => readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
const page = await read("index.html");
const app = await read("app.js");

// The guide's move cards: <li class="move" data-move="..."><svg>...</svg><b>Name</b><span>Points</span></li>
const cards = [...page.matchAll(/<li class="move[^"]*" data-move="(\w+)">([\s\S]*?)<\/li>/g)].map(([, move, body]) => ({
  move,
  body,
  name: body.match(/<b>([^<]+)<\/b>/)?.[1],
  points: body.match(/<span>([^<]+)<\/span>/)?.[1],
}));
// The judge's moves that aren't aura farming, so pay nothing.
const ZERO = ["trying_too_hard", "no_aura", "cannot_tell"];

describe("the guide's moves", () => {
  it("has a card with a silhouette for every move the judge can read", () => {
    assert.deepEqual(cards.map((card) => card.move).sort(), Object.keys(MOVES).sort());
    for (const { move, body } of cards) assert.match(body, /<svg viewBox="0 0 64 64" aria-hidden="true">[\s\S]+<\/svg>/, move);
  });

  it("names each move as the live read does", () => {
    for (const { move, name } of cards) assert.ok(app.includes(`${move}: "${name}"`), `${move} is "${name}" on the page`);
  });

  it("shows nothing for the moves that aren't aura, and a level's points, at most Legendary's, for the rest", () => {
    const legendary = POINTS_PER_LEVEL * (AURA_LEVELS.length - 1);
    for (const { move, points } of cards) {
      if (ZERO.includes(move)) {
        assert.equal(points, "0 aura", move);
        assert.match(page, new RegExp(`class="move zero" data-move="${move}"`), `${move} is styled as paying nothing`);
        continue;
      }
      const value = Number(points?.match(/^\+(\d+) aura$/)?.[1]);
      assert.ok(value > 0 && value <= legendary && value % POINTS_PER_LEVEL === 0, `${move}: ${points}`);
    }
  });

  it("has no inline styles, which the page's Content-Security-Policy blocks", () => {
    assert.doesNotMatch(page, /\sstyle=/);
  });
});
