import { useEffect, useState } from "react";
import { api, supabase } from "./api";
import { useI18n } from "./i18n";
import { ImageUpload } from "./image-upload";
import { ErrorBox, Loading } from "./ui";
interface Fields { bank_name:string;holder:string;account:string;instructions:string;wallet_name:string;wallet_identifier:string;wallet_qr:string;usdt_network:string;usdt_address:string;payment_link:string; }
interface Settings extends Fields { bank_enabled:boolean;wallet_enabled:boolean;usdt_enabled:boolean;link_enabled:boolean;version:number; }
export interface ReceivingInstructions {
 bank?:{bank_name:string;holder:string;account:string};wallet?:{name:string;identifier:string;qr:string};usdt?:{network:string;address:string};link?:string;instructions?:string;
}
export function safeReceivingLink(value: unknown): string | null {
 try { const url = new URL(String(value)); return url.protocol==='https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function MerchantReceiving() {
 const { t }=useI18n();
 const [config,setConfig]=useState<Settings|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const [uploads,setUploads]=useState<Record<string,boolean>>({});const uploading=Object.values(uploads).some(Boolean);
 useEffect(()=>{if(!supabase){setLoading(false);return;}api<{receiving:Settings}>('receiving').then(x=>setConfig(x.receiving)).catch(()=>setError('商家收款设置暂不可用，请联系平台管理员。')).finally(()=>setLoading(false));},[]);
 async function save(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(!config||uploading)return;const form=new FormData(event.currentTarget);setBusy(true);setError('');setSaved(false);
  try{const result=await api<{receiving:Settings}>('receiving/save',{...config,...Object.fromEntries(form),bank_enabled:config.bank_enabled,wallet_enabled:config.wallet_enabled,usdt_enabled:config.usdt_enabled,link_enabled:config.link_enabled,version:config.version});setConfig(result.receiving);setSaved(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 function field(name:keyof Fields,label:string,max:number,required=true){return <label>{t(label)}<input name={name} required={required} maxLength={max} value={config?.[name]||''} autoComplete="off" onChange={e=>{if(config)setConfig({...config,[name]:e.target.value});setSaved(false);}} /></label>;}
 function toggle(name:'bank_enabled'|'wallet_enabled'|'usdt_enabled'|'link_enabled',label:string){return <label className="row"><input type="checkbox" checked={config?.[name]||false} onChange={e=>{if(config)setConfig({...config,[name]:e.target.checked});setSaved(false);}} />{t(label)}</label>;}
 return <section className="card payment-panel"><h2>{t('商家收款方式与资料')}</h2><p>{t('自行选择银行、电子钱包、USDT或收款链接，顾客下单后按你的资料付款。')}</p>
  {loading?<Loading/>:config?<form onSubmit={save}><fieldset className="receiving-fields" disabled={busy||uploading}>
   {toggle('bank_enabled','银行转账')}{config.bank_enabled&&<div className="soft-note">{field('bank_name','银行名称',120)}{field('holder','收款人姓名',120)}{field('account','银行账号',64)}</div>}
   {toggle('wallet_enabled','电子钱包')}{config.wallet_enabled&&<div className="soft-note">{field('wallet_name','电子钱包名称',60)}{field('wallet_identifier','电子钱包账号（选填）',120,false)}<ImageUpload name="wallet_qr" label={t('电子钱包收款二维码（选填）')} initialValue={config.wallet_qr} onUploading={(id,value)=>setUploads(previous=>({...previous,[id]:value}))}/></div>}
   {toggle('usdt_enabled','USDT收款')}{config.usdt_enabled&&<div className="soft-note"><label>{t('USDT网络')}<select aria-label={t('USDT网络')} name="usdt_network" required value={config.usdt_network} onChange={e=>{setConfig({...config,usdt_network:e.target.value});setSaved(false);}}><option value="">{t('请选择网络')}</option><option>TRC20</option><option>ERC20</option><option>BEP20</option></select></label>{field('usdt_address','USDT收款地址',128)}<small>{t('订单以MYR计价，USDT金额及网络须与顾客确认，不自动换汇。')}</small></div>}
   {toggle('link_enabled','收款链接')}{config.link_enabled&&<div className="soft-note">{field('payment_link','商家收款链接（HTTPS）',2000)}</div>}
   <label>{t('付款说明（选填）')}<textarea name="instructions" rows={3} maxLength={500} value={config.instructions} onChange={e=>{setConfig({...config,instructions:e.target.value});setSaved(false);}}/></label>
   <p className="muted">{t('顾客转账后由你核实到账。此处不会自动查账或扣款。')}</p><button className="button" disabled={busy||uploading}>{t('保存收款资料')}</button>
  </fieldset>{saved&&<p role="status" className="success">{t('收款资料已保存，仅用于之后的新订单。')}</p>}</form>:!supabase?<p className="muted">{t('商家收款设置暂不可用，请联系平台管理员。')}</p>:null}<ErrorBox error={error}/>
 </section>;
}
export function CustomerBankTransfer({info,reference}:{info?:ReceivingInstructions;reference:string}){
 const {t}=useI18n();const [selected,setSelected]=useState('');
 const methods=[info?.bank?'bank':'',info?.wallet?'wallet':'',info?.usdt?'usdt':'',safeReceivingLink(info?.link)?'link':''].filter(Boolean);
 if(!info||!methods.length)return null;
 const active=methods.includes(selected)?selected:methods[0];const labels:Record<string,string>={bank:'银行转账',wallet:'电子钱包',usdt:'USDT收款',link:'收款链接'};const link=safeReceivingLink(info.link);
 return <section className="soft-note" style={{overflowWrap:'anywhere'}}><h2>{t('付款给商家')}</h2><label>{t('选择付款方式')}<select aria-label={t('选择付款方式')} value={active} onChange={e=>setSelected(e.target.value)}>{methods.map(method=><option key={method} value={method}>{t(labels[method])}</option>)}</select></label>
  {active==='bank'&&info.bank&&<><p>{t('银行名称')}: {info.bank.bank_name}</p><p>{t('收款人姓名')}: {info.bank.holder}</p><p>{t('银行账号')}: <strong>{info.bank.account}</strong></p></>}
  {active==='wallet'&&info.wallet&&<><p>{info.wallet.name}</p><p>{info.wallet.identifier}</p>{safeReceivingLink(info.wallet.qr)&&<img src={info.wallet.qr} alt={t('电子钱包收款二维码（选填）')} style={{maxWidth:240,width:'100%'}}/>}</>}
  {active==='usdt'&&info.usdt&&<><p>{t('USDT网络')}: <strong>{info.usdt.network}</strong></p><p style={{overflowWrap:'anywhere'}}>{t('USDT收款地址')}: {info.usdt.address}</p><p>{t('订单以MYR计价，USDT金额及网络须与顾客确认，不自动换汇。')}</p></>}
  {active==='link'&&link&&<><a href={link} target="_blank" rel="noopener noreferrer" className="button secondary">{t('打开商家收款链接')}</a><p>{new URL(link).hostname}</p></>}
  <p>{t('订单编号')}: {reference}</p>{info.instructions&&<p>{info.instructions}</p>}<small>{t('转账前请核对商家、户名和金额，付款后联系商家确认。')}</small>
 </section>;
}
