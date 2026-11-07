"""六语真实本地流程；临时数据库，拦截所有远端请求。"""
import os,json,time,tempfile,subprocess,sqlite3
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
catalog=json.loads((root/'src/locales/messages.json').read_text())
languages=['zh','en','ms','th','km','vi']
def text(key,language):return key if language=='zh' else catalog[key][languages.index(language)-1]
with tempfile.TemporaryDirectory() as directory:
    database=directory+'/test.db';base='http://127.0.0.1:3106'
    process=subprocess.Popen(['python3',str(root/'server/app.py')],env={**os.environ,'PORT':'3106','EZSHOP_DB':database,'EZSHOP_DIST':str(root/'local-test-dist')},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        with sync_playwright() as p:
            options={'headless':True,'args':['--no-sandbox']}
            if os.environ.get('EZSHOP_CHROMIUM'):options['executable_path']=os.environ['EZSHOP_CHROMIUM']
            browser=p.chromium.launch(**options);context=browser.new_context(locale='zh-CN',);errors=[]
            context.route('**/*',lambda route:route.continue_() if urlparse(route.request.url).hostname=='127.0.0.1' else route.abort())
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            for attempt in range(80):
                try:page.goto(base);break
                except Exception:time.sleep(.05)
            else:raise RuntimeError('Local server did not start')
            selector=page.locator('.language-selector select')
            selector.select_option('en')
            page.get_by_role('button',name='Sign up free',exact=True).click()
            page.get_by_label('Store name',exact=True).fill('Kenny Demo')
            page.get_by_label('Store URL slug',exact=True).fill('language-store')
            page.get_by_label('Email address',exact=True).fill('language@example.test')
            page.get_by_label('Password',exact=True).fill('Test-only-password-123')
            selector.select_option('th')
            assert page.locator('input[name=name]').input_value()=='Kenny Demo', 'Language switch cleared form'
            page.get_by_role('button',name=text('创建店铺','th'),exact=True).click()
            page.get_by_role('heading',name=text('经营概览','th'),exact=True).wait_for()
            for language in languages:
                selector.select_option(language)
                page.get_by_role('heading',name=text('经营概览',language),exact=True).wait_for()
                page.get_by_role('button',name=text('商品管理',language),exact=True).wait_for()
                assert selector.locator('option').count()==6
                page.reload();page.get_by_role('heading',name=text('经营概览',language),exact=True).wait_for()
                assert selector.input_value()==language
                assert page.locator('html').get_attribute('lang')==language
            response=page.request.post(base+'/api/products',data={'name':'Kenny Shirt','price':2500,'stock':10,'emoji':'📦','category':'全部商品','description':'商家原始商品介绍','variant':'黑色 / M','published':1})
            assert response.status==201,response.text()
            response=page.request.post(base+'/api/settings',data={'name':'Kenny Demo','description':'商家原始店铺介绍','phone':'60123456789','shipping_fee':500,'courier':'J&T Express'})
            assert response.ok,response.text()
            with sqlite3.connect(database) as db:db.execute("update merchants set is_admin=1 where slug='language-store'")
            page.goto(base+'/platform')
            assert selector.locator('option').evaluate_all('(options)=>options.map(o=>o.value)')==['zh','en']
            selector.select_option('en');page.get_by_role('heading',name='Platform admin',exact=True).wait_for()
            assert page.locator('html').get_attribute('lang')=='en'
            page.goto(base+'/merchant');page.get_by_role('button',name=text('商品管理','vi'),exact=True).click()
            assert selector.input_value()=='vi', 'Platform changed merchant preference'
            assert selector.locator('option').count()==6
            page.get_by_role('heading',name=text('商品管理','vi'),exact=True).wait_for()
            page.get_by_role('button',name=text('添加商品','vi'),exact=True).click()
            page.get_by_role('dialog').locator('input[name=name]').fill('Unsaved draft')
            selector.select_option('km')
            assert page.get_by_role('dialog').locator('input[name=name]').input_value()=='Unsaved draft'
            page.get_by_role('button',name=text('关闭','km'),exact=True).click()
            customer=context.new_page();customer.on('pageerror',lambda e:errors.append(str(e)))
            customer.goto(base+'/shop/language-store');choice=customer.locator('.language-selector select')
            assert choice.input_value()=='zh','Customer inherited merchant preference'
            for language in languages:
                choice.select_option(language)
                customer.get_by_role('heading',name='Kenny Demo',exact=True).wait_for()
                customer.get_by_role('link',name=text('购物车',language),exact=True).wait_for()
                customer.get_by_text('商家原始店铺介绍',exact=True).first.wait_for()
                customer.get_by_role('link').filter(has=customer.get_by_role('heading',name='Kenny Shirt',exact=True)).click()
                customer.get_by_role('button',name=text('加入购物车',language),exact=True).wait_for()
                customer.get_by_text('商家原始商品介绍',exact=True).wait_for()
                customer.get_by_text('黑色 / M',exact=False).wait_for()
                if language!='zh':
                    content=customer.locator('.storefront').inner_text().replace('商家原始商品介绍','').replace('黑色 / M','').replace('商家原始店铺介绍','')
                    import re
                    assert not re.search('[\u3400-\u9fff]',content),(language,content)
                customer.reload();assert choice.input_value()==language
                if language in ('th','km'):
                    customer.set_viewport_size({'width':390,'height':844})
                    customer.evaluate('document.fonts.ready')
                    family='Noto Sans Thai' if language=='th' else 'Noto Sans Khmer'
                    assert customer.evaluate("""(family)=>document.fonts.check(`16px "${family}"`)""",family)
                    assert customer.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),language+' mobile overflow'
                    (root/'test-results').mkdir(exist_ok=True)
                    customer.screenshot(path=str(root/'test-results'/('language-'+language+'.png')),full_page=True)
                    customer.set_viewport_size({'width':1280,'height':900})
                customer.goto(base+'/shop/language-store')
            choice.select_option('en')
            customer.get_by_role('link').filter(has=customer.get_by_role('heading',name='Kenny Shirt',exact=True)).click()
            customer.get_by_role('button',name='Add to cart',exact=True).click()
            customer.get_by_role('link',name='Cart',exact=True).click()
            customer.get_by_role('link',name='Checkout',exact=True).click()
            customer.get_by_label('Name',exact=True).fill('Test Buyer')
            customer.get_by_label('Email',exact=True).fill('buyer@example.test')
            customer.get_by_label('Mobile number',exact=True).fill('0123456789')
            customer.get_by_label('Shipping address',exact=True).fill('1 Test Street')
            customer.get_by_label('City',exact=True).fill('Johor Bahru')
            customer.get_by_label('Postcode',exact=True).fill('80000')
            customer.get_by_label('State',exact=True).select_option('Johor')
            choice.select_option('vi')
            assert customer.locator('input[name=customer]').input_value()=='Test Buyer'
            customer.get_by_role('button',name=text('确认提交订单','vi'),exact=False).click()
            customer.get_by_role('heading',name=text('订单已创建','vi'),exact=True).wait_for()
            customer.locator('.badge.pending').filter(has_text=text('待付款','vi')).wait_for()
            customer.reload();customer.get_by_role('heading',name=text('订单已创建','vi'),exact=True).wait_for()
            with sqlite3.connect(database) as db:
                order=db.execute('select total,shipping,status from orders').fetchone();assert order==(3000,500,'pending'),order
                assert db.execute('select stock from products').fetchone()[0]==9
            assert not errors,errors
            browser.close()
            print('PASS: 顾客/商家六语、独立偏好和刷新保存、平台仅中英、表单/商品原文保留、跨语言购物车与真实下单、泰文/高棉文手机布局。')
    finally:
        process.terminate();process.wait(timeout=5)
