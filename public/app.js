// Aura Farming in the browser: 30 seconds in front of the webcam. Every CHECK_MS, two frames taken FRAME_GAP_MS
// apart (so the model can see movement) go to the server, which asks Microsoft-Decision-1.1 whether you are aura
// farming. Aura found means points; the server works out how many.

const ROUND_MS = 30_000;
const CHECK_MS = 1250;
const FRAME_GAP_MS = 500;
const MAX_PENDING = 2;
const JUDGE_WAIT_MS = 4000; // after the timer, for checks still on their way back
const SHORT_SIDE = 320; // px; the model takes 280 to 1,568 px a side
const JPEG_QUALITY = 0.8;
const BEST_KEY = "aura-farming.best";

const MOVE_LABELS = {
  boat_kid_wave: "Boat-kid wave",
  arm_forward: "Arm forward, arm back",
  unbothered_stare: "Unbothered stare",
  shades_on: "Shades on",
  trying_too_hard: "Trying too hard",
  no_aura: "No aura",
  cannot_tell: "Can't tell",
};

// [minimum aura, rank, line], best first.
const RANKS = [
  [14_000, "Pacu Jalur legend", "Full boat-kid energy. The rowers would follow you anywhere."],
  [9_000, "Aura farmer", "Effortless. The camera came to you."],
  [5_000, "Main character", "Unbothered and in control. Hold it longer for legend."],
  [2_000, "Side character", "Real aura in there. Less trying, more being."],
  [1, "Background character", "A flicker of aura. Calm face, chin up, smooth arms."],
  [0, "NPC", "No aura found. Calm face, chin up, slow smooth moves, and go again."],
];

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $("stage"), video: $("video"), status: $("status"), error: $("error"), info: $("info"),
  camera: $("camera"), go: $("go"), again: $("again"), count: $("count"),
  timer: $("timer"), timebar: $("timebar"), total: $("total"), level: $("level"), move: $("move"), meter: $("meter"), pops: $("pops"),
  bestLine: $("best-line"), resTotal: $("res-total"), resRank: $("res-rank"), resLine: $("res-line"), resBest: $("res-best"),
  resImg: $("res-img"), resCap: $("res-cap"), resStats: $("res-stats"), resRecord: $("res-record"),
};

const canvas = document.createElement("canvas");
const draw = canvas.getContext("2d");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const game = {
  phase: "intro",
  online: false,
  stream: null,
  round: 0,
  startedAt: 0,
  pending: 0,
  total: 0,
  checks: 0,
  found: 0,
  misses: 0,
  latencyMs: 0,
  best: null,
};

function setPhase(phase) {
  game.phase = phase;
  ui.stage.dataset.phase = phase;
}

function readBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0; // storage blocked
  }
}

function writeBest(value) {
  try {
    localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // Storage blocked: the best score lasts for this page only.
  }
}

function showBest() {
  const best = readBest();
  ui.bestLine.textContent = best ? `Your best: ${best.toLocaleString()} aura` : "";
}

async function loadStatus() {
  try {
    const status = await (await fetch("/api/status", { cache: "no-store" })).json();
    game.online = status.configured === true;
    ui.status.textContent = game.online ? `Judge: ${status.model}` : "No model configured: set FOUNDRY_ENDPOINT (see the README).";
  } catch {
    game.online = false;
    ui.status.textContent = "The server isn't answering.";
  }
  ui.status.classList.toggle("off", !game.online);
  ui.go.disabled = !game.online;
}

async function startCamera() {
  ui.error.textContent = "";
  if (!navigator.mediaDevices?.getUserMedia) {
    ui.error.textContent = "This page can't open a camera here. Use https, or http://localhost.";
    return;
  }
  ui.camera.disabled = true;
  try {
    game.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    ui.video.srcObject = game.stream;
    await ui.video.play();
    showBest();
    setPhase("ready");
    ui.go.focus();
  } catch (err) {
    ui.error.textContent =
      err?.name === "NotAllowedError"
        ? "Camera access was blocked. Allow it from the address bar and try again."
        : `Couldn't open a camera (${err?.name ?? "error"}).`;
  } finally {
    ui.camera.disabled = false;
  }
}

