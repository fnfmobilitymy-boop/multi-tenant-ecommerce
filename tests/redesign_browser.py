"""Workspace controls against an isolated SQLite store; no external traffic."""
import os,json,time,tempfile,subprocess,sqlite3,urllib.request
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory() as temp:
 db=temp+'/workspace.db';base='http://127.0.0.1:3115'
 server=subprocess.Popen(['python3',str(root/'server/app.py')],env={**os.environ,'PORT':'3115','EZSHOP_DB':db,'EZSHOP_DIST':str(root/'local-test-dist')},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  for _ in range(80):
   try:urllib.request.urlopen(base+'/api/health');break
   except OSError:time.sleep(.05)
  with sync_playwright() as p:
   options={'headless':True,'args':['--no-sandbox']}
   if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
   browser=p.chromium.launch(**options);context=browser.new_context(locale='zh-CN',viewport={'width':1440,'height':1050})
   context.route('**/*',lambda r:r.continue_() if urlparse(r.request.url).hostname=='127.0.0.1' else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   def call(path,data=None):
    res=context.request.post(base+'/api/'+path,data=data) if data is not None else context.request.get(base+'/api/'+path)
    assert res.ok,res.text();return res.json()
   call('register',{'name':'Kenny Lifestyle','slug':'kenny-lifestyle','email':'workspace@example.test','password':'Testing-workspace-12345'})
   icons=['⌚','🎧','👟','👜','☕','🕶️']
   for i in range(15):call('products',{'name':f'精选商品 {i+1:02}','price':1000+i*200,'stock':0 if i==0 else 3 if i==1 else 20,'category':'生活用品' if i%2 else '数码配件','emoji':icons[i%6],'description':'为日常生活挑选的实用好物。','published':1,'featured':0})
   products=call('dashboard')['products']
   for i in range(3):
    call('checkout',{'slug':'kenny-lifestyle','customer':'Alex Tan' if i<2 else 'Maya','email':'alex@example.test' if i<2 else 'maya@example.test','phone':'0123456789','address':'Kuala Lumpur','city':'Kuala Lumpur','state':'Kuala Lumpur','postcode':'50000','items':[{'id':products[0]['id'],'quantity':1}],'checkout_key':'workspace-checkout-'+str(i)+'-1234567890'})
   # Fixture paid orders only. No payment provider or production database touched.
   with sqlite3.connect(db) as c:c.execute("UPDATE orders SET status='paid' WHERE id IN (1,2)");c.commit()
   page.goto(base+'/merchant');page.get_by_role('heading',name='生意总览',exact=True).wait_for()
   expect(page.locator('.chart-summary')).to_contain_text('2');page.get_by_label('统计周期').select_option('30');expect(page.locator('.chart-column')).to_have_count(30)
   page.get_by_label('统计周期').select_option('7');expect(page.locator('.chart-column')).to_have_count(7)
   results=root/'test-results';results.mkdir(exist_ok=True)
   page.screenshot(path=str(results/'redesign-merchant-overview.png'),full_page=True)
   page.get_by_role('button',name='商品管理',exact=True).click()
   expect(page.locator('.catalog-table tbody tr')).to_have_count(10);page.get_by_role('button',name='下一页',exact=True).click();expect(page.locator('.catalog-table tbody tr')).to_have_count(5)
   page.get_by_label('商品状态筛选').select_option('out');expect(page.locator('.catalog-table tbody tr')).to_have_count(1);expect(page.locator('.catalog-table tbody')).to_contain_text('精选商品 01')
   page.get_by_label('商品状态筛选').select_option('low');expect(page.locator('.catalog-table tbody tr')).to_have_count(1);expect(page.locator('.catalog-table tbody')).to_contain_text('精选商品 02')
   page.get_by_label('商品状态筛选').select_option('all');page.get_by_label('商品排序').select_option('price_asc');expect(page.locator('.catalog-table tbody tr').first).to_contain_text('精选商品 01')
   page.get_by_label('搜索商品',exact=True).fill('精选商品 03');expect(page.locator('.catalog-table tbody tr')).to_have_count(1)
   with page.expect_download() as download:page.get_by_role('button',name='导出商品',exact=True).click()
   content=Path(download.value.path()).read_text(encoding='utf-8-sig');assert '精选商品 03' in content and 'MYR' in content and '精选商品 04' not in content
   page.on('dialog',lambda d:d.accept())
   page.get_by_label('选择本页商品').check();page.get_by_role('button',name='批量下架',exact=True).click()
   expect(page.locator('.catalog-table tbody')).to_contain_text('未发布')
   product=next(p for p in call('dashboard')['products'] if p['name']=='精选商品 03');assert product['published']==0 and product['stock']==20
   page.get_by_label('选择本页商品').check();page.get_by_role('button',name='批量上架',exact=True).click();expect(page.locator('.catalog-table tbody')).to_contain_text('已发布')
   page.get_by_role('button',name='编辑商品',exact=True).click();dialog=page.get_by_role('dialog');expect(dialog).to_have_class('modal product-drawer')
   dialog.get_by_label('商品名称',exact=True).fill('精选商品 03 改款');dialog.get_by_role('button',name='保存',exact=True).click();expect(dialog).not_to_be_visible()
   assert next(p for p in call('dashboard')['products'] if p['id']==product['id'])['name']=='精选商品 03 改款'
   fresh=next(p for p in call('dashboard')['products'] if p['id']==product['id'])
   call('products/update',{**fresh,'stock':17})
   page.get_by_label('选择本页商品').check();page.get_by_role('button',name='批量下架',exact=True).click()
   page.get_by_role('alert').filter(has_text='部分商品未更新').wait_for()
   preserved=next(p for p in call('dashboard')['products'] if p['id']==product['id']);assert preserved['stock']==17 and preserved['published']==1
   page.get_by_role('button',name='清除选择',exact=True).click()
   page.get_by_label('搜索商品',exact=True).fill('');page.screenshot(path=str(results/'redesign-merchant-products.png'),full_page=True)
   page.get_by_role('button',name='卡片视图').click();expect(page.locator('.catalog-product')).to_have_count(12)
   page.get_by_role('button',name='顾客管理',exact=True).click();expect(page.locator('.catalog-stats article').first).to_contain_text('2')
   page.get_by_label('搜索顾客').fill('alex');expect(page.locator('tbody tr')).to_have_count(1);page.get_by_role('button',name='查看订单',exact=True).click();expect(page.locator('.customer-order-panel tbody tr')).to_have_count(2)
   assert page.locator('a[href*="/shop/"],a[href*="/platform"]').count()==0
   page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   page.get_by_role('button',name='商品管理',exact=True).click();page.screenshot(path=str(results/'redesign-merchant-mobile.png'),full_page=True);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   shopper=context.new_page();shopper.goto(base+'/shop/kenny-lifestyle');shopper.get_by_label('商品排序').select_option('price_asc')
   expect(shopper.locator('.products-grid .product-card').first).to_contain_text('精选商品 01')
   shopper.get_by_label('仅看有货').check();expect(shopper.locator('.products-grid .product-card').first).to_contain_text('精选商品 02')
   shopper.get_by_label('商品排序').select_option('price_desc');expect(shopper.locator('.products-grid .product-card').first).to_contain_text('精选商品 15')
   shopper.screenshot(path=str(results/'redesign-customer-store.png'),full_page=True)
   shopper.set_viewport_size({'width':390,'height':844});assert shopper.evaluate('document.documentElement.scrollWidth<=innerWidth+1');shopper.screenshot(path=str(results/'redesign-customer-mobile.png'),full_page=True)
   assert shopper.locator('a[href*="/merchant"],a[href*="/platform"]').count()==0
   assert not errors,errors
   browser.close();print('PASS: real catalog search/sort/filter/pagination, safe CSV, bulk publishing, drawer saves, customer contacts, sales charts, shopping filters and mobile portal isolation.')
 finally:server.terminate();server.wait(timeout=5)
