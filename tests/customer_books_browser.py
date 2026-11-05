"""顾客独立会话、自动购买统计与商家记账页面。所有外部请求模拟，不发送邮件、不付款。"""
import os,json,time,base64,threading,functools
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path.split('?')[0] in ('/merchant','/platform') or self.path.startswith('/shop/'):self.path='/index.html'
        super().do_GET()
server=ThreadingHTTPServer(('127.0.0.1',3109),functools.partial(Quiet,directory=str(root/'auth-test-dist')));threading.Thread(target=server.serve_forever,daemon=True).start()
base='http://127.0.0.1:3109';buyer='22222222-2222-4222-8222-222222222222';errors=[];state={'paid':False,'cost':None,'expense':0,'voided':False}
def token(uid):
    encode=lambda x:base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip('=')
    return encode({'alg':'HS256','typ':'JWT'})+'.'+encode({'sub':uid,'role':'authenticated','aud':'authenticated','exp':int(time.time())+36000})+'.fixture'
user={'id':buyer,'email':'buyer@example.test','aud':'authenticated','email_confirmed_at':'2026-11-05T00:00:00Z','user_metadata':{},'app_metadata':{'provider':'email'}}
merchant={'id':1,'name':'Books Store','slug':'books-store','email':'owner@example.test','role':'owner','plan':'pro','bookkeeping_enabled':True}
def report():
    summary={'receipts':2000,'refunds':0,'payouts':0,'manual_income':0,'expenses':state['expense'],'goods_cost':0 if state['cost'] is None else 2*state['cost'],'commissions':0,'missing_cost_orders':1 if state['cost'] is None else 0,'net_cash':2000-state['expense'],'profit':None if state['cost'] is None else 2000-2*state['cost']-state['expense'],'unknown_date_events':0}
    rows=[{'id':1,'source':'order','kind':'payment','amount':2000,'date':'2026-11-05T00:00:00Z','reference':'EZ-BOOK','order_id':1,'voided':False}]
    if state['expense'] or state['voided']:rows.append({'id':9,'source':'manual','kind':'expense','category':'advertising','amount':200,'date':'2026-11-05','reference':'ad-test','description':'Test campaign','voided':state['voided']})
    return {'summary':summary,'rows':rows}
