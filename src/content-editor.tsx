import { useEffect, useId, useRef, useState } from "react";
import { LANGUAGES, type Locale } from "./i18n-core";
import { useI18n } from "./i18n";
import { api } from "./api";
import { ErrorBox } from "./ui";
import type { ContentTranslations, ContentFields } from "./content";
const labels = {
  name: "商品名称",
  description: "商品介绍",
  category: "分类",
  variant: "规格 / 款式（选填）",
};
export function ContentEditor({
  kind,
  initial = {},
  onBusy,
}: {
  kind: "store" | "product";
  initial?: ContentTranslations;
  onBusy: (id: string, busy: boolean) => void;
}) {
  const { t } = useI18n(),
    id = useId(),
    generation = useRef(0);
  const [versions, setVersions] = useState(initial),
    [language, setLanguage] = useState<Locale>("en"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const fields: (keyof ContentFields)[] =
    kind === "store"
      ? ["name", "description"]
      : ["name", "description", "category", "variant"];
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
      onBusy(id, false);
    };
  }, []);
  async function generate(button: HTMLButtonElement) {
    const form = button.form;
    if (!form) return;
    const source = Object.fromEntries(
      fields.map((field) => [
        field,
        (
          form.elements.namedItem(field) as
            | HTMLInputElement
            | HTMLTextAreaElement
            | null
        )?.value || "",
      ]),
    );
    if (!source.name.trim()) {
      setError("请先填写原文名称和介绍。");
      return;
    }
    const current = generation.current;
    setBusy(true);
    onBusy(id, true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ translations: ContentTranslations }>(
        "content-translate",
        { kind, fields: source },
      );
      if (current === generation.current) {
        setVersions((previous) =>
          Object.fromEntries(
            LANGUAGES.map(({ code }) => [
              code,
              Object.fromEntries(
                fields.map((field) => [
                  field,
                  previous[code]?.[field]?.trim()
                    ? previous[code]![field]
                    : result.translations[code]?.[field] || "",
                ]),
              ),
            ]),
          ),
        );
        setNotice("译文草稿已生成，请核对后保存。");
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      onBusy(id, false);
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <fieldset className="content-editor">
      <legend>{t("顾客内容的多语言版本")}</legend>
      <p className="muted">
        {t("顾客选择语言后显示对应内容；未填写的内容显示原文。")}
      </p>
      <input
        type="hidden"
        name="content_translations"
        value={JSON.stringify(versions)}
      />
      <div className="row between">
        <label>
          {t("内容语言")}
          <select
            aria-label={t("内容语言")}
            value={language}
            onChange={(e) => setLanguage(e.target.value as Locale)}
          >
            {LANGUAGES.map((entry) => (
              <option value={entry.code} key={entry.code} lang={entry.code}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={(e) => generate(e.currentTarget)}
        >
          {busy ? t("正在生成译文…") : t("自动生成缺少的译文")}
        </button>
      </div>
      <small>
        {t(
          "自动生成需要已配置的翻译服务；不会覆盖已填写的译文，保存前请核对。",
        )}
      </small>
      {fields.map((field) => {
        const label =
          kind === "store"
            ? field === "name"
              ? "店铺名称"
              : "店铺简介"
            : labels[field];
        return (
          <label key={field}>
            {t(label)}
            {field === "description" ? (
              <textarea
                aria-label={
                  LANGUAGES.find((entry) => entry.code === language)!.label +
                  " · " +
                  t(label)
                }
                rows={3}
                maxLength={kind === "store" ? 500 : 2000}
                value={versions[language]?.[field] || ""}
                onChange={(event) =>
                  setVersions((previous) => ({
                    ...previous,
                    [language]: {
                      ...previous[language],
                      [field]: event.target.value,
                    },
                  }))
                }
              />
            ) : (
              <input
                aria-label={
                  LANGUAGES.find((entry) => entry.code === language)!.label +
                  " · " +
                  t(label)
                }
                maxLength={
                  field === "name"
                    ? kind === "store"
                      ? 80
                      : 120
                    : field === "category"
                      ? 80
                      : 100
                }
                value={versions[language]?.[field] || ""}
                onChange={(event) =>
                  setVersions((previous) => ({
                    ...previous,
                    [language]: {
                      ...previous[language],
                      [field]: event.target.value,
                    },
                  }))
                }
              />
            )}
          </label>
        );
      })}
      <ErrorBox error={error} />
      {notice && (
        <p className="success" role="status">
          {t(notice)}
        </p>
      )}
    </fieldset>
  );
}
