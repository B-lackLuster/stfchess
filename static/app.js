/* stfchess 前端逻辑 */
"use strict";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const GLYPH_KING = "♚", GLYPH_PAWN = "♟";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const CLS_LABEL = {
  best: "最佳", excellent: "优秀", good: "良好",
  inaccuracy: "不精确", mistake: "错误", blunder: "大错",
};

const DEMO_PGN = `[Event "A night at the opera"]
[Site "Paris FRA"]
[Date "1858.11.02"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6
7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7
12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+
Nxb8 17. Rd8# 1-0`;

const S = {
  initialFen: START_FEN,
  history: [],          // {san, uci, fenAfter, capture, check, an?}
  cursor: 0,            // 已应用着法数
  flipped: false,
  sel: null,
  legal: [],
  turn: "w",
  checkSq: null,
  gameOver: false,
  evalCache: new Map(), // fen+depth -> lines
  lines: null,          // 当前评估线
  evalStart: null,      // 整局分析得到的初始评估
  job: null,            // {id, gen}
  jobGen: 0,
  moveGen: 0,           // 每走一步 +1，用于丢弃过期的实时评价
  busy: false,
  vsEngine: false,
  engineSide: "b",
  headers: {},
  analyzeAbort: null,
  badgeOn: localStorage.getItem("stfchess-badge") !== "0",
  soundOn: localStorage.getItem("stfchess-sound") !== "0",
};

const $ = (sel) => document.querySelector(sel);
window.S = S; // 调试用

/* ---------------- 音效（Web Audio 合成，无外部音频文件） ---------------- */
let _actx = null;
function audioCtx() {
  if (!S.soundOn) return null;
  if (!_actx) {
    try { _actx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
  }
  if (_actx.state === "suspended") _actx.resume();
  return _actx;
}

function _env(ctx, t0, peak, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  g.connect(ctx.destination);
  return g;
}

function _knock(ctx, t0, freq, dur, peak) {
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(freq, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.45), t0 + dur);
  o.connect(_env(ctx, t0, peak, dur));
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

function _tone(ctx, t0, freq, dur, type, peak) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.connect(_env(ctx, t0, peak, dur));
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// 落子：木质“嗒”声
function sndMove() {
  const ctx = audioCtx(); if (!ctx) return;
  const t = ctx.currentTime;
  _knock(ctx, t, 560, 0.06, 0.45);
  _knock(ctx, t + 0.012, 230, 0.09, 0.3);
}
// 吃子：更重的双击
function sndCapture() {
  const ctx = audioCtx(); if (!ctx) return;
  const t = ctx.currentTime;
  _knock(ctx, t, 720, 0.05, 0.45);
  _knock(ctx, t + 0.018, 170, 0.12, 0.5);
}
// 将军：两声上扬提示音
function sndCheck() {
  const ctx = audioCtx(); if (!ctx) return;
  const t = ctx.currentTime;
  _tone(ctx, t, 880, 0.12, "triangle", 0.22);
  _tone(ctx, t + 0.1, 1174, 0.16, "triangle", 0.22);
}
// 将杀：下行四音（对局结束）
function sndMate() {
  const ctx = audioCtx(); if (!ctx) return;
  const t = ctx.currentTime;
  [659, 523, 392, 262].forEach((f, i) => _tone(ctx, t + i * 0.15, f, 0.26, "sawtooth", 0.16));
}

function playMoveSound(r) {
  if (!S.soundOn) return;
  if (r.over && r.result && r.result !== "1/2-1/2") sndMate();
  else if (r.check) sndCheck();
  else if (r.capture) sndCapture();
  else sndMove();
}

/* ---------------- API ---------------- */
async function api(path, body) {
  const opt = body !== undefined
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, opt);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

/* ---------------- 状态工具 ---------------- */
function curFen() {
  return S.cursor === 0 ? S.initialFen : S.history[S.cursor - 1].fenAfter;
}
function fenTurn(fen) { return fen.split(" ")[1] || "w"; }
function fenFullmove(fen) { return parseInt(fen.split(" ")[5], 10) || 1; }
function moveNumberAt(ply) {
  const t = fenTurn(S.initialFen);
  const f = fenFullmove(S.initialFen);
  return t === "w" ? f + Math.floor(ply / 2) : f + Math.floor((ply + 1) / 2);
}
function moveColorAt(ply) {
  const t = fenTurn(S.initialFen);
  const isEven = ply % 2 === 0;
  return (t === "w") === isEven ? "w" : "b";
}
function winp(cp) {
  if (cp > 90000) return 100;
  if (cp < -90000) return 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
function fmtEval(cpWhite) {
  if (cpWhite > 90000) return "#" + Math.max(1, 100000 - cpWhite + 1);
  if (cpWhite < -90000) return "#-" + Math.max(1, 100000 + cpWhite + 1);
  return (cpWhite / 100).toFixed(2);
}

/* ---------------- 棋盘渲染 ---------------- */
let _lastRendered = { fen: null, cursor: null };
let _boardFlipped = null;

function buildSquares() {
  const board = $("#board");
  board.innerHTML = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const xf = S.flipped ? 7 - x : x;
      const yf = S.flipped ? y : 7 - y; // 未翻转时第一行（顶部）是第 8 横排
      const div = document.createElement("div");
      div.className = `sq ${(x + y) % 2 === 0 ? "light" : "dark"}`;
      div.dataset.square = FILES[xf] + (yf + 1);
      board.appendChild(div);
    }
  }
  _boardFlipped = S.flipped;
}

