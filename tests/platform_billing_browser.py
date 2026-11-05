"""平台订阅界面：全程拦截远端请求，不付款、不授权真实账号。"""
import os,json,threading,functools,time
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
class Quiet(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] in ("/merchant","/platform"):self.path="/index.html"
        super().do_GET()
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',3108),functools.partial(Quiet,directory=str(root/'auth-test-dist')));threading.Thread(target=server.serve_forever,daemon=True).start()
state={'requests':[],'plan':'free','approve_calls':0};errors=[]
config={'bank_enabled':True,'bank_holder':'Test Platform','bank_account':'11112222333','stripe_enabled':False,'tng_enabled':False,'usdt_enabled':False}
try:
    with sync_playwright() as p:
        options={'headless':True,'args':['--no-sandbox']}
        if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
        browser=p.chromium.launch(**options)
        def context(admin,expired=False):
            result=browser.new_context(locale='zh-CN')
            def intercept(route):
                url=urlparse(route.request.url)
                if url.hostname=='127.0.0.1':return route.continue_()
                body=route.request.post_data_json if route.request.method=='POST' else {};payload=body.get('payload',{})
                def reply(value,status=200):return route.fulfill(status=status,content_type='application/json',body=json.dumps(value))
                if url.path.endswith('/rpc/ezshop_api'):
                    if body['route']=='dashboard':return reply({'merchant':{'id':1 if admin else 2,'name':'Test Admin' if admin else 'Test Merchant','slug':'test','phone':'','description':'','role':'owner','is_admin':admin,'plan':'free' if admin else state['plan'],'subscription_access':not expired},'products':[],'orders':[],'agents':[]})
                    if body['route']=='platform':return reply({'merchants':[]}) if admin else reply({'message':'需要平台管理员权限'},403)
                if url.path.endswith('/rpc/ezshop_payment_api'):return reply({'merchant_id':1 if admin else 2,'plan':state['plan'],'charges_enabled':False,'payouts_enabled':False,'billing':{},'reviews':[]})
                if url.path.endswith('/rpc/ezshop_platform_billing_api'):
                    name=body['route']
                    if name=='view':return reply({'options':{'bank_transfer':True,'stripe_link':False,'tng':False,'usdt_trc20':False},'requests':state['requests'],'paid_until':state.get('paid_until')})
                    if name=='settings':assert admin;return reply({'settings':config})
                    if name=='queue':assert admin;return reply({'requests':state['requests']})
                    if name=='create':
                        assert not admin and payload['method']=='bank_transfer' and payload['amount']=='19.90'
                        request={'id':1,'method':'bank_transfer','amount':'19.90','currency':'MYR','status':'draft','reference':'','merchant_name':'Test Merchant','merchant_email':'test@example.test','can_pay':True,'instructions':{'bank_name':'Hong Leong Bank','holder':'Test Platform','account':'11112222333'}};state['requests']=[request];return reply({'request':request})
                    if name=='submit':state['requests'][0].update(status='submitted',reference=payload['reference']);return reply({'ok':True})
                    if name=='review':
                        assert admin and payload['verified'] is True and payload['actual_amount']=='19.90' and payload['days']==30
                        state['approve_calls']+=1;state['plan']='pro';state['paid_until']='2026-12-05T00:00:00Z';state['requests'][0].update(status='approved',approved_until=state['paid_until']);return reply({'ok':True})
                return route.abort()
            result.route('**/*',intercept);return result
        merchant=context(False).new_page();merchant.on('pageerror',lambda e:errors.append(str(e)));merchant.goto('http://127.0.0.1:3108');merchant.get_by_role('button',name='收款与订阅',exact=True).click()
        assert merchant.get_by_role('button',name='平台管理',exact=True).count()==0
        denied=context(False).new_page();denied.goto('http://127.0.0.1:3108/platform');denied.get_by_role('heading',name='平台管理员登录',exact=True).wait_for();assert denied.get_by_role('button',name='核实并处理',exact=True).count()==0
        section=merchant.locator('section.card').filter(has=merchant.get_by_role('heading',name='平台订阅申请',exact=True))
        section.get_by_label('申请金额',exact=False).fill('19.90');section.get_by_role('button',name='创建订阅申请',exact=True).click()
        section.get_by_text('11112222333',exact=False).wait_for();assert state['plan']=='free'
        section.get_by_label('付款参考号 / 交易哈希',exact=True).fill('TEST-BANK-TRANSFER')
        section.get_by_role('button',name='提交付款资料',exact=True).click();section.get_by_role('status').filter(has_text='等待平台核实').wait_for();assert state['plan']=='free'
        admin=context(True).new_page();admin.on('pageerror',lambda e:errors.append(str(e)));admin.goto('http://127.0.0.1:3108/platform')
        assert admin.locator('.language-selector option').count()==2
        admin.get_by_role('button',name='核实并处理',exact=True).click();dialog=admin.get_by_role('dialog')
        dialog.get_by_label('实际到账金额',exact=False).fill('19.90');dialog.get_by_label('实际打款参考号',exact=True).fill('TEST-VERIFIED-RECEIPT');dialog.get_by_label('开通天数',exact=True).fill('30')
        dialog.get_by_role('button',name='确认到账并开通服务',exact=True).click();assert state['approve_calls']==0
        dialog.get_by_label('已核对银行、钱包或 Stripe 的真实到账',exact=True).check();dialog.get_by_role('button',name='确认到账并开通服务',exact=True).click();dialog.wait_for(state='hidden');assert state['plan']=='pro'
        section.get_by_role('button',name='刷新记录',exact=True).click();section.get_by_text('已核实并开通',exact=True).wait_for()
        expired=context(False,True).new_page();expired.goto('http://127.0.0.1:3108');expired.get_by_role('heading',name='Pro试用或订阅已到期，请先续费。',exact=True).wait_for();assert expired.get_by_role('button',name='商品管理',exact=True).count()==0;expired.get_by_role('heading',name='平台订阅申请',exact=True).wait_for()
        assert not errors,errors;browser.close();print('PASS: 平台自填金额申请、银行资料、提交后不自动升级、管理员实际到账声明、开通期限及平台双语范围。全部远端接口已模拟。')
finally:server.shutdown();server.server_close()