/** The current video frame as a JPEG, scaled so its short side is SHORT_SIDE px: `{ url, data }` (data: base64). */
function grabFrame() {
  const { videoWidth: width, videoHeight: height } = ui.video;
  if (!width || !height) return null;
  const scale = SHORT_SIDE / Math.min(width, height);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  draw.drawImage(ui.video, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  return { url, data: url.slice(url.indexOf(",") + 1) };
}

async function startRound() {
  if (!game.online || !game.stream) return;
  const round = ++game.round;
  setPhase("countdown");
  for (const step of ["3", "2", "1"]) {
    ui.count.textContent = step;
    ui.count.classList.remove("beat");
    void ui.count.offsetWidth; // restart the animation
    ui.count.classList.add("beat");
    await sleep(800);
    if (game.round !== round) return;
  }
  Object.assign(game, { total: 0, checks: 0, found: 0, misses: 0, latencyMs: 0, best: null });
  ui.total.textContent = "0";
  ui.info.textContent = "";
  showRead(null);
  setPhase("round");
  game.startedAt = performance.now();
  setTimeout(() => endRound(round), ROUND_MS);
  requestAnimationFrame(() => tick(round));
  checkLoop(round);
}

function tick(round) {
  if (game.phase !== "round" || game.round !== round) return;
  const left = Math.max(0, ROUND_MS - (performance.now() - game.startedAt));
  ui.timer.textContent = (left / 1000).toFixed(1);
  ui.timebar.style.transform = `scaleX(${left / ROUND_MS})`;
  requestAnimationFrame(() => tick(round));
}

async function checkLoop(round) {
  const live = () => game.phase === "round" && game.round === round;
  while (live()) {
    const started = performance.now();
    // Only start a check whose second frame still falls inside the round.
    if (started + FRAME_GAP_MS - game.startedAt < ROUND_MS && game.pending < MAX_PENDING) {
      const first = grabFrame();
      await sleep(FRAME_GAP_MS);
      if (!live()) return;
      const second = grabFrame();
      if (first && second) check([first, second], round);
    }
    await sleep(Math.max(0, CHECK_MS - (performance.now() - started)));
  }
}

async function check(frames, round) {
  game.pending++;
  try {
    const res = await fetch("/api/aura", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames: frames.map((frame) => frame.data) }),
    });
    const body = await res.json().catch(() => ({}));
    if (game.round !== round) return;
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    applyVerdict(body, frames.at(-1));
  } catch (err) {
    if (game.round === round) {
      game.misses++;
      ui.info.textContent = `Missed a check: ${err.message}`;
    }
  } finally {
    game.pending--;
    if (game.pending === 0) showResults(round);
  }
}

function applyVerdict(verdict, frame) {
  game.checks++;
  game.latencyMs += verdict.latencyMs ?? 0;
  showRead(verdict);
  if (!verdict.found) return;
  game.found++;
  game.total += verdict.points;
  ui.total.textContent = game.total.toLocaleString();
  pop(verdict.points);
  if (!game.best || verdict.points > game.best.points) game.best = { ...verdict, url: frame.url };
}

function showRead(verdict) {
  const aura = verdict?.aura ?? 0;
  ui.stage.style.setProperty("--aura", aura.toFixed(3));
  ui.meter.style.transform = `scaleX(${aura})`;
  ui.level.textContent = verdict ? verdict.levelName : "Reading your aura…";
  ui.move.textContent = verdict?.move ? MOVE_LABELS[verdict.move] : "";
  ui.stage.classList.remove("found");
  if (verdict?.found) {
    void ui.stage.offsetWidth; // restart the flare
    ui.stage.classList.add("found");
  }
  if (verdict) ui.info.textContent = `${game.checks} checks · aura ${Math.round(aura * 100)}% · ${verdict.latencyMs} ms`;
}

function pop(points) {
  const el = document.createElement("div");
  el.className = points >= 750 ? "pop big" : "pop";
  el.textContent = `+${points} aura`;
  el.style.setProperty("--x", `${22 + Math.random() * 56}%`);
  el.addEventListener("animationend", () => el.remove(), { once: true });
  ui.pops.append(el);
}

function endRound(round) {
  if (game.phase !== "round" || game.round !== round) return;
  ui.timer.textContent = "0.0";
  ui.timebar.style.transform = "scaleX(0)";
  setPhase("judging");
  if (game.pending === 0) showResults(round);
  else setTimeout(() => showResults(round), JUDGE_WAIT_MS);
}

function showResults(round) {
  if (game.phase !== "judging" || game.round !== round) return;
  const [, rank, line] = RANKS.find(([min]) => game.total >= min);
  ui.resTotal.textContent = game.total.toLocaleString();
  ui.resRank.textContent = rank;
  ui.resLine.textContent = line;
  const avg = game.checks ? Math.round(game.latencyMs / game.checks) : 0;
  ui.resStats.textContent =
    `Aura found in ${game.found} of ${game.checks} checks` + (game.misses ? `, ${game.misses} missed` : "") + (avg ? ` · ${avg} ms a check` : "");
  ui.resBest.hidden = !game.best;
  if (game.best) {
    ui.resImg.src = game.best.url;
    const move = game.best.move ? ` · ${MOVE_LABELS[game.best.move]}` : "";
    ui.resCap.textContent = `Best moment: +${game.best.points} aura, ${game.best.levelName}${move}`;
  }
  const previous = readBest();
  if (game.total > previous) {
    writeBest(game.total);
    ui.resRecord.textContent = previous ? `New best! Old best: ${previous.toLocaleString()} aura` : "Your first score on the board.";
  } else {
    ui.resRecord.textContent = previous ? `Your best: ${previous.toLocaleString()} aura` : "";
  }
  setPhase("results");
  ui.again.focus();
}

ui.camera.addEventListener("click", startCamera);
ui.go.addEventListener("click", startRound);
ui.again.addEventListener("click", startRound);
loadStatus();
