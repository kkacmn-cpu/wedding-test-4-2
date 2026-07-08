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
  const rows=await C.listUploads(owner.id,['pending','approved','rejected']);
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
    await C.updateUpload(id,{status:'approved',reviewed_at:C.nowIso()});
    return C.json(res,200,{ok:true,status:'approved'});
  }
  if(action==='reject'){
    /* 파일 삭제가 실패한 상태에서 메타데이터만 거절 처리하면 비공개 버킷에 고아 파일이 남는다. */
    await C.removeStorage([row.storage_path]);
    await C.updateUpload(id,{status:'rejected',reviewed_at:C.nowIso(),purge_after:new Date(Date.now()+30*24*60*60*1000).toISOString()});
    return C.json(res,200,{ok:true,status:'rejected'});
  }
  if(action==='delete'){
    await C.removeStorage([row.storage_path]);
    await C.deleteUploadRow(id);
    return C.json(res,200,{ok:true,status:'deleted'});
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