function flipMove(el, oldRect) {
  const r = el.getBoundingClientRect();
  const dx = oldRect.left + oldRect.width / 2 - (r.left + r.width / 2);
  const dy = oldRect.top + oldRect.height / 2 - (r.top + r.height / 2);
  if (!dx && !dy) return;
  el.style.transition = "none";
  el.style.transform = `translate(${dx}px, ${dy}px)`;
  el.getBoundingClientRect(); // 强制重排，让起始位置生效
  el.style.transition = "transform 0.18s cubic-bezier(.2,.8,.3,1)";
  el.style.transform = "";
  el.addEventListener("transitionend", () => { el.style.transition = ""; }, { once: true });
}

function spawnFade(el) {
  const wrap = $("#boardwrap");
  const wr = wrap.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const ghost = document.createElement("span");
  ghost.className = "pc fadeout " + (el.classList.contains("w") ? "w" : "b");
  ghost.textContent = el.textContent;
  ghost.style.fontSize = getComputedStyle(el).fontSize;
  ghost.style.left = (r.left - wr.left) + "px";
  ghost.style.top = (r.top - wr.top) + "px";
  wrap.appendChild(ghost);
  setTimeout(() => ghost.remove(), 340);
}

function pieceAt(fen, sq) {
  const rows = fen.split(" ")[0].split("/");
  const file = FILES.indexOf(sq[0]);
  const rank = parseInt(sq[1], 10);
  const row = rows[8 - rank] || "";
  let f = 0;
  for (const ch of row) {
    if (/\d/.test(ch)) { f += parseInt(ch, 10); continue; }
    if (f === file) return { color: ch === ch.toUpperCase() ? "w" : "b", type: ch.toLowerCase() };
    f++;
  }
  return null;
}

function squareCoord(sq) {
  const file = FILES.indexOf(sq[0]);
  const rank = parseInt(sq[1], 10) - 1;
  let x = file, y = 7 - rank;
  if (S.flipped) { x = 7 - x; y = 7 - y; }
  return { x, y };
}

function renderBoard() {
  if (_boardFlipped !== S.flipped) buildSquares();
  const board = $("#board");
  const fen = curFen();
  const last = S.cursor > 0 ? S.history[S.cursor - 1].uci : null;
  const changed = fen !== _lastRendered.fen;
  const forward = _lastRendered.cursor == null || S.cursor >= _lastRendered.cursor;

  // FLIP：更新棋子前捕获移动方的旧位置
  const anims = [];
  if (changed && last) {
    const from = last.slice(0, 2), to = last.slice(2, 4);
    const originSq = forward ? from : to;
    const destSq = forward ? to : from;
    const originEl = board.querySelector(`.sq[data-square="${originSq}"] .pc`);
    if (originEl) {
      // 被吃棋子淡出（含吃过路兵）
      if (forward) {
        let capSq = to;
        if (originEl.textContent === GLYPH_PAWN && from[0] !== to[0] && !pieceAt(_lastRendered.fen, to)) {
          capSq = to[0] + from[1];
        }
        const capEl = board.querySelector(`.sq[data-square="${capSq}"] .pc`);
        if (capEl && capEl !== originEl) spawnFade(capEl);
      }
      anims.push({ destSq, rect: originEl.getBoundingClientRect() });
      // 王车易位：车同步滑动
      if (originEl.textContent === GLYPH_KING) {
        const ff = FILES.indexOf(from[0]), tf = FILES.indexOf(to[0]);
        if (Math.abs(ff - tf) === 2) {
          const rank = from[1];
          const [rf, rt] = tf > ff ? ["h", "f"] : ["a", "d"];
          const rookEl = board.querySelector(`.sq[data-square="${rf + rank}"] .pc`);
          if (rookEl) anims.push({ destSq: rt + rank, rect: rookEl.getBoundingClientRect() });
        }
      }
    }
  }

  // 增量更新棋子与高亮（内容未变的棋子节点保持不动，动画不被打断）
  for (const sqEl of board.children) {
    const sq = sqEl.dataset.square;
    const p = pieceAt(fen, sq);
    const cur = sqEl.querySelector(".pc");
    if (p) {
      if (!cur || cur.textContent !== GLYPH[p.type] || !cur.classList.contains(p.color)) {
        if (cur) cur.remove();
        const pc = document.createElement("span");
        pc.className = "pc " + p.color;
        pc.textContent = GLYPH[p.type];
        sqEl.appendChild(pc);
      }
      sqEl.classList.add("haspc");
    } else if (cur) {
      cur.remove();
      sqEl.classList.remove("haspc");
    }
    sqEl.classList.toggle("last", !!last && (sq === last.slice(0, 2) || sq === last.slice(2, 4)));
    sqEl.classList.toggle("sel", S.sel === sq);
    sqEl.classList.toggle("check", S.checkSq === sq);
    sqEl.classList.toggle("dest", !!S.sel && S.legal.some((m) => m.from === S.sel && m.to === sq));
  }
  renderCoords();

  // FLIP：从旧位置滑入新位置
  if (anims.length) {
    for (const a of anims) {
      const el = board.querySelector(`.sq[data-square="${a.destSq}"] .pc`);
      if (el) flipMove(el, a.rect);
    }
  }
  _lastRendered = { fen, cursor: S.cursor };
}

