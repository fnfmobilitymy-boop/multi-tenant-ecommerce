import { CustomerBankTransfer } from "./merchant-receiving";
import { stripeAutomationEnabled, stripeConnectEnabled } from "./features";
import { contentField, localizedContent, localizedItem } from "./content";
import { useI18n } from "./i18n";
import { useEffect, useState, useMemo } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Search,
  ShoppingBag,
  ShoppingCart,
  Phone,
  Minus,
  Plus,
  Trash2,
  CheckCircle2,
  Package,
} from "lucide-react";
import { api, money, statusLabel, supabase } from "./api";
import { OrderAccess } from "./order-lookup";
import { OrderPayment } from "./payments";
import { getCart, putCart, setQuantity } from "./cart";
import type { CartLine, Merchant, OrderResult, Product } from "./types";
import { Brand, Empty, ErrorBox, Loading } from "./ui";
import { MALAYSIA_STATES, type ShippingQuote } from "./delivery";
interface StoreData {
  store: Merchant;
  products: Product[];
}
export function Storefront() {
  const { t, locale, errorText } = useI18n();
  const { slug = "", productId } = useParams(),
    location = useLocation(),
    navigate = useNavigate();
  const [rawData, setData] = useState<StoreData | null>(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState("全部商品"),
    [quantity, setQty] = useState(1),
    [cart, setCart] = useState<CartLine[]>(() => getCart(slug)),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [result, setResult] = useState<OrderResult | null>(null);
  const [quote, setQuote] = useState<ShippingQuote | null>(null),
    [quoteError, setQuoteError] = useState(""),
    [quoteLoading, setQuoteLoading] = useState(false);
  const data = useMemo(
    () =>
      rawData
        ? {
            store: localizedContent(rawData.store, locale),
            products: rawData.products.map((p) => localizedContent(p, locale)),
          }
        : null,
    [rawData, locale],
  );
  const [onlineEnabled, setOnlineEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    setOnlineEnabled(false);
    if (supabase && stripeAutomationEnabled && stripeConnectEnabled)
      api<{
        online_enabled: boolean;
      }>("payments/store-options", { slug })
        .then((r) => {
          if (active) setOnlineEnabled(r.online_enabled);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [slug]);
  const base = "/shop/" + encodeURIComponent(slug),
    kind = location.pathname.endsWith("/cart")
      ? "cart"
      : location.pathname.endsWith("/checkout")
        ? "checkout"
        : location.pathname.endsWith("/order-result")
          ? "result"
          : productId
            ? "product"
            : "home";
  useEffect(() => {
    setData(null);
    setError("");
    let active = true;
    api<StoreData>("store?slug=" + encodeURIComponent(slug))
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    setCart(getCart(slug));
    const agent = new URLSearchParams(location.search).get("agent");
    if (agent) sessionStorage.setItem("ezshop:agent:" + slug, agent);
    return () => {
      active = false;
    };
  }, [slug]);
  useEffect(() => {
    let active = true;
    setError("");
    setFeedback("");
    setQty(1);
    if (kind === "cart" || kind === "checkout")
      api<StoreData>("store?slug=" + encodeURIComponent(slug))
        .then(setData)
        .catch((e) => setError(e.message));
    if (kind === "result") {
      setResult(null);
      const ref = new URLSearchParams(location.search).get("ref") || "",
        token = sessionStorage.getItem("ezshop:order:" + ref);
      if (!token) {
        setError("缺少此订单的访问凭证，请联系商家核实订单。");
        return;
      }
      api<OrderResult>("order-result", { slug, reference: ref, token })
        .then((value) => { if (active) setResult(value); })
        .catch((e) => { if (active) setError(e.message); });
    }
    return () => { active = false; };
  }, [location.pathname, location.search, slug, kind]);
  function update(id: number, q: number) {
    setQuantity(slug, id, q);
    setCart(getCart(slug));
  }
  function add(p: Product, now = false) {
    const count =
      (getCart(slug).find((i) => i.id === p.id)?.quantity || 0) + quantity;
    if (count > p.stock) {
      setError("加入后的数量超过当前可售库存");
      return;
    }
    update(p.id, count);
    if (now) navigate(base + "/checkout");
    else setFeedback("已加入购物车");
  }
  const current = data?.products.find((p) => p.id === Number(productId));
  const lines = cart.map((i) => ({
      ...i,
      product: data?.products.find((p) => p.id === i.id),
    })),
    total = lines.reduce((n, i) => n + (i.product?.price || 0) * i.quantity, 0),
    invalid = lines.some(
      (i) => !i.product || i.quantity > (i.product?.stock || 0),
    );
  useEffect(() => {
    let current = true;
    setQuote(null);
    setQuoteError("");
    if (!data || !cart.length || !["cart", "checkout"].includes(kind)) {
      setQuoteLoading(false);
      return;
    }
    setQuoteLoading(true);
    api<ShippingQuote>("shipping-quote", { slug, items: cart })
      .then((q) => {
        if (current) setQuote(q);
      })
      .catch((e) => {
        if (current) setQuoteError(e.message);
      })
      .finally(() => {
        if (current) setQuoteLoading(false);
      });
    return () => {
      current = false;
    };
  }, [data, cart, slug, kind]);
  async function checkout(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (!quote || quoteLoading) {
      setError("订单金额尚未确认，请等待邮费更新后再提交。");
      return;
    }
    setError("");
    if (!cart.length || invalid) {
      setError("请先检查购物车的商品和库存");
      return;
    }
    setBusy(true);
    try {
      const form = Object.fromEntries(new FormData(e.currentTarget));
      const keyName = "ezshop:checkout:" + slug;
      let key = sessionStorage.getItem(keyName);
      if (!key) {
        key = crypto.randomUUID();
        sessionStorage.setItem(keyName, key);
      }
      const o = await api<{
        reference: string;
        access_token: string;
      }>("checkout", {
        ...form,
        slug,
        items: cart,
        agent: sessionStorage.getItem("ezshop:agent:" + slug) || "",
        checkout_key: key,
        payment_method: "manual",
        locale,
      });
      sessionStorage.setItem("ezshop:order:" + o.reference, o.access_token);
      sessionStorage.removeItem(keyName);
      putCart(slug, []);
      setCart([]);
      navigate(base + "/order-result?ref=" + encodeURIComponent(o.reference));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <div className="store-shell">
        <Brand to={base} />
        {error ? <ErrorBox error={error} /> : <Loading />}
      </div>
    );
  const categories = [
    "全部商品",
    ...new Set(data.products.map((p) => p.category || "其他")),
  ].filter((c, i, a) => a.indexOf(c) === i);
  const shown = data.products.filter(
    (p) =>
      (category === "全部商品" || p.category === category) &&
      p.name.toLowerCase().includes(query.toLowerCase()),
  );
  const productCard = (p: Product) => (
    <Link key={p.id} className="product-card" to={base + "/product/" + p.id}>
      <div className="product-image">
        {p.image ? (
          <img src={p.image} alt={p.name} loading="lazy" />
        ) : (
          <span>{p.emoji}</span>
        )}
        {!p.stock && <span className="sold-out">{t("暂时售罄")}</span>}
      </div>
      <div className="product-info">
        <small>
          {p.category === "全部商品"
            ? t("全部商品")
            : contentField(p, "category", locale) || t("精选商品")}
        </small>
        <h3>{p.name}</h3>
        <div className="row between">
          <strong className="purple">{money(p.price, locale)}</strong>
          <span className="round-arrow">
            <ArrowRight size={17} />
          </span>
        </div>
      </div>
    </Link>
  );
  return (
    <div className="storefront">
      <header className="store-nav">
        <Brand to={base} />
        <Link to={base} className="store-name">
          {data.store.name}
        </Link>
        <Link to={base + "/track"} className="text-button">{t("查询订单")}</Link>
        <Link
          className="cart-link"
          to={base + "/cart"}
          aria-label={t("购物车")}
        >
          <ShoppingBag size={21} />
          <span>{cart.reduce((s, i) => s + i.quantity, 0)}</span>
        </Link>
      </header>
      <main className="store-shell">
        <ErrorBox error={error} />
        {data.store.subscription_access === false && <div className="soft-note">{t("店铺暂停接收新订单，已有订单仍可查询。")}</div>}
        {feedback && (
          <div className="success" role="status">
            {t(feedback)} · <Link to={base + "/cart"}>{t("查看购物车 →")}</Link>
          </div>
        )}
        {kind === "home" && (
          <>
            <section className="store-hero">
              <div>
                <span className="eyebrow">
                  {t("CURATED WITH CARE · MALAYSIA")}
                </span>
                <div className="row">
                  {data.store.logo && (
                    <img
                      className="merchant-logo"
                      src={data.store.logo}
                      alt={data.store.name + " Logo"}
                    />
                  )}
                  <h1>{data.store.name}</h1>
                </div>
                <p>
                  {data.store.description ||
                    t("好物值得分享，生活值得认真。发现属于你的日常精选。")}
                </p>
                <a href="#products" className="button">
                  {t("探索商品")}
                  <ArrowRight size={17} />
                </a>
              </div>
              <div className="hero-art">
                {data.store.banner ? (
                  <img
                    className="merchant-banner"
                    src={data.store.banner}
                    alt={data.store.name + " Banner"}
                  />
                ) : (
                  <ShoppingBag size={110} strokeWidth={1} />
                )}
                <span className="hero-pill">{t("为你挑选的好物 ✦")}</span>
              </div>
            </section>
            <div className="store-benefits">
              <span>{t("✦ 马来西亚本地商家")}</span>
              <span>{t("◇ 订单清晰可查")}</span>
              <span>{t("♡ 用心经营，安心选购")}</span>
            </div>
            {!query &&
              category === "全部商品" &&
              data.products.some((p) => p.featured) && (
                <section style={{ marginTop: 35 }}>
                  <h2 className="section-title">{t("热门精选")}</h2>
                  <div className="products-grid">
                    {data.products
                      .filter((p) => p.featured)
                      .slice(0, 3)
                      .map(productCard)}
                  </div>
                </section>
              )}
            <section className="section-heading" id="products">
              <div>
                <span className="eyebrow">{t("FIND YOUR FAVORITES")}</span>
                <h2>{t("店铺商品")}</h2>
                <p>{t("发现好物，从这里开始。")}</p>
              </div>
              <label className="search">
                <Search size={17} />
                <input
                  aria-label={t("搜索商品")}
                  placeholder={t("搜索心仪的商品…")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </section>
            <div className="chips">
              {categories.map((c) => (
                <button
                  key={c}
                  className={category === c ? "chip active" : "chip"}
                  onClick={() => setCategory(c)}
                >
                  {c === "全部商品"
                    ? t(c)
                    : contentField(
                        data.products.find((p) => p.category === c) || {
                          category: c,
                        },
                        "category",
                        locale,
                      )}
                </button>
              ))}
            </div>
            {shown.length ? (
              <div className="products-grid">{shown.map(productCard)}</div>
            ) : (
              <Empty>{t("没有找到商品，试试其他关键词或分类。")}</Empty>
            )}
          </>
        )}
        {kind === "product" &&
          (current ? (
            <>
              <Link className="back-link" to={base}>
                <ArrowLeft size={16} />
                {t("返回店铺")}
              </Link>
              <div className="product-detail">
                <div className="product-image large">
                  {current.image ? (
                    <img src={current.image} alt={current.name} />
                  ) : (
                    <span>{current.emoji}</span>
                  )}
                </div>
                <div>
                  <span className="eyebrow">
                    {current.category === "全部商品"
                      ? t("全部商品")
                      : contentField(current, "category", locale) ||
                        t("精选商品")}
                  </span>
                  <h1>{current.name}</h1>
                  <div className="detail-price">
                    {money(current.price, locale)}
                  </div>
                  <p className="description">
                    {current.description ||
                      t("商家尚未提供商品介绍。如有疑问，欢迎联系商家。")}
                  </p>
                  <div className="stock-line">
                    <span
                      className={current.stock ? "stock-dot" : "stock-dot out"}
                    />
                    {current.stock
                      ? t("现货 \u00B7 可售 ") + current.stock + t(" 件")
                      : t("暂时售罄")}
                  </div>
                  <p className="muted">
                    {t("规格：")}
                    {current.variant || t("单一规格")}
                  </p>
                  <div className="quantity">
                    <button
                      onClick={() => setQty(Math.max(1, quantity - 1))}
                      aria-label={t("减少数量")}
                    >
                      <Minus size={15} />
                    </button>
                    <input
                      aria-label={t("购买数量")}
                      type="number"
                      min="1"
                      max={Math.min(1000, current.stock)}
                      value={quantity}
                      onChange={(e) =>
                        setQty(
                          Math.max(
                            1,
                            Math.min(
                              Math.min(1000, current.stock) || 1,
                              Number(e.target.value) || 1,
                            ),
                          ),
                        )
                      }
                    />
                    <button
                      onClick={() =>
                        setQty(
                          Math.min(
                            Math.min(1000, current.stock) || 1,
                            quantity + 1,
                          ),
                        )
                      }
                      aria-label={t("增加数量")}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  <div className="row">
                    <button
                      className="button secondary"
                      disabled={!current.stock}
                      onClick={() => add(current)}
                    >
                      <ShoppingCart size={18} />
                      {t("加入购物车")}
                    </button>
                    <button
                      className="button"
                      disabled={!current.stock}
                      onClick={() => add(current, true)}
                    >
                      {t("立即购买")}
                      <ArrowRight size={17} />
                    </button>
                  </div>
                  <div className="soft-note">
                    {t(
                      "提交订单后请联系商家安排付款。付款状态以商家核实记录为准。",
                    )}
                  </div>
                </div>
              </div>
              {data.products.length > 1 && (
                <>
                  <h2 className="section-title">{t("你可能也喜欢")}</h2>
                  <div className="products-grid">
                    {data.products
                      .filter((p) => p.id !== current.id)
                      .slice(0, 3)
                      .map(productCard)}
                  </div>
                </>
              )}
            </>
          ) : (
            <Empty>{t("此商品不存在、尚未发布或不属于当前店铺。")}</Empty>
          ))}
        {(kind === "cart" || kind === "checkout") && (
          <>
            <Link className="back-link" to={base}>
              <ArrowLeft size={16} />
              {t("继续选购")}
            </Link>
            <h1>{kind === "cart" ? t("我的购物车") : t("确认订单")}</h1>
            <p>
              {t("当前店铺：")}
              {data.store.name}
            </p>
            {!cart.length ? (
              <Empty>
                <ShoppingBag size={35} />
                <p>{t("购物车还是空的，去发现一些好物吧。")}</p>
                <Link className="button" to={base}>
                  {t("去逛逛")}
                </Link>
              </Empty>
            ) : (
              <div className="checkout-layout">
                <section>
                  {kind === "cart" ? (
                    <div className="card cart-items">
                      {lines.map((i) => (
                        <div key={i.id} className="cart-item">
                          <span className="cart-emoji">
                            {i.product?.emoji || "📦"}
                          </span>
                          <div className="grow">
                            <h3>{i.product?.name || t("商品已下架")}</h3>
                            <p>
                              {i.product
                                ? money(i.product.price, locale)
                                : t("请移除此商品")}
                            </p>
                            {i.product && i.quantity > i.product.stock && (
                              <p className="error">
                                {t("库存仅剩")}
                                {i.product.stock}
                                {t("件")}
                              </p>
                            )}
                          </div>
                          <div className="quantity">
                            <button
                              aria-label={t("减少数量")}
                              onClick={() => update(i.id, i.quantity - 1)}
                            >
                              <Minus size={14} />
                            </button>
                            <input
                              aria-label={t("商品数量")}
                              type="number"
                              min="1"
                              max={Math.min(1000, i.product?.stock || 1)}
                              value={i.quantity}
                              onChange={(e) =>
                                update(
                                  i.id,
                                  Math.max(
                                    1,
                                    Math.min(1000, Number(e.target.value) || 1),
                                  ),
                                )
                              }
                            />
                            <button
                              aria-label={t("增加数量")}
                              disabled={i.quantity >= (i.product?.stock || 0)}
                              onClick={() => update(i.id, i.quantity + 1)}
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                          <button
                            className="icon-button"
                            aria-label={t("删除商品")}
                            onClick={() => update(i.id, 0)}
                          >
                            <Trash2 size={17} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <form
                      id="checkout-form"
                      className="card checkout-form"
                      onSubmit={checkout}
                    >
                      <h2>{t("联系及收货资料")}</h2>
                      <div className="form-grid">
                        <label>
                          {t("姓名")}
                          <input
                            name="customer"
                            required
                            maxLength={100}
                            autoComplete="name"
                          />
                        </label>
                        <label>
                          {t("Email")}
                          <input
                            type="email"
                            name="email"
                            required
                            maxLength={200}
                            autoComplete="email"
                          />
                        </label>
                        <label>
                          {t("手机号码")}
                          <input
                            type="tel"
                            name="phone"
                            required
                            maxLength={40}
                            autoComplete="tel"
                          />
                        </label>
                      </div>
                      <label>
                        {t("收货地址")}
                        <textarea
                          name="address"
                          required
                          maxLength={500}
                          rows={3}
                          autoComplete="street-address"
                        />
                      </label>
                      <div className="form-grid">
                        <label>
                          {t("城市")}
                          <input
                            name="city"
                            required
                            maxLength={100}
                            autoComplete="address-level2"
                          />
                        </label>
                        <label>
                          {t("邮编")}
                          <input
                            name="postcode"
                            inputMode="numeric"
                            pattern="[0-9]{5}"
                            minLength={5}
                            maxLength={5}
                            required
                            autoComplete="postal-code"
                            placeholder={t("5 位邮编")}
                          />
                        </label>
                        <label>
                          {t("州属")}
                          <select
                            name="state"
                            aria-label={t("州属")}
                            required
                            defaultValue=""
                            autoComplete="address-level1"
                          >
                            <option value="" disabled>
                              {t("请选择州属")}
                            </option>
                            {MALAYSIA_STATES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <input type="hidden" name="country" value="MY" />
                      <p className="muted" style={{ marginTop: 15 }}>
                        {t(
                          "配送范围：马来西亚。请确认收货地址、州属和邮编正确。",
                        )}
                      </p>
                      <label>
                        {t("订单备注")}
                        <textarea
                          name="note"
                          maxLength={1000}
                          rows={2}
                          placeholder={t("有什么需要商家留意的吗？")}
                        />
                      </label>
                      <h2>{t("付款方式")}</h2>
                      <div className="payment-option">
                        <input
                          type="radio"
                          name="payment_method"
                          value="manual"
                          defaultChecked
                        />{" "}
                        {t("联系商家付款 \u00B7 由商家核实到账")}
                      </div>
                      <p className="muted">
                        {onlineEnabled
                          ? t(
                              "提交订单后，可在结果页进入安全付款页面，或联系商家安排付款。",
                            )
                          : t("当前由商家核实收款，提交订单不会自动扣款。")}
                      </p>
                    </form>
                  )}
                </section>
                <aside className="card summary">
                  <h2>{t("订单摘要")}</h2>
                  {lines.map((i) => (
                    <div key={i.id} className="summary-line">
                      <span>
                        {i.product?.name || t("已下架商品")} × {i.quantity}
                        <small>
                          {i.product ? money(i.product.price, locale) : "—"}
                          {t("/ 件")}
                        </small>
                      </span>
                      <strong>
                        {money((i.product?.price || 0) * i.quantity, locale)}
                      </strong>
                    </div>
                  ))}
                  <div className="summary-line">
                    <span>{t("商品小计")}</span>
                    <span>{money(total, locale)}</span>
                  </div>
                  <div className="summary-line">
                    <span>{t("邮费")}</span>
                    <span>
                      {quote
                        ? money(quote.shipping, locale)
                        : quoteLoading
                          ? t("计算中…")
                          : t("待确认")}
                    </span>
                  </div>
                  <div className="summary-line">
                    <span>{t("折扣")}</span>
                    <span>{money(0, locale)}</span>
                  </div>
                  <div className="summary-total">
                    <strong>{t("应付总额")}</strong>
                    <strong>
                      {quote ? money(quote.total, locale) : t("待确认")}
                    </strong>
                  </div>
                  {kind === "cart" ? (
                    <Link
                      className={"button full " + (invalid ? "disabled" : "")}
                      to={invalid ? base + "/cart" : base + "/checkout"}
                    >
                      {t("前往结账")}
                      <ArrowRight size={17} />
                    </Link>
                  ) : (
                    <button
                      className="button full"
                      form="checkout-form"
                      disabled={busy || invalid || !quote || quoteLoading}
                    >
                      {busy ? t("正在提交…") : t("确认提交订单")}{" "}
                      <ArrowRight size={17} />
                    </button>
                  )}
                  <ErrorBox error={quoteError} />
                  <p className="fine-print">
                    {t(
                      "邮费由商家自行设定，金额和库存由后端核算。当前不提供快递自动报价。",
                    )}
                  </p>
                  <p className="fine-print">
                    {t("快递公司：")}
                    {data.store.courier || t("商家自行安排")}
                    {t("，以实际发货记录为准。")}
                  </p>
                </aside>
              </div>
            )}
          </>
        )}
        {kind === "result" &&
          (result ? (
            <section className="card result">
              <CheckCircle2 size={48} className="purple" />
              <span className="eyebrow">{t("ORDER RECEIVED")}</span>
              <h1>
                {result.order.status === "refunded"
                  ? t("订单已退款")
                  : result.order.status === "cancelled"
                    ? t("订单已取消")
                    : t("订单已创建")}
              </h1>
              <p>
                {t("订单编号")}
                {result.order.reference}
              </p>
              <div className={"badge " + result.order.status}>
                {t(statusLabel(result.order.status))}
              </div>
              <p className="soft-note">
                {result.order.status === "refunded"
                  ? t("商家已登记完成全额退款。请核对实际到账。")
                  : result.order.status === "paid"
                    ? t("商家已确认收款。")
                    : result.order.status === "cancelled"
                      ? t("此订单已取消，请勿继续付款。")
                      : t("订单已保存，尚未确认收款。请联系商家安排付款。")}
              </p>
              {result.items.map((i, n) => (
                <div className="summary-line" key={n}>
                  <span>
                    {localizedItem(i, locale).name} × {i.quantity}
                  </span>
                  <strong>{money(i.price * i.quantity, locale)}</strong>
                </div>
              ))}
              <div className="summary-line">
                <span>{t("商品小计")}</span>
                <span>
                  {money(
                    result.order.subtotal ??
                      result.items.reduce(
                        (s, i) => s + i.price * i.quantity,
                        0,
                      ),
                    locale,
                  )}
                </span>
              </div>
              <div className="summary-line">
                <span>{t("邮费")}</span>
                <span>{money(result.order.shipping || 0, locale)}</span>
              </div>
              {result.order.fulfillment_status === "shipped" && (
                <div className="soft-note">
                  <strong>{t("商家已登记发货")}</strong>
                  <p>
                    {t("快递公司：")}
                    {result.order.carrier}
                  </p>
                  <p>
                    {t("运单号：")}
                    {result.order.tracking}
                  </p>
                  <small>{t("运送进度请向对应快递公司查询。")}</small>
                </div>
              )}
              <div className="summary-total">
                <strong>{t("总金额")}</strong>
                <strong>{money(result.order.total, locale)}</strong>
              </div>
              {result.order.status === "pending" && <CustomerBankTransfer info={result.payment_instructions} reference={result.order.reference} />}
              <OrderAccess reference={result.order.reference} token={sessionStorage.getItem("ezshop:order:" + result.order.reference) || ""} />
              <OrderPayment
                slug={slug}
                reference={result.order.reference}
                token={
                  sessionStorage.getItem(
                    "ezshop:order:" + result.order.reference,
                  ) || ""
                }
                status={result.order.status}
                onRefresh={async () => {
                  const fresh = await api<OrderResult>("order-result", {
                    slug,
                    reference: result.order.reference,
                    token:
                      sessionStorage.getItem(
                        "ezshop:order:" + result.order.reference,
                      ) || "",
                  });
                  setResult((current) =>
                    current?.order.reference === fresh.order.reference
                      ? fresh
                      : current,
                  );
                }}
              />
              <Link className="button secondary" to={base}>
                {t("返回店铺")}
              </Link>
            </section>
          ) : (
            !error && <Loading />
          ))}
      </main>
      <footer className="store-footer">
        <div>
          <Brand to={base} />
          <p>{data.store.name}</p>
          <p>{data.store.description}</p>
        </div>
        <div>
          <h3>{t("联系商家")}</h3>
          {data.store.phone ? (
            <a
              href={"https://wa.me/" + data.store.phone.replace(/\D/g, "")}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Phone size={16} /> WhatsApp · {data.store.phone}
            </a>
          ) : (
            <p>{t("商家尚未提供公开联系电话")}</p>
          )}
          <p>{t("交易币种 MYR \u00B7 马来西亚")}</p>
        </div>
        <div className="footer-bottom">
          {t("Powered by EZShop \u00B7 让每一笔生意更简单")}
        </div>
      </footer>
    </div>
  );
}
