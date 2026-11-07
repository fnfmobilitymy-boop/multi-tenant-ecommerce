import { csvText } from "./analytics";
import { useCommerceCurrency, currencyFactor } from "./commerce-currency";
import { useMemo, useState } from "react";
import {
  Search,
  Plus,
  Package,
  LayoutGrid,
  List,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useI18n } from "./i18n";
import { useCommerceMoney } from "./commerce-currency";
import { localizedContent } from "./content";
import type { Product } from "./types";
export function ProductWorkspace({
  products,
  query,
  setQuery,
  add,
  edit,
  bulk,
  busy,
}: {
  products: Product[];
  query: string;
  setQuery: (s: string) => void;
  add: () => void;
  edit: (p: Product) => void;
  bulk: (rows: Product[], published: number) => Promise<boolean>;
  busy: boolean;
}) {
  const { t, locale } = useI18n();
  const money = useCommerceMoney(),
    currency = useCommerceCurrency();
  const [view, setView] = useState<"table" | "grid">("table"),
    [category, setCategory] = useState(""),
    [status, setStatus] = useState("all"),
    [sort, setSort] = useState("newest"),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<number[]>([]);
  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category || "全部商品"))],
    [products],
  );
  const filtered = useMemo(
    () =>
      products
        .filter((p) => {
          const display = localizedContent(p, locale);
          return (
            (!category || (p.category || "全部商品") === category) &&
            `${display.name} ${p.name} ${p.variant || ""} ${p.category || ""}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()) &&
            (status === "all" ||
              (status === "published" && p.published !== 0) ||
              (status === "draft" && p.published === 0) ||
              (status === "out" && p.stock === 0) ||
              (status === "low" && p.stock > 0 && p.stock <= 5))
          );
        })
        .sort((a, b) =>
          sort === "price_asc"
            ? a.price - b.price
            : sort === "price_desc"
              ? b.price - a.price
              : sort === "stock"
                ? a.stock - b.stock
                : sort === "name"
                  ? localizedContent(a, locale).name.localeCompare(
                      localizedContent(b, locale).name,
                    )
                  : b.id - a.id,
        ),
    [products, query, category, status, sort, locale],
  );
  const size = view === "grid" ? 12 : 10,
    pages = Math.max(1, Math.ceil(filtered.length / size)),
    current = Math.min(page, pages),
    rows = filtered.slice((current - 1) * size, current * size);
  const chosen = products.filter((p) => selected.includes(p.id));
  const reset = (fn: () => void) => {
    setPage(1);
    fn();
  };
  async function change(published: number) {
    if (!chosen.length || busy) return;
    if (await bulk(chosen, published)) setSelected([]);
  }
  function exportProducts() {
    const content = csvText([
      [t("商品名称"), t("价格"), t("币种"), t("库存"), t("分类"), t("状态")],
      ...filtered.map((p) => [
        localizedContent(p, locale).name,
        p.price / currencyFactor(currency),
        currency,
        p.stock,
        p.category || "",
        t(p.published === 0 ? "未发布" : "已发布"),
      ]),
    ]);
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "ezshop-products.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const toggle = (id: number, checked: boolean) =>
    setSelected((old) =>
      checked
        ? [...new Set([...old, id])].slice(0, 50)
        : old.filter((i) => i !== id),
    );
  const thumbnail = (p: Product) => (
    <span className="catalog-thumbnail">
      {p.image ? (
        <img src={p.image} alt={localizedContent(p, locale).name} />
      ) : (
        <span>{p.emoji || <Package size={25} />}</span>
      )}
    </span>
  );
  return (
    <div className="catalog-workspace">
      <div className="page-heading">
        <div>
          <h1>{t("商品管理")}</h1>
          <p>{t("管理商品、价格与库存")}</p>
        </div>
        <div className="row">
          <button className="button secondary" onClick={exportProducts}>
            {t("导出商品")}
          </button>
          <button className="button" onClick={add}>
            <Plus size={18} />
            {t("添加商品")}
          </button>
        </div>
      </div>
      <div className="catalog-stats">
        {[
          ["全部商品", products.length, "lavender"],
          ["已发布", products.filter((p) => p.published !== 0).length, "mint"],
          ["库存售罄", products.filter((p) => p.stock === 0).length, "peach"],
          [
            "低库存",
            products.filter((p) => p.stock > 0 && p.stock <= 5).length,
            "sky",
          ],
        ].map(([label, value, color]) => (
          <article className={"catalog-stat " + color} key={label}>
            <span>{t(String(label))}</span>
            <strong>{value}</strong>
            <small>
              {label === "低库存" ? t("库存1至5件") : t("实时商品数据")}
            </small>
          </article>
        ))}
      </div>
      <section className="card catalog-panel">
        <div className="catalog-toolbar">
          <div className="search">
            <Search size={18} />
            <input
              id="product-search"
              aria-label={t("搜索商品")}
              placeholder={t("搜索商品名称…")}
              value={query}
              onChange={(e) => reset(() => setQuery(e.target.value))}
            />
          </div>
          <select
            aria-label={t("商品状态筛选")}
            value={status}
            onChange={(e) => reset(() => setStatus(e.target.value))}
          >
            {[
              ["all", "全部状态"],
              ["published", "已发布"],
              ["draft", "未发布"],
              ["low", "低库存"],
              ["out", "库存售罄"],
            ].map(([v, k]) => (
              <option value={v} key={v}>
                {t(k)}
              </option>
            ))}
          </select>
          <div className="catalog-sort">
            <ArrowUpDown size={15} />
            <select
              aria-label={t("商品排序")}
              value={sort}
              onChange={(e) => reset(() => setSort(e.target.value))}
            >
              {[
                ["newest", "最新添加"],
                ["name", "名称排序"],
                ["price_asc", "价格从低到高"],
                ["price_desc", "价格从高到低"],
                ["stock", "库存从少到多"],
              ].map(([v, k]) => (
                <option value={v} key={v}>
                  {t(k)}
                </option>
              ))}
            </select>
          </div>
          <div
            className="view-switch"
            role="group"
            aria-label={t("商品显示方式")}
          >
            <button
              aria-label={t("表格视图")}
              aria-pressed={view === "table"}
              onClick={() => reset(() => setView("table"))}
            >
              <List size={18} />
            </button>
            <button
              aria-label={t("卡片视图")}
              aria-pressed={view === "grid"}
              onClick={() => reset(() => setView("grid"))}
            >
              <LayoutGrid size={18} />
            </button>
          </div>
        </div>
        <div className="catalog-categories">
          <button
            className={!category ? "active" : ""}
            onClick={() => reset(() => setCategory(""))}
          >
            {t("全部商品")} <span>{products.length}</span>
          </button>
          {categories
            .filter((c) => c !== "全部商品")
            .map((c) => (
              <button
                key={c}
                className={category === c ? "active" : ""}
                onClick={() => reset(() => setCategory(c))}
              >
                {c}
              </button>
            ))}
        </div>
        {chosen.length > 0 && (
          <div className="catalog-bulk">
            <strong>
              {t("已选商品")} {chosen.length} / 50
            </strong>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void change(1)}
            >
              {t("批量上架")}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void change(0)}
            >
              {t("批量下架")}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setSelected([])}
            >
              {t("清除选择")}
            </button>
          </div>
        )}
        {view === "table" ? (
          <div className="table-scroll">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label={t("选择本页商品")}
                      disabled={busy || !rows.length}
                      checked={
                        rows.length > 0 &&
                        rows.every((p) => selected.includes(p.id))
                      }
                      onChange={(e) =>
                        setSelected((old) =>
                          e.target.checked
                            ? [
                                ...new Set([...old, ...rows.map((p) => p.id)]),
                              ].slice(0, 50)
                            : old.filter(
                                (id) => !rows.some((p) => p.id === id),
                              ),
                        )
                      }
                    />
                  </th>
                  <th>{t("商品")}</th>
                  <th>{t("价格")}</th>
                  <th>{t("库存")}</th>
                  <th>{t("分类")}</th>
                  <th>{t("状态")}</th>
                  <th>{t("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t("选择商品 {name}", {
                          name: localizedContent(p, locale).name,
                        })}
                        checked={selected.includes(p.id)}
                        disabled={
                          busy ||
                          (!selected.includes(p.id) && selected.length >= 50)
                        }
                        onChange={(e) => toggle(p.id, e.target.checked)}
                      />
                    </td>
                    <td>
                      <div className="catalog-name">
                        {thumbnail(p)}
                        <div>
                          <strong>{localizedContent(p, locale).name}</strong>
                          <small>{p.variant || `#${p.id}`}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <strong>{money(p.price, locale)}</strong>
                    </td>
                    <td>
                      <span
                        className={
                          "stock-dot " +
                          (p.stock === 0
                            ? "out"
                            : p.stock <= 5
                              ? "low"
                              : "healthy")
                        }
                      />
                      {p.stock} {t("件")}
                    </td>
                    <td>
                      {p.category && p.category !== "全部商品"
                        ? p.category
                        : t("全部商品")}
                    </td>
                    <td>
                      <span
                        className={
                          "badge " + (p.published === 0 ? "cancelled" : "paid")
                        }
                      >
                        {t(p.published === 0 ? "未发布" : "已发布")}
                      </span>
                    </td>
                    <td>
                      <button className="text-button" onClick={() => edit(p)}>
                        {t("编辑商品")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="catalog-grid">
            {rows.map((p) => (
              <article className="catalog-product" key={p.id}>
                <div className="catalog-product-visual">
                  {thumbnail(p)}
                  <span
                    className={
                      "badge " + (p.published === 0 ? "cancelled" : "paid")
                    }
                  >
                    {t(p.published === 0 ? "未发布" : "已发布")}
                  </span>
                </div>
                <div className="catalog-product-body">
                  <small>{p.category || t("全部商品")}</small>
                  <h3>{localizedContent(p, locale).name}</h3>
                  <div className="row between">
                    <strong>{money(p.price, locale)}</strong>
                    <small>
                      {t("库存")} {p.stock}
                    </small>
                  </div>
                  <button
                    className="button secondary full"
                    onClick={() => edit(p)}
                  >
                    {t("编辑商品")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {!rows.length && (
          <div className="empty">
            <Package size={36} />
            <strong>
              {t(
                products.length
                  ? "没有匹配的商品"
                  : "还没有商品。点击「添加商品」开始。",
              )}
            </strong>
            {products.length > 0 && (
              <button
                className="text-button"
                onClick={() =>
                  reset(() => {
                    setQuery("");
                    setCategory("");
                    setStatus("all");
                  })
                }
              >
                {t("重置筛选")}
              </button>
            )}
          </div>
        )}
        <div className="catalog-pagination">
          <span>
            {t("匹配商品")} {filtered.length} · {current} / {pages}
          </span>
          <div className="row">
            <button
              className="icon-button"
              aria-label={t("上一页")}
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span>{current}</span>
            <button
              className="icon-button"
              aria-label={t("下一页")}
              disabled={current >= pages}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
