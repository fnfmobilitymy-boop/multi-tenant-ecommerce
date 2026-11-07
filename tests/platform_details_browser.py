"""平台只读明细与门户隔离；所有远端请求拦截，不访问真实顾客资料。"""
import os,json,threading,functools,base64,time
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path.split('?')[0] in ('/merchant','/platform') or self.path.startswith('/shop/'):self.path='/index.html'
        super().do_GET()
server=ThreadingHTTPServer(('127.0.0.1',3110),functools.partial(Quiet,directory=str(root/'auth-test-dist')))
threading.Thread(target=server.serve_forever,daemon=True).start()
base='http://127.0.0.1:3110';errors=[];calls=[]
store={'id':2,'name':'Target Store','email':'owner@example.test','slug':'target-store','plan':'pro','status':'suspended','orders_count':1,'sales':2000}
summary={'receipts':2000,'refunds':0,'payouts':0,'manual_income':0,'expenses':200,'goods_cost':800,'commissions':0,'net_cash':1800,'profit':1000,'missing_cost_orders':0,'unknown_date_events':0}
def token(uid):
    encode=lambda value:base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    return encode({'alg':'HS256','typ':'JWT'})+'.'+encode({'sub':uid,'aud':'authenticated','exp':int(time.time())+36000})+'.fixture'
