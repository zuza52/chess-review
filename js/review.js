/**
 * Математика разбора: нормализация оценок, классификация ходов,
 * точность в процентах (формулы в духе lichess / chess.com).
 */
import { abortError } from './engine.js';
import { scanBook } from './book.js';

export const CLASSES = {
  brilliant: { label: 'Блестящий', glyph: '!!', order: 0 },
  best: { label: 'Лучший', glyph: '★', order: 1 },
  excellent: { label: 'Отличный', glyph: '✓', order: 2 },
  good: { label: 'Хороший', glyph: '✓', order: 3 },
  book: { label: 'Теория', glyph: '≡', order: 4 },
  inaccuracy: { label: 'Неточность', glyph: '?!', order: 5 },
  mistake: { label: 'Ошибка', glyph: '?', order: 6 },
  blunder: { label: 'Зевок', glyph: '??', order: 7 },
};

export const CLASS_ORDER = Object.keys(CLASSES);

const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE_CP = 10000;

/** Оценка движка (от стороны, которая ходит) -> белые сверху. */
export function normalizeInfo(info, fen) {
  const turn = (fen.split(' ')[1] || 'w') === 'w' ? 1 : -1;
  const out = { cp: 0, mate: null, bestmove: null, depth: 0, pv: [], turn: turn === 1 ? 'w' : 'b' };
  if (!info) return out;
  out.depth = info.depth || 0;
  out.pv = info.pv || [];
  out.bestmove = out.pv[0] || null;
  if (info.score) {
    if (info.score.type === 'cp') {
      out.cp = info.score.value * turn;
      if (Math.abs(out.cp) > 2000) out.cp = Math.sign(out.cp) * 2000;
    } else if (info.score.type === 'mate') {
      // mate 0 = сторона, которая должна ходить, уже получила мат
      const m = info.score.value === 0 ? -1 : info.score.value;
      out.mate = m * turn;
      out.mate0 = info.score.value === 0;
      out.cp = Math.sign(out.mate) * (MATE_CP - Math.abs(out.mate) * 10);
    }
  }
  return out;
}

/** Вероятность победы (в процентах) для стороны с оценкой cp. */
export function winPercent(cp) {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

export function winPercentOf(ev) {
  if (!ev) return 50;
  if (ev.mate != null) return ev.mate > 0 ? 100 : 0;
  return winPercent(ev.cp);
}

/** Точность одного хода по потере вероятности победы. */
export function accuracyFromLoss(loss) {
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, loss)) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

export function formatEval(ev, { signed = true } = {}) {
  if (!ev) return '0.0';
  if (ev.mate != null) {
    if (ev.mate0) return '#';
    return (ev.mate > 0 ? (signed ? '+' : '') : '−') + 'M' + Math.abs(ev.mate);
  }
  const p = ev.cp / 100;
  if (Math.abs(p) < 0.05) return '0.0';
  return (p > 0 ? (signed ? '+' : '') : '−') + Math.abs(p).toFixed(1);
}

export function materialWhite(fen) {
  const placement = fen.split(' ')[0];
  let sum = 0;
  for (const ch of placement) {
    const v = PIECE_VALUE[ch.toLowerCase()];
    if (!v) continue;
    sum += ch === ch.toUpperCase() ? v : -v;
  }
  return sum;
}

/** Ходы, где оценка просела, помечаем для графика. */
export function isBadClass(cls) {
  return cls === 'inaccuracy' || cls === 'mistake' || cls === 'blunder';
}

/**
 * Полный разбор партии.
 * @param {object} game  { startFen, moves: [...] }
 * @param {Engine} engine
 */
