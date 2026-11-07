import { useState } from "react";
import { Store, ArrowRight } from "lucide-react";
import { useI18n } from "./i18n";
import { Brand, ErrorBox } from "./ui";
export function CustomerHome() {
  const { t } = useI18n();
  const [entry, setEntry] = useState("");
  const [error, setError] = useState("");
  function enter(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    let slug = entry.trim();
    if (/^https?:\/\//i.test(slug)) {
      try {
        const url = new URL(slug);
        const base = import.meta.env.BASE_URL.replace(/\/$/, "");
        const legacy =
          url.origin === "https://fnfmobilitymy-boop.github.io" &&
          url.pathname.startsWith("/multi-tenant-ecommerce/shop/");
        const own =
          url.origin === window.location.origin &&
          url.pathname.startsWith(base + "/shop/");
        const canonical =
          ["https://ezshop.lifestyle", "https://www.ezshop.lifestyle"].includes(
            url.origin,
          ) && url.pathname.startsWith("/shop/");
        if (url.username || url.password || (!own && !legacy && !canonical))
          throw new Error();
        slug = decodeURIComponent(
          url.pathname.split("/shop/")[1].split("/")[0],
        );
      } catch {
        setError("请输入有效的店铺链接或标识。");
        return;
      }
    }
    if (slug.length > 60 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      setError("请输入有效的店铺链接或标识。");
      return;
    }
    // Reload into the store so its dedicated customer auth client is initialized.
    window.location.assign(import.meta.env.BASE_URL + "shop/" + encodeURIComponent(slug));
  }
  return (
    <main className="customer-home">
      <header>
        <Brand to="/" />
      </header>
      <section className="card customer-entry">
        <Store size={34} className="purple" aria-hidden="true" />
        <h1>{t("欢迎来到 EZShop")}</h1>
        <p>{t("使用商家分享的店铺链接，浏览商品和查询订单。")}</p>
        <form onSubmit={enter}>
          <label>
            {t("店铺链接或标识")}
            <input
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder={t("粘贴商家分享的店铺链接")}
              autoComplete="off"
              required
            />
          </label>
          <ErrorBox error={error} />
          <button className="button full">
            {t("进入店铺")}
            <ArrowRight size={18} />
          </button>
        </form>
        <small>{t("每家店铺独立经营，请向商家索取专属链接。")}</small>
      </section>
    </main>
  );
}
