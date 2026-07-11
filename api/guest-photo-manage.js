'use strict';

const C=require('./guest-photo-common.js');

function validId(value){
  const id=String(value||'').trim();
  return /^[0-9a-f-]{36}$/i.test(id)?id:'';
}
function validOperation(value){
  const action=String(value||'');
  return ['approve','hide','delete','reject'].includes(action)?action:'';
}
async function signedRows(rows){
  const viewable=rows.filter(r=>r.status!=='rejected'&&r.storage_path);
  const signed=await C.createSignedViews(viewable.map(r=>r.storage_path),15*60);
  const byPath=new Map(signed.map(x=>[x.path,x.signedUrl]));
  return rows.map(r=>({
    id:r.id,guestName:r.guest_name||'',status:r.status,createdAt:r.created_at,reviewedAt:r.reviewed_at||'',
    sizeBytes:Number(r.size_bytes||0),mimeType:r.mime_type||'',url:byPath.get(r.storage_path)||''
  }));
}
async function authenticate(body){return C.verifyOwner(body.slug,body.editCode,body.manageToken);}
async function list(owner,res){
  await C.cleanupRejected(owner.id).catch(error=>console.warn('guest-photo rejected cleanup skipped',error&&error.message));
  const rows=await C.listUploads(owner.id,['pending','approved','hidden']);
  return C.json(res,200,{ok:true,items:await signedRows(rows)});
}
async function getOwnedUpload(owner,id){
  const safe=validId(id);if(!safe)return null;
  const row=await C.getUploadById(safe);
  return row&&row.card_id===owner.id?row:null;
}
async function purgeUpload(row){
  const purgeNow=new Date(Date.now()-1000).toISOString();
  await C.updateUpload(row.id,{status:'rejected',reviewed_at:C.nowIso(),purge_after:purgeNow,upload_secret_hash:null,expires_at:null});
  let cleanupPending=false;
  try{
    if(row.storage_path)await C.removeStorage([row.storage_path]);
    await C.deleteUploadRow(row.id);
  }catch(error){
    cleanupPending=true;
    console.warn('guest-photo purge deferred',row.id,error&&error.message);
  }
  return {status:'deleted',cleanupPending};
}
async function mutateOne(owner,operation,id){
  const row=await getOwnedUpload(owner,id);
  if(!row){const error=new Error('사진을 찾을 수 없습니다.');error.status=404;throw error;}
  if(operation==='approve'){
    if(!['pending','approved','hidden'].includes(row.status)){const error=new Error('공개할 수 없는 사진입니다.');error.status=409;throw error;}
    const info=await C.waitForStorageObject(row.storage_path,2);
    if(!info){const error=new Error('사진 파일을 확인할 수 없어 공개하지 못했습니다.');error.status=409;throw error;}
    await C.updateUpload(row.id,{status:'approved',reviewed_at:C.nowIso(),upload_secret_hash:null,expires_at:null,purge_after:null});
    return {status:'approved'};
  }
  if(operation==='hide'){
    if(!['approved','hidden'].includes(row.status)){const error=new Error('공개 중인 사진만 숨길 수 있습니다.');error.status=409;throw error;}
    await C.updateUpload(row.id,{status:'hidden',reviewed_at:C.nowIso(),upload_secret_hash:null,expires_at:null,purge_after:null});
    return {status:'hidden'};
  }
  if(operation==='delete'||operation==='reject')return purgeUpload(row);
  const error=new Error('지원하지 않는 관리 요청입니다.');error.status=400;throw error;
}
async function mutate(owner,body,res){
  const operation=validOperation(body.action);
  const id=validId(body.id);
  if(!operation)return C.json(res,400,{ok:false,error:'지원하지 않는 관리 요청입니다.'});
  if(!id)return C.json(res,400,{ok:false,error:'사진 정보를 확인해 주세요.'});
  try{
    const result=await mutateOne(owner,operation,id);
    return C.json(res,200,{ok:true,...result});
  }catch(error){
    return C.json(res,error&&error.status||500,{ok:false,error:error&&error.message||'사진을 처리하지 못했습니다.'});
  }
}
async function batch(owner,body,res){
  const operation=validOperation(body.operation);
  const ids=[...new Set((Array.isArray(body.ids)?body.ids:[]).map(validId).filter(Boolean))];
  if(!operation||operation==='reject')return C.json(res,400,{ok:false,error:'일괄 처리 종류를 확인해 주세요.'});
  if(!ids.length||ids.length>50)return C.json(res,400,{ok:false,error:'처리할 사진을 1장 이상 50장 이하로 선택해 주세요.'});
  const results=[];
  for(const id of ids){
    try{results.push({id,ok:true,...await mutateOne(owner,operation,id)});}
    catch(error){results.push({id,ok:false,error:error&&error.message||'처리 실패'});}
  }
  const processed=results.filter(x=>x.ok).length,failed=results.length-processed;
  return C.json(res,200,{ok:true,operation,processed,failed,results});
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
    const action=String(body.action||'');
    if(action==='list')return await list(owner,res);
    if(action==='batch')return await batch(owner,body,res);
    return await mutate(owner,body,res);
  }catch(error){
    console.error('guest-photo-manage error',error);
    return C.json(res,502,{ok:false,error:'사진 관리 정보를 불러오지 못했습니다.'});
  }
}

module.exports=handler;
module.exports._test={validId,validOperation,signedRows,mutateOne,mutate,batch};
