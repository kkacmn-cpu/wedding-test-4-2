'use strict';

const crypto=require('crypto');
const C=require('./guest-photo-common.js');

function clientSessionHash(v){
  const s=String(v||'').trim();
  return /^[A-Za-z0-9_-]{16,100}$/.test(s)?C.sha256(s):'';
}
function validStartedAt(v){
  const n=Number(v||0),now=Date.now();
  return Number.isFinite(n)&&n>0&&now-n>=1200&&now-n<60*60*1000;
}
function validFileMeta(item){
  if(!item||typeof item!=='object')return null;
  const mime=C.safeMime(item.mime),size=Number(item.size||0);
  if(!mime||!Number.isFinite(size)||size<1||size>C.MAX_FILE_BYTES)return null;
  return {mime,size};
}
async function listApproved(slug,res){
  const card=await C.getCardBySlug(slug);
  const cfg=C.featureConfig(card);
  if(!card||!cfg.enabled)return C.json(res,200,{ok:true,enabled:false,items:[]});
  await C.cleanupRejected(card.id).catch(error=>console.warn('guest-photo rejected cleanup skipped',error&&error.message));
  const rows=await C.listUploads(card.id,['approved']);
  const signed=await C.createSignedViews(rows.map(r=>r.storage_path));
  const byPath=new Map(signed.map(x=>[x.path,x.signedUrl]));
  return C.json(res,200,{ok:true,enabled:true,uploadOpen:C.uploadWindowOpen(card,cfg),maxPhotos:cfg.maxPhotos,items:rows.map(r=>({
    id:r.id,url:byPath.get(r.storage_path)||'',createdAt:r.created_at
  })).filter(x=>x.url)});
}
async function prepare(body,res){
  if(body.website)return C.json(res,400,{ok:false,error:'요청을 처리하지 못했습니다.'});
  if(!validStartedAt(body.startedAt))return C.json(res,429,{ok:false,error:'잠시 후 다시 시도해 주세요.'});
  const slug=C.safeSlug(body.slug),sessionHash=clientSessionHash(body.sessionId);
  const files=Array.isArray(body.files)?body.files.map(validFileMeta):[];
  if(!slug||!sessionHash||!files.length||files.some(x=>!x)||files.length>C.MAX_FILES_PER_REQUEST){
    return C.json(res,400,{ok:false,error:'사진 정보를 확인해 주세요.'});
  }
  const card=await C.getCardBySlug(slug),cfg=C.featureConfig(card);
  if(!card||!cfg.enabled)return C.json(res,404,{ok:false,error:'사진 공유 기능을 사용할 수 없습니다.'});
  if(!C.uploadWindowOpen(card,cfg))return C.json(res,403,{ok:false,error:'사진을 받을 수 있는 기간이 종료되었습니다.'});

  /* 만료 예약 정리는 보조 작업이다. 삭제 장애가 새 업로드 전체를 막지 않도록 실패를 기록만 한다.
     실제 수량 판정 RPC는 만료된 uploading 행을 제외하고 계산한다. */
  await C.cleanupExpiredUploading(card.id).catch(error=>console.warn('guest-photo cleanup skipped',error&&error.message));
  await C.cleanupRejected(card.id).catch(error=>console.warn('guest-photo rejected cleanup skipped',error&&error.message));

  const guestName=C.cleanName(body.guestName);
  const descriptors=files.map(meta=>{
    const id=crypto.randomUUID(),secret=C.randomSecret(),ext=C.extForMime(meta.mime);
    return {
      id,secret,mime:meta.mime,size:meta.size,path:`${card.id}/${id}.${ext}`,
      expiresAt:new Date(Date.now()+C.SIGNED_UPLOAD_TTL_SECONDS*1000).toISOString()
    };
  });
  const reservationItems=descriptors.map(x=>({
    id:x.id,storage_path:x.path,mime_type:x.mime,size_bytes:x.size,
    upload_secret_hash:C.sha256(x.secret),expires_at:x.expiresAt
  }));
  try{
    await C.reserveUploads(card,guestName,sessionHash,reservationItems,cfg.maxPhotos);
  }catch(error){
    const msg=String(error&&error.message||'');
    if(msg.includes('CARD_LIMIT'))return C.json(res,409,{ok:false,error:`이 청첩장은 하객 사진을 최대 ${cfg.maxPhotos}장까지 받을 수 있습니다.`});
    if(msg.includes('SESSION_LIMIT'))return C.json(res,429,{ok:false,error:'한 번에 올릴 수 있는 사진 수를 초과했습니다. 잠시 후 다시 시도해 주세요.'});
    throw error;
  }

  try{
    const signed=await Promise.all(descriptors.map(x=>C.createSignedUpload(x.path)));
    return C.json(res,200,{ok:true,bucket:C.BUCKET,items:descriptors.map((x,i)=>({
      id:x.id,path:x.path,token:signed[i].token,secret:x.secret,mime:x.mime
    }))});
  }catch(error){
    /* 서명 발급이 일부만 성공해도 클라이언트에는 응답하지 않는다.
       예약 행을 전부 되돌려 2시간 동안 업로드 가능 장수를 잠그는 현상을 막는다. */
    await Promise.allSettled(descriptors.map(x=>C.deleteUploadRow(x.id)));
    throw error;
  }
}

