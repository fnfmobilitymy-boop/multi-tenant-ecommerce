import type { CartLine } from "./types";
export function parseCart(value: string | null): CartLine[] {
  try {
    const a: unknown = JSON.parse(value || "[]");
    return Array.isArray(a)
      ? a
          .filter(
            (x): x is CartLine =>
              x &&
              typeof x === "object" &&
              Number.isSafeInteger(x.id) &&
              x.id > 0 &&
              Number.isSafeInteger(x.quantity) &&
              x.quantity > 0 &&
              x.quantity <= 1000,
          )
          .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)
      : [];
  } catch {
    return [];
  }
}
export const cartKey = (slug: string) => "ezshop:cart:" + slug;
export function getCart(slug: string): CartLine[] {
  return parseCart(localStorage.getItem(cartKey(slug)));
}
export function putCart(slug: string, lines: CartLine[]) {
  localStorage.setItem(cartKey(slug), JSON.stringify(lines));
  window.dispatchEvent(new Event("ezshop:cart"));
}
export function setQuantity(slug: string, id: number, quantity: number) {
  const items = getCart(slug).filter((i) => i.id !== id);
  if (quantity > 0) items.push({ id, quantity });
  putCart(slug, items);
}
