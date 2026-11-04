"""本地多语言内容、浏览器默认语言、人工优先和交易快照验证。"""
import os,json,time,tempfile,subprocess,sqlite3
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
catalog=json.loads((root/'src/locales/messages.json').read_text());languages=['zh','en','ms','th','km','vi']
def t(key,language):return key if language=='zh' else catalog[key][languages.index(language)-1]
with tempfile.TemporaryDirectory() as directory:
    database=directory+'/content.db';base='http://127.0.0.1:3107'
    server=subprocess.Popen(['python3',str(root/'server/app.py')],env={**os.environ,'PORT':'3107','EZSHOP_DB':database,'EZSHOP_DIST':str(root/'local-test-dist')},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        with sync_playwright() as p:
            options={'headless':True,'args':['--no-sandbox']}
            if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
            browser=p.chromium.launch(**options);errors=[]
            def context(locale):
                value=browser.new_context(locale=locale)
                value.route('**/*',lambda route:route.continue_() if urlparse(route.request.url).hostname=='127.0.0.1' else route.abort())
                return value
            merchant=context('vi-VN');page=merchant.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            for attempt in range(80):
                try:page.goto(base);break
                except Exception:time.sleep(.05)
            else:raise RuntimeError('Server failed')
            assert page.locator('.language-selector select').input_value()=='vi','Merchant browser default was ignored'
            page.locator('.language-selector select').select_option('en')
            page.get_by_role('button',name='Sign up free',exact=True).click()
            for label,value in [('Store name','Original Store'),('Store URL slug','content-store'),('Email address','content@example.test'),('Password','Testing-only-12345')]:page.get_by_label(label,exact=True).fill(value)
            page.get_by_role('button',name='Create store',exact=True).click()
            page.get_by_role('button',name='Products',exact=True).click()
            page.get_by_role('button',name='Add product',exact=True).click();dialog=page.get_by_role('dialog')
            dialog.get_by_label('Product name',exact=True).fill('原文商品')
            dialog.get_by_label('Price (MYR)',exact=True).fill('25.00')
            dialog.get_by_label('Available stock',exact=True).fill('10')
            dialog.get_by_label('Product description',exact=True).fill('原始描述')
            dialog.get_by_label('Category',exact=True).fill('Clothes')
            translated={
                'zh':('中文衬衫','中文介绍'), 'en':('English Shirt','English description'),
                'ms':('Baju Melayu','Penerangan Melayu'), 'th':('เสื้อไทย','รายละเอียดสินค้าไทย'),
                'km':('អាវខ្មែរ','ការពិពណ៌នាខ្មែរ'), 'vi':('Áo Việt','Mô tả tiếng Việt')}
            for language,(name,description) in translated.items():
                dialog.get_by_label('Content language',exact=True).select_option(language)
                native={'zh':'中文','en':'English','ms':'Bahasa Melayu','th':'ไทย','km':'ខ្មែរ','vi':'Tiếng Việt'}[language]
                dialog.get_by_label(native+' · Product name',exact=True).fill(name)
                dialog.get_by_label(native+' · Product description',exact=True).fill(description)
            dialog.get_by_role('button',name='Generate missing translations',exact=True).click()
            dialog.get_by_role('alert').filter(has_text='Automatic translation is not configured').wait_for()
            assert dialog.get_by_label('Tiếng Việt · Product name',exact=True).input_value()=='Áo Việt'
            # Isolated mock verifies draft merge; it does not call Google or save a real translation.
            page.route('**/api/content-translate',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps({'translations':{code:{'name':'Should not overwrite','description':'Should not overwrite','category':'Category '+code} for code in languages}})))
            dialog.get_by_role('button',name='Generate missing translations',exact=True).click()
            dialog.get_by_role('status').filter(has_text='Translation drafts generated').wait_for()
            assert dialog.get_by_label('Tiếng Việt · Product name',exact=True).input_value()=='Áo Việt'
            assert dialog.get_by_label('Tiếng Việt · Category',exact=True).input_value()=='Category vi'

            dialog.get_by_role('button',name='Save',exact=True).click();dialog.wait_for(state='hidden')
            page.reload();assert page.locator('.language-selector select').input_value()=='en','Manual preference was overwritten by browser default'
            customer_context=context('th-TH');customer=customer_context.new_page();customer.on('pageerror',lambda e:errors.append(str(e)))
            customer.goto(base+'/shop/content-store');choice=customer.locator('.language-selector select')
            assert choice.input_value()=='th'
            for language,(name,description) in translated.items():
                choice.select_option(language);customer.get_by_role('heading',name=name,exact=True).wait_for()
                customer.get_by_role('link').filter(has=customer.get_by_role('heading',name=name,exact=True)).click()
                customer.get_by_text(description,exact=True).wait_for()
                customer.get_by_role('button',name=t('加入购物车',language),exact=True).wait_for()
                customer.goto(base+'/shop/content-store')
            choice.select_option('vi');customer.get_by_role('link').filter(has=customer.get_by_role('heading',name='Áo Việt',exact=True)).click()
            customer.get_by_role('button',name=t('加入购物车','vi'),exact=True).click()
            customer.get_by_role('link',name=t('购物车','vi'),exact=True).click();choice.select_option('en')
            customer.get_by_role('heading',name='English Shirt',exact=True).wait_for()
            customer.get_by_role('link',name='Checkout',exact=True).click()
            for label,value in [('Name','สมชาย'),('Email','buyer@example.test'),('Mobile number','0123456789'),('Shipping address','Địa chỉ gốc 123'),('City','Johor Bahru'),('Postcode','80000')]:customer.get_by_label(label,exact=True).fill(value)
            customer.get_by_label('State',exact=True).select_option('Johor');choice.select_option('vi')
            customer.get_by_role('button',name=t('确认提交订单','vi'),exact=False).click()
            customer.get_by_role('heading',name=t('订单已创建','vi'),exact=True).wait_for()
            customer.get_by_text('Áo Việt × 1',exact=False).wait_for()
            with sqlite3.connect(database) as db:
                order=db.execute('select customer,address,locale,total from orders').fetchone();assert order==('สมชาย','Địa chỉ gốc 123','vi',2500),order
                db.execute("update products set content_translations='{}'")
            choice.select_option('en');customer.get_by_text('English Shirt × 1',exact=False).wait_for()
            customer.reload();customer.get_by_text('English Shirt × 1',exact=False).wait_for()
            assert not errors,errors
            browser.close();print('PASS: 商家/顾客浏览器语言默认、手选优先、六语商品名称介绍、购物车跨语言、自动翻译未配置提示、订单语言快照及个人资料原文。')
    finally:
        server.terminate();server.wait(timeout=5)
