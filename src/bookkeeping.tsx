import {
  currencyTimeZone,
  type Currency,
} from "../supabase/functions/_shared/currencies";
import {
  useCommerceCurrency,
  useCommerceMoney,
  useCommerceDate,
  currencyFactor,
} from "./commerce-currency";
import { toMinor } from "../supabase/functions/_shared/currencies";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import { ErrorBox, Loading, Modal } from "./ui";
interface Row {
  id: number;
  source: "order" | "manual";
  kind: string;
  amount: number;
  date: string | null;
  reference: string;
  order_id?: number;
  category?: string;
  description?: string;
  voided: boolean;
}
interface Summary {
  receipts: number;
  refunds: number;
  payouts: number;
  manual_income: number;
  expenses: number;
  goods_cost: number;
  commissions: number;
  missing_cost_orders: number;
  net_cash: number;
  profit: number | null;
  unknown_date_events: number;
}
interface Report {
  summary: Summary;
  rows: Row[];
}
interface CostOrder {
  version: number;
  reference: string;
  unknown_paid_date: boolean;
  items: {
    id: number;
    name: string;
    quantity: number;
    unit_cost: number | null;
  }[];
}
const categories: Record<string, string> = {
  operating: "日常支出",
  shipping: "邮寄支出",
  advertising: "广告费",
  fees: "手续费",
  inventory: "进货付款（仅现金流）",
  other_income: "其他收入",
  capital: "投入资金（不计利润）",
};
const kinds: Record<string, string> = {
  payment: "订单收款",
  refund: "退款支出",
  payout: "佣金提现",
  income: "其他收入",
  expense: "日常支出",
};
const today = (currency: Currency = "MYR") =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: currencyTimeZone(currency),
  }).format(new Date());
