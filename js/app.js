/**
 * Chess Review — разбор шахматных партий со Stockfish 19 (WASM) на устройстве.
 */
import { Chess } from '../vendor/chess.js';
import { Engine } from './engine.js';
import { loadBook } from './book.js';
import { analyzeGame, normalizeInfo, formatEval, winPercentOf, CLASSES } from './review.js';
import { Board } from './board.js';
import { EvalChart } from './chart.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const SAMPLE_PGN = `[Event "Париж, опера"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[Round "?"]
[White "Морфи, Пол"]
[Black "Герцог Карл / граф Изуар"]
[Result "1-0"]

1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7
8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7
14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`;

const DEFAULTS = { depth: 12, showArrows: true, sound: true, autoAnalyze: true };

// ------------------------------------------------------------------ state
const settings = Object.assign(
  {},
  DEFAULTS,
  JSON.parse(localStorage.getItem('cr.settings') || '{}')
);

const state = {
  engine: null,
  engineReady: false,
  engineError: null,
  book: null,
  game: null,
  review: null,
  ply: 0,
  analyzing: false,
  abort: null,
  queued: null,
  orientation: localStorage.getItem('cr.orient') === 'black' ? 'black' : 'white',
};

const free = { chess: new Chess(), abort: null, lastInfo: null, lastRender: 0, pending: null };

let board;
let freeBoard;
let chart;
let enginePromise = null;
let deferredPrompt = null;

// ------------------------------------------------------------------ utils
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function saveSettings() {
  localStorage.setItem('cr.settings', JSON.stringify(settings));
}

function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function findKing(chess, color) {
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && sq.type === 'k' && sq.color === color) return sq.square;
    }
  }
  return null;
}

function uciToSan(fen, uci) {
  if (!uci || uci.length < 4) return null;
  try {
    const c = new Chess(fen);
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return m ? m.san : null;
  } catch {
    return null;
  }
}

function uciLineToSan(fen, pv) {
  try {
    const c = new Chess(fen);
    const out = [];
    for (const u of pv) {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (!m) break;
      out.push(m.san);
    }
    return out.join(' ');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ PGN
function splitPgnGames(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const games = [];
  let cur = [];
  let inMoves = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('[')) {
      if (inMoves && cur.some((l) => l.trim())) {
        games.push(cur.join('\n'));
        cur = [];
      }
      inMoves = false;
      cur.push(line);
    } else {
      if (t) inMoves = true;
      cur.push(line);
    }
  }
  if (cur.some((l) => l.trim())) games.push(cur.join('\n'));
  return games.length ? games : [text];
}

function buildGame(pgnText) {
  const probe = new Chess();
  probe.loadPgn(pgnText);
  const headers = probe.header() || {};
  const sans = probe.history();
  if (!sans.length) throw new Error('В партии не найдено ходов');

  const startFen = headers.FEN || DEFAULT_FEN;
  const chess = new Chess(startFen);
  const moves = [];

  for (const san of sans) {
    const fenBefore = chess.fen();
    const legal = chess.moves().length;
    let mv;
    try {
      mv = chess.move(san);
    } catch {
      break;
    }
    if (!mv) break;
    let terminal = null;
    if (chess.isCheckmate()) terminal = { type: 'mate', winner: mv.color };
    else if (chess.isStalemate()) terminal = { type: 'stalemate' };
    else if (chess.isInsufficientMaterial()) terminal = { type: 'material' };
    else if (chess.isDraw()) terminal = { type: 'draw' };
    moves.push({
      san: mv.san,
      from: mv.from,
      to: mv.to,
      promotion: mv.promotion,
      color: mv.color,
      piece: mv.piece,
      captured: mv.captured,
      uci: mv.from + mv.to + (mv.promotion || ''),
      fenBefore,
      fenAfter: chess.fen(),
      num: +(fenBefore.split(' ')[5] || 1),
      legal,
      forced: legal === 1,
      terminal,
    });
  }
  if (!moves.length) throw new Error('Не удалось прочитать ходы партии');
  return {
    headers,
    startFen,
    moves,
    finalFen: chess.fen(),
    pgn: pgnText,
    customStart: !!headers.FEN,
  };
}

// ------------------------------------------------------------------ cache
const REVIEW_CACHE_VERSION = 2;

function cacheKey(game, depth) {
  return 'cr.rev.' + hashStr('v' + REVIEW_CACHE_VERSION + '|' + game.pgn + '|' + game.startFen + '|' + depth);
}

function readCache(key, depth) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.v !== REVIEW_CACHE_VERSION || data.depth !== depth) return null;
    return data.review;
  } catch {
    return null;
  }
}

function writeCache(key, review) {
  try {
    localStorage.setItem(key, JSON.stringify({ v: REVIEW_CACHE_VERSION, depth: review.depth, at: Date.now(), review }));
    pruneCache();
  } catch {
    /* переполнение — не критично */
  }
}

function pruneCache() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('cr.rev.'));
    if (keys.length <= 8) return;
    const items = keys
      .map((k) => {
        try {
          return { k, at: JSON.parse(localStorage.getItem(k)).at || 0 };
        } catch {
          return { k, at: 0 };
        }
      })
      .sort((a, b) => b.at - a.at);
    items.slice(8).forEach((it) => localStorage.removeItem(it.k));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ engine
function initEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const chip = $('#engineChip');
    const eng = new Engine('engine/stockfish-19-lite-single.js');
    state.engine = eng;
    await eng.init();
    try {
      await eng.setOption('Hash', 32);
    } catch {
      /* не критично */
    }
    state.engineReady = true;
    chip.className = 'brand-sub ready';
    chip.innerHTML = '<span class="dot"></span> ' + eng.name + ' · готов';
    return eng;
  })().catch((err) => {
    state.engineError = err;
    const chip = $('#engineChip');
    chip.className = 'brand-sub error';
    chip.innerHTML = '<span class="dot"></span> Движок не загрузился';
    console.error(err);
    throw err;
  });
  return enginePromise;
}

function ensureEngine() {
  return initEngine();
}

// ------------------------------------------------------------------ sound
let audioCtx = null;
function playMoveSound() {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.07);
    gain.gain.setValueAtTime(0.09, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ review screen
function renderPlayers() {
  const g = state.game;
  const w = g ? g.headers.White || 'Белые' : 'Белые';
  const b = g ? g.headers.Black || 'Чёрные' : 'Чёрные';
  const we = g && g.headers.WhiteElo ? ` (${g.headers.WhiteElo})` : '';
  const be = g && g.headers.BlackElo ? ` (${g.headers.BlackElo})` : '';
  $('#playersBar .player.white .pname').textContent = w + we;
  $('#playersBar .player.black .pname').textContent = b + be;
  $('#gameResult').textContent = (g && g.headers.Result) || '—';
}

function showReviewCard(show) {
  $('#reviewCard').classList.toggle('hidden', !show);
  $('#importCard').classList.toggle('hidden', show);
  $('#screen-review').classList.toggle('has-game', show);
}

function renderMoveList() {
  const list = $('#moveList');
  const g = state.game;
  if (!g) {
    list.innerHTML = '';
    return;
  }
  const rev = state.review;
  const rows = [];
  for (let i = 0; i < g.moves.length; i += 2) {
    const white = g.moves[i];
    const black = g.moves[i + 1];
    const num = white.num;
    rows.push(`<div class="ml-row">
      <div class="ml-num">${num}</div>
      ${cell(white, i, rev)}
      ${black ? cell(black, i + 1, rev) : '<div class="ml-cell empty"></div>'}
    </div>`);
  }
  list.innerHTML = rows.join('');
}

function cell(mv, index, rev) {
  const info = rev ? rev.moves[index] : null;
  const cls = info ? info.cls : null;
  const badge = cls
    ? `<span class="cbadge ${cls}">${CLASSES[cls].glyph}</span>`
    : '<span class="cbadge" style="background:#4a4741"></span>';
  return `<button class="ml-cell" data-ply="${index + 1}">${badge}<span class="ml-san">${mv.san}</span></button>`;
}

function highlightMoveList() {
  $$('#moveList .ml-cell').forEach((el) => {
    el.classList.toggle('active', +el.dataset.ply === state.ply);
  });
  const active = $('#moveList .ml-cell.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function updateEvalBar(ev, fillSel = '#evalBarFill', txtSel = '#evalBarTxt') {
  const pct = ev ? winPercentOf(ev) : 50;
  const fill = $(fillSel);
  if (fill) fill.style.height = pct.toFixed(1) + '%';
  const txt = $(txtSel);
  if (txt) txt.textContent = ev ? formatEval(ev) : '0.0';
}

function renderMoveCard() {
  const card = $('#moveCard');
  const g = state.game;
  if (!g) {
    card.innerHTML = '<div class="mc-empty">Загрузите партию, чтобы увидеть разбор.</div>';
    return;
  }
  if (state.ply === 0) {
    const ev = state.review ? state.review.evals[0] : null;
    card.innerHTML = `<div class="mc-head"><span class="mc-move">Начальная позиция</span>${
      ev ? `<span class="mc-eval">${formatEval(ev)}</span>` : ''
    }</div><div class="mc-best">${g.startFen === DEFAULT_FEN ? 'Стандартное начало партии.' : 'Позиция из FEN.'}</div>`;
    return;
  }

  const mv = g.moves[state.ply - 1];
  const info = state.review ? state.review.moves[state.ply - 1] : null;
  const dots = mv.color === 'w' ? '.' : '…';
  const evalAfter = info ? info.evalAfter : null;

  let head = `<div class="mc-head"><span class="mc-move">${mv.num}${dots} ${mv.san}</span>`;
  if (info) {
    head += `<span class="cbadge big ${info.cls}">${CLASSES[info.cls].glyph}</span>`;
    head += `<span class="muted small">${CLASSES[info.cls].label}</span>`;
  }
  if (evalAfter) head += `<span class="mc-eval">${formatEval(evalAfter)}</span>`;
  head += '</div>';

  let best = '';
  if (info && info.bestmove && info.bestmove !== mv.uci) {
    const san = uciToSan(mv.fenBefore, info.bestmove);
    if (san) {
      best = `<div class="mc-best">Лучше было: <span class="alt">${san}</span> · оценка ${formatEval(
        info.evalBefore
      )}</div>`;
    }
  } else if (info && info.cls === 'best') {
    best = '<div class="mc-best">Это лучший ход по версии движка.</div>';
  } else if (info && info.cls === 'book') {
    best = '<div class="mc-best">Дебютная теория.</div>';
  } else if (!info) {
    best = '<div class="mc-best">Нажмите «Анализировать», чтобы оценить ход.</div>';
  }

  card.innerHTML = head + best;
}

function renderPosition() {
  const g = state.game;
  if (!g) return;
  const ply = state.ply;
  const fen = ply === 0 ? g.startFen : g.moves[ply - 1].fenAfter;

  board.setPosition(fen);
  const last = ply > 0 ? g.moves[ply - 1] : null;
  board.setLastMove(last?.from, last?.to);

  let checkSq = null;
  try {
    const c = new Chess(fen);
    if (c.inCheck()) checkSq = findKing(c, c.turn());
  } catch {
    /* ignore */
  }
  board.setCheck(checkSq);

  const rev = state.review;
  const arrows = [];
  if (settings.showArrows && rev && rev.evals[ply]?.bestmove) {
    const u = rev.evals[ply].bestmove;
    if (u && u.length >= 4 && u !== '(none)') {
      arrows.push({ from: u.slice(0, 2), to: u.slice(2, 4), color: '#81b64c' });
    }
  }
  board.setArrows(arrows);

  const badges = new Map();
  if (rev && ply > 0) {
    const mv = rev.moves[ply - 1];
    if (mv && mv.cls) badges.set(mv.to, { cls: mv.cls, glyph: CLASSES[mv.cls].glyph });
  }
  board.setBadges(badges);

  updateEvalBar(rev ? rev.evals[ply] : null);
  renderMoveCard();
  chart.setCurrent(ply);
  highlightMoveList();
  updateNav();
}

function updateNav() {
  const n = state.game ? state.game.moves.length : 0;
  const p = state.ply;
  const map = { start: p === 0, prev: p === 0, next: p >= n, end: p >= n };
  for (const [k, disabled] of Object.entries(map)) {
    const btn = $(`.nav-btn[data-nav="${k}"]`);
    if (btn) btn.disabled = disabled;
  }
}

function goPly(p) {
  const n = state.game ? state.game.moves.length : 0;
  state.ply = Math.max(0, Math.min(n, p));
  renderPosition();
}

function renderAccuracy() {
  const rev = state.review;
  const w = $('#accWhite .acc-num');
  const b = $('#accBlack .acc-num');
  if (!rev) {
    w.textContent = '—';
    b.textContent = '—';
    return;
  }
  w.textContent = rev.accuracy.w ? rev.accuracy.w.toFixed(1) : '—';
  b.textContent = rev.accuracy.b ? rev.accuracy.b.toFixed(1) : '—';
}

function renderCounts() {
  const el = $('#countsRow');
  const rev = state.review;
  if (!rev) {
    el.innerHTML = '';
    return;
  }
  const order = ['brilliant', 'best', 'inaccuracy', 'mistake', 'blunder'];
  const side = (label, counts) =>
    `<div class="counts-row"><span class="counts-side">${label}</span>${order
      .filter((k) => counts[k])
      .map(
        (k) =>
          `<span class="count-pill"><span class="cbadge ${k}">${CLASSES[k].glyph}</span>${counts[k]}</span>`
      )
      .join('')}</div>`;
  el.innerHTML = side('Белые', rev.counts.w) + side('Чёрные', rev.counts.b);
}

function applyReview(review) {
  state.review = review;
  renderAccuracy();
  renderCounts();
  renderMoveList();
  chart.setData(review.evals, review.moves);
  const nameEl = $('#openingName');
  nameEl.textContent = review.opening ? review.opening.name : 'Разбор партии';
  nameEl.title = review.opening ? `${review.opening.eco} · ${review.opening.name}` : '';
  $('#analysisMeta').textContent = `глубина ${review.depth} · ${review.duration.toFixed(1)} с`;
  $('#btnAnalyze').textContent = 'Пересчитать';
  renderPosition();
}

function updateProgress(info) {
  const pct = Math.round((info.done / info.total) * 100);
  $('#progressFill').style.width = pct + '%';
  const perMove = info.elapsed / info.done;
  const left = Math.max(0, Math.round(perMove * (info.total - info.done)));
  $('#progressText').textContent = pct + '%';
  $('#analysisMeta').textContent =
    `ход ${info.done} из ${info.total}` + (left > 0 ? ` · осталось ~${left} с` : '');
}

function setAnalyzingUI(on) {
  $('#btnAnalyze').classList.toggle('hidden', on);
  $('#progress').classList.toggle('hidden', !on);
  const chip = $('#engineChip');
  chip.classList.toggle('busy', on);
  if (!on) {
    $('#progressFill').style.width = '0%';
    if (state.review) {
      $('#analysisMeta').textContent = `глубина ${state.review.depth} · ${state.review.duration.toFixed(1)} с`;
    }
  }
}

async function startAnalysis(force = false) {
  if (!state.game || state.analyzing) return;
  const depth = settings.depth;
  const key = cacheKey(state.game, depth);

  if (!force) {
    const cached = readCache(key, depth);
    if (cached) {
      applyReview(cached);
      return;
    }
  }

  state.analyzing = true;
  state.abort = new AbortController();
  setAnalyzingUI(true);
  $('#analysisMeta').textContent = 'подготовка движка…';

  try {
    await ensureEngine();
    if (!state.book) state.book = await loadBook().catch(() => null);
    const review = await analyzeGame(state.game, state.engine, {
      depth,
      book: state.book,
      signal: state.abort.signal,
      onProgress: updateProgress,
    });
    writeCache(key, review);
    applyReview(review);
    toast(`Готово: глубина ${depth}, ${review.duration.toFixed(1)} с`);
  } catch (err) {
    if (err.name === 'AbortError') {
      toast('Анализ отменён');
    } else {
      console.error(err);
      toast(err.message || 'Ошибка анализа', 4000);
    }
  } finally {
    state.analyzing = false;
    state.abort = null;
    setAnalyzingUI(false);
    if (state.queued) {
      const q = state.queued;
      state.queued = null;
      setTimeout(() => startAnalysis(q.force), 0);
    }
  }
}

/** Ставит разбор в очередь: если что-то считается, оно будет прервано. */
function requestAnalysis(force = false) {
  if (state.analyzing) {
    state.queued = { force };
    state.abort?.abort();
    return;
  }
  startAnalysis(force);
}

function loadGame(game) {
  state.abort?.abort();
  state.game = game;
  state.review = null;
  state.ply = 0;
  renderPlayers();
  renderMoveList();
  renderAccuracy();
  renderCounts();
  showReviewCard(true);
  chart.setData([], []);
  $('#openingName').textContent = 'Разбор партии';
  $('#analysisMeta').textContent = 'не проанализировано';
  $('#btnAnalyze').textContent = 'Анализировать';
  renderPosition();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (settings.autoAnalyze) requestAnalysis();
}

function importPgn(text) {
  const chunks = splitPgnGames(text);
  const games = [];
  const errors = [];
  for (const chunk of chunks) {
    try {
      games.push(buildGame(chunk));
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (!games.length) {
    toast(errors[0] || 'Не удалось разобрать PGN', 4000);
    return;
  }
  if (games.length === 1) {
    loadGame(games[0]);
  } else {
    showGamePicker(games);
  }
}

function showGamePicker(games) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="pickerBackdrop">
    <div class="modal">
      <h2>В файле ${games.length} партий</h2>
      <div class="modal-sub">Выберите, какую разбирать</div>
      <div id="pickerList"></div>
      <button class="btn ghost modal-close" id="pickerCancel">Отмена</button>
    </div>
  </div>`;
  const list = $('#pickerList');
  games.forEach((g) => {
    const btn = document.createElement('button');
    btn.className = 'game-item';
    const title = document.createElement('b');
    title.textContent = `${g.headers.White || 'Белые'} — ${g.headers.Black || 'Чёрные'}`;
    const meta = document.createElement('div');
    meta.className = 'g-meta';
    meta.textContent = `${g.headers.Result || '*'} · ${g.headers.Date || ''} · ${
      g.headers.Event || ''
    } · ${g.moves.length} ходов`;
    btn.appendChild(title);
    btn.appendChild(meta);
    btn.onclick = () => {
      root.innerHTML = '';
      loadGame(g);
    };
    list.appendChild(btn);
  });
  $('#pickerCancel').onclick = () => (root.innerHTML = '');
  $('#pickerBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'pickerBackdrop') root.innerHTML = '';
  });
}

