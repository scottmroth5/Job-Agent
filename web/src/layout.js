// The order rule for arranged screens (server/layout.js saves the order): saved items first in their saved order,
// then anything added since in its default place. Unknown or repeated saved items are dropped. No JSX, so the
// unit tests import it directly.
export function arranged(defaults, saved) {
  if (!Array.isArray(saved) || !saved.length) return [...defaults];
  const first = [...new Set(saved)].filter((k) => defaults.includes(k));
  return [...first, ...defaults.filter((k) => !first.includes(k))];
}

/** The list with the item at index i moved by step (-1 earlier, +1 later); unchanged at either end. */
export function moved(list, i, step) {
  const j = i + step;
  if (i < 0 || j < 0 || i >= list.length || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
