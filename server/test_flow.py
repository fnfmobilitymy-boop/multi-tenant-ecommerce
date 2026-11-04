"""Integration checks against a fresh, isolated database and server."""
import unittest, urllib.request, urllib.error, http.cookiejar, json, subprocess, tempfile, os, time, pathlib
ROOT = pathlib.Path(__file__).parent
class Flow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.port = 3098
        cls.proc = subprocess.Popen(['python3', str(ROOT/'app.py')], env={**os.environ,'PORT':str(cls.port),'EZSHOP_DB':cls.temp.name+'/test.db'}, stdout=subprocess.DEVNULL)
        cls.base = 'http://127.0.0.1:'+str(cls.port)+'/api/'
        for _ in range(60):
            try:
                urllib.request.urlopen(cls.base+'health', timeout=1)
                break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError('Test server failed to start')
    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate();cls.proc.wait(timeout=5);cls.temp.cleanup()
    def client(self):
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),urllib.request.ProxyHandler({}))
    def call(self,c,path,data=None,expected=200):
        req=urllib.request.Request(self.base+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'} if data is not None else {})
        try:
            res=c.open(req)
        except urllib.error.HTTPError as e:
            res=e
        result=json.load(res)
        self.assertEqual(res.status,expected,result)
        return result
    def test_product_specs_are_persisted_and_snapshotted(self):
        a,guest=self.client(),self.client()
        self.call(a,'register',dict(name='Specs',slug='specs-store',email='specs@example.test',password='Testing-12345'))
        self.call(a,'products',dict(name='Shirt',price=2500,stock=4,emoji='📦',variant='黑色 / M'),201)
        product=self.call(a,'dashboard')['products'][0]
        self.assertEqual(self.call(guest,'store?slug=specs-store')['products'][0]['variant'],'黑色 / M')
        request=dict(slug='specs-store',customer='Buyer',email='buyer@example.test',phone='0123456789',address='KL',checkout_key='specs-checkout-key-1234567890',items=[dict(id=product['id'],quantity=1)])
        order=self.call(guest,'checkout',request,201)
        product=self.call(a,'dashboard')['products'][0]
        self.call(a,'products/update',{**product,'variant':'白色 / L'})
        self.call(guest,'checkout',request)
        result=self.call(guest,'order-result',dict(slug='specs-store',reference=order['reference'],token=order['access_token']))
        self.assertEqual(result['items'][0]['name'],'Shirt · 黑色 / M')
        self.assertEqual(self.call(guest,'store?slug=specs-store')['products'][0]['variant'],'白色 / L')
    def test_full_commerce_and_isolation(self):
        a,b,guest=self.client(),self.client(),self.client()
        self.call(guest,'dashboard',expected=401)
        self.call(a,'register',dict(name='Kedai A',slug='kedai-a',email='a@example.test',password='Testing-12345'))
        self.call(b,'register',dict(name='Kedai B',slug='kedai-b',email='b@example.test',password='Testing-12345'))
        self.call(a,'products',dict(name='Cookie box',price=3990,stock=3,emoji='🍪'),201)
        self.call(b,'products',dict(name='Tea',price=1000,stock=5,emoji='☕'),201)
        self.call(a,'agents',dict(name='Alice',rate=10),201)
        da=self.call(a,'dashboard');db=self.call(b,'dashboard')
        pid=da['products'][0]['id'];foreign=db['products'][0]['id'];code=da['agents'][0]['code']
        self.assertEqual(len(da['products']),1);self.assertEqual(len(db['products']),1)
        store=self.call(guest,'store?slug=kedai-a');self.assertNotIn('merchant_id',store['products'][0]);self.assertNotIn('email',store['store'])
        order=dict(slug='kedai-a',customer='Customer',email='customer@example.test',phone='0123456789',address='Kuala Lumpur',agent=code,items=[dict(id=pid,quantity=2)],total=1)
        self.call(guest,'checkout',{**order,'items':[dict(id=foreign,quantity=1)]},400)
        self.call(guest,'checkout',{**order,'items':[dict(id=pid,quantity=1),dict(id=pid,quantity=1)]},400)
        result=self.call(guest,'checkout',order,201)
        self.assertEqual(result['total'],7980)
        self.call(guest,'checkout',order,400)
        da=self.call(a,'dashboard');oid=da['orders'][0]['id']
        self.assertEqual(da['products'][0]['stock'],1)
        self.assertEqual(da['orders'][0]['commission'],798)
        self.assertEqual(da['agents'][0]['earned'],0)
        self.assertEqual(self.call(b,'dashboard')['orders'],[])
        self.call(b,'orders/paid',dict(id=oid),404)
        self.call(a,'orders/paid',dict(id=oid));self.call(a,'orders/paid',dict(id=oid))
        da=self.call(a,'dashboard');self.assertEqual(da['agents'][0]['earned'],798)
        self.assertEqual(da['agents'][0]['orders_count'],1)
        self.call(a,'logout',{});self.call(a,'dashboard',expected=401)
        self.call(a,'login',dict(email='a@example.test',password='wrongpassword'),401)
        self.call(a,'login',dict(email='a@example.test',password='Testing-12345'))
        self.assertEqual(self.call(a,'dashboard')['merchant']['slug'],'kedai-a')
    def test_order_details_cancellation_and_inventory(self):
        a,b,guest=self.client(),self.client(),self.client()
        self.call(a,'register',dict(name='Cancel A',slug='cancel-a',email='cancel-a@example.test',password='Testing-12345'))
        self.call(b,'register',dict(name='Cancel B',slug='cancel-b',email='cancel-b@example.test',password='Testing-12345'))
        self.call(a,'products',dict(name='Snapshot name',price=1250,stock=3,emoji='📦'),201)
        self.call(a,'agents',dict(name='Agent',rate=20),201)
        data=self.call(a,'dashboard');pid=data['products'][0]['id'];agent=data['agents'][0]['code']
        checkout=dict(slug='cancel-a',customer='Buyer',email='buyer@example.test',phone='0123456789',address='KL',agent=agent,items=[dict(id=pid,quantity=2)])
        self.call(guest,'checkout',checkout,201)
        data=self.call(a,'dashboard');oid=data['orders'][0]['id']
        self.call(guest,'orders/detail?id='+str(oid),expected=401)
        self.call(b,'orders/detail?id='+str(oid),expected=404)
        detail=self.call(a,'orders/detail?id='+str(oid))
        self.assertEqual(detail['items'],[dict(name='Snapshot name',price=1250,quantity=2)])
        self.assertEqual(detail['order']['address'],'KL')
        self.call(b,'orders/cancel',dict(id=oid),404)
        self.assertEqual(self.call(a,'dashboard')['products'][0]['stock'],1)
        # Concurrent repeated cancellation must restore each reserved unit once.
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.call(a,'orders/cancel',dict(id=oid)),range(2)))
        data=self.call(a,'dashboard')
        self.assertEqual(data['products'][0]['stock'],3)
        self.assertEqual(data['orders'][0]['status'],'cancelled')
        self.assertEqual(data['agents'][0]['earned'],0)
        self.call(a,'orders/paid',dict(id=oid),409)
        # Restored inventory is available again, and paid orders cannot be cancelled.
        self.call(guest,'checkout',checkout,201)
        oid2=self.call(a,'dashboard')['orders'][0]['id']
        self.call(a,'orders/paid',dict(id=oid2))
        self.call(a,'orders/cancel',dict(id=oid2),409)
        self.assertEqual(self.call(a,'dashboard')['products'][0]['stock'],1)
    def test_product_edit_settings_and_price_snapshots(self):
        a,b,guest=self.client(),self.client(),self.client()
        self.call(a,'register',dict(name='Edit A',slug='edit-a',email='edit-a@example.test',password='Testing-12345'))
        self.call(b,'register',dict(name='Edit B',slug='edit-b',email='edit-b@example.test',password='Testing-12345'))
        self.call(a,'products',dict(name='Original',price=1000,stock=5,emoji='📦'),201)
        p=self.call(a,'dashboard')['products'][0]
        self.call(b,'products/update',{**p,'name':'Unauthorized'},404)
        order=dict(slug='edit-a',customer='Buyer',email='editbuyer@example.test',phone='0123456789',address='KL',items=[dict(id=p['id'],quantity=2)])
        self.call(guest,'checkout',order,201)
        self.call(a,'products/update',{**p,'price':2000},409)
        fresh=self.call(a,'dashboard')['products'][0]
        self.assertEqual(fresh['stock'],3)
        self.call(a,'products/update',{**fresh,'name':'Updated','price':2000,'stock':4})
        self.call(a,'products/update',{**fresh,'name':'Stale'},409)
        data=self.call(a,'dashboard');oid=data['orders'][0]['id']
        detail=self.call(a,'orders/detail?id='+str(oid))
        self.assertEqual(detail['items'][0]['name'],'Original')
        self.assertEqual(detail['items'][0]['price'],1000)
        self.assertEqual(self.call(guest,'checkout',order,201)['total'],4000)
        self.call(a,'settings',dict(name='New Store',phone='+60123456789',description='Fresh local products'))
        public=self.call(guest,'store?slug=edit-a')['store']
        self.assertEqual(public,dict(name='New Store',slug='edit-a',phone='+60123456789',description='Fresh local products',shipping_fee=0,courier=''))
        self.assertEqual(self.call(b,'dashboard')['merchant']['name'],'Edit B')
        self.call(a,'settings',dict(name='Bad',phone='javascript:alert(1)',description='x'),400)
        self.call(a,'settings',dict(name='New Store',phone='',description=''))
        self.assertEqual(self.call(guest,'store?slug=edit-a')['store']['phone'],'')

    def test_existing_database_migration_is_repeatable(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as tmp:
            path=tmp+'/legacy.db'
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE merchants(id INTEGER PRIMARY KEY,name TEXT,slug TEXT UNIQUE,email TEXT UNIQUE,password TEXT); CREATE TABLE products(id INTEGER PRIMARY KEY,merchant_id INTEGER,name TEXT,price INTEGER,stock INTEGER,emoji TEXT); INSERT INTO merchants VALUES(1,'Legacy','legacy','legacy@example.test','hash'); INSERT INTO products VALUES(1,1,'Legacy product',1000,7,'box');")
            result=subprocess.run(['python3','-c','import app; app.init(); app.init()'],cwd=ROOT,env={**os.environ,'EZSHOP_DB':path},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT name,stock,version FROM products').fetchone(),('Legacy product',7,0))
                self.assertEqual(db.execute('SELECT name,phone,description FROM merchants').fetchone(),('Legacy','',''))

    def test_storefront_idempotency_and_private_result(self):
        a,b,guest=self.client(),self.client(),self.client()
        self.call(a,'register',dict(name='Customer Store',slug='customer-store',email='store@example.test',password='Testing-12345'))
        self.call(b,'register',dict(name='Other Store',slug='other-store',email='other@example.test',password='Testing-12345'))
        self.call(a,'products',dict(name='Hidden',price=3000,stock=5,emoji='box',published=0),201)
        self.call(a,'products',dict(name='Visible',price=1500,stock=5,emoji='box',published=1,category='Gift',description='Real product'),201)
        data=self.call(a,'dashboard');p=data['products'][0];hidden=data['products'][1]
        public=self.call(guest,'store?slug=customer-store')
        self.assertEqual(len(public['products']),1)
        self.assertEqual(public['products'][0]['description'],'Real product')
        checkout=dict(slug='customer-store',customer='Buyer',email='private@example.test',phone='0123456789',address='KL',items=[dict(id=p['id'],quantity=2)],checkout_key='stable-request-key-123456',total=1,note='Deliver carefully')
        self.call(guest,'checkout',{**checkout,'items':[dict(id=hidden['id'],quantity=1)]},400)
        first=self.call(guest,'checkout',checkout,201)
        second=self.call(guest,'checkout',checkout)
        self.assertEqual(first['reference'],second['reference'])
        self.assertEqual(first['access_token'],second['access_token'])
        self.assertEqual(first['total'],3000)
        data=self.call(a,'dashboard')
        self.assertEqual(data['products'][0]['stock'],3)
        self.assertEqual(len(data['orders']),1)
        self.assertNotIn('access_token',data['orders'][0])
        self.call(guest,'order-result',dict(slug='customer-store',reference=first['reference'],token='wrong-token'),404)
        self.call(guest,'order-result',dict(slug='other-store',reference=first['reference'],token=first['access_token']),404)
        result=self.call(guest,'order-result',dict(slug='customer-store',reference=first['reference'],token=first['access_token']))
        self.assertEqual(result['order']['status'],'pending')
        self.assertNotIn('email',result['order'])
        self.assertEqual(result['items'][0]['quantity'],2)
        self.call(guest,'checkout',{**checkout,'checkout_key':'new-request-key-123456789','payment_method':'fpx'},400)
    def test_team_agent_permissions_and_revoke(self):
        owner,staff,agent,guest=self.client(),self.client(),self.client(),self.client()
        self.call(owner,'register',dict(name='Team Store',slug='team-store',email='teamowner@example.test',password='Testing-12345'))
        self.call(owner,'products',dict(name='Team Product',price=1000,stock=10,emoji='box'),201)
        invite=self.call(owner,'team/invite',dict(name='Inventory',email='inventory@example.test',role='inventory'),201)
        self.call(guest,'join',dict(token=invite['invite_token'],email='wrong@example.test',password='Testing-12345'),400)
        self.call(guest,'join',dict(token=invite['invite_token'],email='inventory@example.test',password='Testing-12345'))
        self.call(guest,'join',dict(token=invite['invite_token'],email='inventory@example.test',password='Testing-12345'),400)
        self.call(staff,'login',dict(email='inventory@example.test',password='Testing-12345'))
        d=self.call(staff,'dashboard');self.assertEqual(d['merchant']['role'],'inventory');self.assertEqual(d['orders'],[])
        self.call(staff,'settings',dict(name='Not allowed'),403)
        self.call(staff,'orders/detail?id=1',expected=403)
        self.call(staff,'team',expected=403)
        self.call(staff,'platform',expected=403)
        self.call(staff,'products',dict(name='Staff Item',price=2000,stock=5,emoji='box'),201)
        invite=self.call(owner,'team/invite',dict(name='Affiliate',email='affiliate@example.test',role='agent',rate=10),201)
        self.call(guest,'join',dict(token=invite['invite_token'],email='affiliate@example.test',password='Testing-12345'))
        self.call(agent,'login',dict(email='affiliate@example.test',password='Testing-12345'))
        d=self.call(agent,'dashboard');self.assertEqual(d['merchant']['role'],'agent');self.assertEqual(d['products'],[])
        code=d['agents'][0]['code'];product=self.call(owner,'dashboard')['products'][0]
        self.call(guest,'checkout',dict(slug='team-store',customer='Private Buyer',email='privatebuyer@example.test',phone='0123456789',address='Private address',agent=code,items=[dict(id=product['id'],quantity=1)]),201)
        d=self.call(agent,'dashboard');self.assertEqual(len(d['orders']),1);self.assertNotIn('email',d['orders'][0]);self.assertNotIn('address',d['orders'][0])
        self.call(agent,'products',dict(name='Not allowed',price=1000,stock=1,emoji='box'),403)
        members=self.call(owner,'team')['members'];sid=next(m['id'] for m in members if m['role']=='inventory')
        self.call(owner,'team/revoke',dict(id=sid))
        self.call(staff,'dashboard',expected=401)
        self.assertTrue(self.call(owner,'team')['logs'])

    def test_platform_admin_is_not_self_assignable(self):
        owner,admin,guest=self.client(),self.client(),self.client()
        self.call(owner,'register',dict(name='Managed Store',slug='managed-store',email='managed@example.test',password='Testing-12345',is_admin=1))
        d=self.call(owner,'dashboard');self.assertEqual(d['merchant']['is_admin'],0)
        self.call(owner,'platform',expected=403)
        self.call(admin,'register',dict(name='Admin',slug='admin-store',email='admin@example.test',password='Testing-12345'))
        # Only trusted local tooling may bootstrap an admin, never a public endpoint.
        import sqlite3
        with sqlite3.connect(self.temp.name+'/test.db') as db:db.execute("UPDATE merchants SET is_admin=1 WHERE email='admin@example.test'")
        all_stores=self.call(admin,'platform')['merchants'];target=next(m for m in all_stores if m['slug']=='managed-store')
        self.call(admin,'platform/update',dict(id=target['id'],plan='pro',status='suspended'))
        self.call(owner,'dashboard',expected=403)
        self.call(guest,'store?slug=managed-store',expected=404)
        self.call(admin,'platform/update',dict(id=target['id'],plan='pro',status='active'))
        self.assertEqual(self.call(owner,'dashboard')['merchant']['plan'],'pro')
    def test_notification_queue_does_not_claim_delivery_before_provider_acceptance(self):
        c,guest=self.client(),self.client()
        self.call(c,'register',dict(name='Mail Store',slug='mail-store',email='mailowner@example.test',password='Testing-12345'))
        self.call(c,'settings',dict(name='Mail Store',shipping_fee=500))
        self.call(c,'products',dict(name='Receipt Product',price=1500,stock=5,emoji='box'),201)
        p=self.call(c,'dashboard')['products'][0]
        checkout=dict(slug='mail-store',customer='Buyer',email='mailbuyer@example.test',phone='0123456789',address='KL',city='Kuala Lumpur',state='Kuala Lumpur',postcode='50000',items=[dict(id=p['id'],quantity=1)])
        self.call(guest,'checkout',checkout,201)
        oid=self.call(c,'dashboard')['orders'][0]['id']
        self.call(c,'orders/paid',dict(id=oid));self.call(c,'orders/paid',dict(id=oid))
        jobs=self.call(c,'notifications')['jobs'];self.assertEqual(len(jobs),1);self.assertEqual(jobs[0]['status'],'queued')
        import app,notifications,io
        from unittest.mock import patch
        with patch.object(app,'DB',pathlib.Path(self.temp.name+'/test.db')):
            # Provider is simulated locally: no real messages leave this test.
            with patch.dict(os.environ,{'RESEND_API_KEY':'test-only-key','MAIL_FROM':'test@example.test'}),patch('notifications.urllib.request.urlopen',side_effect=lambda *args,**kwargs:io.BytesIO(b'{"id":"provider-test-id"}')) as provider:
                notifications.dispatch(limit=100)
                self.assertGreaterEqual(provider.call_count,1)
                html=[json.loads(call.args[0].data)['html'] for call in provider.call_args_list]
                self.assertTrue(any('邮费 RM 5.00' in body and '总额 RM 20.00' in body for body in html))
            job=self.call(c,'notifications')['jobs'][0];self.assertEqual(job['status'],'sent');self.assertEqual(job['provider_id'],'provider-test-id')
            with patch.dict(os.environ,{'RESEND_API_KEY':'test-only-key','MAIL_FROM':'test@example.test'}),patch('notifications.urllib.request.urlopen') as provider:
                notifications.dispatch(limit=1);self.assertEqual(provider.call_count,0)
    def test_payout_reservation_refund_clawback_and_tenant_isolation(self):
        owner,agent,other,guest=self.client(),self.client(),self.client(),self.client()
        self.call(owner,'register',dict(name='Finance Store',slug='finance-store',email='financeowner@example.test',password='Testing-12345'))
        self.call(other,'register',dict(name='Finance Other',slug='finance-other',email='financeother@example.test',password='Testing-12345'))
        invite=self.call(owner,'team/invite',dict(name='Finance Agent',email='financeagent@example.test',role='agent',rate=50),201)
        self.call(guest,'join',dict(token=invite['invite_token'],email='financeagent@example.test',password='Testing-12345'))
        self.call(agent,'login',dict(email='financeagent@example.test',password='Testing-12345'))
        code=self.call(agent,'dashboard')['agents'][0]['code']
        self.call(owner,'products',dict(name='Finance Product',price=10000,stock=10,emoji='box'),201)
        pid=self.call(owner,'dashboard')['products'][0]['id']
        checkout=dict(slug='finance-store',customer='Buyer',email='financebuyer@example.test',phone='0123456789',address='KL',agent=code,items=[dict(id=pid,quantity=1)])
        self.call(guest,'checkout',checkout,201)
        oid=self.call(owner,'dashboard')['orders'][0]['id']
        self.call(owner,'orders/paid',dict(id=oid))
        from concurrent.futures import ThreadPoolExecutor
        def concurrent_request(i):
            payload=dict(amount=4000,bank_details='Concurrent test beneficiary',request_key='concurrent-payout-key-12345-'+str(i))
            request=urllib.request.Request(self.base+'payouts/request',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
            try:response=agent.open(request)
            except urllib.error.HTTPError as error:response=error
            return response.status,json.load(response)
        with ThreadPoolExecutor(max_workers=2) as pool:outcomes=list(pool.map(concurrent_request,range(2)))
        self.assertEqual(sorted(code for code,body in outcomes),[201,409])
        successful=next(body['id'] for code,body in outcomes if code==201)
        self.call(owner,'payouts/update',dict(id=successful,status='rejected',reference='Concurrency test completed'))
        req=dict(amount=3000,bank_details='Test Bank / Test beneficiary',request_key='payout-request-key-123456')
        payout=self.call(agent,'payouts/request',req,201)
        self.assertEqual(self.call(agent,'payouts/request',req)['id'],payout['id'])
        self.call(agent,'payouts/request',{**req,'amount':3001},409)
        self.call(agent,'payouts/request',{**req,'amount':2500,'request_key':'payout-second-key-1234567'},409)
        reserved=self.call(agent,'payouts/request',{**req,'amount':2000,'request_key':'payout-third-key-12345678'},201)
        self.assertEqual(self.call(agent,'payouts')['balances'][0]['available'],0)
        self.call(agent,'payouts/update',dict(id=payout['id'],status='paid',reference='TEST-TRANSFER'),403)
        self.call(other,'payouts/update',dict(id=payout['id'],status='paid',reference='TEST-TRANSFER'),404)
        self.call(owner,'payouts/update',dict(id=payout['id'],status='paid',reference='TEST-TRANSFER'))
        self.call(owner,'payouts/update',dict(id=payout['id'],status='paid',reference='TEST-TRANSFER'))
        self.call(other,'orders/refund',dict(id=oid,reference='TEST-REFUND',restock=True),404)
        self.call(agent,'orders/refund',dict(id=oid,reference='TEST-REFUND',restock=True),403)
        refund=dict(id=oid,reference='TEST-REFUND',restock=True)
        self.call(owner,'orders/refund',refund);self.call(owner,'orders/refund',refund)
        self.call(owner,'orders/refund',{**refund,'reference':'DIFFERENT'},409)
        d=self.call(owner,'dashboard');self.assertEqual(d['products'][0]['stock'],10);self.assertEqual(d['orders'][0]['status'],'refunded')
        ledger=self.call(agent,'payouts');self.assertEqual(ledger['balances'][0],dict(agent_id=d['agents'][0]['id'],name='Finance Agent',earned=0,paid=3000,reserved=0,available=-3000))
        self.assertEqual(next(p for p in ledger['payouts'] if p['id']==reserved['id'])['status'],'rejected')
        self.call(agent,'payouts/request',{**req,'amount':1,'request_key':'payout-after-refund-12345'},409)
        self.call(owner,'payouts/update',dict(id=reserved['id'],status='paid',reference='TEST-LATE'),409)
        self.call(owner,'orders/paid',dict(id=oid),409)
        self.assertEqual(self.call(other,'payouts')['payouts'],[])
    def test_image_upload_and_public_store_display(self):
        owner,guest=self.client(),self.client()
        self.call(owner,'register',dict(name='Image Store',slug='image-store',email='imageowner@example.test',password='Testing-12345'))
        png=(ROOT.parent/'tests/fixtures/shop-image.png').read_bytes()
        def upload(client,body,mime,length=None):
            headers={'Content-Type':mime}
            if length:headers['Content-Length']=str(length)
            request=urllib.request.Request(self.base+'media',data=body,headers=headers)
            try:response=client.open(request)
            except urllib.error.HTTPError as error:response=error
            return response.status,json.load(response)
        self.assertEqual(upload(guest,png,'image/png')[0],401)
        self.assertEqual(upload(owner,b'<svg/>','image/svg+xml')[0],415)
        self.assertEqual(upload(owner,b'not a PNG','image/png')[0],415)
        self.assertEqual(upload(owner,b'x','image/png',5*1024*1024+1)[0],413)
        code,media=upload(owner,png,'image/png');self.assertEqual(code,201)
        self.assertRegex(media['url'],r'^/media/[0-9]+/[a-f0-9]{40}\.png$')
        self.call(owner,'settings',dict(name='Image Store',description='',phone='',logo=media['url'],banner=media['url']))
        self.call(owner,'products',dict(name='Photo product',price=1000,stock=1,emoji='box',image=media['url']),201)
        store=self.call(guest,'store?slug=image-store');self.assertEqual(store['store']['logo'],media['url']);self.assertEqual(store['products'][0]['image'],media['url'])
        with guest.open(self.base.removesuffix('/api/')+media['url']) as response:
            self.assertEqual(response.headers['Content-Type'],'image/png');self.assertEqual(response.read(),png)
        code,second=upload(owner,png,'image/png');self.assertEqual(code,201);self.assertNotEqual(second['url'],media['url'])
        with self.assertRaises(urllib.error.HTTPError) as error:guest.open(self.base.removesuffix('/api/')+'/media/../app.py')
        self.assertEqual(error.exception.code,404)
    def test_merchant_shipping_fee_and_manual_dispatch(self):
        owner,other,guest=self.client(),self.client(),self.client()
        self.call(owner,'register',dict(name='Delivery Store',slug='delivery-store',email='deliveryowner@example.test',password='Testing-12345'))
        self.call(other,'register',dict(name='Delivery Other',slug='delivery-other',email='deliveryother@example.test',password='Testing-12345'))
        self.call(owner,'settings',dict(name='Delivery Store',shipping_fee=750,courier='J&T Express'))
        self.call(owner,'products',dict(name='Shipped Item',price=1000,stock=10,emoji='box'),201)
        self.call(owner,'agents',dict(name='Shipping Agent',rate=10),201)
        d=self.call(owner,'dashboard');pid=d['products'][0]['id'];agent=d['agents'][0]['code']
        self.assertEqual(self.call(guest,'store?slug=delivery-store')['store']['shipping_fee'],750)
        items=[dict(id=pid,quantity=2)]
        quote=self.call(guest,'shipping-quote',dict(slug='delivery-store',items=items,shipping=0,total=1));self.assertEqual(quote,dict(subtotal=2000,shipping=750,discount=0,total=2750))
        self.assertEqual(self.call(owner,'dashboard')['orders'],[])
        payload=dict(slug='delivery-store',customer='Buyer',email='deliverybuyer@example.test',phone='0123456789',address='Street 1',city='Kuala Lumpur',state='Kuala Lumpur',postcode='50000',items=items,agent=agent,checkout_key='delivery-request-key-123456',shipping=0,total=1)
        self.call(guest,'checkout',{**payload,'postcode':'123'},400)
        self.call(guest,'checkout',{**payload,'country':'SG'},400)
        result=self.call(guest,'checkout',payload,201);self.assertEqual(result['total'],2750)
        d=self.call(owner,'dashboard');o=d['orders'][0];self.assertEqual(o['subtotal'],2000);self.assertEqual(o['shipping'],750);self.assertEqual(o['commission'],200)
        self.call(owner,'settings',dict(name='Delivery Store',shipping_fee=900,courier='DHL eCommerce'))
        self.assertEqual(self.call(guest,'checkout',payload)['total'],2750)
        self.assertEqual(self.call(owner,'dashboard')['products'][0]['stock'],8)
        shipment=dict(id=o['id'],carrier='J&T Express',tracking='TEST-SHIP-001')
        self.call(owner,'orders/ship',shipment,409);self.call(other,'orders/ship',shipment,404)
        self.call(owner,'orders/paid',dict(id=o['id']))
        self.call(owner,'orders/ship',shipment);self.call(owner,'orders/ship',shipment)
        self.call(owner,'orders/ship',{**shipment,'tracking':'OTHER'},409)
        public=self.call(guest,'order-result',dict(slug='delivery-store',reference=result['reference'],token=result['access_token']))['order']
        self.assertEqual(public['fulfillment_status'],'shipped');self.assertEqual(public['tracking'],'TEST-SHIP-001');self.assertEqual(public['shipping'],750)
        self.call(owner,'settings',dict(name='Delivery Store',shipping_fee=-1),400)
        self.assertEqual(self.call(owner,'dashboard')['merchant']['shipping_fee'],900)
    def test_validation_and_csrf(self):
        c=self.client()
        self.call(c,'register',dict(name='Invalid',slug='../x',email='invalid',password='short'),400)
        req=urllib.request.Request(self.base+'register',data=b'{}',headers={'Content-Type':'application/json','Sec-Fetch-Site':'cross-site'})
        with self.assertRaises(urllib.error.HTTPError) as context:c.open(req)
        self.assertEqual(context.exception.code,403)
if __name__=='__main__':unittest.main(verbosity=2)
