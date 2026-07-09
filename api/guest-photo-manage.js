'use strict';

const C=require('./guest-photo-common.js');

async function signedRows(rows){
  const viewable=rows.filter(r=>r.status!=='rejected'&&r.storage_path);
  const signed=await C.createSignedViews(viewable.map(r=>r.storage_path),15*60);
  const byPath=new Map(signed.map(x=>[x.path,x.signedUrl]));
  return rows.map(r=>({
    id:r.id,guestName:r.guest_name||'',status:r.status,createdAt:r.created_at,reviewedAt:r.reviewed_at||'',
    sizeBytes:Number(r.size_bytes||0),mimeType:r.mime_type||'',url:byPath.get(r.storage_path)||''
  }));
}
async function authenticate(body){
  return C.verifyOwner(body.slug,body.editCode,body.manageToken);
}
async function list(owner,res){
  await C.cleanupRejected(owner.id).catch(error=>console.warn('guest-photo rejected cleanup skipped',error&&error.message));
  const rows=await C.listUploads(owner.id,['pending','approved']);
  return C.json(res,200,{ok:true,items:await signedRows(rows)});
}
async function mutate(owner,body,res){
  const id=String(body.id||'');
  if(!/^[0-9a-f-]{36}$/i.test(id))return C.json(res,400,{ok:false,error:'사진 정보를 확인해 주세요.'});
  const row=await C.getUploadById(id);
  if(!row||row.card_id!==owner.id)return C.json(res,404,{ok:false,error:'사진을 찾을 수 없습니다.'});
  const action=String(body.action||'');
  if(action==='approve'){
    if(!['pending','approved'].includes(row.status))return C.json(res,409,{ok:false,error:'승인할 수 없는 사진입니다.'});
    const info=await C.waitForStorageObject(row.storage_path,2);
    if(!info)return C.json(res,409,{ok:false,error:'사진 파일을 확인할 수 없어 승인하지 못했습니다.'});
    await C.updateUpload(id,{status:'approved',reviewed_at:C.nowIso(),upload_secret_hash:null,expires_at:null,purge_after:null});
    return C.json(res,200,{ok:true,status:'approved'});
  }
  if(action==='reject'||action==='delete'){
    /* 먼저 공개 대상에서 숨긴 뒤 Storage와 행을 제거한다.
       Storage 장애가 생겨도 승인 사진이 계속 노출되지 않으며, 다음 API 호출에서 cleanupRejected가 재시도한다. */
    const purgeNow=new Date(Date.now()-1000).toISOString();
    await C.updateUpload(id,{status:'rejected',reviewed_at:C.nowIso(),purge_after:purgeNow,upload_secret_hash:null,expires_at:null});
    let cleanupPending=false;
    try{
      if(row.storage_path)await C.removeStorage([row.storage_path]);
      await C.deleteUploadRow(id);
    }catch(error){
      cleanupPending=true;
      console.warn('guest-photo purge deferred',id,error&&error.message);
    }
    return C.json(res,200,{ok:true,status:action==='delete'?'deleted':'rejected',cleanupPending});
  }
  return C.json(res,400,{ok:false,error:'지원하지 않는 관리 요청입니다.'});
}

async function handler(req,res){
  C.securityHeaders(res);
  if(String(req.method||'').toUpperCase()!=='POST'){
    res.setHeader('Allow','POST');return C.json(res,405,{ok:false,error:'허용되지 않은 요청입니다.'});
  }
  if(!C.configured())return C.json(res,503,{ok:false,error:'사진 공유 서버 설정이 필요합니다.'});
  try{
    const body=C.parseBody(req),owner=await authenticate(body);
    if(!owner)return C.json(res,401,{ok:false,error:'청첩장 수정 권한을 다시 확인해 주세요.'});
    if(String(body.action||'')==='list')return await list(owner,res);
    return await mutate(owner,body,res);
  }catch(error){
    console.error('guest-photo-manage error',error);
    return C.json(res,502,{ok:false,error:'사진 관리 정보를 불러오지 못했습니다.'});
  }
}

module.exports=handler;
module.exports._test={signedRows,mutate};
