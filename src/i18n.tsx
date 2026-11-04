import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Globe } from "lucide-react";
import {
  allowedLanguages,
  browserLocale,
  normalizeLocale,
  translate,
  translateError,
  type Audience,
  type Locale,
} from "./i18n-core";
export { translate, intlLocale } from "./i18n-core";
const listeners = new Set<() => void>();
const memory = new Map<Audience, Locale>();
function read(audience: Audience): Locale {
  if (memory.has(audience)) return memory.get(audience)!;
  try {
    const stored = localStorage.getItem("ezshop:language:" + audience);
    if (stored) return normalizeLocale(stored, audience);
  } catch {
    /* Browser preference also works without storage. */
  }
  return browserLocale(
    navigator.languages?.length ? navigator.languages : [navigator.language],
    audience,
  );
}
function write(audience: Audience, locale: Locale) {
  const value = normalizeLocale(locale, audience);
  memory.set(audience, value);
  try {
    localStorage.setItem("ezshop:language:" + audience, value);
  } catch {
    /* Session preference still works when storage is disabled. */
  }
  listeners.forEach((fn) => fn());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const Context = createContext<{
  audience: Audience;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}>({ audience: "merchant", locale: "zh", setLocale: () => {} });
export function I18nProvider({
  audience,
  children,
}: {
  audience: Audience;
  children: ReactNode;
}) {
  const locale = useSyncExternalStore(
    subscribe,
    () => read(audience),
    () => "zh" as Locale,
  );
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key === "ezshop:language:" + audience || event.key === null) {
        memory.delete(audience);
        listeners.forEach((fn) => fn());
      }
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, [audience]);
  return (
    <Context.Provider
      value={{ audience, locale, setLocale: (value) => write(audience, value) }}
    >
      <div lang={locale} className="localized-app">
        {children}
      </div>
    </Context.Provider>
  );
}
export function useI18n() {
  const value = useContext(Context);
  return {
    ...value,
    t: (key: string, values?: Record<string, string | number>) =>
      translate(value.locale, key, values),
    errorText: (message: string) => translateError(value.locale, message),
  };
}
export function LanguageToolbar() {
  const { audience, locale, setLocale, t } = useI18n();
  return (
    <div className="language-toolbar">
      <label className="language-selector">
        <Globe size={16} aria-hidden="true" />
        <span>{t("语言")}</span>
        <select
          aria-label={t("语言")}
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          {allowedLanguages(audience).map((language) => (
            <option
              key={language.code}
              value={language.code}
              lang={language.code}
            >
              {language.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
