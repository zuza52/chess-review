/** График оценки партии (canvas). */

const COLORS = {
  brilliant: '#26c2a3',
  best: '#81b64c',
  excellent: '#96bc4b',
  good: '#8fae7a',
  book: '#a88865',
  inaccuracy: '#f7c045',
  mistake: '#e58f2a',
  blunder: '#ca3431',
};

const MAX_PAWNS = 6;

export class EvalChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = opts.onSelect || (() => {});
    this.evals = [];
    this.moves = [];
    this.current = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this._resize = this._resize.bind(this);
    this._pointer = this._pointer.bind(this);
    this.ro = new ResizeObserver(this._resize);
    this.ro.observe(canvas);
    canvas.addEventListener('pointerdown', this._pointer);
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons || e.pointerType !== 'mouse') this._pointer(e);
    });
    this._resize();
  }

  setData(evals, moves) {
    this.evals = evals || [];
    this.moves = moves || [];
    this.draw();
  }

  setCurrent(i) {
    this.current = i;
    this.draw();
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  }

  _x(i, n, pad) {
    if (n <= 1) return pad;
    return pad + (i / (n - 1)) * (this.w - pad * 2);
  }

  _y(ev) {
    let p = 0;
    if (ev) {
      if (ev.mate != null) p = ev.mate > 0 ? MAX_PAWNS : -MAX_PAWNS;
      else p = Math.max(-MAX_PAWNS, Math.min(MAX_PAWNS, ev.cp / 100));
    }
    const top = 10;
    const bottom = this.h - 10;
    return top + ((MAX_PAWNS - p) / (MAX_PAWNS * 2)) * (bottom - top);
  }

  draw() {
    if (!this.w || !this.h) return;
    const ctx = this.ctx;
    const { w, h } = this;
    const pad = 6;
    ctx.clearRect(0, 0, w, h);

    const n = this.evals.length;
    const mid = this._y({ cp: 0 });

    // фон: светлая половина сверху
    ctx.fillStyle = 'rgba(238, 238, 214, 0.10)';
    ctx.fillRect(0, 0, w, h);

    if (n === 0) {
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const pts = this.evals.map((ev, i) => [this._x(i, n, pad), this._y(ev)]);

    // область "белые сверху"
    ctx.beginPath();
    ctx.moveTo(pts[0][0], 0);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[pts.length - 1][0], 0);
    ctx.closePath();
    const gWhite = ctx.createLinearGradient(0, 0, 0, h);
    gWhite.addColorStop(0, 'rgba(246, 246, 235, 0.95)');
    gWhite.addColorStop(1, 'rgba(246, 246, 235, 0.55)');
    ctx.fillStyle = gWhite;
    ctx.fill();

    // область "чёрные снизу"
    ctx.beginPath();
    ctx.moveTo(pts[0][0], h);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[pts.length - 1][0], h);
    ctx.closePath();
    const gBlack = ctx.createLinearGradient(0, 0, 0, h);
    gBlack.addColorStop(0, 'rgba(24, 22, 20, 0.55)');
    gBlack.addColorStop(1, 'rgba(24, 22, 20, 0.92)');
    ctx.fillStyle = gBlack;
    ctx.fill();

    // линия нуля
    ctx.strokeStyle = 'rgba(0,0,0,.28)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.setLineDash([]);

    // сама кривая
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = 'rgba(40, 38, 34, .75)';
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // отметки ошибок
    for (const mv of this.moves) {
      if (!mv.cls) continue;
      if (!['inaccuracy', 'mistake', 'blunder', 'brilliant'].includes(mv.cls)) continue;
      const idx = mv.index + 1;
      const x = this._x(idx, n, pad);
      const y = this._y(this.evals[idx]);
      ctx.beginPath();
      ctx.arc(x, y, mv.cls === 'blunder' ? 3.4 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[mv.cls];
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // текущая позиция
    if (this.current >= 0 && this.current < n) {
      const x = this._x(this.current, n, pad);
      const y = this._y(this.evals[this.current]);
      ctx.strokeStyle = 'rgba(129, 182, 76, .9)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = '#81b64c';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  _pointer(e) {
    if (!this.evals.length) return;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const pad = 6;
    const n = this.evals.length;
    const t = n <= 1 ? 0 : ((x - pad) / (this.w - pad * 2)) * (n - 1);
    const idx = Math.max(0, Math.min(n - 1, Math.round(t)));
    this.onSelect(idx);
  }
}