// ------------------------------------------------------------------ free board
function renderFree() {
  const chess = free.chess;
  freeBoard.setPosition(chess.fen());
  const hist = chess.history({ verbose: true });
  const last = hist[hist.length - 1];
  freeBoard.setLastMove(last?.from, last?.to);
  freeBoard.setCheck(chess.inCheck() ? findKing(chess, chess.turn()) : null);
  $('#fenCurrent').textContent = chess.fen();
  $('#freeTurn').textContent = chess.turn() === 'w' ? 'ход белых' : 'ход чёрных';

  const rows = [];
  for (let i = 0; i < hist.length; i += 2) {
    rows.push(`<div class="ml-row"><div class="ml-num">${i / 2 + 1}</div>
      <div class="ml-cell"><span class="ml-san">${hist[i]?.san || ''}</span></div>
      <div class="ml-cell"><span class="ml-san">${hist[i + 1]?.san || ''}</span></div></div>`);
  }
  $('#freeMoveList').innerHTML = rows.join('') || '<div class="mc-empty" style="padding:10px">Пока нет ходов.</div>';
}

function renderFreeLines(fen, infos) {
  const now = performance.now();
  if (now - free.lastRender < 70) {
    free.pending = { fen, infos };
    clearTimeout(free._t);
    free._t = setTimeout(() => {
      if (free.pending) {
        const p = free.pending;
        free.pending = null;
        renderFreeLines(p.fen, p.infos);
      }
    }, 80);
    return;
  }
  free.lastRender = now;
  free.lastInfo = infos[0] || null;

  const box = $('#freeLines');
  if (!infos.length) {
    box.innerHTML = '<div class="muted small">Движок думает…</div>';
    return;
  }
  box.innerHTML = infos
    .map((info) => {
      const ev = normalizeInfo(info, fen);
      const san = uciLineToSan(fen, info.pv.slice(0, 10));
      const active = ev.mate != null ? 'mate' : ev.cp >= 0 ? 'pos' : 'neg';
      return `<div class="eline" data-uci="${info.pv[0] || ''}">
        <span class="score ${active}">${formatEval(ev)}</span>
        <span class="pv">${san || '…'}</span>
      </div>`;
    })
    .join('');

  updateEvalBar(normalizeInfo(infos[0], fen), '#freeEvalFill', '#freeEvalTxt');

  const last = infos[0];
  if (last) {
    const nps = last.nps ? (last.nps / 1000).toFixed(0) + 'k' : '—';
    const nodes = last.nodes ? (last.nodes / 1000).toFixed(0) + 'k' : '—';
    $('#freeStat').textContent = `глубина ${last.depth} · ${nodes} узлов · ${nps} nps`;
  }
}