function renderCoords() {
  const wrap = $("#coords");
  wrap.innerHTML = "";
  for (let i = 0; i < 8; i++) {
    const fileLabel = FILES[S.flipped ? 7 - i : i];
    const fl = document.createElement("span");
    fl.className = "coord-file";
    const xf = S.flipped ? 7 - i : i;
    const yf = S.flipped ? 7 - i : i;
    fl.textContent = fileLabel;
    fl.style.left = `calc(${i} * 12.5% + 4px)`;
    fl.style.right = "auto";
    fl.style.bottom = "3px";
    // 文件坐标在底行；判断该格底色决定文字颜色
    const light = (xf + yf) % 2 === 0;
    fl.classList.toggle("on-light", light);
    wrap.appendChild(fl);

    const rankLabel = String((S.flipped ? i : 8 - i));
    const rl = document.createElement("span");
    rl.className = "coord-rank";
    rl.textContent = rankLabel;
    rl.style.top = `calc(${i} * 12.5% + 3px)`;
    const lightR = (xf + yf) % 2 === 0;
    rl.classList.toggle("on-light", lightR);
    wrap.appendChild(rl);
  }
}

/* ---------------- 走子 ---------------- */
async function refreshLegal() {
  const fen = curFen();
  try {
    const r = await api("/api/position/moves", { fen });
    if (fen !== curFen()) return; // 已切换
    S.legal = r.moves;
    S.turn = r.turn;
    S.checkSq = r.check_sq;
    renderBoard();
    renderStatus();
  } catch (e) {
    S.legal = [];
    setStatus(`载入合法着法失败: ${e.message}`, true);
  }
}

function showPromo(from, to) {
  const promo = $("#promo");
  const color = S.turn;
  promo.innerHTML = "";
  ["q", "r", "b", "n"].forEach((t) => {
    const b = document.createElement("button");
    b.textContent = GLYPH[t];
    if (color === "w") b.style.color = "#fafafa";
    b.onclick = () => { promo.hidden = true; doUserMove(from, to, t); };
    promo.appendChild(b);
  });
  const coord = squareCoord(to);
  const wrap = $("#boardwrap");
  const w = wrap.clientWidth / 8;
  promo.style.width = w + "px";
  promo.style.left = Math.min(coord.x * w, wrap.clientWidth - w - 4) + "px";
  promo.style.top = (coord.y < 4 ? coord.y * w : wrap.clientHeight - 4 * w - 4) + "px";
  promo.hidden = false;
}

async function doUserMove(from, to, promotion) {
  if (S.busy) return;
  S.sel = null;
  clearHint();
  S.busy = true;
  const preFen = curFen();
  const depth = +$("#depth").value;
  try {
    const r = await api("/api/position/move", { fen: preFen, from, to, promotion: promotion || undefined });
    if (S.badgeOn) S._pendingEval = { preFen, uci: r.uci, depth };
    applyMove(r);
  } catch (e) {
    setStatus(`走子失败: ${e.message}`, true);
  }
  S.busy = false;
  maybeEngineMove();
}

function applyMove(r) {
  // 若从历史中间走子 → 分叉：截断后续
  if (S.cursor < S.history.length) {
    S.history = S.history.slice(0, S.cursor);
    invalidateJob();
  }
  const pe = S._pendingEval;
  S._pendingEval = null;
  S.moveGen++;
  S.history.push({
    san: r.san, uci: r.uci, fenAfter: r.fen_after,
    capture: r.capture, check: r.check, color: r.color, an: null,
  });
  S.cursor = S.history.length;
  if (r.over) {
    S.gameOver = true;
  }
  playMoveSound(r);
  afterPositionChange();
  if (pe) scheduleMoveBadge(pe.preFen, pe.uci, pe.depth);
}

function invalidateJob() {
  if (S.job) { api(`/api/jobs/${S.job.id}/cancel`, {}).catch(() => {}); }
  S.job = null;
  S.jobGen++;
  $("#jobprogress").style.display = "none";
  $("#jobtext").textContent = "";
}

function afterPositionChange() {
  renderAll();
  refreshLegal();
  scheduleAnalyze();
}

/* ---------------- 导航 ---------------- */
function setCursor(n) {
  n = Math.max(0, Math.min(S.history.length, n));
  if (n === S.cursor) return;
  S.cursor = n;
  S.sel = null;
  S._pendingEval = null;
  clearHint();
  S.gameOver = false; // 回退视为未结束（引擎对弈时以实时判定为准）
  afterPositionChange();
}

/* ---------------- 引擎分析（当前局面） ---------------- */
let analyzeTimer = null;
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(runPositionAnalyze, 250);
}

