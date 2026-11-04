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
          <h1>{agent ? "我的佣金结算" : "代理佣金结算"}</h1>
          <p>申请、余额及实际打款记录，清楚对账。</p>
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
            申请提现
          </button>
        )}
      </div>
      <div className="soft-note">
        这里不会发起银行转账。商家须实际完成打款后，再填写转账参考号登记。退款会扣回佣金；已打出的佣金可能形成负余额，须先结清。
      </div>
      <ErrorBox error={error} />
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>代理</th>
              <th>已赚佣金</th>
              <th>已登记打款</th>
              <th>待处理预留</th>
              <th>可申请余额</th>
            </tr>
          </thead>
          <tbody>
            {data?.balances.map((b) => (
              <tr key={b.agent_id}>
                <td>{b.name}</td>
                <td>{money(b.earned)}</td>
                <td>{money(b.paid)}</td>
                <td>{money(b.reserved)}</td>
                <td className={b.available < 0 ? "danger" : "purple"}>
                  {money(b.available)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.balances.length && <Empty>暂无代理佣金记录。</Empty>}
      </div>
      <div className="card table-scroll" style={{ marginTop: 20 }}>
        <table>
          <thead>
            <tr>
              <th>申请时间</th>
              <th>代理</th>
              <th>金额</th>
              <th>收款资料</th>
              <th>状态 / 参考号</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.payouts.map((p) => (
              <tr key={p.id}>
                <td>{dateLabel(p.created)}</td>
                <td>{p.agent_name}</td>
                <td>{money(p.amount)}</td>
                <td>
                  <p className="bank-details">{p.bank_details}</p>
                </td>
                <td>
                  {
                    {
                      requested: "待商家处理",
                      paid: "已记录打款",
                      rejected: "已拒绝",
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
                        登记已打款
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
                        拒绝
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
        {data && !data.payouts.length && <Empty>暂无提现申请。</Empty>}
      </div>
      {open && (
        <Modal
          title={
            agent
              ? "申请佣金提现"
              : action === "paid"
                ? "登记已完成的打款"
                : "拒绝提现申请"
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
                  申请金额（MYR）
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
                  收款银行、账号及户名
                  <textarea
                    name="bank_details"
                    rows={4}
                    maxLength={500}
                    required
                  />
                </label>
                <p className="muted">
                  仅你和商家所有者能查看此申请。申请金额会从可用余额预留。
                </p>
              </>
            ) : (
              <>
                <p>
                  {selected?.agent_name} · {money(selected?.amount || 0)}
                </p>
                <p className="bank-details">{selected?.bank_details}</p>
                <div className="soft-note">
                  {action === "paid"
                    ? "请先在银行核实实际打款成功，再登记参考号；此操作不会发起转账。"
                    : "拒绝后将释放此申请预留的佣金余额。"}
                </div>
                <label>
                  {action === "paid" ? "实际打款参考号" : "拒绝原因"}
                  <input name="reference" required maxLength={200} />
                </label>
              </>
            )}
            <ErrorBox error={error} />
            <button className="button full" disabled={busy}>
              {busy
                ? "正在保存…"
                : agent
                  ? "提交申请"
                  : action === "paid"
                    ? "已核实，保存打款记录"
                    : "确认拒绝"}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
