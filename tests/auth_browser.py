"""验证浏览器端确认邮件回跳。所有远端请求均拦截，不发送实际邮件。"""
import os,json,threading,functools,time,base64
from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if urlparse(self.path).path in ('/forgot-password','/reset-password'):self.path='/index.html'
        return super().do_GET()
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
                if url.path.endswith('/recover'):
                    return route.fulfill(status=200,content_type='application/json',body='{}')
                if url.path.endswith('/user'):
                    return route.fulfill(status=200,content_type='application/json',body=json.dumps({'id':'11111111-1111-4111-8111-111111111111','aud':'authenticated','role':'authenticated','email':'test@example.test','app_metadata':{'provider':'email','providers':['email']},'user_metadata':{}}))
                if url.path.endswith('/logout'):
                    return route.fulfill(status=204,body='')
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
        page.get_by_role('button',name='立即登录',exact=True).click()
        page.get_by_role('link',name='忘记密码？',exact=True).click()
        page.get_by_label('注册邮箱',exact=True).fill('test@example.test')
        page.get_by_role('button',name='发送重设邮件',exact=True).click()
        page.get_by_role('status').filter(has_text='若此邮箱已注册').wait_for()
        recover=next(c for c in captured if c[0].endswith('/recover'))
        assert recover[2].get('email')=='test@example.test'
        assert recover[1].get('redirect_to')==[base+'/'], 'Wrong password recovery callback'
        def encoded(value):return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
        token=encoded({'alg':'HS256','typ':'JWT'})+'.'+encoded({'iss':'https://auth-test.supabase.co/auth/v1','sub':'11111111-1111-4111-8111-111111111111','aud':'authenticated','role':'authenticated','iat':int(time.time()),'exp':int(time.time())+3600})+'.'+base64.urlsafe_b64encode(b'test-only-signature-bytes').decode().rstrip('=')
        page.goto(base+'/#access_token='+token+'&refresh_token=fixture-only-refresh&expires_in=3600&token_type=bearer&type=recovery')
        page.get_by_role('heading',name='设置新密码',exact=True).wait_for()
        page.get_by_label('新密码',exact=True).fill('New-test-only-12345')
        page.get_by_label('再次输入新密码',exact=True).fill('Different-test-12345')
        page.get_by_role('button',name='保存新密码',exact=True).click()
        page.get_by_role('alert').filter(has_text='两次输入的密码不一致').wait_for()
        page.get_by_label('再次输入新密码',exact=True).fill('New-test-only-12345')
        page.get_by_role('button',name='保存新密码',exact=True).click()
        page.get_by_role('status').filter(has_text='密码已更新').wait_for()
        assert any(c[0].endswith('/user') and c[2] and c[2].get('password')=='New-test-only-12345' for c in captured)
        assert any(c[0].endswith('/logout') and c[1].get('scope')==['global'] for c in captured)
        page.get_by_role('link',name='返回登录',exact=True).click()
        page.get_by_role('heading',name='欢迎回来 👋',exact=True).wait_for()
        page.evaluate('document.fonts.ready')
        assert page.evaluate('document.fonts.check(\'27px "Racing Sans One"\')')
        (root/'test-results').mkdir(exist_ok=True)
        page.screenshot(path=str(root/'test-results/brand-font.png'),full_page=True)
        page.goto(base+'/reset-password')
        page.get_by_role('alert').filter(has_text='重设链接已失效').wait_for()
        page.locator('.language-selector select').select_option('en')
        page.get_by_role('alert').filter(has_text='Reset link is expired').wait_for()
        page.get_by_role('link',name='Request another reset email',exact=True).click()
        page.get_by_label('Registered email',exact=True).fill('test@example.test')
        page.locator('.language-selector select').select_option('km')
        assert page.locator('input[name=email]').input_value()=='test@example.test'
        page.get_by_role('button',name='ផ្ញើអ៊ីមែលកំណត់ឡើងវិញ',exact=True).click()
        page.get_by_role('status').filter(has_text='ប្រសិនបើអ៊ីមែលនេះបានចុះឈ្មោះ').wait_for()
        assert not errors,errors
        browser.close()
        print('PASS: 品牌字体已加载；注册/重发/找回邮件回跳正确；重设密码、退出会话及失效链接提示正常。全部邮件接口已模拟，没有发送实际邮件。')
finally:
    server.shutdown();server.server_close()