async function runPositionAnalyze() {
  const fen = curFen();
  const depth = +$("#depth").value;
  const key = fen + "|" + depth;
  if (S.evalCache.has(key)) {
    renderLines(S.evalCache.get(key));
    return;
  }
  if (!S.legal.length) {
    $("#lines").innerHTML = `<div id="evalhint">对局已结束</div>`;
    return;
  }
  if (S.analyzeAbort) S.analyzeAbort.abort();
  const ac = new AbortController();
  S.analyzeAbort = ac;
  try {
    const r = await fetch("/api/position/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, depth, multipv: 3, cap: 2.5 }),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    const data = await r.json();
    if (data.fen !== curFen()) return;
    if (S.evalCache.size > 400) S.evalCache.delete(S.evalCache.keys().next().value);
    S.evalCache.set(key, data.lines);
    renderLines(data.lines);
  } catch (e) {
    if (e.name === "AbortError") return;
    const eh = document.getElementById("evalhint");
    if (eh) eh.textContent = "评估失败: " + e.message;
  }
}

function renderLines(lines) {
  S.lines = lines;
  const wrap = $("#lines");
  wrap.innerHTML = "";
  if (!lines || !lines.length) {
    wrap.innerHTML = `<div id="evalhint">无评估结果</div>`;
    return;
  }
  const fen = curFen();
  lines.forEach((ln) => {
    const div = document.createElement("div");
    div.className = "line";
    const sc = document.createElement("span");
    sc.className = "score " + (ln.cp_white >= 0 ? "pos" : "neg");
    sc.textContent = fmtEval(ln.cp_white);
    const pv = document.createElement("span");
    pv.className = "pv";
    pv.textContent = pvText(ln.pv_san, fen);
    pv.title = pv.textContent;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = "深度" + ln.depth;
    div.append(sc, pv, meta);
    wrap.appendChild(div);
  });
  // 评估条
  const cp = lines[0].cp_white;
  const wp = winp(cp);
  $("#evalfill").style.width = wp.toFixed(1) + "%";
  $("#evaltext").textContent = fmtEval(cp);
}

function pvText(pvSan, fen) {
  if (!pvSan || !pvSan.length) return "";
  const turn = fenTurn(fen);
  let num = fenFullmove(fen);
  const out = [];
  let i = 0;
  if (turn === "b") { out.push(`${num}… ${pvSan[0]}`); num++; i = 1; }
  for (; i < pvSan.length; i += 2) {
    out.push(`${num}. ${pvSan[i]}` + (pvSan[i + 1] ? ` ${pvSan[i + 1]}` : ""));
    num++;
  }
  return out.join("  ");
}

/* ---------------- 实时着法评价（棋子右上角徽章） ---------------- */
function portClassify(loss, isBest) {
  if (isBest || loss <= 1) return "best";
  if (loss <= 10) return "excellent";
  if (loss <= 25) return "good";
  if (loss <= 50) return "inaccuracy";
  if (loss <= 100) return "mistake";
  return "blunder";
}

function showMoveBadge(sq, cls, text) {
  const wrap = $("#boardwrap");
  const old = document.getElementById("movebadge");
  if (old) old.remove();
  const w = wrap.clientWidth / 8;
  const c = squareCoord(sq);
  const badge = document.createElement("div");
  badge.id = "movebadge";
  badge.className = "movebadge " + cls;
  badge.textContent = text || CLS_LABEL[cls];
  badge.style.left = Math.max(2, Math.min((c.x + 1) * w - 12, wrap.clientWidth - 56)) + "px";
  badge.style.top = Math.max(2, c.y * w - 9) + "px";
  wrap.appendChild(badge);
  setTimeout(() => badge.remove(), 2600);
}

// 用独立的（不会被局面分析中止的）评估请求评价刚走的这步。
// 人机模式下引擎会立即应答并触发新的分析，主分析请求会被中止，
// 因此徽章 evaluation 必须走单独请求，并用 moveGen 防止过期显示。
function scheduleMoveBadge(preFen, uci, depth) {
  if (!S.badgeOn) return;
  const postFen = curFen();
  const gen = S.moveGen;
  fetch("/api/position/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fen: postFen, depth, multipv: 1, cap: 2.5 }),
  }).then((r) => r.json()).then((data) => {
    if (gen !== S.moveGen || curFen() !== postFen) return;
    const key = postFen + "|" + depth;
    if (!S.evalCache.has(key)) {
      if (S.evalCache.size > 400) S.evalCache.delete(S.evalCache.keys().next().value);
      S.evalCache.set(key, data.lines || []);
    }
    const to = uci.slice(2, 4);
    if (!S.legal.length) {
      // 终局：将杀或逼和
      if (S.checkSq) showMoveBadge(to, "best", "将杀!");
      else showMoveBadge(to, "mistake", "逼和");
      return;
    }
    const prev = S.evalCache.get(preFen + "|" + depth);
    if (!prev || !prev.length || !data.lines || !data.lines.length) return;
    const bestUci = prev[0].pv_uci ? prev[0].pv_uci[0] : null;
    const playedCp = -data.lines[0].cp_pov; // 对手视角取反 → 行棋方实际所得
    const loss = Math.max(0, prev[0].cp_pov - playedCp);
    showMoveBadge(to, portClassify(loss, bestUci === uci));
  }).catch(() => {});
}

/* ---------------- 提示箭头 ---------------- */
function drawHint(uci) {
  const svg = $("#hintsvg");
  const from = uci.slice(0, 2), to = uci.slice(2, 4);
  const a = squareCoord(from), b = squareCoord(to);
  const x1 = a.x + 0.5, y1 = a.y + 0.5, x2 = b.x + 0.5, y2 = b.y + 0.5;
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const hx = x2 - ux * 0.32, hy = y2 - uy * 0.32; // 箭头终点缩短
  svg.innerHTML = `
    <defs><marker id="ah" markerWidth="3" markerHeight="3" refX="1.6" refY="1.5" orient="auto">
      <path d="M0,0 L3,1.5 L0,3 z" fill="rgba(255,213,74,0.95)"/></marker></defs>
    <line x1="${x1}" y1="${y1}" x2="${hx}" y2="${hy}" stroke="rgba(255,213,74,0.95)"
      stroke-width="0.16" marker-end="url(#ah)" stroke-linecap="round"/>`;
}
function clearHint() { $("#hintsvg").innerHTML = ""; }

