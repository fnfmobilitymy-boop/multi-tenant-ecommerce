"""支付页面集成验证：拦截所有远端请求，绝不触发真实付款。"""
import os,json,threading,functools
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if urlparse(self.path).path.startswith('/shop/'):self.path='/index.html'
        return super().do_GET()
server=ThreadingHTTPServer(('127.0.0.1',3105),functools.partial(Quiet,directory=str(root/os.environ.get('EZSHOP_AUTH_TEST_DIST','auth-test-dist'))))
threading.Thread(target=server.serve_forever,daemon=True).start()
base='http://127.0.0.1:3105';errors=[];calls=[];state={'paid':False,'review':False,'online':True}
merchant={'id':1,'name':'Test Merchant','slug':'test-store','phone':'60123456789','description':'Test','role':'owner','plan':'free'}
try:
    with sync_playwright() as p:
        options={'headless':True,'args':['--no-sandbox']}
        if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
        browser=p.chromium.launch(**options);context=browser.new_context(locale='zh-CN',)
        def intercept(route):
            request=route.request;url=urlparse(request.url)
            if url.hostname=='127.0.0.1':return route.continue_()
            body=request.post_data_json if request.method=='POST' else {}
            def reply(value,status=200):return route.fulfill(status=status,content_type='application/json',body=json.dumps(value))
            if url.path=='/rest/v1/rpc/ezshop_api':
                name=body['route'];calls.append(name)
                if name=='receiving':return reply({'receiving':{'bank_enabled':False,'wallet_enabled':False,'usdt_enabled':False,'link_enabled':False,'version':0,'instructions':''}})
                if name=='dashboard':return reply({'merchant':merchant,'products':[],'orders':[],'agents':[]})
                if name=='store':return reply({'store':merchant,'products':[]})
                if name=='order-result':
                    assert body['payload']['token']=='test-order-access-token'
                    return reply({'order':{'reference':'EZ-TEST','status':'paid' if state['paid'] else 'pending','total':1000,'created':'2026-11-04T00:00:00Z'},'items':[{'name':'Test product','quantity':1,'price':1000}],'store':merchant})
            if url.path=='/rest/v1/rpc/ezshop_payment_api':
                name=body['route'];calls.append(name)
                if name=='owner-status':return reply({'merchant_id':1,'plan':'free','charges_enabled':False,'payouts_enabled':False,'billing':{},'reviews':[]})
                if name=='store-options':return reply({'online_enabled':state['online']})
                if name=='order-summary':return reply({'online_enabled':state['online'],'requires_review':state['review'],'order_status':'paid' if state['paid'] else 'pending'})
            if url.path=='/functions/v1/payments':
                calls.append(body['action'])
                if body['action']=='readiness':return reply({'mode':'test','configured':True,'payment_verified':False})
                if body['action']=='order-checkout':
                    assert body['reference']=='EZ-TEST' and body['token']=='test-order-access-token'
                    # Malicious/unexpected hosted URL must be refused before navigation.
                    return reply({'url':'https://untrusted.example/steal'})
                return reply({'error':'支付服务尚未配置，当前不会发起付款或订阅。'},503)
            return route.abort()
        context.route('**/*',intercept)
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(base)
        page.get_by_role('button',name='收款设置与套餐',exact=True).click()
        page.get_by_text('使用下方平台订阅申请付款，平台核实到账后开通服务。',exact=True).wait_for()
        assert page.get_by_role('button',name='查看价格并订阅 Pro',exact=True).count()==0
        assert 'subscription-checkout' not in calls and 'readiness' not in calls
        assert page.get_by_role('button',name='开通商家收款账户',exact=True).count()==0
        page.locator('.language-selector select').select_option('en')
        page.get_by_role('heading',name='Payment settings and plan',exact=True).wait_for()
        assert page.get_by_role('button',name='Open merchant payment account',exact=True).count()==0
        assert not any(action in calls for action in ['connect-onboarding','readiness','subscription-checkout'])
        page.evaluate("sessionStorage.setItem('ezshop:order:EZ-TEST','test-order-access-token')")
        page.goto(base+'/shop/test-store/order-result?ref=EZ-TEST&payment_return=1')
        page.get_by_text('订单已保存，尚未确认收款。请联系商家安排付款。',exact=True).wait_for()
        assert page.get_by_role('button',name='前往安全付款页',exact=True).count()==0
        assert not state['paid'], 'Return URL fabricated a paid order'
        state['paid']=True
        page.get_by_role('button',name='刷新订单与付款状态',exact=True).click()
        page.locator('.badge.paid').wait_for()
        assert 'order-checkout' not in calls
        assert not errors,errors
        (root/'test-results').mkdir(exist_ok=True)
        page.screenshot(path=str(root/'test-results/payment-result.png'),full_page=True)
        browser.close()
        print('PASS: 平台Pro人工申请、不展示商家Stripe入口、返回网址不能伪造收款、后端订单状态更新。所有远端接口已模拟。')
finally:
    server.shutdown();server.server_close()
