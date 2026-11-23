// The aura check. The browser sends one to three webcam frames; this module checks they are JPEGs the model
// accepts, and writes everything the model reads: what aura farming is, and three typed questions.
//
//   aura  (noul)   -> is the player aura farming?             found when the probability >= AURA_THRESHOLD
//   level (score)  -> how much aura, from No aura to Legendary  sets the points
//   move  (choice) -> what the player is doing                  shown live as the "read"
//
// The browser supplies pictures only, so it can't put its own text or questions in front of the model.

import { readChoice, readNoul, readScore } from "./decisions.js";
import { jpegSize } from "./jpeg.js";

export const MAX_FRAMES = 3;
// The model takes PNG or JPEG images of 280 to 1,568 px a side.
export const MIN_SIDE = 280;
export const MAX_SIDE = 1568;
export const MAX_FRAME_BYTES = 400 * 1024;

export const AURA_THRESHOLD = 0.5;
// Legendary aura (level 4) with full certainty is the meme's "+1000 aura".
export const POINTS_PER_LEVEL = 250;

export const AURA_LEVELS = [
  "No aura: nobody in view, or no attempt at all",
  "A trace: relaxed, but an everyday look",
  "Some aura: calm and composed, a little too cool to care",
  "Main character: unbothered, chin up, steady gaze, smooth moves",
  "Legendary: full boat-kid energy, stone-faced calm and effortless flowing moves",
];
export const LEVEL_NAMES = ["No aura", "A trace", "Some aura", "Main character", "Legendary"];

export const MOVES = {
  boat_kid_wave: "Slow, smooth arm sweeps or fists rolling like a wheel, as the boat kid does on the bow",
  arm_forward: "One arm stretched forward and the other back, balanced and steady",
  unbothered_stare: "Still, calm and blank-faced, with a steady gaze ahead or into the distance",
  shades_on: "Sunglasses on, chin up, cool and still",
  trying_too_hard: "Laughing, grinning, pulling faces or flailing",
  no_aura: "Nobody in view, face hidden or turned away, or just an everyday look",
  cannot_tell: "Too dark, blurry or cropped to tell",
};

// What aura farming is, after the 2025 meme (Wikipedia: "Aura farming"; BBC News Mundo on the boat-kid video).
const DEFINITION = [
  "Aura farming game: a player has 30 seconds in front of a webcam to farm as much aura as they can.",
  "Aura farming means cultivating an air of effortless cool on purpose: calm, confident and unbothered, without seeming to try. " +
    "The meme comes from the Pacu Jalur boat races in Riau, Indonesia, where a boy dances on the bow of a speeding racing boat " +
    "in a black traditional outfit, a headcloth and sunglasses. His face stays calm and nearly expressionless while he repeats " +
    "slow, smooth moves: one hand sweeping forward at chest height as the other passes underneath, both fists rolling like a " +
    "wheel from side to side, one arm stretched forward and the other back in a balanced pose, the odd kiss blown to the crowd.",
  "Signs of aura: a calm or blank face with no big smile; chin up; an upright, relaxed, steady posture; a steady gaze ahead " +
    "or into the distance; slow, smooth, controlled gestures; sunglasses.",
  "Signs of no aura: nobody in the picture; face hidden or turned away; laughing, grinning or pulling faces; looking down " +
    "at a phone or keyboard; slouching; fast, jerky or frantic moves; obviously straining to look cool.",
  "Judge only pose, facial expression, gaze, gestures and props such as sunglasses. Ignore the person's looks, body, age, " +
    "gender and skin, and the room around them.",
];

const QUESTIONS = {
  aura: {
    type: "noul",
    instructions: "Is the player aura farming in these frames?",
    criteria: {
      true: "A person is in view and looks deliberately, effortlessly cool: calm face, composed posture, steady gaze, smooth controlled moves",
      false: "Nobody in view, or an ordinary, goofy, laughing, distracted or try-hard look",
    },
  },
  level: { type: "score", instructions: "How much aura is the player farming?", criteria: AURA_LEVELS },
  move: { type: "choice", instructions: "Which best describes what the player is doing?", criteria: MOVES },
};

export class AuraInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AuraInputError";
    this.status = status;
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** `{ state, questions, assets }` for the model, from the browser's (untrusted) `{ frames: [base64 JPEG, ...] }`. */
export function buildAuraRequest(body) {
  const frames = body?.frames;
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_FRAMES) {
    throw new AuraInputError(`Send { "frames": [...] } with 1 to ${MAX_FRAMES} base64 JPEG frames`);
  }
  const assets = {};
  const refs = frames.map((data, i) => {
    const n = i + 1;
    if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) {
      throw new AuraInputError(`Frame ${n} is not base64`);
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_FRAME_BYTES) throw new AuraInputError(`Frame ${n} is larger than ${MAX_FRAME_BYTES / 1024} KB`, 413);
    const size = jpegSize(bytes);
    if (!size) throw new AuraInputError(`Frame ${n} is not a JPEG`);
    const { width, height } = size;
    if (Math.min(width, height) < MIN_SIDE || Math.max(width, height) > MAX_SIDE) {
      throw new AuraInputError(`Frame ${n} is ${width}x${height}; each side must be ${MIN_SIDE} to ${MAX_SIDE} px`);
    }
    const name = `frame${n}.jpg`;
    assets[name] = { type: "image", format: "jpeg", data_base64: data };
    return `image:${name}`;
  });
  const framesLine =
    refs.length === 1
      ? `Webcam frame of the player: ${refs[0]}`
      : `Webcam frames of the player, about half a second apart, oldest first: ${refs.join(" ")}`;
  return { state: [...DEFINITION, framesLine].join("\n"), questions: QUESTIONS, assets };
}

/** Points for one check: nothing unless aura is found, then up to +1000 for Legendary at full certainty. */
export function auraPoints(probability, level) {
  if (probability < AURA_THRESHOLD) return 0;
  return Math.max(10, Math.round((POINTS_PER_LEVEL * level * probability) / 10) * 10);
}

/** The verdict the browser shows: `{ found, points, aura, level, levelName, move, moveConfidence }`. */
export function readAura(answers) {
  const aura = readNoul(answers?.aura)?.probability ?? 0;
  const level = readScore(answers?.level, AURA_LEVELS.length)?.score ?? 0;
  const move = readChoice(answers?.move, Object.keys(MOVES));
  const points = auraPoints(aura, level);
  return {
    found: points > 0,
    points,
    aura,
    level,
    levelName: LEVEL_NAMES[Math.round(level)],
    move: move?.choice ?? null,
    moveConfidence: move ? (move.probabilities[move.choice] ?? move.confidence) : null,
  };
}
