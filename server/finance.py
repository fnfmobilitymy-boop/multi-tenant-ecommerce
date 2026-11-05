"""佣金账本及线下已完成款项的登记。这里不会发起银行转账或支付退款。"""
import re
from datetime import datetime,timezone

class FinanceError(Exception):
    def __init__(self,message,status=400):super().__init__(message);self.status=status

def number(data,key):
    value=data.get(key)
    if type(value) is not int or not 0<value<2**53:raise FinanceError(key+' 必须为正整数')
    return value

def text(data,key,limit=500):
    value=data.get(key)
    if not isinstance(value,str) or not value.strip() or len(value)>limit:raise FinanceError('请填写有效的 '+key)
    return value.strip()

def balance(db,mid,aid):
    earned=db.execute("SELECT COALESCE(SUM(commission),0) FROM orders WHERE merchant_id=? AND agent_id=? AND status='paid'",(mid,aid)).fetchone()[0]
    paid,reserved=db.execute("SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0),COALESCE(SUM(CASE WHEN status='requested' THEN amount ELSE 0 END),0) FROM payouts WHERE merchant_id=? AND agent_id=?",(mid,aid)).fetchone()
    return {'earned':earned,'paid':paid,'reserved':reserved,'available':earned-paid-reserved}

def handle(db,mid,role,member,path,data,method):
    if not (path.startswith('/api/payouts') or path=='/api/orders/refund'):return None
    if role not in ('owner','agent'):raise FinanceError('当前角色不能访问佣金结算或退款',403)
    aid=member['agent_id'] if role=='agent' else None
    if role=='agent' and not aid:raise FinanceError('代理账户配置无效',403)
    if path=='/api/payouts' and method=='GET':
        agents=db.execute('SELECT id,name FROM agents WHERE merchant_id=?'+(' AND id=?' if aid else ''),(mid,aid) if aid else (mid,)).fetchall()
        balances=[{'agent_id':a['id'],'name':a['name'],**balance(db,mid,a['id'])} for a in agents]
        rows=db.execute('SELECT p.*,a.name agent_name FROM payouts p JOIN agents a ON a.id=p.agent_id WHERE p.merchant_id=?'+(' AND p.agent_id=?' if aid else '')+' ORDER BY p.id DESC',(mid,aid) if aid else (mid,)).fetchall()
        return {'balances':balances,'payouts':[{k:r[k] for k in r.keys() if k!='request_key'} for r in rows]},200
    if path=='/api/payouts/request' and method=='POST':
        if role!='agent':raise FinanceError('仅代理可以提交自己的提现申请',403)
        amount=number(data,'amount');details=text(data,'bank_details');key=text(data,'request_key',100)
        if not re.fullmatch(r'[A-Za-z0-9_-]{20,100}',key):raise FinanceError('请求标识无效')
        if not db.in_transaction:db.execute('BEGIN IMMEDIATE')
        old=db.execute('SELECT * FROM payouts WHERE merchant_id=? AND agent_id=? AND request_key=?',(mid,aid,key)).fetchone()
        if old:
            if old['amount']!=amount or old['bank_details']!=details:raise FinanceError('同一请求标识不能用于不同的申请',409)
            return {'ok':True,'id':old['id']},200
        if amount>balance(db,mid,aid)['available']:raise FinanceError('可提现余额不足',409)
        pid=db.execute('INSERT INTO payouts(merchant_id,agent_id,amount,bank_details,request_key) VALUES(?,?,?,?,?)',(mid,aid,amount,details,key)).lastrowid
        db.execute('INSERT INTO audit_log(merchant_id,actor,action,object_id) VALUES(?,?,?,?)',(mid,'agent:'+str(aid),'payout.request',pid))
        db.commit();return {'ok':True,'id':pid},201
    if path=='/api/payouts/update' and method=='POST':
        if role!='owner':raise FinanceError('仅商家所有者可以登记结算',403)
        pid=number(data,'id');status=data.get('status')
        if status not in ('paid','rejected'):raise FinanceError('结算状态无效')
        reference=text(data,'reference',200)
        if not db.in_transaction:db.execute('BEGIN IMMEDIATE')
        p=db.execute('SELECT * FROM payouts WHERE id=? AND merchant_id=?',(pid,mid)).fetchone()
        if not p:raise FinanceError('找不到提现申请',404)
        if p['status']==status and p['reference']==reference:return {'ok':True},200
        if p['status']!='requested':raise FinanceError('申请已处理，不能重复修改',409)
        if status=='paid' and balance(db,mid,p['agent_id'])['available']<0:raise FinanceError('佣金已变动，请先核对账本',409)
        db.execute("UPDATE payouts SET status=?,reference=?,updated=datetime('now') WHERE id=?",(status,reference,pid))
        db.execute('INSERT INTO audit_log(merchant_id,actor,action,object_id) VALUES(?,?,?,?)',(mid,'owner','payout.'+status,pid))
        db.commit();return {'ok':True},200
    if path=='/api/orders/refund' and method=='POST':
        if role!='owner':raise FinanceError('仅商家所有者可以登记退款',403)
        oid=number(data,'id');reference=text(data,'reference',200);restock=data.get('restock',False)
        if type(restock) is not bool:raise FinanceError('库存恢复选项无效')
        if not db.in_transaction:db.execute('BEGIN IMMEDIATE')
        o=db.execute('SELECT * FROM orders WHERE id=? AND merchant_id=?',(oid,mid)).fetchone()
        if not o:raise FinanceError('找不到订单',404)
        if o['status']=='refunded':
            if o['refund_reference']==reference and bool(o['stock_returned'])==restock:return {'ok':True},200
            raise FinanceError('退款已经登记，不能重复修改',409)
        if o['status']!='paid':raise FinanceError('只能为已付款订单登记全额退款',409)
        if restock:
            for i in db.execute('SELECT product_id,quantity FROM order_items WHERE order_id=?',(oid,)).fetchall():db.execute('UPDATE products SET stock=stock+?,version=version+1 WHERE id=? AND merchant_id=?',(i['quantity'],i['product_id'],mid))
        db.execute("UPDATE orders SET status='refunded',refund_reference=?,stock_returned=?,refunded_at=? WHERE id=?",(reference,int(restock),datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S'),oid))
        if o['agent_id']:
            db.execute("UPDATE payouts SET status='rejected',reference='关联订单退款，请重新申请',updated=datetime('now') WHERE merchant_id=? AND agent_id=? AND status='requested'",(mid,o['agent_id']))
        db.execute('INSERT INTO audit_log(merchant_id,actor,action,object_id) VALUES(?,?,?,?)',(mid,'owner','order.refund',oid))
        db.commit();return {'ok':True},200
    raise FinanceError('找不到结算操作',404)
