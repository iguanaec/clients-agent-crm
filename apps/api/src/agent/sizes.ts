/**
 * Convierte lo que dice la clienta ("8 años", "6 meses", "talla 10") a las tallas del catálogo
 * el catálogo (atributo `Talla`: 0M, 1M, 3M, 9M, 12M, 18M, 24M, 2, 4, 6, 8, 10, 12, 14, 16...).
 * Devuelve candidatas en orden de preferencia (talla exacta primero, luego la siguiente).
 */
export function candidateSizes(input: string): string[] {
  const t = input.toLowerCase().trim();

  const months = t.match(/(\d+)\s*(m\b|mes|meses)/);
  if (months) {
    const n = Number(months[1]);
    const grid = [0, 1, 3, 6, 9, 12, 18, 24];
    const next = grid.find((g) => g >= n) ?? 24;
    const nextBigger = grid.find((g) => g > next);
    return [next, nextBigger].filter((x): x is number => x !== undefined).map((g) => `${g}M`);
  }

  const years = t.match(/(\d+)\s*(a(ñ|n)os?|años|a\b)?/);
  if (years) {
    const n = Number(years[1]);
    if (n >= 2 && n <= 16) return [String(n), String(n + 2)].filter((s) => Number(s) <= 16);
    if (n < 2) return ["18M", "24M"];
  }
  return [];
}
