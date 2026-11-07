"""多国店铺真实本地流程；隔离数据库、拦截外部请求，不产生真实收款。"""
import os,subprocess,tempfile,time,urllib.request,json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
regions=[('MY','MYR','10.00','2.50','50000'),('SG','SGD','10.00','2.50','018956'),('TH','THB','10.00','2.50','10100'),('KH','KHR','1000.00','100.00','120101'),('KH','USD','10.00','2.50','120101'),('VN','VND','50000','10000','10000')]
with tempfile.TemporaryDirectory() as temp:
    server=subprocess.Popen(['python3',str(root/'server/app.py')],env={**os.environ,'PORT':'3112','EZSHOP_DB':temp+'/regional.db','EZSHOP_DIST':str(root/'local-test-dist')},stdout=subprocess.DEVNULL)
    base='http://127.0.0.1:3112'
    try:
        for _ in range(100):
            try:urllib.request.urlopen(base+'/api/health');break
            except OSError:time.sleep(.05)
        else:raise RuntimeError('Server did not start')
        with sync_playwright() as p:
            options={'headless':True,'args':['--no-sandbox']}
            if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
            browser=p.chromium.launch(**options);errors=[]
            def context(tz):
                c=browser.new_context(locale='zh-CN',timezone_id=tz)
                c.route('**/*',lambda route:route.continue_() if urlparse(route.request.url).hostname=='127.0.0.1' else route.abort())
                return c
            for country,currency,price,shipping,postcode in regions:
                owner=context('Asia/Ho_Chi_Minh').new_page();owner.on('pageerror',lambda e:errors.append(str(e)))
                owner.goto(base+'/merchant');owner.get_by_role('button',name='免费注册',exact=True).click()
                assert owner.get_by_label('商家国家／地区',exact=True).input_value()=='VN','Device region not suggested'
                owner.get_by_label('商家国家／地区',exact=True).select_option(country);owner.get_by_label('店铺币种',exact=True).select_option(currency)
                slug='regional-'+currency.lower();owner.get_by_label('店铺名称',exact=True).fill('Region '+currency);owner.get_by_label('店铺网址标识',exact=True).fill(slug);owner.get_by_label('邮箱地址',exact=True).fill(slug+'@example.test');owner.get_by_label('密码',exact=True).fill('Fixture-password-12345');owner.get_by_role('button',name='创建店铺',exact=True).click();owner.get_by_role('heading',name='经营概览',exact=True).wait_for()
                owner.get_by_role('button',name='添加新商品',exact=False).click();dialog=owner.get_by_role('dialog');dialog.get_by_label('商品名称',exact=True).fill('Regional Item');dialog.get_by_label('价格（'+currency+'）',exact=True).fill(price);dialog.get_by_role('button',name='保存',exact=True).click();dialog.wait_for(state='hidden')
                owner.get_by_role('button',name='店铺设置',exact=True).click();assert owner.get_by_label('店铺币种',exact=True).is_disabled();owner.get_by_label('每单邮费（'+currency+'）',exact=True).fill(shipping);owner.get_by_role('button',name='保存店铺资料',exact=True).click();owner.get_by_role('status').filter(has_text='资料已保存').wait_for()
                buyer=context('Asia/Singapore').new_page();buyer.on('pageerror',lambda e:errors.append(str(e)));buyer.goto(base+'/shop/'+slug);buyer.get_by_role('heading',name='Region '+currency,exact=True).wait_for();buyer.get_by_text('交易币种：'+currency,exact=True).wait_for()
                expected=buyer.evaluate("v=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:v.currency}).format(Number(v.price))",{'currency':currency,'price':price});buyer.get_by_text(expected,exact=True).first.wait_for()
                buyer.get_by_label('语言',exact=True).select_option('en');buyer.get_by_text('Transaction currency: '+currency,exact=True).wait_for();expected=buyer.evaluate("v=>new Intl.NumberFormat('en-MY',{style:'currency',currency:v.currency}).format(Number(v.price))",{'currency':currency,'price':price});buyer.get_by_text(expected,exact=True).first.wait_for();buyer.get_by_label('Language',exact=True).select_option('zh')
                buyer.get_by_role('link',name='Regional Item',exact=False).click();buyer.get_by_role('heading',name='Regional Item',exact=True).wait_for();buyer.get_by_role('button',name='加入购物车',exact=True).click();buyer.get_by_role('link',name='购物车',exact=True).click();buyer.get_by_role('link',name='前往结账',exact=False).click()
                buyer.get_by_label('姓名',exact=True).fill('Fixture Buyer');buyer.get_by_label('Email',exact=True).fill('buyer@example.test');buyer.get_by_label('手机号码',exact=True).fill('0123456789');buyer.get_by_label('收货地址',exact=True).fill('Fixture local address');buyer.get_by_label('城市',exact=True).fill('Fixture City');buyer.get_by_label('邮编',exact=True).fill(postcode)
                if country=='MY':buyer.get_by_label('州属',exact=True).select_option('Kuala Lumpur')
                else:buyer.get_by_label('州属',exact=True).fill('Fixture Region')
                assert buyer.locator('input[name=country]').input_value()==country
                buyer.get_by_role('button',name='确认提交订单',exact=False).click();buyer.get_by_role('heading',name='订单已创建',exact=True).wait_for();buyer.reload();buyer.get_by_role('heading',name='订单已创建',exact=True).wait_for()
                result=buyer.evaluate("async()=>{const ref=new URL(location.href).searchParams.get('ref');const r=await fetch('/api/order-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:"+json.dumps(slug)+",reference:ref,token:sessionStorage.getItem('ezshop:order:'+ref)})});return r.json()}")
                assert result['order']['currency']==currency
                expected_total=int(price)+int(shipping) if currency=='VND' else round((float(price)+float(shipping))*100)
                assert result['order']['total']==expected_total
                buyer.set_viewport_size({'width':390,'height':844});assert buyer.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                owner.context.close();buyer.context.close()
            assert not errors,errors;browser.close();print('PASS: MYR/SGD/THB/KHR/USD/VND注册建议及确认、商品/运费、切语言不改币种、当地邮编结账、订单币种快照、越南盾单位及手机布局。全程本地临时数据。')
    finally:server.terminate();server.wait(timeout=5)
