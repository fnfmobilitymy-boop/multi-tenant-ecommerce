"""Batch packing/address prints and shipment queue; isolated local data only."""
import os,tempfile,subprocess,time,urllib.request,json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory() as tmp:
    server=subprocess.Popen(['python3',str(root/'server/app.py')],env={**os.environ,'PORT':'3114','EZSHOP_DB':tmp+'/fulfillment.db','EZSHOP_DIST':str(root/'local-test-dist')},stdout=subprocess.DEVNULL)
    base='http://127.0.0.1:3114'
    try:
        for _ in range(100):
            try:urllib.request.urlopen(base+'/api/health');break
            except OSError:time.sleep(.05)
        with sync_playwright() as p:
            launch={'headless':True,'args':['--no-sandbox']}
            if os.environ.get('EZSHOP_CHROMIUM'):launch['executable_path']=os.environ['EZSHOP_CHROMIUM']
            browser=p.chromium.launch(**launch);c=browser.new_context(locale='zh-CN',timezone_id='Asia/Kuala_Lumpur');errors=[]
            c.route('**/*',lambda route:route.continue_() if urlparse(route.request.url).hostname=='127.0.0.1' else route.abort())
            owner=c.new_page();owner.on('pageerror',lambda e:errors.append(str(e)));owner.goto(base);owner.get_by_role('button',name='免费注册',exact=True).click()
            for label,value in [('店铺名称','Fulfillment Store'),('店铺网址标识','fulfillment-store'),('邮箱地址','fulfillment@example.test'),('密码','Fixture-password-12345')]:owner.get_by_label(label,exact=True).fill(value)
            owner.get_by_role('button',name='创建店铺',exact=True).click();owner.get_by_role('heading',name='生意总览',exact=True).wait_for()
            def api(path,data=None):
                res=c.request.get(base+'/api/'+path) if data is None else c.request.post(base+'/api/'+path,data=data)
                assert res.ok,res.text();return res.json()
            api('products',{'name':'Packing Item','price':1000,'stock':10,'emoji':'📦'});pid=api('dashboard')['products'][0]['id'];refs=[]
            for n in range(4):
                result=api('checkout',{'slug':'fulfillment-store','items':[{'id':pid,'quantity':1}],'customer':'<script>fixture</script>' if n==0 else 'Buyer '+str(n),'email':'buyer@example.test','phone':'0123456789','address':'123 Fixture Street','city':'Shah Alam','state':'Selangor','postcode':'40150'})
                order=next(o for o in api('dashboard')['orders'] if o['reference']==result['reference']);refs.append(order)
                if n!=2:api('orders/paid',{'id':order['id']})
                if n==3:api('orders/ship',{'id':order['id'],'carrier':'Lalamove','tracking':'LM-ALREADY-SHIPPED'})
            before=api('dashboard');owner.reload();owner.get_by_role('button',name='订单管理',exact=True).click()
            assert owner.get_by_label('选择订单 '+refs[2]['reference'],exact=True).is_disabled();assert owner.get_by_label('选择订单 '+refs[3]['reference'],exact=True).is_disabled()
            owner.get_by_label('选择本页待发货订单',exact=True).check();owner.get_by_role('button',name='批量打印配货单',exact=True).click()
            dialog=owner.get_by_role('dialog',name='配货单',exact=True);dialog.locator('.packing-document').nth(1).wait_for();assert dialog.locator('.packing-document').count()==2;assert dialog.locator('li').count()==2;assert dialog.locator('script').count()==0
            dialog.get_by_text('<script>fixture</script>',exact=False).wait_for()
            owner.evaluate('window.__printCalled=false;window.print=()=>{window.__printCalled=true}')
            dialog.get_by_role('button',name='打印',exact=True).click();assert owner.evaluate('window.__printCalled')
            owner.emulate_media(media='print');assert not owner.locator('nav').is_visible();assert dialog.locator('.packing-document').first.is_visible();owner.pdf(path=tmp+'/packing.pdf');owner.emulate_media(media='screen');dialog.get_by_role('button',name='关闭',exact=True).click()
            owner.get_by_role('button',name='批量打印地址标签',exact=True).click();dialog=owner.get_by_role('dialog',name='收货地址标签',exact=True);dialog.locator('.packing-document').nth(1).wait_for();assert dialog.locator('li').count()==0;dialog.get_by_text('地址标签不是快递公司官方面单',exact=False).wait_for();dialog.get_by_role('button',name='关闭',exact=True).click()
            after=api('dashboard');assert [(o['id'],o['status'],o['fulfillment_status']) for o in before['orders']]==[(o['id'],o['status'],o['fulfillment_status']) for o in after['orders']];assert before['products'][0]['stock']==after['products'][0]['stock']
            owner.get_by_role('row').filter(has_text=refs[0]['reference']).get_by_role('button',name='查看详情',exact=False).click();dialog=owner.get_by_role('dialog',name='订单详情',exact=True);dialog.get_by_label('实际快递公司',exact=True).fill('Lalamove');dialog.get_by_label('运单号',exact=True).fill('LM-NEW-SHIPMENT');dialog.get_by_role('button',name='已寄件，保存发货记录',exact=True).click();dialog.get_by_text('已登记发货',exact=True).wait_for();dialog.get_by_role('button',name='关闭',exact=True).click()
            owner.get_by_role('button',name='邮件通知',exact=True).click();owner.get_by_role('cell',name='发货通知',exact=True).nth(1).wait_for();owner.get_by_role('cell',name='等待发送',exact=True).first.wait_for()
            owner.get_by_role('button',name='订单管理',exact=True).click()
            owner.set_viewport_size({'width':390,'height':844});assert owner.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            assert not errors,errors;browser.close();print('PASS: 批量选择仅已付款待发货订单、配货单及地址标签、打印样式与HTML转义、打印不改付款/发货/库存、实际登记发货才通知入队。未发送邮件。')
    finally:server.terminate();server.wait(timeout=5)