async function complete(body,res){
  const id=String(body.id||''),secret=String(body.secret||'');
  if(!/^[0-9a-f-]{36}$/i.test(id)||secret.length<20)return C.json(res,400,{ok:false,error:'업로드 정보를 확인해 주세요.'});
  const row=await C.getUploadById(id);
  if(!row)return C.json(res,404,{ok:false,error:'업로드 요청을 찾을 수 없습니다.'});
  const secretHash=C.sha256(secret);
  /* complete 응답 직후 네트워크가 끊기면 클라이언트는 같은 요청을 다시 보낸다.
     pending/approved 상태를 성공으로 돌려 중복 접수·가짜 실패를 막는다. */
  if(row.status==='pending'||row.status==='approved'||row.status==='hidden'){
    if(row.upload_secret_hash&&!C.hashEquals(row.upload_secret_hash,secretHash))return C.json(res,403,{ok:false,error:'업로드 권한을 확인할 수 없습니다.'});
    return C.json(res,200,{ok:true,status:row.status,alreadyCompleted:true});
  }
  if(row.status!=='uploading')return C.json(res,409,{ok:false,error:'이미 처리된 업로드 요청입니다.'});
  if(!C.hashEquals(row.upload_secret_hash,secretHash))return C.json(res,403,{ok:false,error:'업로드 권한을 확인할 수 없습니다.'});
  if(row.expires_at&&new Date(row.expires_at).getTime()<Date.now())return C.json(res,410,{ok:false,error:'업로드 시간이 만료되었습니다.'});

  /* 클라이언트가 complete만 호출해 빈 예약을 pending으로 바꾸지 못하도록
     실제 비공개 Storage 객체가 생성되었는지 확인한다. */
  const info=await C.waitForStorageObject(row.storage_path,3);
  if(!info)return C.json(res,409,{ok:false,error:'사진 전송을 아직 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'});
  const actualSize=Number(info.size||0),actualMime=info.mime||row.mime_type;
  const invalidSize=!Number.isFinite(actualSize)||actualSize<1||actualSize>C.MAX_FILE_BYTES;
  const invalidMime=!C.safeMime(actualMime);
  const declaredSize=Number(row.size_bytes||0);
  const sizeMismatch=actualSize>0&&declaredSize>0&&actualSize!==declaredSize;
  if(invalidSize||invalidMime||sizeMismatch){
    await C.removeStorage([row.storage_path]).catch(()=>{});
    await C.deleteUploadRow(id).catch(()=>{});
    return C.json(res,400,{ok:false,error:'전송된 사진 파일을 확인할 수 없습니다. 다시 선택해 주세요.'});
  }
  /* 승인 전까지 해시를 유지해 complete 재시도를 안전하게 검증한다.
     승인·거절·삭제 시 관리 API가 해시를 제거한다. */
  await C.updateUpload(id,{status:'pending',completed_at:C.nowIso(),expires_at:null,size_bytes:actualSize,mime_type:actualMime});
  return C.json(res,200,{ok:true,status:'pending'});
}


async function cancel(body,res){
  const id=String(body.id||''),secret=String(body.secret||'');
  if(!/^[0-9a-f-]{36}$/i.test(id)||secret.length<20)return C.json(res,400,{ok:false,error:'업로드 정보를 확인해 주세요.'});
  const row=await C.getUploadById(id);
  if(!row)return C.json(res,200,{ok:true,status:'cancelled'});
  if(row.status==='pending'||row.status==='approved'||row.status==='hidden')return C.json(res,200,{ok:true,status:row.status,alreadyCompleted:true});
  if(row.status==='rejected')return C.json(res,200,{ok:true,status:'cancelled'});
  if(row.status!=='uploading')return C.json(res,409,{ok:false,error:'이미 처리된 업로드 요청입니다.'});
  if(!C.hashEquals(row.upload_secret_hash,C.sha256(secret)))return C.json(res,403,{ok:false,error:'업로드 권한을 확인할 수 없습니다.'});
  try{
    await C.removeStorage([row.storage_path]);
    await C.deleteUploadRow(id);
  }catch(error){
    /* 삭제 장애가 있어도 즉시 만료 처리해 업로드 가능 장수를 잠그지 않는다.
       다음 prepare 시 cleanupExpiredUploading이 Storage와 행을 다시 정리한다. */
    await C.updateUpload(id,{expires_at:new Date(Date.now()-1000).toISOString()}).catch(()=>{});
  }
  return C.json(res,200,{ok:true,status:'cancelled'});
}

async function handler(req,res){
  C.securityHeaders(res);
  if(!C.configured())return C.json(res,503,{ok:false,error:'사진 공유 서버 설정이 필요합니다.'});
  try{
    const method=String(req.method||'GET').toUpperCase();
    if(method==='GET')return listApproved(C.safeSlug(req.query&&req.query.slug),res);
    if(method!=='POST'){res.setHeader('Allow','GET, POST');return C.json(res,405,{ok:false,error:'허용되지 않은 요청입니다.'});}
    const body=C.parseBody(req),action=String(body.action||'');
    if(action==='prepare')return await prepare(body,res);
    if(action==='complete')return await complete(body,res);
    if(action==='cancel')return await cancel(body,res);
    return C.json(res,400,{ok:false,error:'지원하지 않는 요청입니다.'});
  }catch(error){
    console.error('guest-photo error',error);
    return C.json(res,502,{ok:false,error:'사진 공유 서버와 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'});
  }
}

module.exports=handler;
module.exports._test={clientSessionHash,validStartedAt,validFileMeta,prepare,complete,cancel};