function runFreeAnalysis() {
  if (!$('#freeEngineOn').checked) {
    free.abort?.abort();
    $('#freeLines').innerHTML = '<div class="muted small">Анализ выключен.</div>';
    freeBoard.setArrows([]);
    return;
  }
  free.abort?.abort();
  const ac = new AbortController();
  free.abort = ac;
  const fen = free.chess.fen();
  freeBoard.setArrows([]);
  $('#freeLines').innerHTML = '<div class="muted small">Движок думает…</div>';

  ensureEngine()
    .then(() => {
      if (ac.signal.aborted) return;
      return state.engine.analyze({
        fen,
        depth: 24,
        multipv: 3,
        signal: ac.signal,
        onInfo: (infos) => {
          if (!ac.signal.aborted) renderFreeLines(fen, infos);
        },
      });
    })
    .then((res) => {
      if (!res || ac.signal.aborted) return;
      renderFreeLines(fen, res.infos);
      const best = res.bestmove;
      if (best && best.length >= 4 && best !== '(none)') {
        freeBoard.setArrows([{ from: best.slice(0, 2), to: best.slice(2, 4), color: '#81b64c' }]);
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') console.error(err);
    });
}

// ------------------------------------------------------------------ settings
function openSettings() {
  const root = $('#modalRoot');
  const depthOpts = [10, 12, 14, 16, 18]
    .map((d) => `<option value="${d}" ${d === settings.depth ? 'selected' : ''}>${d}</option>`)
    .join('');
  root.innerHTML = `<div class="modal-backdrop" id="setBackdrop">
    <div class="modal">
      <h2>Настройки</h2>
      <div class="modal-sub">Stockfish 19 NNUE · считается на устройстве</div>

      <div class="field">
        <div><div class="field-label">Глубина анализа</div><div class="field-desc">Больше — точнее, но дольше</div></div>
        <select id="setDepth">${depthOpts}</select>
      </div>

      <div class="field">
        <div><div class="field-label">Стрелка лучшего хода</div><div class="field-desc">Показывать рекомендацию движка</div></div>
        <label class="switch"><input type="checkbox" id="setArrows" ${settings.showArrows ? 'checked' : ''}><span class="slider"></span></label>
      </div>

      <div class="field">
        <div><div class="field-label">Автоанализ</div><div class="field-desc">Запускать разбор сразу после загрузки</div></div>
        <label class="switch"><input type="checkbox" id="setAuto" ${settings.autoAnalyze ? 'checked' : ''}><span class="slider"></span></label>
      </div>

      <div class="field">
        <div><div class="field-label">Звук ходов</div><div class="field-desc">Тихий щелчок при ходе</div></div>
        <label class="switch"><input type="checkbox" id="setSound" ${settings.sound ? 'checked' : ''}><span class="slider"></span></label>
      </div>

      <div class="field">
        <div><div class="field-label">Кэш разборов</div><div class="field-desc">Сохранённые партии открываются мгновенно</div></div>
        <button class="btn small" id="setClearCache">Очистить</button>
      </div>

      <button class="btn ghost wide" id="setInstall" style="margin-top:12px">Установить на телефон</button>
      <button class="btn primary wide modal-close" id="setClose" style="margin-top:8px">Готово</button>
    </div>
  </div>`;

  const close = () => (root.innerHTML = '');
  $('#setClose').onclick = close;
  $('#setBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'setBackdrop') close();
  });

  $('#setDepth').onchange = (e) => {
    settings.depth = +e.target.value;
    saveSettings();
    if (state.game) toast('Глубина изменена — нажмите «Пересчитать»');
  };
  $('#setArrows').onchange = (e) => {
    settings.showArrows = e.target.checked;
    saveSettings();
    renderPosition();
  };
  $('#setAuto').onchange = (e) => {
    settings.autoAnalyze = e.target.checked;
    saveSettings();
  };
  $('#setSound').onchange = (e) => {
    settings.sound = e.target.checked;
    saveSettings();
    if (settings.sound) playMoveSound();
  };
  $('#setClearCache').onclick = () => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('cr.rev.'))
      .forEach((k) => localStorage.removeItem(k));
    toast('Кэш разборов очищен');
  };
  $('#setInstall').onclick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const res = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (res.outcome === 'accepted') toast('Приложение установлено');
    } else {
      toast('Откройте меню браузера → «Установить приложение» / «На экран Домой»', 5000);
    }
  };
}

