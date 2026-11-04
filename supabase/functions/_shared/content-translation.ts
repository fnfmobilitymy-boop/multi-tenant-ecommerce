export const CONTENT_LANGUAGES = ["zh", "en", "ms", "th", "km", "vi"] as const;
export function translationInput(body: unknown) {
  if (!body || typeof body !== "object") throw new Error("Invalid content");
  const { kind, fields } = body as { kind: unknown; fields: unknown };
  if (kind !== "store" && kind !== "product") throw new Error("Invalid kind");
  const limits: Record<string, number> =
    kind === "store"
      ? { name: 80, description: 500 }
      : { name: 120, description: 2000, category: 80, variant: 100 };
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error("Invalid fields");
  const entries = Object.entries(fields);
  if (
    !entries.length ||
    entries.some(
      ([key, value]) =>
        !Object.hasOwn(limits, key) ||
        typeof value !== "string" ||
        value.length > limits[key],
    )
  )
    throw new Error("Invalid fields");
  const pairs = entries.filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].trim().length > 0,
  );
  if (!pairs.some(([key]) => key === "name")) throw new Error("Name required");
  return {
    kind,
    pairs,
    characters: pairs.reduce((total, [, value]) => total + value.length, 0),
  };
}
export function decodeTranslation(value: string) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-fA-F]+|#[0-9]+);/g,
    (entity) => {
      const literal: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&#39;": "'",
      };
      if (literal[entity]) return literal[entity];
      const code = entity.startsWith("&#x")
        ? parseInt(entity.slice(3, -1), 16)
        : parseInt(entity.slice(2, -1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    },
  );
}
export function translatedFields(
  result: unknown,
  pairs: [string, string][],
  kind: string,
) {
  const entries = (
    result as { data?: { translations?: { translatedText?: string }[] } }
  )?.data?.translations;
  if (!Array.isArray(entries) || entries.length !== pairs.length)
    throw new Error("Incomplete translation");
  const limits: Record<string, number> =
    kind === "store"
      ? { name: 80, description: 500 }
      : { name: 120, description: 2000, category: 80, variant: 100 };
  return Object.fromEntries(
    pairs.map(([key], index) => {
      const text = entries[index]?.translatedText;
      if (typeof text !== "string" || !text.trim())
        throw new Error("Incomplete translation");
      const decoded = decodeTranslation(text).trim();
      if (decoded.length > limits[key]) throw new Error("Translation too long");
      return [key, decoded];
    }),
  );
}
