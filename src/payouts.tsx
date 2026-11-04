import { useI18n } from "./i18n";
import { useEffect, useState } from "react";
import { api, money, dateLabel } from "./api";
import { Empty, ErrorBox, Modal } from "./ui";
interface Balance {
  agent_id: number;
  name: string;
  earned: number;
  paid: number;
  reserved: number;
  available: number;
}
interface Payout {
  id: number;
  agent_name: string;
  amount: number;
  bank_details: string;
  status: "requested" | "paid" | "rejected";
  reference: string;
  created: string;
}
interface Ledger {
  balances: Balance[];
  payouts: Payout[];
}
export function Payouts({ agent = false }: { agent?: boolean }) {
  const { t, locale, errorText } = useI18n();
  const [data, setData] = useState<Ledger | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState<Payout | null>(null),
    [action, setAction] = useState<"paid" | "rejected">("paid"),
    [key, setKey] = useState("");
  async function load() {
    try {
      setData(await api<Ledger>("payouts"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (agent)
        await api("payouts/request", {
          amount: Math.round(Number(f.amount) * 100),
          bank_details: f.bank_details,
          request_key: key,
        });
      else
        await api("payouts/update", {
          id: selected?.id,
          status: action,
          reference: f.reference,
        });
      await load();
      setOpen(false);
      setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section style={agent ? { marginTop: 40 } : undefined}>
      <div className="page-heading">
        <div>
          <h1>{agent ? t("我的佣金结算") : t("代理佣金结算")}</h1>
          <p>{t("申请、余额及实际打款记录，清楚对账。")}</p>
        </div>
        {agent && (
          <button
            className="button"
            onClick={() => {
              setKey(crypto.randomUUID());
              setOpen(true);
              setError("");
            }}
          >
            {t("申请提现")}
          </button>
        )}
      </div>
      <div className="soft-note">
        {t(
          "这里不会发起银行转账。商家须实际完成打款后，再填写转账参考号登记。退款会扣回佣金；已打出的佣金可能形成负余额，须先结清。",
        )}
      </div>
      <ErrorBox error={error} />
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("代理")}</th>
              <th>{t("已赚佣金")}</th>
              <th>{t("已登记打款")}</th>
              <th>{t("待处理预留")}</th>
              <th>{t("可申请余额")}</th>
            </tr>
          </thead>
          <tbody>
            {data?.balances.map((b) => (
              <tr key={b.agent_id}>
                <td>{b.name}</td>
                <td>{money(b.earned, locale)}</td>
                <td>{money(b.paid, locale)}</td>
                <td>{money(b.reserved, locale)}</td>
                <td className={b.available < 0 ? "danger" : "purple"}>
                  {money(b.available, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.balances.length && (
          <Empty>{t("暂无代理佣金记录。")}</Empty>
        )}
      </div>
      <div className="card table-scroll" style={{ marginTop: 20 }}>
        <table>
          <thead>
            <tr>
              <th>{t("申请时间")}</th>
              <th>{t("代理")}</th>
              <th>{t("金额")}</th>
              <th>{t("收款资料")}</th>
              <th>{t("状态 / 参考号")}</th>
              <th>{t("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {data?.payouts.map((p) => (
              <tr key={p.id}>
                <td>{dateLabel(p.created, locale)}</td>
                <td>{p.agent_name}</td>
                <td>{money(p.amount, locale)}</td>
                <td>
                  <p className="bank-details">{p.bank_details}</p>
                </td>
                <td>
                  {
                    {
                      requested: t("待商家处理"),
                      paid: t("已记录打款"),
                      rejected: t("已拒绝"),
                    }[p.status]
                  }
                  <small>{p.reference}</small>
                </td>
                <td>
                  {!agent && p.status === "requested" ? (
                    <div className="row">
                      <button
                        className="text-button"
                        onClick={() => {
                          setSelected(p);
                          setAction("paid");
                          setOpen(true);
                          setError("");
                        }}
                      >
                        {t("登记已打款")}
                      </button>
                      <button
                        className="text-button danger"
                        onClick={() => {
                          setSelected(p);
                          setAction("rejected");
                          setOpen(true);
                          setError("");
                        }}
                      >
                        {t("拒绝")}
                      </button>
                    </div>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.payouts.length && <Empty>{t("暂无提现申请。")}</Empty>}
      </div>
      {open && (
        <Modal
          title={
            agent
              ? t("申请佣金提现")
              : action === "paid"
                ? t("登记已完成的打款")
                : t("拒绝提现申请")
          }
          close={() => {
            setOpen(false);
            setSelected(null);
          }}
        >
          <form onSubmit={submit}>
            {agent ? (
              <>
                <label>
                  {t("申请金额（MYR）")}
                  <input
                    name="amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    max="9000000000"
                    required
                  />
                </label>
                <label>
                  {t("收款银行、账号及户名")}
                  <textarea
                    name="bank_details"
                    rows={4}
                    maxLength={500}
                    required
                  />
                </label>
                <p className="muted">
                  {t(
                    "仅你和商家所有者能查看此申请。申请金额会从可用余额预留。",
                  )}
                </p>
              </>
            ) : (
              <>
                <p>
                  {selected?.agent_name} ·{" "}
                  {money(selected?.amount || 0, locale)}
                </p>
                <p className="bank-details">{selected?.bank_details}</p>
                <div className="soft-note">
                  {action === "paid"
                    ? t(
                        "请先在银行核实实际打款成功，再登记参考号；此操作不会发起转账。",
                      )
                    : t("拒绝后将释放此申请预留的佣金余额。")}
                </div>
                <label>
                  {action === "paid" ? t("实际打款参考号") : t("拒绝原因")}
                  <input name="reference" required maxLength={200} />
                </label>
              </>
            )}
            <ErrorBox error={error} />
            <button className="button full" disabled={busy}>
              {busy
                ? t("正在保存…")
                : agent
                  ? t("提交申请")
                  : action === "paid"
                    ? t("已核实，保存打款记录")
                    : t("确认拒绝")}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
