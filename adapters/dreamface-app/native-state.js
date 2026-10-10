// Native counters remain separate from the ported web-generation service balance even under the same identity.
import { defineAdapter } from './_webview.js';
import { ORIGIN_ARG, session, siteOrigin } from './_shared.js';
export default defineAdapter({
 description: 'Native App identity/version and native credit counters. Compare with credits and visible UI; the web-generation service can have a separate balance. （原生会话 原生积分）',
 access: 'read', args: [ORIGIN_ARG], result: {kind:'value',description:'Native bridge state'},
 async run({tab,args}) {
  const s=await session(tab,siteOrigin(args));
  const credits=await tab.evaluate(`(async()=>{
   const raw=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Bridge timeout')),5000);window.WebViewJavascriptBridge.callHandler('getCredits',{useServer:true},data=>{clearTimeout(timer);resolve(data);});});
   const value=typeof raw==='string'?JSON.parse(raw):raw;
   if(value?.code!==0) throw new Error('Native credit query failed');
   const data=typeof value.data==='string'?JSON.parse(value.data):value.data;
   const number=v=>v===undefined||v===null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
   return {total:number(data?.credits?.count),video_free_uses_left:number(data?.free_credits?.ai_video_remaining_count),video_free_uses_total:number(data?.free_credits?.ai_video_total_count),expires_time:number(data?.free_credits?.expires_time)};
  })()`);
  return {user_id:s.userId,account_id:s.accountId,app_version:s.appVersion,platform_type:s.platformType,origin:s.origin,native_credits:credits};
 }
});
