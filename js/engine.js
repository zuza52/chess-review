/**
 * Тонкая обёртка над UCI-движком Stockfish (WASM) в Web Worker.
 * Поиски сериализуются: новый поиск аккуратно останавливает предыдущий,
 * поэтому UI никогда не зависает в ожидании bestmove.
 */

export function abortError() {
  const e = new Error('Поиск отменён');
  e.name = 'AbortError';
  return e;
}

/** Разбор строки "info ..." в объект. */
export function parseInfo(line) {
  const t = line.split(/\s+/);
  const out = { depth: 0, multipv: 1, score: null, pv: [], nodes: 0, nps: 0, time: 0 };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': out.depth = +t[++i]; break;
      case 'seldepth': i++; break;
      case 'multipv': out.multipv = +t[++i]; break;
      case 'nodes': out.nodes = +t[++i]; break;
      case 'nps': out.nps = +t[++i]; break;
      case 'time': out.time = +t[++i]; break;
      case 'hashfull': i++; break;
      case 'score': {
        const type = t[++i];
        const value = +t[++i];
        out.score = { type, value };
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') i++;
        break;
      }
      case 'pv':
        out.pv = t.slice(i + 1);
        i = t.length;
        break;
      default:
        break;
    }
  }
  return out;
}

export class Engine {
  constructor(url = 'engine/stockfish-19-lite-single.js') {
    this.url = url;
    this.worker = null;
    this.ready = false;
    this.name = 'Stockfish 19';
    this._init = null;
    this._search = null;
    this._lock = Promise.resolve();
    this._readyWaiters = [];
    this.onLog = null;
  }

  /** Загружает wasm и ждёт uciok. */
  init() {
    if (this._init) return this._init;
    this._init = new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(this.url);
      } catch (err) {
        reject(new Error('Не удалось запустить движок: ' + err.message));
        return;
      }
      this.worker = worker;

      let settled = false;
      const finishOk = () => {
        if (settled) return;
        settled = true;
        clearInterval(kick);
        clearTimeout(deadline);
        this.ready = true;
        resolve(this);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(kick);
        clearTimeout(deadline);
        reject(err);
      };

      worker.onerror = (ev) => fail(new Error(ev.message || 'Ошибка загрузки движка'));
      worker.onmessage = (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
        for (const raw of text.split('\n')) {
          const line = raw.trim();
          if (!line) continue;
          if (line.startsWith('id name ')) this.name = line.slice(8).trim();
          if (line === 'uciok') finishOk();
          this._onLine(line);
        }
      };

      // wasm компилируется асинхронно: повторяем uci, пока не ответит
      const kick = setInterval(() => {
        try { worker.postMessage('uci'); } catch { /* ignore */ }
      }, 500);
      const deadline = setTimeout(
        () => fail(new Error('Движок не ответил за 90 секунд. Проверьте файлы в папке engine/.')),
        90000
      );
      worker.postMessage('uci');
    });
    return this._init;
  }

  _onLine(line) {
    if (this.onLog) this.onLog(line);
    if (line.startsWith('info ')) {
      if (this._search) this._search.info(line);
      return;
    }
    if (line.startsWith('bestmove')) {
      const s = this._search;
      if (s) {
        this._search = null;
        s.bestmove(line);
      }
      return;
    }
    if (line === 'readyok') {
      const w = this._readyWaiters.shift();
      if (w) w();
    }
  }

  isReady() {
    return new Promise((resolve) => {
      this._readyWaiters.push(resolve);
      this.worker.postMessage('isready');
    });
  }

  async setOption(name, value) {
    this.worker.postMessage(`setoption name ${name} value ${value}`);
    await this.isReady();
  }

  /** Просит движок остановиться и ждёт bestmove. */
  interrupt() {
    const s = this._search;
    if (!s) return Promise.resolve();
    s.cancel();
    try { this.worker.postMessage('stop'); } catch { /* ignore */ }
    return s.done;
  }

  stop() {
    this.interrupt();
  }

  /**
   * Запускает поиск. Возвращает { bestmove, info, infos }.
   * onInfo(infos) вызывается при каждом обновлении (массив по multipv).
   */
  analyze({ fen, depth = 14, multipv = 1, movetime = 0, onInfo, signal }) {
    if (signal?.aborted) return Promise.reject(abortError());

    // новый поиск важнее текущего — сразу тормозим старый
    if (this._search) this.interrupt();

    const run = this._lock.then(async () => {
      if (this._search) await this._search.done;
      return this._start({ fen, depth, multipv, movetime, onInfo, signal });
    });
    this._lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  _start({ fen, depth, multipv, movetime, onInfo, signal }) {
    return new Promise((resolve, reject) => {
      if (!this.ready || !this.worker) {
        reject(new Error('Движок ещё не готов'));
        return;
      }

      const byLine = new Map();
      let cancelled = false;
      let settle = null;
      const done = new Promise((res) => (settle = res));

      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      const finish = (fn, value) => {
        cleanup();
        settle();
        fn(value);
      };

      const search = {
        done,
        cancel: () => {
          cancelled = true;
          cleanup();
        },
        info: (line) => {
          if (cancelled) return;
          const parsed = parseInfo(line);
          if (!parsed.score) return;
          const prev = byLine.get(parsed.multipv);
          if (!prev || parsed.depth >= prev.depth) byLine.set(parsed.multipv, parsed);
          if (onInfo) {
            const list = [...byLine.values()].sort((a, b) => a.multipv - b.multipv);
            try { onInfo(list); } catch { /* ignore */ }
          }
        },
        bestmove: (line) => {
          const bestmove = (line.split(/\s+/)[1] || '').trim();
          const list = [...byLine.values()].sort((a, b) => a.multipv - b.multipv);
          if (cancelled) finish(reject, abortError());
          else finish(resolve, { bestmove, info: list[0] || null, infos: list });
        },
      };

      const onAbort = () => {
        search.cancel();
        try { this.worker.postMessage('stop'); } catch { /* ignore */ }
      };

      if (signal) {
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this._search = search;
      try {
        this.worker.postMessage(`setoption name MultiPV value ${multipv}`);
        this.worker.postMessage(`position fen ${fen}`);
        this.worker.postMessage(movetime ? `go movetime ${movetime}` : `go depth ${depth}`);
      } catch (err) {
        this._search = null;
        finish(reject, err);
      }
    });
  }

  quit() {
    try { this.worker?.postMessage('quit'); } catch { /* ignore */ }
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
    this.ready = false;
  }
}