async function hint() {
  if (S.gameOver) return;
  try {
    const r = await api("/api/position/analyze", { fen: curFen(), depth: 14, multipv: 1, cap: 2.5 });
    if (!r.lines.length) return;
    drawHint(r.lines[0].pv_uci[0]);
    setStatus(`提示: ${r.lines[0].pv_san[0]}（评估 ${fmtEval(r.lines[0].cp_white)}）`);
  } catch (e) {
    setStatus("提示失败: " + e.message, true);
  }
}

/* ---------------- 人机对弈 ---------------- */
async function maybeEngineMove() {
  if (!S.vsEngine || S.busy || S.gameOver) return;
  if (fenTurn(curFen()) !== S.engineSide) return;
  S.busy = true;
  setStatus("引擎思考中…");
  try {
    const preFen = curFen();
    const depth = +$("#depth").value;
    const r = await api("/api/engine/move", { fen: preFen, level: +$("#engine-level").value });
    if (S.badgeOn) S._pendingEval = { preFen, uci: r.uci, depth };
    applyMove(r);
    setStatus(`引擎走了 ${r.san}`);
  } catch (e) {
    setStatus("引擎走子失败: " + e.message, true);
  }
  S.busy = false;
}

/* ---------------- 棋盘方向 ---------------- */
function applyOrientation() {
  // 默认白方在下；人机对弈且引擎执白（人类执黑）时黑方在下
  S.flipped = S.vsEngine && S.engineSide === "w";
  renderBoard();
}

/* ---------------- PGN / FEN ---------------- */
async function importPGN() {
  const text = $("#pgn").value.trim();
  if (!text) { setStatus("请先粘贴 PGN 内容", true); return; }
  try {
    const r = await api("/api/games/parse", { pgn: text });
    S.initialFen = r.initial_fen;
    S.headers = r.headers || {};
    S.history = r.moves.map((m) => ({ ...m, fenAfter: m.fen_after, an: null }));
    S.cursor = S.history.length;
    S.gameOver = r.over;
    S.evalStart = null;
    invalidateJob();
    clearHint();
    setStatus(`已导入 ${r.moves.length} 步${r.result && r.result !== "*" ? "，结果 " + r.result : ""}`);
    S._pendingEval = null;
    applyOrientation();
    renderAll();
    refreshLegal();
    scheduleAnalyze();
    startGameAnalysis();
  } catch (e) {
    setStatus("PGN 导入失败: " + e.message, true);
  }
}

async function loadFEN() {
  const fen = $("#fen").value.trim();
  if (!fen) { setStatus("请输入 FEN", true); return; }
  try {
    await api("/api/position/moves", { fen }); // 顺便校验 FEN 合法性
    S.initialFen = fen;
    S.history = [];
    S.cursor = 0;
    S.gameOver = false;
    S.headers = {};
    S.evalStart = null;
    invalidateJob();
    clearHint();
    setStatus("已载入 FEN 局面");
    S._pendingEval = null;
    applyOrientation();
    renderAll();
    await refreshLegal();
    scheduleAnalyze();
  } catch (e) {
    setStatus("FEN 无效: " + e.message, true);
  }
}

