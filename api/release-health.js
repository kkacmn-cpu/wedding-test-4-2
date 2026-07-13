'use strict';

const C=require('./guest-photo-common.js');
const BUILD='V70_PREMIUM_REDESIGN_20260713';
const RPC_NAMES={
  publishCreateRpc:'create_card_with_purchase',
  editReadRpc:'get_card_for_edit',
  editUpdateRpc:'update_card_by_slug',
  buyerSessionRpc:'issue_buyer_manage_session',
  buyerListRpc:'list_buyer_manage_cards',
  buyerReadRpc:'get_card_for_buyer_manage',
  buyerUpdateRpc:'update_card_by_buyer_manage'
};

function queryValue(req,key){
  if(req&&req.query&&req.query[key]!=null)return String(req.query[key]);
  try{return new URL(req.url||'', 'https://local.invalid').searchParams.get(key)||'';}catch(_){return '';}
}
async function probe(work){
  try{await work();return {ok:true};}
  catch(error){return {ok:false,error:String(error&&error.code||error&&error.message||'CHECK_FAILED').slice(0,120)};}
}
function rpcCheck(paths,name){
  const ok=Boolean(paths&&paths[`/rpc/${name}`]);
  return ok?{ok:true}:{ok:false,error:'RPC_NOT_EXPOSED'};
}
async function getOpenApiPaths(){
  if(!C.configured())throw new Error('NOT_CONFIGURED');
  const response=await C.timedFetch(`${C.SUPABASE_URL}/rest/v1/`,{
    method:'GET',
    headers:C.headers({'Accept':'application/openapi+json'})
  });
  const text=await response.text();
  let body={};
  if(text){try{body=JSON.parse(text);}catch(_){throw new Error('OPENAPI_INVALID_JSON');}}
  if(!response.ok)throw new Error(`OPENAPI_${response.status}`);
  if(!body||typeof body.paths!=='object')throw new Error('OPENAPI_PATHS_MISSING');
  return body.paths;
}
async function handler(req,res){
  const method=String(req&&req.method||'GET').toUpperCase();
  if(method!=='GET'){
    res.setHeader('Allow','GET');
    return C.json(res,405,{ok:false,error:'METHOD_NOT_ALLOWED',build:BUILD});
  }
  const deep=queryValue(req,'deep')==='1';
  const env={
    supabaseUrl:Boolean(process.env.SUPABASE_URL),
    serviceRoleKey:Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    guestPhotoBucket:Boolean(process.env.GUEST_PHOTO_BUCKET||C.BUCKET),
    guestPhotoMaxPerCard:Boolean(process.env.GUEST_PHOTO_MAX_PER_CARD||C.MAX_CARD_PHOTOS)
  };
  const checks={};
  if(deep&&C.configured()){
    checks.cards=await probe(()=>C.rest('cards?select=id&limit=1'));
    checks.guestbookModeration=await probe(()=>C.rest('guestbook_moderation?select=card_id&limit=1'));
    checks.guestPhotoHidden=await probe(()=>C.rest('guest_photo_uploads?select=id,status&status=eq.hidden&limit=1'));
    // RPC는 실제 호출하지 않고 PostgREST OpenAPI 경로에서 존재 여부만 읽습니다.
    try{
      const paths=await getOpenApiPaths();
      for(const [key,name] of Object.entries(RPC_NAMES))checks[key]=rpcCheck(paths,name);
    }catch(error){
      const message=String(error&&error.message||'OPENAPI_CHECK_FAILED').slice(0,120);
      for(const key of Object.keys(RPC_NAMES))checks[key]={ok:false,error:message};
    }
    checks.storageBucket=await probe(async()=>{
      const r=await C.timedFetch(`${C.STORAGE_URL}/bucket/${encodeURIComponent(C.BUCKET)}`,{headers:C.headers()});
      if(!r.ok)throw new Error(`STORAGE_BUCKET_${r.status}`);
    });
  }
  const requiredEnvOk=env.supabaseUrl&&env.serviceRoleKey;
  const deepOk=!deep||(!Object.values(checks).some(v=>!v.ok));
  return C.json(res,(requiredEnvOk&&deepOk)?200:503,{ok:requiredEnvOk&&deepOk,build:BUILD,deep,env,checks,checkedAt:new Date().toISOString()});
}
module.exports=handler;
module.exports._test={BUILD,RPC_NAMES,probe,rpcCheck,getOpenApiPaths};
