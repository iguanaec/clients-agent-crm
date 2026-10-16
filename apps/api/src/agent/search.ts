const STOP = new Set(["talla", "tallas", "size", "de", "del", "la", "el", "para", "años", "anos", "año", "ano", "meses", "mes", "a", "un", "una"]);

/** Palabras de búsqueda en minúscula, sin conectores y con plurales simples recortados ("vestidos" -> "vestido"). */
export function searchTerms(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** Variantes candidatas cuando el catálogo no es de ropa infantil: se compara cada palabra con la etiqueta exacta. */
export function variantTokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9ñ.]+/).filter((w) => w && !STOP.has(w));
}