try:
    with sync_playwright() as p:
        options={'headless':True,'args':['--no-sandbox']}
        if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
        browser=p.chromium.launch(**options)
        def context():
            c=browser.new_context(locale='en-MY')
            def intercept(route):
                request=route.request;url=urlparse(request.url)
                if url.hostname=='127.0.0.1':return route.continue_()
                body=(request.post_data_json or {}) if request.method=='POST' else {};payload=body.get('payload',{})
                def reply(value,status=200):return route.fulfill(status=status,content_type='application/json',body=json.dumps(value))
                if url.path=='/auth/v1/token':return reply({'access_token':token(buyer),'refresh_token':'customer-fixture-refresh','expires_in':36000,'expires_at':int(time.time())+36000,'token_type':'bearer','user':user})
                if url.path=='/auth/v1/user':return reply(user)
                if url.path=='/auth/v1/logout':return reply({})
                if url.path.endswith('/rpc/ezshop_customer_api'):
                    assert request.headers.get('authorization')=='Bearer '+token(buyer) or buyer in json.loads(base64.urlsafe_b64decode(request.headers['authorization'].split('.')[1]+'==')).get('sub','')
                    if body['route']=='history':return reply({'summary':{'paid_total':2000 if state['paid'] else 0,'refunded_total':0,'purchased_quantity':2 if state['paid'] else 0,'pending_count':0 if state['paid'] else 1,'order_count':1},'orders':[{'reference':'EZ-CUSTOMER','total':2000,'quantity':2,'status':'paid' if state['paid'] else 'pending','created':'2026-11-05T00:00:00Z','slug':'books-store','store_name':'Books Store','access_token':'private-order-fixture'}]})
                    return reply({'ok':True})
                if url.path.endswith('/rpc/ezshop_api'):
                    if body['route']=='dashboard':return reply({'merchant':merchant,'products':[],'orders':[],'agents':[]})
                    if body['route']=='store':return reply({'store':merchant,'products':[]})
                    if body['route']=='order-result':
                        assert payload['token']=='private-order-fixture'
                        return reply({'order':{'reference':'EZ-CUSTOMER','status':'paid','total':2000,'created':'2026-11-05T00:00:00Z'},'items':[{'name':'Item','price':1000,'quantity':2}]})
                if url.path.endswith('/rpc/ezshop_payment_api'):return reply({'online_enabled':False,'order_status':'paid','requires_review':False})
                if url.path.endswith('/rpc/ezshop_books_api'):
                    name=body['route']
                    if name=='summary':return reply(report())
                    if name=='order':return reply({'reference':'EZ-BOOK','version':0,'unknown_paid_date':False,'items':[{'id':101,'name':'Item','quantity':2,'unit_cost':state['cost']}]})
                    if name=='order-costs':assert payload['items'][0]['unit_cost']==400;state['cost']=400;return reply({'ok':True})
                    if name=='entry/add':assert payload['amount']==200 and payload['kind']=='expense';state['expense']=200;return reply({'ok':True})
                    if name=='entry/void':state['expense']=0;state['voided']=True;return reply({'ok':True})
                return route.abort()
            c.route('**/*',intercept);return c
        c=context();merchant_token=token('11111111-1111-4111-8111-111111111111')
        merchant_session={'access_token':merchant_token,'refresh_token':'merchant-fixture-refresh','expires_in':36000,'expires_at':int(time.time())+36000,'token_type':'bearer','user':{**user,'id':'11111111-1111-4111-8111-111111111111','email':'owner@example.test'}}
        c.add_init_script("if(!localStorage.getItem('sb-auth-test-auth-token'))localStorage.setItem('sb-auth-test-auth-token',"+json.dumps(json.dumps(merchant_session))+");")
        page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(base+'/shop/books-store/account');page.get_by_label('Email address',exact=True).fill('buyer@example.test');page.get_by_label('Password',exact=True).fill('Customer-test-password-123');page.get_by_role('button',name='Customer login',exact=True).click()
        page.get_by_text('Purchased units',exact=True).wait_for();metric=page.locator('article.metric').filter(has_text='Purchased units');assert metric.locator('strong').inner_text()=='0'
        state['paid']=True;page.get_by_role('button',name='Refresh records',exact=True).click();metric.locator('strong').filter(has_text='2').wait_for()
        page.get_by_role('button',name='View details',exact=True).click();page.get_by_text('Item × 2',exact=False).wait_for();assert 'private-order-fixture' not in page.url
        assert page.evaluate("!!localStorage.getItem('ezshop-customer-auth-auth-test.supabase.co')")
        assert page.evaluate("JSON.parse(localStorage.getItem('sb-auth-test-auth-token')).access_token")==merchant_token,'Customer login replaced the merchant session'
        page.goto(base+'/shop/books-store/account');page.get_by_role('button',name='Log out',exact=True).click();page.get_by_role('button',name='Customer login',exact=True).wait_for();assert page.evaluate("sessionStorage.getItem('ezshop:order:EZ-CUSTOMER')") is None
        fresh=context().new_page();fresh.goto(base+'/shop/books-store/account');fresh.get_by_label('Email address',exact=True).fill('buyer@example.test');fresh.get_by_label('Password',exact=True).fill('Customer-test-password-123');fresh.get_by_role('button',name='Customer login',exact=True).click();fresh.locator('article.metric').filter(has_text='Purchased units').locator('strong').filter(has_text='2').wait_for()
        m=context().new_page();m.on('pageerror',lambda e:errors.append(str(e)));m.goto(base+'/merchant');m.get_by_role('button',name='Income, expenses and profit',exact=True).click();m.get_by_text('Costs needed',exact=True).wait_for()
        m.get_by_role('button',name='Costs and receipt date',exact=True).click();dialog=m.get_by_role('dialog');dialog.locator('input[name=cost-101]').fill('4.00');dialog.get_by_label('Reason for correction',exact=True).fill('Supplier invoice');dialog.get_by_role('button',name='Save',exact=True).click();dialog.wait_for(state='hidden');m.locator('article.metric').filter(has_text='Estimated operating profit').locator('strong').filter(has_text='12.00').wait_for()
        m.get_by_role('button',name='Record income or expense',exact=True).click();dialog=m.get_by_role('dialog');dialog.locator('select[name=category]').select_option('advertising');dialog.get_by_label('Amount',exact=False).fill('2.00');dialog.get_by_label('Description',exact=True).fill('Test campaign');dialog.get_by_role('button',name='Save',exact=True).click();dialog.wait_for(state='hidden');m.get_by_text('Test campaign',exact=False).wait_for()
        m.once('dialog',lambda d:d.accept('Correction'));m.get_by_role('button',name='Void entry',exact=True).click();m.get_by_text('Voided',exact=True).wait_for()
        m.set_viewport_size({'width':390,'height':844});assert m.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        assert not errors,errors;browser.close();print('PASS: 顾客独立登录、跨设备购买统计、退出清除凭证；商家成本补录、支出、作废及手机账本。未访问真实服务。')
finally:server.shutdown();server.server_close()