// ------------------------------------------------------------------ wiring
function switchScreen(name) {
  $$('.tab, .ttab').forEach((t) => t.classList.toggle('active', t.dataset.screen === name));
  $('#screen-review').classList.toggle('hidden', name !== 'review');
  $('#screen-board').classList.toggle('hidden', name !== 'board');
  if (name === 'board') {
    if (state.analyzing) {
      state.abort?.abort();
      toast('Разбор приостановлен');
    }
    renderFree();
    runFreeAnalysis();
  } else {
    free.abort?.abort();
  }
}

function setupUI() {
  // tabs
  $$('.tab, .ttab').forEach((tab) => {
    tab.onclick = () => switchScreen(tab.dataset.screen);
  });

  // import
  $('#btnLoadPgn').onclick = () => {
    const text = $('#pgnInput').value.trim();
    if (!text) {
      toast('Вставьте текст PGN');
      return;
    }
    importPgn(text);
  };
  $('#btnPickFile').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      $('#pgnInput').value = text;
      importPgn(text);
    } catch (err) {
      toast('Не удалось прочитать файл');
    }
    e.target.value = '';
  };
  $('#btnSample').onclick = () => {
    $('#pgnInput').value = SAMPLE_PGN;
    importPgn(SAMPLE_PGN);
  };
  $('#btnNewGame').onclick = () => {
    switchScreen('review');
    $('#importCard').classList.remove('hidden');
    $('#pgnInput').focus();
    $('#importCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $('#btnSettings').onclick = openSettings;

  // analysis
  $('#btnAnalyze').onclick = () => requestAnalysis(!!state.review);
  $('#btnCancel').onclick = () => state.abort?.abort();

  // navigation
  $$('.nav-btn[data-nav]').forEach((btn) => {
    btn.onclick = () => {
      const a = btn.dataset.nav;
      if (a === 'start') goPly(0);
      else if (a === 'prev') goPly(state.ply - 1);
      else if (a === 'next') goPly(state.ply + 1);
      else if (a === 'end') goPly(state.game ? state.game.moves.length : 0);
      else if (a === 'flip') {
        board.flip();
        freeBoard.flip();
        state.orientation = board.orientation;
        localStorage.setItem('cr.orient', state.orientation);
      }
    };
  });

  $('#moveList').addEventListener('click', (e) => {
    const cell = e.target.closest('.ml-cell');
    if (cell && cell.dataset.ply) goPly(+cell.dataset.ply);
  });

  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    if ($('#screen-board').classList.contains('hidden') === false) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goPly(state.ply - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      goPly(state.ply + 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      goPly(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      goPly(state.game ? state.game.moves.length : 0);
    }
  });

  // free board buttons
  $('#freeUndo').onclick = () => {
    if (free.chess.undo()) {
      renderFree();
      runFreeAnalysis();
    }
  };
  $('#freeReset').onclick = () => {
    free.chess.reset();
    renderFree();
    runFreeAnalysis();
  };
  $('#freeFlip').onclick = () => {
    freeBoard.flip();
    board.flip();
    state.orientation = freeBoard.orientation;
    localStorage.setItem('cr.orient', state.orientation);
  };
  $('#freeCopyFen').onclick = async () => {
    try {
      await navigator.clipboard.writeText(free.chess.fen());
      toast('FEN скопирован');
    } catch {
      toast(free.chess.fen(), 5000);
    }
  };
  $('#btnLoadFen').onclick = () => {
    const val = $('#fenInput').value.trim();
    if (!val) return;
    try {
      free.chess.load(val);
      $('#fenInput').value = '';
      renderFree();
      runFreeAnalysis();
    } catch (err) {
      toast('Некорректный FEN');
    }
  };
  $('#fenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnLoadFen').click();
  });
  $('#freeEngineOn').onchange = () => runFreeAnalysis();
  $('#freeLines').addEventListener('click', (e) => {
    const line = e.target.closest('.eline');
    if (!line) return;
    const uci = line.dataset.uci;
    if (!uci || uci.length < 4) return;
    let mv = null;
    try {
      mv = free.chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || 'q',
      });
    } catch {
      mv = null;
    }
    if (mv) {
      playMoveSound();
      renderFree();
      runFreeAnalysis();
    }
  });

  // PWA
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });
}

