"""验证浏览器端确认邮件回跳。所有远端请求均拦截，不发送实际邮件。"""
import os,json,threading,functools
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',3104),functools.partial(Quiet,directory=str(root/os.environ.get('EZSHOP_AUTH_TEST_DIST','dist'))))
threading.Thread(target=server.serve_forever,daemon=True).start()
base='http://127.0.0.1:3104';captured=[];errors=[]
try:
    with sync_playwright() as p:
        options={'headless':True,'args':['--no-sandbox']}
        if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
        browser=p.chromium.launch(**options)
        context=browser.new_context()
        def intercept(route):
            request=route.request;url=urlparse(request.url)
            if url.hostname=='127.0.0.1':return route.continue_()
            if url.path.startswith('/auth/v1/'):
                captured.append((url.path,parse_qs(url.query),request.post_data_json))
                if url.path.endswith('/signup'):
                    return route.fulfill(status=200,content_type='application/json',body=json.dumps({'user':{'id':'11111111-1111-4111-8111-111111111111','email':'test@example.test','app_metadata':{},'user_metadata':{}},'session':None}))
                if url.path.endswith('/resend'):
                    return route.fulfill(status=200,content_type='application/json',body='{}')
                return route.fulfill(status=401,content_type='application/json',body='{"message":"Test: authentication required"}')
            if url.path=='/rest/v1/rpc/ezshop_api':
                return route.fulfill(status=401,content_type='application/json',body='{"message":"Test: authentication required","code":"P0001"}')
            return route.abort()
        context.route('**/*',intercept)
        page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(base)
        page.get_by_role('button',name='免费注册',exact=True).click()
        page.get_by_label('店铺名称',exact=True).fill('Test Store')
        page.get_by_label('店铺网址标识').fill('test-store')
        page.get_by_label('邮箱地址').fill('test@example.test')
        page.get_by_label('密码',exact=True).fill('Test-only-12345')
        page.get_by_role('button',name='创建店铺',exact=True).click()
        page.get_by_role('alert').filter(has_text='请先通过邮件验证').wait_for()
        page.get_by_role('button',name='重新发送验证邮件',exact=True).click()
        page.get_by_role('status').filter(has_text='验证邮件请求已提交').wait_for()
        signup=next(c for c in captured if c[0].endswith('/signup'))
        resend=next(c for c in captured if c[0].endswith('/resend'))
        assert signup[1].get('redirect_to')==[base+'/'], 'Wrong signup callback'
        assert resend[1].get('redirect_to')==[base+'/'] or resend[2].get('email_redirect_to')==base+'/', 'Wrong resend callback'
        assert not errors,errors
        browser.close()
        print('PASS: 注册和重发验证邮件都使用网站根目录回跳；界面显示真实的待验证提示。全部邮件接口已模拟，没有发送实际邮件。')
finally:
    server.shutdown();server.server_close()
