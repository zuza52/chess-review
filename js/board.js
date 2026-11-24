/** Доска: отрисовка, тап/перетаскивание, подсветки, стрелки, диалог превращения. */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const SVG_NS = 'http://www.w3.org/2000/svg';

export function parsePlacement(fen) {
  const pos = {};
  const rows = (fen || '').split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r] || '') {
      if (/\d/.test(ch)) {
        file += +ch;
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        pos[FILES[file] + (8 - r)] = color + ch.toUpperCase();
        file++;
      }
    }
  }
  return pos;
}

export class Board {
  constructor(el, opts = {}) {
    this.el = el;
    this.orientation = opts.orientation || 'white';
    this.onMove = opts.onMove || (() => {});
    this.getMoves = opts.getMoves || (() => []);
    this.interactive = true;

    this.fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    this.pos = parsePlacement(this.fen);
    this.turn = 'w';
    this.lastMove = null;
    this.checkSq = null;
    this.badges = new Map();
    this.arrowList = [];
    this.selected = null;
    this.dests = new Map();
    this.ghost = null;

    this._onDown = this._down.bind(this);
    this._onMoveWin = this._moveWin.bind(this);
    this._onUp = this._up.bind(this);

    this._build();
    this.el.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMoveWin, { passive: true });
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMoveWin);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.el.innerHTML = '';
  }

  // ---------------------------------------------------------------- render
  _build() {
    this.el.innerHTML = '';
    this.squares = new Map();
    this.xy = new Map();

    const files = this.orientation === 'white' ? FILES.slice() : FILES.slice().reverse();
    const ranks = this.orientation === 'white' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = files[col];
        const rank = ranks[row];
        const sq = file + rank;
        const fi = FILES.indexOf(file);
        const isLight = (fi + rank - 1) % 2 === 1;
        const el = document.createElement('div');
        el.className = 'sq ' + (isLight ? 'light' : 'dark');
        el.dataset.sq = sq;
        if (col === 0) {
          const c = document.createElement('span');
          c.className = 'coord rank';
          c.textContent = rank;
          el.appendChild(c);
        }
        if (row === 7) {
          const c = document.createElement('span');
          c.className = 'coord file';
          c.textContent = file;
          el.appendChild(c);
        }
        this.el.appendChild(el);
        this.squares.set(sq, el);
        this.xy.set(sq, [col, row]);
      }
    }

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'board-arrows');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.el.appendChild(this.svg);

    this._renderPieces();
    this._paintMarks();
  }

  _renderPieces() {
    for (const [sq, el] of this.squares) {
      const piece = this.pos[sq] || '';
      if ((el.dataset.piece || '') === piece) continue;
      el.dataset.piece = piece;
      const old = el.querySelector('.pc');
      if (old) old.remove();
      if (piece) {
        const d = document.createElement('div');
        d.className = 'pc pc-' + piece;
        el.appendChild(d);
      }
    }
  }

  _paintMarks() {
    for (const el of this.squares.values()) {
      el.classList.remove('last', 'sel', 'dest', 'occupied', 'check');
      const old = el.querySelector('.badge');
      if (old) old.remove();
    }
    if (this.lastMove) {
      this.squares.get(this.lastMove.from)?.classList.add('last');
      this.squares.get(this.lastMove.to)?.classList.add('last');
    }
    if (this.checkSq) this.squares.get(this.checkSq)?.classList.add('check');
    if (this.selected) {
      this.squares.get(this.selected)?.classList.add('sel');
      for (const to of this.dests.keys()) {
        const el = this.squares.get(to);
        if (!el) continue;
        el.classList.add('dest');
        if (this.pos[to]) el.classList.add('occupied');
      }
    }
    for (const [sq, badge] of this.badges) {
      const el = this.squares.get(sq);
      if (!el) continue;
      const b = document.createElement('span');
      b.className = 'badge cbadge ' + badge.cls;
      b.textContent = badge.glyph;
      el.appendChild(b);
    }
    this._paintArrows();
  }

  _paintArrows() {
    this.svg.innerHTML = '';
    for (const a of this.arrowList) {
      const p1 = this.xy.get(a.from);
      const p2 = this.xy.get(a.to);
      if (!p1 || !p2) continue;
      const x1 = p1[0] + 0.5;
      const y1 = p1[1] + 0.5;
      const x2 = p2[0] + 0.5;
      const y2 = p2[1] + 0.5;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const headLen = Math.min(0.30, len * 0.42);
      const headW = 0.26;
      const sx = x1 + ux * 0.30;
      const sy = y1 + uy * 0.30;
      const ex = x2 - ux * 0.26;
      const ey = y2 - uy * 0.26;
      const bx = ex - ux * headLen;
      const by = ey - uy * headLen;
      const color = a.color || '#81b64c';

      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', sx.toFixed(3));
      line.setAttribute('y1', sy.toFixed(3));
      line.setAttribute('x2', bx.toFixed(3));
      line.setAttribute('y2', by.toFixed(3));
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '0.16');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('opacity', a.opacity ?? '0.85');
      this.svg.appendChild(line);

      const head = document.createElementNS(SVG_NS, 'polygon');
      head.setAttribute(
        'points',
        `${ex.toFixed(3)},${ey.toFixed(3)} ` +
          `${(bx - uy * headW * 0.5).toFixed(3)},${(by + ux * headW * 0.5).toFixed(3)} ` +
          `${(bx + uy * headW * 0.5).toFixed(3)},${(by - ux * headW * 0.5).toFixed(3)}`
      );
      head.setAttribute('fill', color);
      head.setAttribute('opacity', a.opacity ?? '0.85');
      this.svg.appendChild(head);
    }
  }

  // ---------------------------------------------------------------- public
  setPosition(fen) {
    this.fen = fen;
    this.turn = (fen.split(' ')[1] || 'w') === 'w' ? 'w' : 'b';
    this.pos = parsePlacement(fen);
    this._renderPieces();
    this._paintMarks();
  }

  setOrientation(o) {
    if (o !== 'white' && o !== 'black') return;
    if (o === this.orientation) return;
    this.orientation = o;
    this.selected = null;
    this.dests.clear();
    this._build();
  }

  flip() {
    this.setOrientation(this.orientation === 'white' ? 'black' : 'white');
  }

  setLastMove(from, to) {
    this.lastMove = from && to ? { from, to } : null;
    this._paintMarks();
  }

  setCheck(square) {
    this.checkSq = square || null;
    this._paintMarks();
  }

  setBadges(map) {
    this.badges = map instanceof Map ? map : new Map();
    this._paintMarks();
  }

  setArrows(list) {
    this.arrowList = Array.isArray(list) ? list : [];
    this._paintArrows();
  }

  setInteractive(on) {
    this.interactive = !!on;
    if (!on) this._clearSelection();
  }

  setHints(on) {
    this.hints = !!on;
  }

  /** Разрешает ходы из квадрата (для внешнего источника правил). */
  setMoveSource(fn) {
    this.getMoves = fn;
  }

  // ------------------------------------------------------------- interaction
  _down(e) {
    if (!this.interactive) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const target = e.target.closest ? e.target.closest('.sq') : null;
    if (!target || !this.el.contains(target)) return;
    const sq = target.dataset.sq;

    if (this.selected && this.selected !== sq && this.dests.has(sq)) {
      e.preventDefault();
      const mv = this.dests.get(sq);
      this._complete(this.selected, sq, mv);
      return;
    }
    if (this.selected === sq) {
      this._clearSelection();
      return;
    }

    const piece = this.pos[sq];
    if (!piece || piece[0] !== this.turn) {
      this._clearSelection();
      return;
    }

    const moves = this.getMoves(sq) || [];
    if (!moves.length) {
      this._clearSelection();
      return;
    }

    this.selected = sq;
    this.dests = new Map();
    for (const m of moves) this.dests.set(m.to, m);
    this._paintMarks();
    this._startDrag(e, sq, piece);
  }

  _startDrag(e, sq, piece) {
    const rect = this.el.getBoundingClientRect();
    const cell = rect.width / 8;
    const ghost = document.createElement('div');
    ghost.className = 'drag-piece pc-' + piece;
    ghost.style.width = cell + 'px';
    ghost.style.height = cell + 'px';
    ghost.style.left = e.clientX - rect.left + 'px';
    ghost.style.top = e.clientY - rect.top + 'px';
    this.el.appendChild(ghost);
    this.ghost = ghost;
    this.dragFrom = sq;
    this._rect = rect;
    this._dragMoved = false;
    this.el.classList.add('dragging');
    this.squares.get(sq)?.querySelector('.pc')?.classList.add('drag-src');
  }

  _moveWin(e) {
    if (!this.ghost) return;
    this._dragMoved = true;
    this.ghost.style.left = e.clientX - this._rect.left + 'px';
    this.ghost.style.top = e.clientY - this._rect.top + 'px';
  }

  _up(e) {
    if (!this.ghost) return;
    const from = this.dragFrom;
    const moved = this._dragMoved;
    this._endDrag();
    if (!moved) return;
    const sqEl = document.elementFromPoint(e.clientX, e.clientY);
    const target = sqEl?.closest?.('.sq');
    if (!target || !this.el.contains(target)) {
      this._clearSelection();
      return;
    }
    const to = target.dataset.sq;
    if (to !== from && this.dests.has(to)) {
      this._complete(from, to, this.dests.get(to));
    } else {
      this._clearSelection();
    }
  }

  _endDrag() {
    this.ghost?.remove();
    this.ghost = null;
    this.el.classList.remove('dragging');
    this.squares.get(this.dragFrom)?.querySelector('.pc')?.classList.remove('drag-src');
  }

  async _complete(from, to, mv) {
    const promotion = mv && mv.promotion;
    this._clearSelection();
    if (promotion) {
      const piece = await this._askPromotion(mv.color || this.turn);
      this.onMove({ from, to, promotion: piece });
    } else {
      this.onMove({ from, to });
    }
  }

  _askPromotion(color) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'promo';
      const inner = document.createElement('div');
      inner.className = 'promo-inner';
      for (const p of ['q', 'r', 'b', 'n']) {
        const btn = document.createElement('button');
        btn.className = 'promo-btn pc-' + color + p.toUpperCase();
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', () => {
          wrap.remove();
          resolve(p);
        });
        inner.appendChild(btn);
      }
      wrap.appendChild(inner);
      this.el.appendChild(wrap);
    });
  }

  _clearSelection() {
    this.selected = null;
    this.dests = new Map();
    this._endDrag();
    this._paintMarks();
  }
}