export function Bookkeeping() {
  const { t, locale } = useI18n();
  const currency = useCommerceCurrency(),
    money = useCommerceMoney(),
    dateLabel = useCommerceDate(),
    inputStep = currency === "VND" ? "1" : "0.01";
  const [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [entry, setEntry] = useState(false),
    [kind, setKind] = useState("expense"),
    [mode, setMode] = useState("all"),
    [period, setPeriod] = useState(today(currency).slice(0, 7)),
    [day, setDay] = useState(today(currency)),
    [costs, setCosts] = useState<{ id: number; data: CostOrder } | null>(null);
  const generation = useRef(0),
    key = useRef(crypto.randomUUID());
  async function load() {
    const current = ++generation.current;
    if ((mode === "month" && !period) || (mode === "day" && !day)) {
      setReport(null);
      setError("请选择统计日期。");
      return;
    }
    try {
      const result = await api<Report>("books/summary", {
        month: mode === "month" ? period : "",
        date: mode === "day" ? day : "",
      });
      if (current === generation.current) {
        setReport(result);
        setError("");
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [mode, period, day]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("books/entry/add", {
        ...Object.fromEntries(form),
        currency,
        amount: toMinor(form.get("amount"), currency),
        request_key: key.current,
      });
      key.current = crypto.randomUUID();
      setEntry(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openCosts(id: number) {
    setError("");
    try {
      setCosts({ id, data: await api<CostOrder>("books/order", { id }) });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function saveCosts(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!costs) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("books/order-costs", {
        currency,
        id: costs.id,
        version: costs.data.version,
        reason: form.get("reason"),
        paid_on: form.get("paid_on") || "",
        items: costs.data.items.map((i) => ({
          id: i.id,
          unit_cost: toMinor(form.get("cost-" + i.id), currency),
        })),
      });
      setCosts(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function voidEntry(row: Row) {
    const reason = window.prompt(t("请填写作废原因。"));
    if (!reason) return;
    setBusy(true);
    try {
      await api("books/entry/void", { id: row.id, reason });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t("收支与利润")}</h1>
          <p>{t("订单收款、退款及佣金自动记录，支出和成本由商家补充。")}</p>
        </div>
        <button
          className="button"
          onClick={() => {
            setEntry(true);
            setError("");
          }}
        >
          {t("录入收支")}
        </button>
      </div>
      <div className="row">
        <label>
          {t("统计范围")}
          <select
            aria-label={t("统计范围")}
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="all">{t("全部记录")}</option>
            <option value="month">{t("按月")}</option>
            <option value="day">{t("按日")}</option>
          </select>
        </label>
        {mode === "month" && (
          <label>
            {t("月份")}
            <input
              type="month"
              value={period}
              required
              onChange={(e) => setPeriod(e.target.value)}
            />
          </label>
        )}
        {mode === "day" && (
          <label>
            {t("日期")}
            <input
              type="date"
              value={day}
              required
              onChange={(e) => setDay(e.target.value)}
            />
          </label>
        )}
        <button className="text-button" onClick={load}>
          {t("刷新记录")}
        </button>
      </div>
      <ErrorBox error={error} />
      {!report && !error ? (
        <Loading />
      ) : (
        report && (
          <>
            <div className="metric-grid">
              {(
                [
                  ["订单收款", report.summary.receipts],
                  ["退款支出", report.summary.refunds],
                  ["手动录入收入", report.summary.manual_income],
                  ["已录入支出", report.summary.expenses],
                  ["商品销售成本", report.summary.goods_cost],
                  ["代理佣金成本", report.summary.commissions],
                  ["现金收支结余", report.summary.net_cash],
                  ["经营利润估算", report.summary.profit],
                ] as const
              ).map(([label, value]) => (
                <article className="card metric" key={label}>
                  <span>{t(label)}</span>
                  <strong>
                    {value === null ? t("待补成本") : money(value, locale)}
                  </strong>
                </article>
              ))}
            </div>
            <div className="soft-note">
              {t(
                "进货付款和投入资金只影响现金流；商品成本按成交快照计算，避免重复计入利润。",
              )}
              <p>{t("佣金按已付款订单计入利润，提现只影响现金流。")}</p>
              {report.summary.missing_cost_orders > 0 && (
                <p>
                  {t("存在缺少成本的订单，补录后才能计算利润。")} (
                  {report.summary.missing_cost_orders})
                </p>
              )}
              {report.summary.unknown_date_events > 0 && (
                <p>
                  {t(
                    "历史记录缺少真实日期，日期筛选不含这些记录，可在订单成本中补录。",
                  )}{" "}
                  ({report.summary.unknown_date_events})
                </p>
              )}
            </div>
            <section className="card table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("日期")}</th>
                    <th>{t("类型")}</th>
                    <th>{t("金额")}</th>
                    <th>{t("说明及参考号")}</th>
                    <th>{t("操作")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr
                      key={row.source + row.id}
                      style={{ opacity: row.voided ? 0.5 : 1 }}
                    >
                      <td>
                        {row.date
                          ? row.source === "manual"
                            ? row.date
                            : dateLabel(row.date, locale)
                          : t("日期未记录")}
                      </td>
                      <td>
                        {t(
                          row.category
                            ? categories[row.category] || kinds[row.kind]
                            : kinds[row.kind] || row.kind,
                        )}
                        {row.voided && <small>{t("已作废")}</small>}
                      </td>
                      <td>{money(row.amount, locale)}</td>
                      <td>
                        {row.description}
                        <small>{row.reference}</small>
                      </td>
                      <td>
                        {row.order_id && (
                          <button
                            className="text-button"
                            onClick={() => openCosts(row.order_id!)}
                          >
                            {t("成本及收款日期")}
                          </button>
                        )}
                        {row.source === "manual" && !row.voided && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => voidEntry(row)}
                          >
                            {t("作废")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <p className="muted">
              {t("汇总包含全部符合条件的记录，流水列表最多显示最近200笔。")}
            </p>
          </>
        )
      )}
      {entry && (
        <Modal
          title={t("录入收支")}
          close={() => {
            if (!busy) setEntry(false);
          }}
        >
          <form onSubmit={save}>
            <label>
              {t("类型")}
              <select
                aria-label={t("类型")}
                name="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="expense">{t("支出")}</option>
                <option value="income">{t("收入")}</option>
              </select>
            </label>
            <label>
              {t("分类")}
              <select aria-label={t("分类")} name="category" key={kind}>
                {Object.entries(categories)
                  .filter(([k]) =>
                    kind === "income"
                      ? ["other_income", "capital"].includes(k)
                      : !["other_income", "capital"].includes(k),
                  )
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {t(label)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t("金额")} ({currency})
              <input
                name="amount"
                type="number"
                required
                min={inputStep}
                step={inputStep}
                max="1000000000"
              />
            </label>
            <label>
              {t("日期")}
              <input
                name="occurred_on"
                type="date"
                required
                min="2000-01-01"
                max={today(currency)}
                defaultValue={today(currency)}
              />
            </label>
            <label>
              {t("说明")}
              <input name="description" required maxLength={300} />
            </label>
            <label>
              {t("参考号（选填）")}
              <input name="reference" maxLength={120} />
            </label>
            <p className="soft-note">
              {t("订单收入、退款和佣金已自动记录，请勿重复录入。")}
            </p>
            <ErrorBox error={error} />
            <button className="button" disabled={busy}>
              {t("保存")}
            </button>
          </form>
        </Modal>
      )}
      {costs && (
        <Modal
          title={t("成本及收款日期")}
          close={() => {
            if (!busy) setCosts(null);
          }}
        >
          <form onSubmit={saveCosts}>
            <p>{costs.data.reference}</p>
            {costs.data.items.map((i) => (
              <label key={i.id}>
                {i.name} × {i.quantity} ·{" "}
                {t("单位成本（{currency}）", { currency })}
                <input
                  name={"cost-" + i.id}
                  type="number"
                  min="0"
                  step={inputStep}
                  max="1000000"
                  required
                  defaultValue={
                    i.unit_cost === null
                      ? ""
                      : i.unit_cost / currencyFactor(currency)
                  }
                />
              </label>
            ))}
            {costs.data.unknown_paid_date && (
              <label>
                {t("历史收款日期（选填）")}
                <input
                  name="paid_on"
                  type="date"
                  min="2000-01-01"
                  max={today(currency)}
                />
              </label>
            )}
            <label>
              {t("更正原因")}
              <input name="reason" required maxLength={300} />
            </label>
            <ErrorBox error={error} />
            <button className="button" disabled={busy}>
              {t("保存")}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
