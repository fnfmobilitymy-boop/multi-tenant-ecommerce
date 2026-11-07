"""Merchant zone editor and real local checkout; no external services."""
import os,tempfile,subprocess,time,urllib.request,json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory() as tmp:
    server=subprocess.Popen(['python3',str(root/'server/app.py')],env={**os.environ,'PORT':'3113','EZSHOP_DB':tmp+'/zones.db','EZSHOP_DIST':str(root/'local-test-dist')},stdout=subprocess.DEVNULL)
    base='http://127.0.0.1:3113'
    try:
        for _ in range(100):
            try:urllib.request.urlopen(base+'/api/health');break
            except OSError:time.sleep(.05)
        with sync_playwright() as p:
            options={'headless':True,'args':['--no-sandbox']}
            if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
            browser=p.chromium.launch(**options);context=browser.new_context(locale='zh-CN',timezone_id='Asia/Kuala_Lumpur');errors=[]
            context.route('**/*',lambda route:route.continue_() if urlparse(route.request.url).hostname=='127.0.0.1' else route.abort())
            owner=context.new_page();owner.on('pageerror',lambda e:errors.append(str(e)));owner.goto(base);owner.get_by_role('button',name='免费注册',exact=True).click()
            for name,value in [('店铺名称','Zones Store'),('店铺网址标识','zones-store'),('邮箱地址','zones@example.test'),('密码','Fixture-password-12345')]:owner.get_by_label(name,exact=True).fill(value)
            owner.get_by_role('button',name='创建店铺',exact=True).click();owner.get_by_role('heading',name='经营概览',exact=True).wait_for()
            owner.get_by_role('button',name='添加新商品',exact=False).click();dialog=owner.get_by_role('dialog');dialog.get_by_label('商品名称',exact=True).fill('Zones Item');dialog.get_by_label('价格（MYR）',exact=True).fill('10.00');dialog.get_by_role('button',name='保存',exact=True).click();dialog.wait_for(state='hidden')
            owner.get_by_role('button',name='店铺设置',exact=True).click();owner.get_by_label('每单邮费（MYR）',exact=True).fill('8.00')
            owner.get_by_role('button',name='添加运费规则',exact=True).click();rule=owner.get_by_role('region',name='分区固定邮费',exact=True).locator('fieldset').nth(0);rule.get_by_label('适用州属',exact=True).select_option('Sabah');rule.get_by_label('固定邮费（MYR）',exact=True).fill('15.00')
            owner.get_by_role('button',name='添加运费规则',exact=True).click();rule=owner.get_by_role('region',name='分区固定邮费',exact=True).locator('fieldset').nth(1);rule.get_by_label('适用州属',exact=True).select_option('Selangor');rule.get_by_label('适用城市／地区',exact=True).fill('Shah Alam');rule.get_by_label('固定邮费（MYR）',exact=True).fill('0')
            owner.get_by_role('button',name='保存店铺资料',exact=True).click();owner.get_by_role('status').filter(has_text='资料已保存').wait_for();owner.reload();owner.get_by_role('button',name='店铺设置',exact=True).click();assert owner.get_by_role('region',name='分区固定邮费',exact=True).locator('fieldset').count()==2
            buyer=context.new_page();buyer.on('pageerror',lambda e:errors.append(str(e)));buyer.goto(base+'/shop/zones-store');buyer.get_by_role('link',name='Zones Item',exact=False).click();buyer.get_by_role('button',name='加入购物车',exact=True).click();buyer.get_by_role('link',name='购物车',exact=True).click();buyer.get_by_role('link',name='前往结账',exact=False).click()
            buyer.get_by_text('填写收货地区后计算',exact=True).first.wait_for();submit=buyer.get_by_role('button',name='确认提交订单',exact=False);assert submit.is_disabled()
            for name,value in [('姓名','Buyer'),('Email','buyer@example.test'),('手机号码','0123456789'),('收货地址','123 Address'),('城市','Kota Kinabalu'),('邮编','88700')]:buyer.get_by_label(name,exact=True).fill(value)
            buyer.get_by_label('州属',exact=True).select_option('Sabah')
            summary=buyer.locator('aside.summary');summary.get_by_text('MYR 15.00',exact=True).wait_for();summary.get_by_text('MYR 25.00',exact=True).wait_for()
            buyer.get_by_label('州属',exact=True).select_option('Selangor');buyer.get_by_label('城市',exact=True).fill('Shah Alam');buyer.get_by_label('邮编',exact=True).fill('40150');summary.get_by_text('MYR 0.00',exact=True).first.wait_for();submit.click();buyer.get_by_role('heading',name='订单已创建',exact=True).wait_for()
            result=buyer.evaluate("async()=>{const ref=new URLSearchParams(location.search).get('ref');return await(await fetch('/api/order-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:'zones-store',reference:ref,token:sessionStorage.getItem('ezshop:order:'+ref)})})).json()}")
            assert result['order']['shipping']==0 and result['order']['total']==1000
            owner.set_viewport_size({'width':390,'height':844});assert owner.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            assert not errors,errors;browser.close();print('PASS: 保存及刷新分区运费、Sabah固定邮费、地区免邮、地址变更重算、未填地址禁止提交、订单快照及手机布局。全程本地。')
    finally:server.terminate();server.wait(timeout=5)