function setupBoards() {
  board = new Board($('#board'), {
    orientation: state.orientation,
    getMoves: () => [],
  });
  board.setInteractive(false);
  board.setPosition(DEFAULT_FEN);

  freeBoard = new Board($('#freeBoard'), {
    orientation: state.orientation,
    getMoves: (sq) => free.chess.moves({ square: sq, verbose: true }),
    onMove: ({ from, to, promotion }) => {
      const mv = free.chess.move({ from, to, promotion: promotion || 'q' });
      if (!mv) return;
      playMoveSound();
      renderFree();
      runFreeAnalysis();
    },
  });
  freeBoard.setPosition(free.chess.fen());
}

function setupChart() {
  chart = new EvalChart($('#chart'), { onSelect: (i) => goPly(i) });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  // В упакованных приложениях (EXE/APK) файлы и так лежат локально,
  // а кэш service worker только мешает обновлениям — выключаем его.
  const packaged = location.hostname === 'chessreview.local' || location.hostname === '127.0.0.1';
  if (packaged) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
    if (window.caches) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    return;
  }

  if (location.protocol !== 'https:') return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW:', err));
}

// ------------------------------------------------------------------ boot
// Аппаратная кнопка «назад» (Android): закрываем окно, если оно открыто.
window.__crBack = function () {
  const root = document.getElementById('modalRoot');
  if (root && root.firstElementChild) {
    const closeBtn = root.querySelector('.modal-close');
    if (closeBtn) closeBtn.click();
    else root.innerHTML = '';
    return true;
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  return false;
};

function boot() {
  setupBoards();
  setupChart();
  setupUI();
  renderPlayers();
  renderMoveList();
  renderPosition();
  renderFree();
  registerSW();

  initEngine().catch(() => {});
  loadBook()
    .then((b) => (state.book = b))
    .catch(() => {});

  // автозапуск примера не делаем — ждём пользователя
}

boot();