async function exportPGN() {
  if (!S.history.length) { setStatus("没有可导出的着法", true); return; }
  try {
    const r = await api("/api/games/export", {
      headers: S.headers,
      initial_fen: S.initialFen,
      moves: S.history.map((m) => m.uci),
      analysis: S.history.map((m) => m.an || {}),
    });
    const blob = new Blob([r.pgn], { type: "application/x-chess-pgn" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (S.headers.White || "analysis") + "-vs-" + (S.headers.Black || "opponent") + ".pgn";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("已导出带评注的 PGN");
  } catch (e) {
    setStatus("导出失败: " + e.message, true);
  }
}

/* ---------------- 整局分析任务 ---------------- */
async function startGameAnalysis() {
  if (!S.history.length) { setStatus("没有着法可分析，请先走子或导入棋局", true); return; }
  invalidateJob();
  const gen = ++S.jobGen;
  const depth = +$("#depth").value;
  try {
    const r = await api("/api/games/analyze-job", {
      initial_fen: S.initialFen,
      moves: S.history.map((m) => m.uci),
      depth,
      cap: 2.0,
    });
    S.job = { id: r.job_id, gen };
    $("#jobprogress").style.display = "block";
    $("#jobtext").textContent = "分析中…";
    pollJob(r.job_id, gen);
  } catch (e) {
    setStatus("启动分析失败: " + e.message, true);
  }
}

async function pollJob(id, gen) {
  while (S.job && S.job.id === id && S.jobGen === gen) {
    await new Promise((res) => setTimeout(res, 600));
    if (S.jobGen !== gen) return;
    let r;
    try { r = await api(`/api/jobs/${id}`); } catch (e) { return; }
    $("#jobprogress > div").style.width =
      r.total ? Math.round(100 * r.done / r.total) + "%" : "0%";
    $("#jobtext").textContent = `分析中 ${r.done}/${r.total} 局面（深度 ${$("#depth").value}）…`;
    if (r.status === "running") continue;
    if (r.status === "done" && r.result) {
      mergeAnalysis(r.result);
      $("#jobtext").textContent =
        `分析完成：白方准确率 ${r.result.accuracy_white ?? "–"}%，黑方准确率 ${r.result.accuracy_black ?? "–"}%`;
    } else if (r.status === "cancelled") {
      $("#jobtext").textContent = "分析已取消";
    } else {
      $("#jobtext").textContent = "分析失败: " + (r.error || "未知错误");
    }
    $("#jobprogress").style.display = "none";
    S.job = null;
    return;
  }
}

function mergeAnalysis(res) {
  S.evalStart = res.eval_start;
  res.moves.forEach((m) => {
    if (S.history[m.ply]) S.history[m.ply].an = m;
  });
  renderAccuracy(res);
  renderMoves();
  renderGraph();
}

function renderAccuracy(res) {
  const box = $("#accuracy");
  box.style.display = "flex";
  const cats = ["best", "excellent", "good", "inaccuracy", "mistake", "blunder"];
  [["w", "#acc-w"], ["b", "#acc-b"]].forEach(([side, sel]) => {
    const el = $(sel);
    const acc = side === "w" ? res.accuracy_white : res.accuracy_black;
    el.querySelector(".val").textContent = acc != null ? acc + "%" : "–";
    const counts = res.counts[side];
    el.querySelector(".acc-counts").innerHTML = cats
      .filter((c) => counts[c] > 0)
      .map((c) => `<span><i class="bdg ${c}">${CLS_LABEL[c]}</i> ${counts[c]}</span>`)
      .join("");
  });
}

/* ---------------- 着法列表 ---------------- */
function renderMoves() {
  const ml = $("#movelist");
  ml.innerHTML = "";
  for (let i = 0; i < S.history.length; i += 2) {
    const num = document.createElement("span");
    num.className = "mnum";
    num.textContent = moveNumberAt(i) + ".";
    ml.appendChild(num);
    for (let j = i; j < i + 2; j++) {
      if (j >= S.history.length) { ml.appendChild(document.createElement("span")); continue; }
      const m = S.history[j];
      const cell = document.createElement("span");
      cell.className = "mv" + (S.cursor === j + 1 ? " cur" : "");
      cell.dataset.ply = j;
      const san = document.createElement("span");
      san.className = "san";
      san.textContent = m.san;
      cell.appendChild(san);
      if (m.an) {
        const b = document.createElement("i");
        b.className = "bdg " + m.an.cls;
        b.textContent = CLS_LABEL[m.an.cls];
        cell.appendChild(b);
        const lossTxt = m.an.cp_loss > 90000 ? "送杀" : m.an.cp_loss + " 厘兵";
        cell.title = `引擎推荐: ${m.an.best_san} (${m.an.best_score})\n实际: ${m.an.san} → ${m.an.played_score}\n损失: ${lossTxt} | 单步准确率 ${m.an.accuracy}%`;
      }
      cell.onclick = () => setCursor(j + 1);
      ml.appendChild(cell);
    }
  }
  const cur = ml.querySelector(".mv.cur");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

/* ---------------- 评估曲线 ---------------- */
function renderGraph() {
  const svg = $("#graph");
  svg.innerHTML = "";
  const hasData = S.history.some((m) => m.an);
  const w = svg.clientWidth || 600;
  const h = 110;
  const pad = 6;
  const points = [];
  if (S.evalStart != null) points.push({ ply: 0, cp: S.evalStart });
  S.history.forEach((m, i) => {
    if (m.an && m.an.eval_white_after != null) points.push({ ply: i + 1, cp: m.an.eval_white_after });
  });
  if (points.length < 2) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", "50%"); t.setAttribute("y", "50%");
    t.setAttribute("fill", "#9aa1af"); t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "middle");
    t.setAttribute("font-size", "12");
    t.textContent = "运行「分析整局」后显示评估曲线";
    svg.appendChild(t);
    return;
  }
  const n = Math.max(...points.map((p) => p.ply), S.history.length, 1);
  const X = (ply) => pad + (ply / n) * (w - 2 * pad);
  const Y = (cp) => h - (winp(cp) / 100) * h;
  const NS = "http://www.w3.org/2000/svg";

  // 黑方区域底色
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("x", 0); bg.setAttribute("y", 0);
  bg.setAttribute("width", w); bg.setAttribute("height", h);
  bg.setAttribute("fill", "#101216");
  svg.appendChild(bg);

  // 面积多边形（曲线到底边），白色部分直接填充，黑方部分用 clip
  const poly = points.map((p) => `${X(p.ply)},${Y(p.cp)}`).join(" ");
  const areaPts = `${pad},${h} ${poly} ${w - pad},${h}`;
  const areaW = document.createElementNS(NS, "polygon");
  areaW.setAttribute("points", areaPts);
  areaW.setAttribute("fill", "#e9e9e9");
  svg.appendChild(areaW);

  const clip = document.createElementNS(NS, "clipPath");
  clip.setAttribute("id", "belowclip");
  const cr = document.createElementNS(NS, "rect");
  cr.setAttribute("x", 0); cr.setAttribute("y", h / 2);
  cr.setAttribute("width", w); cr.setAttribute("height", h / 2);
  clip.appendChild(cr);
  svg.appendChild(clip);

  const areaB = document.createElementNS(NS, "polygon");
  areaB.setAttribute("points", areaPts);
  areaB.setAttribute("fill", "#05070a");
  areaB.setAttribute("clip-path", "url(#belowclip)");
  svg.appendChild(areaB);

  // 中线与曲线
  const mid = document.createElementNS(NS, "line");
  mid.setAttribute("x1", pad); mid.setAttribute("x2", w - pad);
  mid.setAttribute("y1", h / 2); mid.setAttribute("y2", h / 2);
  mid.setAttribute("stroke", "#3a4050");
  mid.setAttribute("stroke-width", 1);
  svg.appendChild(mid);

  const curve = document.createElementNS(NS, "polyline");
  curve.setAttribute("points", poly);
  curve.setAttribute("fill", "none");
  curve.setAttribute("stroke", "#e5b84b");
  curve.setAttribute("stroke-width", 1.6);
  svg.appendChild(curve);

  // 悬停参考线
  const guide = document.createElementNS(NS, "line");
  guide.setAttribute("stroke", "#7aa2f7");
  guide.setAttribute("stroke-width", 1);
  guide.setAttribute("y1", 0); guide.setAttribute("y2", h);
  guide.setAttribute("visibility", "hidden");
  svg.appendChild(guide);

  svg.onmousemove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    let best = points[0];
    for (const p of points) if (Math.abs(X(p.ply) - x) < Math.abs(X(best.ply) - x)) best = p;
    guide.setAttribute("x1", X(best.ply));
    guide.setAttribute("x2", X(best.ply));
    guide.setAttribute("visibility", "visible");
    const label = best.ply === 0
      ? `初始局面 评估 ${fmtEval(best.cp)}`
      : `${moveNumberAt(best.ply - 1)}. ${S.history[best.ply - 1]?.san || ""} (${S.history[best.ply - 1]?.an?.color === "w" ? "白" : "黑"}) → ${fmtEval(best.cp)}`;
    $("#graphtip").textContent = label;
  };
  svg.onmouseleave = () => {
    guide.setAttribute("visibility", "hidden");
    $("#graphtip").textContent = "";
  };
  svg.onclick = (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    let best = points[0];
    for (const p of points) if (Math.abs(X(p.ply) - x) < Math.abs(X(best.ply) - x)) best = p;
    setCursor(best.ply);
  };
}

