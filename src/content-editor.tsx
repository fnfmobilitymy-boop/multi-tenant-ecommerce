import { useState } from "react";
import { LANGUAGES, type Locale } from "./i18n-core";
import { useI18n } from "./i18n";
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
}: {
  kind: "store" | "product";
  initial?: ContentTranslations;
}) {
  const { t } = useI18n();
  const [versions, setVersions] = useState(initial);
  const [language, setLanguage] = useState<Locale>("en");
  const fields: (keyof ContentFields)[] =
    kind === "store"
      ? ["name", "description"]
      : ["name", "description", "category", "variant"];
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
      </div>
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
    </fieldset>
  );
}
