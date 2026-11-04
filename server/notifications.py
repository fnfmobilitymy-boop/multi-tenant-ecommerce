"""通知队列。默认只排队，必须显式 dispatch 且配置 Resend 才会向客户发邮件。"""
import argparse,json,os,time,urllib.request,urllib.error
from html import escape
from datetime import datetime,timezone
from app import connect,init

def reminders():
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        day=datetime.now(timezone.utc).strftime('%Y-%m-%d')
        rows=db.execute("SELECT id,merchant_id FROM orders WHERE status='pending' AND created<=datetime('now','-24 hours')").fetchall()
        for order in rows:
            db.execute("INSERT OR IGNORE INTO notification_jobs(merchant_id,order_id,kind,event_key) VALUES(?,?,'reminder',?)",(order['merchant_id'],order['id'],'reminder:'+str(order['id'])+':'+day))
        return len(rows)

def claim():
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        # Recover interrupted attempts after 10 minutes; the provider idempotency
        # key stays stable so a repeated delivery request does not duplicate mail.
        db.execute("UPDATE notification_jobs SET status='queued' WHERE status='sending' AND updated<?",(int(time.time())-600,))
        row=db.execute("SELECT n.*,o.reference,o.email,o.customer,o.total,o.status order_status,m.name store_name FROM notification_jobs n JOIN orders o ON o.id=n.order_id JOIN merchants m ON m.id=n.merchant_id WHERE n.status IN ('queued','failed') AND n.attempts<3 ORDER BY n.id LIMIT 1").fetchone()
        if not row:return None
        expected='paid' if row['kind']=='receipt' else 'pending'
        if row['order_status']!=expected:
            db.execute("UPDATE notification_jobs SET status='skipped',updated=? WHERE id=?",(int(time.time()),row['id']))
            return {'skipped':True}
        db.execute("UPDATE notification_jobs SET status='sending',attempts=attempts+1,updated=? WHERE id=?",(int(time.time()),row['id']))
        return dict(row)

def dispatch(limit=20):
    key=os.environ.get('RESEND_API_KEY')
    sender=os.environ.get('MAIL_FROM')
    if not key or not sender:raise SystemExit('未配置 RESEND_API_KEY 和 MAIL_FROM；没有发送任何邮件。')
    for _ in range(limit):
        job=claim()
        if job is None:break
        if job.get('skipped'):continue
        title='付款收据' if job['kind']=='receipt' else '订单付款提醒'
        with connect() as db:
            items=db.execute('SELECT name,price,quantity FROM order_items WHERE order_id=?',(job['order_id'],)).fetchall()
        lines=''.join('<li>'+escape(i['name'])+' × '+str(i['quantity'])+' · RM '+format(i['price']*i['quantity']/100,'.2f')+'</li>' for i in items)
        html='<h2>'+escape(job['store_name'])+' · '+title+'</h2><p>订单 '+escape(job['reference'])+'</p><ul>'+lines+'</ul><p>总额 RM '+format(job['total']/100,'.2f')+'</p><p>'+('商家已确认收款。' if job['kind']=='receipt' else '此订单仍待付款。如已付款，请联系商家核实，请勿重复付款。')+'</p>'
        request=urllib.request.Request('https://api.resend.com/emails',data=json.dumps({'from':sender,'to':[job['email']],'subject':title+' · '+job['reference'],'html':html}).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':'ezshop-mail-'+str(job['id'])},method='POST')
        try:
            with urllib.request.urlopen(request,timeout=20) as response:
                result=json.load(response)
                if not result.get('id'):raise ValueError('Provider did not return delivery request id')
            with connect() as db:db.execute("UPDATE notification_jobs SET status='sent',provider_id=?,error=NULL,updated=? WHERE id=?",(result['id'],int(time.time()),job['id']))
        except Exception as error:
            # Do not persist raw provider errors; they may contain credentials or
            # customer data. A request id means accepted, not guaranteed delivered.
            reason='HTTP '+str(error.code) if isinstance(error,urllib.error.HTTPError) else type(error).__name__
            with connect() as db:db.execute("UPDATE notification_jobs SET status='failed',error=?,updated=? WHERE id=?",(reason,int(time.time()),job['id']))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['enqueue-reminders','dispatch']);args=p.parse_args();init()
    if args.command=='enqueue-reminders':print('已检查待付款提醒：',reminders())
    else:dispatch();print('队列处理完成；请在商家通知记录及邮件服务商后台检查状态。')