/* ---------------- 状态与其他渲染 ---------------- */
function setStatus(text, isErr = false) {
  const el = $("#status");
  el.textContent = text;
  el.style.color = isErr ? "#ff7b72" : "";
}

function renderStatus() {
  const fen = curFen();
  const turn = fenTurn(fen);
  if (S.gameOver && S.cursor === S.history.length) {
    setStatus("对局结束");
    return;
  }
  const side = turn === "w" ? "白方" : "黑方";
  const check = S.checkSq ? " · 将军！" : "";
  $("#status").innerHTML =
    `第 ${fenFullmove(fen)} 回合 · <span class="turn">${side}行棋</span>${check}`;
}

function renderStepInfo() {
  $("#stepinfo").textContent = S.history.length
    ? `${S.cursor} / ${S.history.length} 步`
    : "起始局面";
}

function renderAll() {
  renderBoard();
  renderMoves();
  renderStatus();
  renderStepInfo();
  renderGraph();
  const cached = S.evalCache.get(curFen() + "|" + $("#depth").value);
  if (cached) renderLines(cached);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  const boardEl = $("#board");
  boardEl.addEventListener("pointerdown", onBoardPointerDown);
  window.addEventListener("pointermove", onBoardPointerMove);
  window.addEventListener("pointerup", onBoardPointerUp);
  window.addEventListener("pointercancel", () => { cancelDrag(); });
  // 首次交互时解锁音频（浏览器策略要求用户手势）
  window.addEventListener("pointerdown", () => audioCtx(), { once: true, capture: true });

  $("#btn-start").onclick = () => setCursor(0);
  $("#btn-prev").onclick = () => setCursor(S.cursor - 1);
  $("#btn-next").onclick = () => setCursor(S.cursor + 1);
  $("#btn-end").onclick = () => setCursor(S.history.length);

  $("#btn-new").onclick = async () => {
    invalidateJob();
    S.initialFen = START_FEN;
    S.history = [];
    S.cursor = 0;
    S.gameOver = false;
    S.headers = {};
    S.evalStart = null;
    S.sel = null;
    S._pendingEval = null;
    clearHint();
    $("#accuracy").style.display = "none";
    setStatus("新对局开始");
    applyOrientation();
    renderAll();
    await refreshLegal();
    scheduleAnalyze();
    maybeEngineMove();
  };

  $("#btn-undo").onclick = () => {
    if (!S.history.length || S.busy) return;
    // 引擎刚走完（最后一步是引擎的）→ 连引擎的应着一起撤销，回到自己轮次
    const lastMove = S.history[S.history.length - 1];
    const trim = (S.vsEngine && S.history.length >= 2 && lastMove.color === S.engineSide) ? 2 : 1;
    S.history = S.history.slice(0, S.history.length - trim);
    S.cursor = S.history.length;
    S.gameOver = false;
    S.sel = null;
    S._pendingEval = null;
    invalidateJob();
    clearHint();
    renderAll();
    refreshLegal();
    scheduleAnalyze();
    maybeEngineMove();
  };

  $("#btn-flip").onclick = () => { S.flipped = !S.flipped; renderBoard(); };

  $("#btn-hint").onclick = hint;
  $("#btn-engine-move").onclick = async () => {
    if (S.busy || S.gameOver) return;
    S.busy = true;
    setStatus("引擎思考中…");
    try {
      const preFen = curFen();
      const depth = +$("#depth").value;
      const r = await api("/api/engine/move", { fen: preFen, level: +$("#engine-level").value });
      if (S.badgeOn) S._pendingEval = { preFen, uci: r.uci, depth };
      applyMove(r);
      setStatus(`引擎走了 ${r.san}`);
    } catch (e) {
      setStatus("引擎走子失败: " + e.message, true);
    }
    S.busy = false;
  };

  $("#chk-vs-engine").onchange = (e) => {
    S.vsEngine = e.target.checked;
    applyOrientation();
    if (S.vsEngine) maybeEngineMove();
  };
  $("#chk-badge").checked = S.badgeOn;
  $("#chk-badge").onchange = (e) => {
    S.badgeOn = e.target.checked;
    localStorage.setItem("stfchess-badge", S.badgeOn ? "1" : "0");
  };
  $("#chk-sound").checked = S.soundOn;
  $("#chk-sound").onchange = (e) => {
    S.soundOn = e.target.checked;
    localStorage.setItem("stfchess-sound", S.soundOn ? "1" : "0");
    if (S.soundOn) sndMove(); // 试听
  };
  $("#engine-side").onchange = (e) => {
    S.engineSide = e.target.value;
    applyOrientation();
    maybeEngineMove();
  };

  $("#depth").onchange = () => {
    scheduleAnalyze();
    renderGraph();
  };

  $("#btn-import-pgn").onclick = importPGN;
  $("#btn-export-pgn").onclick = exportPGN;
  $("#btn-load-fen").onclick = loadFEN;
  $("#btn-demo").onclick = () => { $("#pgn").value = DEMO_PGN; importPGN(); };
  $("#btn-analyze-game").onclick = startGameAnalysis;

  document.addEventListener("keydown", (ev) => {
    if (ev.target.tagName === "TEXTAREA" || ev.target.tagName === "INPUT") return;
    if (ev.key === "ArrowLeft") setCursor(S.cursor - 1);
    if (ev.key === "ArrowRight") setCursor(S.cursor + 1);
    if (ev.key === "Home") setCursor(0);
    if (ev.key === "End") setCursor(S.history.length);
  });

  window.addEventListener("resize", () => renderGraph());
}