merchant_token=token('22222222-2222-4222-8222-222222222222');platform_token=token('11111111-1111-4111-8111-111111111111')
order={'id':7,'reference':'EZ-READ','customer':'Buyer','email':'buyer@example.test','phone':'0123456789','address':'KL delivery address','country_code':'MY','state':'Kuala Lumpur','city':'Kuala Lumpur','postcode':'50000','total':2000,'status':'paid','created':'2026-11-05T00:00:00Z'}
try:
    with sync_playwright() as p:
        options={'headless':True,'args':['--no-sandbox']}
        if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
        browser=p.chromium.launch(**options)
        def context(admin=True,needs_login=False):
            c=browser.new_context(locale='zh-CN')
            c.add_init_script("if (!localStorage.getItem('sb-auth-test-auth-token')) localStorage.setItem('sb-auth-test-auth-token',"+json.dumps(json.dumps({'access_token':merchant_token,'refresh_token':'merchant-refresh','expires_at':int(time.time())+36000,'expires_in':36000,'token_type':'bearer','user':{'id':'22222222-2222-4222-8222-222222222222','email':'merchant@example.test','aud':'authenticated','app_metadata':{},'user_metadata':{}}}))+');')
            def intercept(route):
                req=route.request;url=urlparse(req.url)
                if url.hostname=='127.0.0.1':return route.continue_()
                assert req.headers.get('authorization')!='Bearer '+merchant_token,'Platform reused merchant login'
                body=(req.post_data_json or {}) if req.method=='POST' else {};name=body.get('route');payload=body.get('payload',{})
                def reply(value,status=200):return route.fulfill(status=status,content_type='application/json',body=json.dumps(value))
                if url.path=='/auth/v1/token':return reply({'access_token':platform_token,'refresh_token':'platform-refresh','expires_in':36000,'expires_at':int(time.time())+36000,'token_type':'bearer','user':{'id':'11111111-1111-4111-8111-111111111111','email':'platform@example.test','aud':'authenticated','app_metadata':{},'user_metadata':{}}})
                if url.path=='/auth/v1/user':return reply({'id':'11111111-1111-4111-8111-111111111111','email':'platform@example.test','aud':'authenticated','app_metadata':{},'user_metadata':{}})
                if url.path=='/auth/v1/logout':
                    assert parse_qs(url.query).get('scope')==['local'],'Platform logout revoked other portal sessions'
                    return reply({})
                if url.path.endswith('/rpc/ezshop_api'):
                    if name=='store':return reply({'store':{**store,'slug':'platform','status':'active'},'products':[]})
                    assert name=='platform','Platform used merchant dashboard or mutation: '+str(name)
                    return reply({'merchants':[store]}) if admin and (not needs_login or req.headers.get('authorization')=='Bearer '+platform_token) else reply({'message':'需要平台管理员权限'},403)
                if url.path.endswith('/rpc/ezshop_payment_api'):
                    assert name=='store-options'
                    return reply({'online_enabled':False})
                if url.path.endswith('/rpc/ezshop_platform_billing_api'):
                    if name=='settings':return reply({'settings':{}})
                    if name=='queue':return reply({'requests':[]})
                    raise AssertionError('Unexpected platform billing mutation: '+str(name))
                if url.path.endswith('/rpc/ezshop_platform_read_api'):
                    assert admin and payload['merchant_id']==2
                    calls.append(name)
                    if name=='overview':return reply({'merchant':store,'summary':summary,'counts':{'products':55,'stock':275,'orders':1,'customers':1},'receiving':{'bank_name':'Fixture Bank','holder':'Fixture Merchant','account':'not-a-real-account'}})
                    if name=='order':
                        assert payload['order_id']==7
                        return reply({'order':order,'items':[{'id':11,'name':'Product 1','price':1000,'unit_cost':400,'quantity':2}]})
                    rows=[];total=0;page=payload.get('page',1)
                    if name=='products':
                        total=55;rows=[{'id':i,'name':'Product '+str(i),'price':1000,'stock':5,'unit_cost':400,'published':0} for i in range((page-1)*50+1,min(page*50,55)+1)]
                    if name=='orders':
                        time.sleep(.1) # Ensure the test awaits the orders response, not stale product rows.
                        total=2;rows=[{**order,'id':8,'reference':'EZ-OTHER'},order]
                    if name=='customers':total=1;rows=[{'names':['Buyer'],'email':'buyer@example.test','orders_count':1,'paid_total':2000,'refunded_total':0,'addresses':['KL delivery address']}]
                    if name=='journal':total=1;rows=[{'id':1,'date':None,'kind':'payment','amount':2000,'reference':'EZ-READ','voided':False}]
                    return reply({'rows':rows,'total':total,'page':page,'page_size':50})
                raise AssertionError('Unexpected external request: '+url.path)
            c.route('**/*',intercept);return c
        c=context();page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(base+'/platform')
        page.wait_for_function("document.querySelector('.brand-icon img').naturalWidth > 0 && document.querySelector('.brand-icon img').src.includes('platform-icon') && document.querySelector('link[data-ezshop-icon]').href.includes('platform-icon')")
        page.get_by_label('搜索商家',exact=True).fill('no-such-store');page.get_by_text('没有匹配的商家',exact=True).wait_for()
        page.get_by_label('搜索商家',exact=True).fill('owner@example.test');page.get_by_role('row').filter(has_text='owner@example.test').wait_for()
        page.get_by_label('筛选商家状态',exact=True).select_option('active');page.get_by_text('没有匹配的商家',exact=True).wait_for()
        page.get_by_label('筛选商家状态',exact=True).select_option('suspended')
        (root/'test-results').mkdir(exist_ok=True)
        page.screenshot(path=str(root/'test-results/redesign-platform.png'),full_page=True)
        page.get_by_role('row').filter(has_text='owner@example.test').get_by_role('button',name='查看明细',exact=True).click()
        page.get_by_role('heading',name='Target Store',exact=True).wait_for();page.get_by_text('not-a-real-account',exact=True).wait_for()
        page.locator('article.metric').filter(has_text='预计经营利润').locator('strong').filter(has_text='10.00').wait_for()
        assert page.locator('a[href*="/merchant"],a[href*="/shop/"]').count()==0
        page.get_by_role('tab',name='商品与库存',exact=True).click();page.get_by_role('cell',name='Product 1',exact=True).wait_for()
        page.get_by_role('button',name='下一页',exact=True).click();page.get_by_role('cell',name='Product 51',exact=True).wait_for()
        assert page.get_by_role('cell',name='Product 1',exact=True).count()==0
        page.get_by_role('tab',name='订单与顾客',exact=True).click()
        location_row=page.get_by_role('row').filter(has=page.get_by_role('cell',name='EZ-READ',exact=True))
        location_row.get_by_role('cell',name='马来西亚',exact=True).wait_for()
        location_row.get_by_role('cell',name='50000',exact=True).wait_for()
        location_row.get_by_role('cell',name='KL delivery address',exact=True).wait_for()
        assert location_row.get_by_role('cell',name='Kuala Lumpur',exact=True).count()==2
        page.get_by_role('tab',name='顾客汇总',exact=True).click()
        page.get_by_role('cell',name='KL delivery address',exact=True).wait_for()
        page.get_by_role('tab',name='订单与顾客',exact=True).click();page.get_by_role('row').filter(has=page.get_by_role('cell',name='EZ-READ',exact=True)).get_by_role('button',name='查看明细',exact=True).click()
        dialog=page.get_by_role('dialog');dialog.get_by_text('KL delivery address',exact=True).wait_for();dialog.get_by_text('单位成本',exact=True).wait_for();dialog.get_by_role('button',name='关闭',exact=True).click()
        for name in ['顾客汇总','代理','团队与权限','佣金结算','收支流水','操作记录','通知记录']:
            page.get_by_role('tab',name=name,exact=True).click();page.get_by_text('记录总数：',exact=False).wait_for()
        page.get_by_label('语言',exact=True).select_option('en');page.get_by_role('tab',name='Products and stock',exact=True).click();page.get_by_role('columnheader',name='Unit cost',exact=True).wait_for()
        page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        assert page.get_by_label('Language',exact=True).locator('option').count()==2
        page.get_by_role('button',name='Back to merchants',exact=True).click();page.get_by_role('row').filter(has_text='owner@example.test').get_by_role('button',name='View details',exact=True).wait_for()
        denied=context(False).new_page();denied.goto(base+'/platform');denied.get_by_role('heading',name='平台管理员登录',exact=True).wait_for();assert denied.get_by_role('table').count()==0
        assert set(['overview','products','orders','order','customers','agents','team','payouts','journal','audit','notifications']).issubset(calls)
        login=context(True,True).new_page();login.goto(base+'/platform');login.get_by_role('heading',name='平台管理员登录',exact=True).wait_for();login.get_by_label('邮箱地址',exact=True).fill('platform@example.test');login.get_by_label('密码',exact=True).fill('Fixture-platform-password-123');login.get_by_role('button',name='立即登录',exact=True).click();login.get_by_role('row').filter(has_text='owner@example.test').get_by_role('button',name='查看明细',exact=True).wait_for()
        login.wait_for_function("localStorage.getItem('ezshop-platform-auth-auth-test.supabase.co')!==null")
        assert login.evaluate("JSON.parse(localStorage.getItem('sb-auth-test-auth-token')).access_token")==merchant_token
        login.get_by_role('button',name='退出登录',exact=True).click();login.get_by_role('heading',name='平台管理员登录',exact=True).wait_for()
        assert login.evaluate("JSON.parse(localStorage.getItem('sb-auth-test-auth-token')).access_token")==merchant_token
        assert login.evaluate("localStorage.getItem('ezshop-platform-auth-auth-test.supabase.co')") is None
        customer=context().new_page();customer.goto(base+'/shop/platform');customer.get_by_role('heading',name='Target Store',exact=True).wait_for();assert customer.locator('a[href="/merchant"],a[href="/platform"],a[href^="/platform/"]').count()==0
        assert not errors,errors
        browser.close();print('PASS: 平台独立只读明细、商品分页、顾客/订单成本、账本、全部分类、中英及手机布局；普通商家拒绝平台访问。未访问真实服务。')
finally:server.shutdown();server.server_close()