export async function analyzeGame(game, engine, opts = {}) {
  const { depth = 14, book = null, onProgress, onEval, signal } = opts;
  const moves = game.moves;
  const total = moves.length + 1;
  const evals = new Array(total);
  const started = performance.now();

  const terminalEval = (i) => {
    if (i === 0) return null;
    const t = moves[i - 1].terminal;
    if (!t) return null;
    if (t.type === 'mate') {
      const sign = t.winner === 'w' ? 1 : -1;
      return {
        cp: sign * MATE_CP,
        mate: sign,
        mate0: true,
        bestmove: null,
        depth: 0,
        pv: [],
        terminal: true,
      };
    }
    return { cp: 0, mate: null, bestmove: null, depth: 0, pv: [], terminal: true };
  };

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw abortError();
    const fen = i === 0 ? game.startFen : moves[i - 1].fenAfter;

    const term = terminalEval(i);
    if (term) {
      evals[i] = term;
      if (onProgress) {
        onProgress({
          done: i + 1,
          total,
          index: i,
          eval: evals[i],
          elapsed: (performance.now() - started) / 1000,
        });
      }
      continue;
    }

    let result;
    try {
      result = await engine.analyze({
        fen,
        depth,
        multipv: 1,
        signal,
        onInfo: (infos) => {
          if (!onEval || !infos[0]) return;
          onEval(i, normalizeInfo(infos[0], fen));
        },
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error(`Движок остановился на позиции ${i + 1}: ${err.message}`);
    }
    evals[i] = normalizeInfo(result.info, fen);
    if (!evals[i].bestmove && result.bestmove) evals[i].bestmove = result.bestmove;
    if (onProgress) {
      onProgress({
        done: i + 1,
        total,
        index: i,
        eval: evals[i],
        elapsed: (performance.now() - started) / 1000,
      });
    }
  }

  const bookScan = book && !game.customStart
    ? scanBook(book, moves.map((m) => m.san))
    : { flags: new Array(moves.length).fill(false), opening: null };

  const counts = { w: {}, b: {} };
  const accLists = { w: [], b: [] };

  const analyzedMoves = moves.map((mv, i) => {
    const sign = mv.color === 'w' ? 1 : -1;
    const before = evals[i];
    const after = evals[i + 1];
    const beforeMover = { cp: before.cp * sign, mate: before.mate == null ? null : before.mate * sign };
    const afterMover = { cp: after.cp * sign, mate: after.mate == null ? null : after.mate * sign };
    const wpBefore = winPercentOf(beforeMover);
    const wpAfter = winPercentOf(afterMover);
    const loss = Math.max(0, wpBefore - wpAfter);
    const accuracy = accuracyFromLoss(loss);

    const isBest = !!before.bestmove && mv.uci === before.bestmove;
    const inBook = bookScan.flags[i];

    const matBefore = materialWhite(mv.fenBefore);
    const matAfter = materialWhite(mv.fenAfter);
    const materialDelta = (matAfter - matBefore) * sign;
    const sacrifice = materialDelta <= -200;
    const isBrilliant =
      isBest &&
      sacrifice &&
      afterMover.cp >= 50 &&
      !mv.forced &&
      depth >= 10;

    let cls;
    if (inBook) cls = 'book';
    else if (isBrilliant) cls = 'brilliant';
    else if (isBest) cls = 'best';
    else if (loss < 2) cls = 'excellent';
    else if (loss < 5) cls = 'good';
    else if (loss < 10) cls = 'inaccuracy';
    else if (loss < 20) cls = 'mistake';
    else cls = 'blunder';

    if (mv.forced && !inBook) cls = 'best';

    counts[mv.color][cls] = (counts[mv.color][cls] || 0) + 1;
    accLists[mv.color].push(accuracy);

    return {
      ...mv,
      index: i,
      cls,
      loss,
      accuracy,
      evalBefore: before,
      evalAfter: after,
      bestmove: before.bestmove,
      inBook,
      brilliant: cls === 'brilliant',
    };
  });

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  return {
    depth,
    evals,
    moves: analyzedMoves,
    accuracy: { w: mean(accLists.w), b: mean(accLists.b) },
    counts,
    opening: bookScan.opening,
    duration: (performance.now() - started) / 1000,
  };
}