/* ---------------- 棋盘拖拽 / 点击走子（鼠标与触屏统一 Pointer Events） ---------------- */
let _drag = null; // {from, el, pid, startX, startY, moved}

function squareFromPoint(x, y) {
  const rect = $("#board").getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const col = Math.floor((x - rect.left) / (rect.width / 8));
  const row = Math.floor((y - rect.top) / (rect.height / 8));
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  const xf = S.flipped ? 7 - col : col;
  const yf = S.flipped ? row : 7 - row;
  return FILES[xf] + (yf + 1);
}

function onBoardPointerDown(ev) {
  if (ev.button !== undefined && ev.button !== 0) return; // 仅左键
  const sqEl = ev.target.closest(".sq");
  if (!sqEl || $("#promo").hidden === false) return;
  clearHint();
  const sq = sqEl.dataset.square;
  // 已有选中且点在合法目标上 → 直接走子
  if (S.sel) {
    const cand = S.legal.filter((m) => m.from === S.sel && m.to === sq);
    if (cand.length) {
      S.sel = null;
      if (cand.some((m) => m.promotion)) showPromo(cand[0].from, sq);
      else doUserMove(cand[0].from, sq);
      return;
    }
  }
  const p = pieceAt(curFen(), sq);
  if (p && p.color === S.turn && !S.gameOver && !S.busy) {
    S.sel = sq;
    renderBoard();
    _drag = {
      from: sq,
      el: sqEl.querySelector(".pc"),
      pid: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: false,
    };
    try { sqEl.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    ev.preventDefault();
  } else {
    S.sel = null;
    renderBoard();
  }
}

function onBoardPointerMove(ev) {
  if (!_drag || ev.pointerId !== _drag.pid) return;
  if (!_drag.moved) {
    if (Math.hypot(ev.clientX - _drag.startX, ev.clientY - _drag.startY) < 5) return;
    _drag.moved = true;
    const el = _drag.el;
    if (!el) return;
    el.classList.add("dragging");
    el.style.width = el.getBoundingClientRect().width + "px";
    el.style.position = "fixed";
    el.style.zIndex = 60;
    el.style.pointerEvents = "none";
  }
  const el = _drag.el;
  const r = el.getBoundingClientRect();
  el.style.left = (ev.clientX - r.width / 2) + "px";
  el.style.top = (ev.clientY - r.height / 2) + "px";
}

function releaseDragged(el) {
  if (!el) return;
  el.classList.remove("dragging");
  el.style.cssText = "";
}

function cancelDrag() {
  if (!_drag) return;
  releaseDragged(_drag.el);
  _drag = null;
  renderBoard();
}

function onBoardPointerUp(ev) {
  if (!_drag || ev.pointerId !== _drag.pid) return;
  const d = _drag;
  _drag = null;
  if (!d.moved) return; // 原地松开 = 单击选中，保留 S.sel 供再次点击走子
  const to = squareFromPoint(ev.clientX, ev.clientY);
  const mv = to && S.legal.find((m) => m.from === d.from && m.to === to);
  if (mv) {
    S.sel = null;
    releaseDragged(d.el);
    if (mv.promotion) showPromo(d.from, to);
    else doUserMove(d.from, to);
  } else {
    // 非法位置 → 弹回原格
    releaseDragged(d.el);
    renderBoard();
  }
}

/* ---------------- 初始化 ---------------- */
async function init() {
  bindEvents();
  renderAll();
  await refreshLegal();
  try {
    const h = await api("/api/health");
    $("#engine-name").textContent = h.engine;
    $("#conn").textContent = "引擎已连接";
    $("#conn").className = "ok";
    scheduleAnalyze();
  } catch (e) {
    $("#conn").textContent = "引擎连接失败: " + e.message;
    $("#conn").className = "bad";
  }
}

init();
