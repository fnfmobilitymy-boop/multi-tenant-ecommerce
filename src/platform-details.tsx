import {
  validCurrency,
  type Currency,
} from "../supabase/functions/_shared/currencies";
import { useEffect, useRef, useState } from "react";
import { countryNames, type CountryCode } from "./commerce-currency";
import { api, dateLabel, money, statusLabel } from "./api";
import { useI18n } from "./i18n";
import { ErrorBox, Loading, Modal } from "./ui";
type RecordData = Record<string, unknown>;
interface PageData {
  rows: RecordData[];
  total: number;
  page: number;
  page_size: number;
}
interface Overview {
  merchant: RecordData;
  summary: RecordData;
  counts: RecordData;
  receiving: RecordData;
}
const names: Record<string, [string, string]> = {
  bank: ["银行", "Bank"],
  wallet: ["电子钱包", "Wallet"],
  usdt: ["USDT", "USDT"],
  link: ["付款链接", "Payment link"],
  identifier: ["收款账号", "Receiving account"],
  network: ["网络", "Network"],
  qr: ["二维码地址", "QR address"],
  currency: ["币种", "Currency"],
  country_code: ["国家／地区", "Country / region"],
  payment_instructions: ["下单时的收款资料", "Receiving details at checkout"],
  content_translations: ["多语言内容", "Localized content"],
  locale: ["订单语言", "Order language"],
  trial_ends_at: ["试用截止", "Trial ends"],
  zh: ["中文", "Chinese"],
  en: ["英文", "English"],
  ms: ["马来语", "Malay"],
  th: ["泰语", "Thai"],
  km: ["高棉语", "Khmer"],
  vi: ["越南语", "Vietnamese"],
  overview: ["商家概览", "Merchant overview"],
  products: ["商品与库存", "Products and stock"],
  orders: ["订单与顾客", "Orders and customers"],
  customers: ["顾客汇总", "Customer summary"],
  agents: ["代理", "Agents"],
  team: ["团队与权限", "Team and roles"],
  payouts: ["佣金结算", "Commission payouts"],
  journal: ["收支流水", "Cash journal"],
  audit: ["操作记录", "Activity log"],
  notifications: ["通知记录", "Notification history"],
  id: ["编号", "ID"],
  name: ["名称", "Name"],
  names: ["姓名", "Names"],
  email: ["邮箱", "Email"],
  phone: ["电话", "Phone"],
  phones: ["电话", "Phones"],
  addresses: ["收货地址", "Delivery addresses"],
  address: ["收货地址", "Delivery address"],
  price: ["售价", "Price"],
  unit_cost: ["单位成本", "Unit cost"],
  stock: ["库存", "Stock"],
  published: ["上架", "Published"],
  total: ["订单金额", "Order total"],
  reference: ["参考号", "Reference"],
  customer: ["顾客", "Customer"],
  status: ["状态", "Status"],
  created: ["创建时间", "Created"],
  updated: ["更新时间", "Updated"],
  orders_count: ["订单数", "Orders"],
  paid_total: ["累计付款", "Total paid"],
  refunded_total: ["累计退款", "Total refunded"],
  last_order: ["最近下单", "Latest order"],
  amount: ["金额", "Amount"],
  kind: ["类别", "Type"],
  date: ["日期", "Date"],
  description: ["说明", "Description"],
  role: ["角色", "Role"],
  joined: ["已加入", "Joined"],
  rate: ["佣金比例（%）", "Commission rate (%)"],
  action: ["操作", "Action"],
  actor: ["操作人", "Actor"],
  object_id: ["对象编号", "Record ID"],
  order_id: ["订单编号", "Order ID"],
  agent_id: ["代理编号", "Agent ID"],
  product_id: ["商品编号", "Product ID"],
  merchant_id: ["商家编号", "Merchant ID"],
  bank_details: ["结算账户", "Payout account"],
  note: ["备注", "Note"],
  quantity: ["数量", "Quantity"],
  variant: ["规格", "Variant"],
  category: ["分类", "Category"],
  image: ["商品图片地址", "Product image address"],
  emoji: ["商品图标", "Product icon"],
  featured: ["精选", "Featured"],
  version: ["记录版本", "Record version"],
  code: ["推广标识", "Referral code"],
  source: ["来源", "Source"],
  voided: ["已作废", "Voided"],
  attempts: ["尝试次数", "Attempts"],
  receipts: ["订单收款", "Order receipts"],
  refunds: ["退款支出", "Refunds"],
  manual_income: ["其他进账", "Other cash income"],
  expenses: ["日常出账", "Recorded expenses"],
  goods_cost: ["已售商品成本", "Cost of goods sold"],
  commissions: ["应计佣金", "Accrued commissions"],
  net_cash: ["净现金流", "Net cash flow"],
  profit: ["预计经营利润", "Estimated operating profit"],
  missing_cost_orders: ["成本未完整的订单", "Orders with incomplete costs"],
  unknown_date_events: ["日期未知的流水", "Events with unknown dates"],
  slug: ["店铺标识", "Store identifier"],
  plan: ["套餐", "Plan"],
  logo: ["Logo 地址", "Logo address"],
  banner: ["Banner 地址", "Banner address"],
  shipping_fee: ["每单邮费", "Shipping fee"],
  courier: ["常用快递", "Default courier"],
  subtotal: ["商品小计", "Subtotal"],
  shipping: ["邮费", "Shipping"],
  discount: ["优惠", "Discount"],
  commission: ["佣金", "Commission"],
  state: ["州属", "State"],
  city: ["城市", "City"],
  postcode: ["邮编", "Postcode"],
  fulfillment_status: ["发货状态", "Fulfillment status"],
  carrier: ["快递公司", "Courier"],
  tracking: ["运单号", "Tracking number"],
  shipped_at: ["发货时间", "Shipped at"],
  refunded_at: ["退款时间", "Refunded at"],
  refund_reference: ["退款凭据", "Refund reference"],
  stock_returned: ["已退回库存", "Stock returned"],
  bank_enabled: ["启用银行", "Bank enabled"],
  bank_name: ["银行名称", "Bank name"],
  holder: ["收款人", "Account holder"],
  account: ["银行账号", "Bank account"],
  instructions: ["付款说明", "Payment instructions"],
  wallet_enabled: ["启用电子钱包", "Wallet enabled"],
  wallet_name: ["钱包名称", "Wallet name"],
  wallet_identifier: ["钱包账号", "Wallet account"],
  wallet_qr: ["钱包二维码地址", "Wallet QR address"],
  usdt_enabled: ["启用 USDT", "USDT enabled"],
  usdt_network: ["USDT 网络", "USDT network"],
  usdt_address: ["USDT 地址", "USDT address"],
  link_enabled: ["启用收款链接", "Payment link enabled"],
  payment_link: ["收款地址", "Payment address"],
  translations: ["多语言内容", "Localized content"],
  language: ["语言", "Language"],
  expires: ["有效期", "Expires"],
};
const tabs = [
  "overview",
  "products",
  "orders",
  "customers",
  "agents",
  "team",
  "payouts",
  "journal",
  "audit",
  "notifications",
];
const columns: Record<string, string[]> = {
  products: ["name", "price", "unit_cost", "stock", "published"],
  orders: ["reference", "customer", "email", "country_code", "state", "city", "postcode", "address", "total", "status", "created"],
  customers: ["names", "email", "addresses", "orders_count", "paid_total", "refunded_total"],
  agents: ["name", "rate", "code"],
  team: ["name", "email", "role", "joined"],
  payouts: ["id", "agent_id", "amount", "status"],
  journal: ["date", "kind", "amount", "reference", "voided"],
  audit: ["created", "actor", "action", "object_id"],
  notifications: ["order_id", "kind", "status", "attempts", "updated"],
};
const terms: Record<string, [string, string]> = {
  active: ["正常", "Active"],
  suspended: ["暂停", "Suspended"],
  requested: ["待结算", "Requested"],
  rejected: ["已拒绝", "Rejected"],
  trialing: ["试用中", "Trialing"],
  past_due: ["待续费", "Past due"],
  owner: ["店铺所有者", "Owner"],
  manager: ["店铺经理", "Manager"],
  inventory: ["库存", "Inventory"],
  orders: ["订单客服", "Order staff"],
  agent: ["代理", "Agent"],
  shipped: ["已发货", "Shipped"],
  unfulfilled: ["未发货", "Unfulfilled"],
  queued: ["待发送", "Queued"],
  sent: ["已发送", "Sent"],
  failed: ["失败", "Failed"],
  receipt: ["订单收据", "Receipt"],
  reminder: ["付款提醒", "Payment reminder"],
  shipment: ["发货通知", "Shipment notice"],
  payment: ["订单收款", "Order payment"],
  refund: ["退款支出", "Refund"],
  payout: ["佣金结算", "Commission payout"],
  income: ["进账", "Income"],
  expense: ["出账", "Expense"],
  event: ["订单与结算", "Orders and payouts"],
  manual: ["手动记账", "Manual entry"],
  operating: ["日常支出", "Operating expense"],
  shipping: ["邮寄支出", "Shipping expense"],
  advertising: ["广告费", "Advertising"],
  fees: ["手续费", "Fees"],
  other_income: ["其他收入", "Other income"],
  capital: ["投入资金", "Capital"],
};
const amounts = new Set([
  "price",
  "unit_cost",
  "total",
  "amount",
  "paid_total",
  "refunded_total",
  "receipts",
  "refunds",
  "payouts",
  "manual_income",
  "expenses",
  "goods_cost",
  "commissions",
  "net_cash",
  "profit",
  "shipping_fee",
  "subtotal",
  "shipping",
  "discount",
  "commission",
]);
export function PlatformDetails({
  merchant,
  close,
}: {
  merchant: { id: number; name: string; currency?: Currency };
  close: () => void;
}) {
  const { t, locale } = useI18n();
  const L = (zh: string, en: string) => (locale === "en" ? en : zh);
  const label = (key: string) => (names[key] ? L(...names[key]) : key);
  const [storeCurrency, setStoreCurrency] = useState<Currency>(
    merchant.currency || "MYR",
  );
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState("overview"),
    [page, setPage] = useState(1),
    [data, setData] = useState<Overview | PageData | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [detail, setDetail] = useState<{
      row: RecordData;
      items?: RecordData[];
    } | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setData(null);
    setError("");
    api<Overview | PageData>("platform-read/" + tab, {
      merchant_id: merchant.id,
      page,
    })
      .then((result) => {
        if (current === generation.current) {
          setData(result);
          if ("merchant" in result && validCurrency(result.merchant.currency))
            setStoreCurrency(result.merchant.currency);
        }
      })
      .catch((e) => {
        if (current === generation.current) setError((e as Error).message);
      });
    return () => {
      generation.current++;
    };
  }, [merchant.id, tab, page, revision]);
  function value(
    key: string,
    item: unknown,
    currency: Currency = storeCurrency,
  ): string {
    if (item === null || item === undefined || item === "")
      return key === "unit_cost" || key === "profit"
        ? L("未知／待补成本", "Unknown / costs needed")
        : "—";
    if (key === "country_code" && typeof item === "string" && Object.hasOwn(countryNames, item))
      return t(countryNames[item as CountryCode]);
    if (amounts.has(key) && typeof item === "number")
      return money(item, locale, currency);
    if (typeof item === "boolean" || key === "published" || key === "featured")
      return item ? L("是", "Yes") : L("否", "No");
    if (
      [
        "created",
        "updated",
        "date",
        "last_order",
        "shipped_at",
        "refunded_at",
        "trial_ends_at",
      ].includes(key) &&
      typeof item === "string"
    )
      return item.length === 10 ? item : dateLabel(item, locale, storeCurrency);
    if (
      [
        "status",
        "kind",
        "role",
        "source",
        "category",
        "fulfillment_status",
      ].includes(key) &&
      typeof item === "string"
    )
      return terms[item] ? L(...terms[item]) : t(statusLabel(item));
    if (Array.isArray(item)) return item.map((x) => value(key, x)).join(" / ");
    if (typeof item === "object")
      return Object.entries(item as RecordData)
        .map(([k, v]) => `${label(k)}: ${value(k, v)}`)
        .join(" · ");
    return String(item);
  }
  function fields(row: RecordData) {
    return (
      <dl className="platform-detail-fields">
        {Object.entries(row)
          .filter(([key]) => !["version"].includes(key))
          .map(([key, item]) => (
            <div key={key}>
              <dt>{label(key)}</dt>
              <dd>
                {value(
                  key,
                  item,
                  validCurrency(row.currency) ? row.currency : storeCurrency,
                )}
              </dd>
            </div>
          ))}
      </dl>
    );
  }
  async function open(row: RecordData) {
    setError("");
    if (tab !== "orders") {
      setDetail({ row });
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ order: RecordData; items: RecordData[] }>(
        "platform-read/order",
        { merchant_id: merchant.id, order_id: row.id },
      );
      setDetail({ row: result.order, items: result.items });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const report = data && "summary" in data ? data : null;
  const listing = data && "rows" in data ? data : null;
  return (
    <section aria-label={L("商家业务明细", "Merchant business details")}>
      <div className="page-heading">
        <div>
          <h2>{merchant.name}</h2>
          <p>
            {L(
              "平台只读查看；不会切换为商家身份，也不会修改订单、库存或账本。",
              "Read-only platform view. This does not switch merchant identity or modify orders, stock or books.",
            )}
          </p>
        </div>
        <div className="row">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setDetail(null);
              setData(null);
              setRevision((x) => x + 1);
            }}
          >
            {t("刷新")}
          </button>
          <button className="button secondary" disabled={busy} onClick={close}>
            {L("返回商家列表", "Back to merchants")}
          </button>
        </div>
      </div>
      <div
        className="portal-detail-tabs"
        role="tablist"
        aria-label={L("业务分类", "Business sections")}
      >
        {tabs.map((key) => (
          <button
            key={key}
            role="tab"
            disabled={busy}
            aria-selected={tab === key}
            className={tab === key ? "button" : "button secondary"}
            onClick={() => {
              if (tab !== key || page !== 1) setData(null);
              setTab(key);
              setPage(1);
              setDetail(null);
            }}
          >
            {label(key)}
          </button>
        ))}
      </div>
      <ErrorBox
        error={
          /ezshop_platform_read_api|PGRST202/.test(error)
            ? L(
                "平台业务明细尚未启用，请先完成后台升级。",
                "Platform business details are not enabled yet. Complete the backend upgrade first.",
              )
            : error
        }
      />
      {!data && !error && <Loading />}
      {report && (
        <>
          <h3>{L("店铺资料", "Store profile")}</h3>
          <div className="card">{fields(report.merchant)}</div>
          <h3>{L("经营汇总（全部记录）", "Business totals (all records)")}</h3>
          <div className="metric-grid">
            {Object.entries(report.counts).map(([key, item]) => (
              <article className="card metric" key={key}>
                <p>{label(key)}</p>
                <strong>{String(item)}</strong>
              </article>
            ))}
            {Object.entries(report.summary).map(([key, item]) => (
              <article className="card metric" key={key}>
                <p>{label(key)}</p>
                <strong>{value(key, item)}</strong>
              </article>
            ))}
          </div>
          <p className="soft-note">
            {L(
              "利润为估算值。成本不完整时不显示利润；未知收款日期不会自动补造。",
              "Profit is an estimate and remains unknown when costs are incomplete. Missing receipt dates are not invented.",
            )}
          </p>
          <h3>{L("商家收款资料", "Merchant receiving details")}</h3>
          <div className="card">{fields(report.receiving)}</div>
        </>
      )}
      {listing && (
        <>
          {(tab === "orders" || tab === "customers") && <p className="soft-note">{L("位置来自订单收货资料，不代表顾客实时位置。国家、州属、城市与邮编可在订单列表查看；未提供的资料显示为 —。", "Locations come from order delivery details, not live customer locations. Country, state, city and postal code appear in the order list; missing details show —.")}</p>}
          <p>
            {L("记录总数：", "Total records: ")}
            {listing.total}
          </p>
          <div className="card table-scroll">
            <table>
              <thead>
                <tr>
                  {columns[tab].map((key) => (
                    <th key={key}>{label(key)}</th>
                  ))}
                  <th>{L("明细", "Details")}</th>
                </tr>
              </thead>
              <tbody>
                {listing.rows.map((row, i) => (
                  <tr
                    key={
                      String(row.source || tab) +
                      ":" +
                      String(row.id || row.email || i)
                    }
                  >
                    {columns[tab].map((key) => (
                      <td key={key}>
                        {value(
                          key,
                          row[key],
                          validCurrency(row.currency)
                            ? row.currency
                            : storeCurrency,
                        )}
                      </td>
                    ))}
                    <td>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => void open(row)}
                      >
                        {L("查看明细", "View details")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!listing.rows.length && (
              <p className="empty">{L("暂无记录", "No records")}</p>
            )}
          </div>
          <div className="row between">
            <button
              className="button secondary"
              disabled={page <= 1}
              onClick={() => {
                setData(null);
                setPage((x) => x - 1);
              }}
            >
              {L("上一页", "Previous")}
            </button>
            <span>
              {page} /{" "}
              {Math.max(1, Math.ceil(listing.total / listing.page_size))}
            </span>
            <button
              className="button secondary"
              disabled={page * listing.page_size >= listing.total}
              onClick={() => {
                setData(null);
                setPage((x) => x + 1);
              }}
            >
              {L("下一页", "Next")}
            </button>
          </div>
        </>
      )}
      {detail && (
        <Modal
          title={L("业务记录明细", "Business record details")}
          close={() => setDetail(null)}
        >
          {fields(detail.row)}
          {detail.items && (
            <>
              <h3>{L("订单商品", "Order items")}</h3>
              {detail.items.map((row, index) => (
                <div className="card" key={index}>
                  {fields(row)}
                </div>
              ))}
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
