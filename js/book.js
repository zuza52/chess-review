/** Дебютная книга: дерево вариантов из lichess chess-openings. */
let cache = null;

export async function loadBook() {
  if (cache) return cache;
  const res = await fetch('data/openings.json');
  if (!res.ok) throw new Error('Не удалось загрузить дебютную книгу');
  cache = await res.json();
  return cache;
}

/**
 * Идём по дереву вместе с ходами партии.
 * flags[i] === true, если ход i всё ещё в теории.
 */
export function scanBook(book, sans) {
  const flags = new Array(sans.length).fill(false);
  let opening = null;
  let node = book;
  for (let i = 0; i < sans.length; i++) {
    if (!node) break;
    const next = node[sans[i]];
    if (!next) {
      node = null;
      break;
    }
    flags[i] = true;
    node = next;
    if (node.n) opening = { name: node.n, eco: node.e, ply: i + 1 };
  }
  return { flags, opening };
}
