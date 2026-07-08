'use strict';

const crypto=require('crypto');

const SUPABASE_URL=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const SERVICE_ROLE_KEY=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'');
const BUCKET=String(process.env.GUEST_PHOTO_BUCKET||'wedding-guest-photos');
const STORAGE_URL=SUPABASE_URL?`${SUPABASE_URL}/storage/v1`:'';
const MAX_CARD_PHOTOS=Math.max(1,Math.min(50,Number(process.env.GUEST_PHOTO_MAX_PER_CARD||10)));
const MAX_FILES_PER_REQUEST=3;
const MAX_FILE_BYTES=5*1024*1024;
const SIGNED_UPLOAD_TTL_SECONDS=2*60*60;
const SIGNED_VIEW_TTL_SECONDS=60*60;
const REQUEST_TIMEOUT_MS=10_000;

function configured(){return Boolean(SUPABASE_URL&&SERVICE_ROLE_KEY);}
function nowIso(){return new Date().toISOString();}
function securityHeaders(res){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Pragma','no-cache');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
}
function json(res,status,payload){
  securityHeaders(res);
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
function headers(extra){
  return {
    'Accept':'application/json',
    'apikey':SERVICE_ROLE_KEY,
    'Authorization':`Bearer ${SERVICE_ROLE_KEY}`,
    ...(extra||{})
  };
}
async function timedFetch(url,options,timeoutMs=REQUEST_TIMEOUT_MS){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...(options||{}),signal:controller.signal});}
  finally{clearTimeout(timer);}
}
async function readJson(response){
  const text=await response.text();
  if(!text)return null;
  try{return JSON.parse(text);}catch(e){throw new Error(`INVALID_JSON_${response.status}`);}
}
function safeSlug(v){
  const s=String(v||'').trim();
  return /^[A-Za-z0-9가-힣._~-]{1,140}$/.test(s)?s:'';
}
function cleanName(v){return String(v||'').trim().replace(/[<>\u0000-\u001f]/g,'').slice(0,20);}
function safeMime(v){
  const s=String(v||'').toLowerCase();
  return ['image/jpeg','image/png','image/webp'].includes(s)?s:'';
}
function extForMime(mime){return mime==='image/png'?'png':(mime==='image/webp'?'webp':'jpg');}
function sha256(v){return crypto.createHash('sha256').update(String(v||'')).digest('hex');}
function randomSecret(){return crypto.randomBytes(24).toString('hex');}
function hashEquals(a,b){
  const aa=Buffer.from(String(a||''));
  const bb=Buffer.from(String(b||''));
  return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);
}
function featureConfig(card){
  const opts=card&&card.options&&typeof card.options==='object'?card.options:{};
  const raw=opts.guest_photo_share&&typeof opts.guest_photo_share==='object'?opts.guest_photo_share:{};
  const max=Math.max(1,Math.min(MAX_CARD_PHOTOS,Number(raw.max_photos||MAX_CARD_PHOTOS)));
  return {
    enabled:raw.enabled===true,
    maxPhotos:max,
    approvalRequired:raw.approval_required!==false,
    uploadDaysAfter:Math.max(1,Math.min(60,Number(raw.upload_days_after||14)))
  };
}
function uploadWindowOpen(card,cfg,at=new Date()){
  if(!card||!cfg||!cfg.enabled)return false;
  if(!card.wedding_date)return true;
  const d=new Date(`${card.wedding_date}T23:59:59`);
  if(Number.isNaN(d.getTime()))return true;
  d.setDate(d.getDate()+cfg.uploadDaysAfter);
  return at.getTime()<=d.getTime();
}
async function rest(path,options){
  if(!configured())throw new Error('NOT_CONFIGURED');
  const response=await timedFetch(`${SUPABASE_URL}/rest/v1/${path}`,{
    ...(options||{}),
    headers:{...headers(),...((options&&options.headers)||{})}
  });
  const text=await response.text();
  let body=null;
  if(text){try{body=JSON.parse(text);}catch(e){body={raw:text};}}
  if(!response.ok){
    const msg=body&&body.message?body.message:(body&&body.raw?body.raw:'');
    const error=new Error(`REST_${response.status}:${String(msg).slice(0,180)}`);
    error.status=response.status;
    error.code=body&&body.code?String(body.code):'';
    error.details=body&&body.details?String(body.details):'';
    error.hint=body&&body.hint?String(body.hint):'';
    error.responseBody=body;
    throw error;
  }
  return body;
}
async function getCardBySlug(slug){
  const s=safeSlug(slug);if(!s)return null;
  const params=new URLSearchParams({select:'id,slug,wedding_date,options',slug:`eq.${s}`,limit:'1'});
  const rows=await rest(`cards?${params.toString()}`);
  return Array.isArray(rows)?rows[0]||null:null;
}
async function cleanupExpiredUploading(cardId){
  const params=new URLSearchParams({
    select:'id,storage_path',card_id:`eq.${cardId}`,status:'eq.uploading',expires_at:`lt.${nowIso()}`,limit:'50'
  });
  const rows=await rest(`guest_photo_uploads?${params.toString()}`);
  if(!Array.isArray(rows)||!rows.length)return 0;
  const paths=rows.map(r=>r.storage_path).filter(Boolean);
  /* Storage 삭제가 실패한 경우 메타데이터를 먼저 지우지 않는다.
     경로를 잃으면 비공개 버킷에 고아 파일이 남아 운영자가 정리할 수 없기 때문이다. */
  if(paths.length)await removeStorage(paths);
  let removed=0;
  for(const row of rows){await deleteUploadRow(row.id);removed++;}
  return removed;
}
async function countActive(cardId){
  const params=new URLSearchParams({
    select:'id',card_id:`eq.${cardId}`,status:'in.(uploading,pending,approved)',limit:'200'
  });
  const rows=await rest(`guest_photo_uploads?${params.toString()}`);
  return Array.isArray(rows)?rows.length:0;
}
async function countRecentSession(cardId,sessionHash){
  if(!sessionHash)return 0;
  const since=new Date(Date.now()-60*60*1000).toISOString();
  const params=new URLSearchParams({
    select:'id',card_id:`eq.${cardId}`,guest_session_hash:`eq.${sessionHash}`,created_at:`gte.${since}`,limit:'20'
  });
  const rows=await rest(`guest_photo_uploads?${params.toString()}`);
  return Array.isArray(rows)?rows.length:0;
}
async function reserveUploads(card,guestName,sessionHash,items,maxPhotos){
  const data=await rpc('reserve_guest_photo_uploads_v1',{
    p_card_id:card.id,
    p_card_slug:card.slug,
    p_guest_name:guestName||null,
    p_guest_session_hash:sessionHash,
    p_items:items,
    p_max_photos:Math.max(1,Math.min(MAX_CARD_PHOTOS,Number(maxPhotos||MAX_CARD_PHOTOS))),
    p_session_limit:MAX_FILES_PER_REQUEST
  });
  return Array.isArray(data)?data:[];
}
async function insertUpload(row){
  const rows=await rest('guest_photo_uploads',{
    method:'POST',
    headers:{'Content-Type':'application/json','Prefer':'return=representation'},
    body:JSON.stringify(row)
  });
  return Array.isArray(rows)?rows[0]||null:null;
}
async function deleteUploadRow(id){
  const params=new URLSearchParams({id:`eq.${id}`});
  await rest(`guest_photo_uploads?${params.toString()}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
}
async function getUploadById(id){
  const params=new URLSearchParams({select:'*',id:`eq.${id}`,limit:'1'});
  const rows=await rest(`guest_photo_uploads?${params.toString()}`);
  return Array.isArray(rows)?rows[0]||null:null;
}
async function updateUpload(id,patch){
  const params=new URLSearchParams({id:`eq.${id}`});
  const rows=await rest(`guest_photo_uploads?${params.toString()}`,{
    method:'PATCH',
    headers:{'Content-Type':'application/json','Prefer':'return=representation'},
    body:JSON.stringify(patch)
  });
  return Array.isArray(rows)?rows[0]||null:null;
}
async function listUploads(cardId,statuses){
  const params=new URLSearchParams({
    select:'id,card_id,card_slug,guest_name,storage_path,status,mime_type,size_bytes,created_at,completed_at,reviewed_at',
    card_id:`eq.${cardId}`,
    order:'created_at.desc',
    limit:'60'
  });
  if(Array.isArray(statuses)&&statuses.length)params.set('status',`in.(${statuses.join(',')})`);
  const rows=await rest(`guest_photo_uploads?${params.toString()}`);
  return Array.isArray(rows)?rows:[];
}
async function getStorageObjectInfo(path){
  const clean=String(path||'').replace(/^\/+|\/+$/g,'');
  if(!clean)return null;
  const parts=clean.split('/'),name=parts.pop(),prefix=parts.join('/');
  const response=await timedFetch(`${STORAGE_URL}/object/list/${encodeURIComponent(BUCKET)}`,{
    method:'POST',headers:headers({'Content-Type':'application/json'}),
    body:JSON.stringify({prefix,limit:100,offset:0,search:name,sortBy:{column:'name',order:'asc'}})
  });
  const data=await readJson(response);
  if(!response.ok||!Array.isArray(data))throw new Error(`STORAGE_LIST_${response.status}`);
  const item=data.find(x=>x&&(x.name===name||x.name===clean));
  if(!item)return null;
  const meta=item.metadata&&typeof item.metadata==='object'?item.metadata:{};
  const size=Number(meta.size||meta.contentLength||0);
  const mime=safeMime(meta.mimetype||meta.contentType||'');
  return {path:clean,name,size:Number.isFinite(size)?size:0,mime,metadata:meta};
}
async function waitForStorageObject(path,attempts=3){
  for(let i=0;i<attempts;i++){
    const info=await getStorageObjectInfo(path);
    if(info)return info;
    if(i<attempts-1)await new Promise(r=>setTimeout(r,250*(i+1)));
  }
  return null;
}
async function createSignedUpload(path){
  const response=await timedFetch(`${STORAGE_URL}/object/upload/sign/${BUCKET}/${path}`,{
    method:'POST',headers:headers({'Content-Type':'application/json'}),body:'{}'
  });
  const data=await readJson(response);
  if(!response.ok||!data||!data.url)throw new Error(`STORAGE_SIGN_UPLOAD_${response.status}`);
  const full=`${STORAGE_URL}${data.url}`;
  const token=new URL(full).searchParams.get('token');
  if(!token)throw new Error('STORAGE_UPLOAD_TOKEN_MISSING');
  return {signedUrl:full,token,path};
}
async function createSignedViews(paths,expiresIn=SIGNED_VIEW_TTL_SECONDS){
  if(!paths.length)return [];
  const response=await timedFetch(`${STORAGE_URL}/object/sign/${BUCKET}`,{
    method:'POST',headers:headers({'Content-Type':'application/json'}),
    body:JSON.stringify({expiresIn,paths})
  });
  const data=await readJson(response);
  if(!response.ok||!Array.isArray(data))throw new Error(`STORAGE_SIGN_VIEW_${response.status}`);
  return data.map((item,index)=>({
    path:item.path||paths[index]||'',
    signedUrl:item.signedURL?encodeURI(`${STORAGE_URL}${item.signedURL}`):''
  }));
}
async function removeStorage(paths){
  const list=(paths||[]).filter(Boolean);if(!list.length)return;
  const response=await timedFetch(`${STORAGE_URL}/object/${BUCKET}`,{
    method:'DELETE',headers:headers({'Content-Type':'application/json'}),body:JSON.stringify({prefixes:list})
  });
  if(!response.ok)throw new Error(`STORAGE_DELETE_${response.status}`);
}
async function rpc(name,args){
  return rest(`rpc/${name}`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args||{})
  });
}
async function verifyOwner(slug,editCode,manageToken){
  const s=safeSlug(slug);if(!s)return null;
  let data=null;
  if(manageToken){
    data=await rpc('get_card_for_buyer_manage',{p_slug:s,p_manage_token:String(manageToken)});
  }else if(editCode){
    data=await rpc('get_card_for_edit',{p_slug:s,p_edit_code:String(editCode)});
  }else{return null;}
  const row=Array.isArray(data)?data[0]:data;
  if(!row||row.slug!==s||!row.id)return null;
  return {id:row.id,slug:row.slug};
}
function parseBody(req){
  return req&&req.body&&typeof req.body==='object'?req.body:{};
}

module.exports={
  SUPABASE_URL,SERVICE_ROLE_KEY,BUCKET,STORAGE_URL,MAX_CARD_PHOTOS,MAX_FILES_PER_REQUEST,MAX_FILE_BYTES,
  SIGNED_UPLOAD_TTL_SECONDS,SIGNED_VIEW_TTL_SECONDS,REQUEST_TIMEOUT_MS,
  configured,securityHeaders,json,headers,timedFetch,readJson,safeSlug,cleanName,safeMime,extForMime,sha256,randomSecret,hashEquals,
  featureConfig,uploadWindowOpen,rest,getCardBySlug,cleanupExpiredUploading,countActive,countRecentSession,reserveUploads,insertUpload,deleteUploadRow,getUploadById,updateUpload,listUploads,
  getStorageObjectInfo,waitForStorageObject,createSignedUpload,createSignedViews,removeStorage,rpc,verifyOwner,parseBody,nowIso
};
