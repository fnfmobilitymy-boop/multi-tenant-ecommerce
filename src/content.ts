import type { Locale } from "./i18n-core";
export type ContentFields = {
  name?: string;
  description?: string;
  category?: string;
  variant?: string;
};
export type ContentTranslations = Partial<Record<Locale, ContentFields>>;
export function contentField(
  source: ContentFields & { content_translations?: ContentTranslations },
  field: keyof ContentFields,
  locale: Locale,
): string {
  return (
    source.content_translations?.[locale]?.[field]?.trim() ||
    source[field] ||
    ""
  );
}
export function localizedContent<
  T extends ContentFields & { content_translations?: ContentTranslations },
>(source: T, locale: Locale): T {
  return {
    ...source,
    name: contentField(source, "name", locale),
    description: contentField(source, "description", locale),
    variant: contentField(source, "variant", locale),
  };
}
export function localizedItem<
  T extends { name: string; content_translations?: ContentTranslations },
>(source: T, locale: Locale): T {
  const entry = source.content_translations?.[locale];
  if (!entry?.name) return source;
  return {
    ...source,
    name: entry.name + (entry.variant ? " · " + entry.variant : ""),
  };
}
