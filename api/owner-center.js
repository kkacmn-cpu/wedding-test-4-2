'use strict';

const C=require('./guest-photo-common.js');

function clampInt(value,min,max,fallback){
  const n=Number.parseInt(value,10);
  return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;
}

async function listTable(table,cardId,select,limit){
  const params=new URLSearchParams({
    select,
    card_id:`eq.${cardId}`,
    order:'created_at.desc',
    limit:String(clampInt(limit,1,1000,200))
  });
  const rows=await C.rest(`${table}?${params.toString()}`);
  return Array.isArray(rows)?rows:[];
}

function safeRowId(value){
  const id=String(value||'').trim();
  return /^[A-Za-z0-9_-]{1,120}$/.test(id)?id:'';
}

function isModerationMissing(error){
  const text=[error&&error.code,error&&error.message,error&&error.details,error&&error.hint].filter(Boolean).join(' ');
  return /PGRST205|guestbook_moderation|schema cache/i.test(text);
}

async function listModeration(cardId){
  const params=new URLSearchParams({select:'guestbook_id,status',card_id:`eq.${cardId}`,status:'eq.hidden',limit:'1000'});
  const rows=await C.rest(`guestbook_moderation?${params.toString()}`);
  return Array.isArray(rows)?rows:[];
}

async function getGuestbookBundle(cardId,limit){
  const rows=await listTable('guestbook',cardId,'id,name,message,created_at',limit);
  let moderationRows=[],moderationReady=true;
  try{moderationRows=await listModeration(cardId);}catch(error){
    if(isModerationMissing(error))moderationReady=false;else throw error;
  }
  const hiddenSet=new Set(moderationRows.filter(row=>row&&row.status==='hidden').map(row=>String(row.guestbook_id||'')));
  return {rows,hiddenSet,moderationReady};
}

function normalizeRsvp(row){
  const attendance=String(row&&row.attendance||'')==='불참'?'불참':'참석';
  const side=String(row&&row.side||'')==='bride'?'bride':'groom';
  const meal=String(row&&row.meal||'')==='yes'?'yes':'no';
  const plusRaw=Number.parseInt(row&&row.plus_count,10);
  const plusCount=Number.isFinite(plusRaw)?Math.max(0,Math.min(20,plusRaw)):0;
  return {
    name:String(row&&row.name||'이름 없음').slice(0,80),
    side,
    attendance,
    meal,
    plus_count:plusCount,
    phone:String(row&&row.phone||'').slice(0,80),
    memo:String(row&&row.memo||'').slice(0,300),
    created_at:String(row&&row.created_at||'')
  };
}

function normalizeGuestbook(row,hiddenSet){
  const id=safeRowId(row&&row.id);
  return {
    id,
    name:String(row&&row.name||'이름 없음').slice(0,80),
    message:String(row&&row.message||'').slice(0,1000),
    created_at:String(row&&row.created_at||''),
    hidden:!!(id&&hiddenSet&&hiddenSet.has(id))
  };
}

function summarizeRsvp(rows){
  const normalized=rows.map(normalizeRsvp);
  let guests=0,meals=0,declines=0;
  normalized.forEach(row=>{
    if(row.attendance==='불참'){declines++;return;}
    const party=1+row.plus_count;
    guests+=party;
    if(row.meal==='yes')meals+=party;
  });
  return {responses:normalized.length,guests,meals,declines};
}

async function getSummary(owner){
  const warnings=[];
  const sources={
    rsvp:{ok:false,error:''},
    guestbook:{ok:false,error:''},
    photos:{ok:false,error:''}
  };
  const safe=async(key,label,work,fallback)=>{
    try{
      const value=await work();
      sources[key]={ok:true,error:''};
      return value;
    }catch(error){
      console.error(`owner-center ${label} summary error`,error);
      warnings.push(label);
      sources[key]={ok:false,error:'일시적으로 확인할 수 없습니다.'};
      return fallback;
    }
  };
  const [rsvpRows,guestbookBundle,photoRows]=await Promise.all([
    safe('rsvp','참석 응답',()=>listTable('rsvp',owner.id,'attendance,meal,plus_count',1000),[]),
    safe('guestbook','방명록',()=>getGuestbookBundle(owner.id,1000),{rows:[],hiddenSet:new Set(),moderationReady:false}),
    safe('photos','하객 사진',()=>C.listUploads(owner.id,['pending','approved','hidden']),[])
  ]);
  const rsvp=summarizeRsvp(rsvpRows);
  const normalizedGuestbook=guestbookBundle.rows.map(row=>normalizeGuestbook(row,guestbookBundle.hiddenSet));
  const hiddenGuestbook=normalizedGuestbook.filter(row=>row.hidden).length;
  const pendingPhotos=photoRows.filter(row=>row.status==='pending').length;
  const approvedPhotos=photoRows.filter(row=>row.status==='approved').length;
  const hiddenPhotos=photoRows.filter(row=>row.status==='hidden').length;
  return {
    ...rsvp,
    guestbook:normalizedGuestbook.length-hiddenGuestbook,
    hiddenGuestbook,
    moderationReady:guestbookBundle.moderationReady,
    pendingPhotos,
    approvedPhotos,
    hiddenPhotos,
    warnings,
    sources,
    generatedAt:new Date().toISOString()
  };
}

function apiError(res,status,code,message,retryable){
  return C.json(res,status,{ok:false,code,error:message,retryable:!!retryable});
}

async function getOwnedGuestbookRow(cardId,guestbookId){
  const id=safeRowId(guestbookId);if(!id)return null;
  const params=new URLSearchParams({select:'id,name,message,created_at',id:`eq.${id}`,card_id:`eq.${cardId}`,limit:'1'});
  const rows=await C.rest(`guestbook?${params.toString()}`);
  return Array.isArray(rows)?rows[0]||null:null;
}

async function hideGuestbook(cardId,guestbookId){
  const row=await getOwnedGuestbookRow(cardId,guestbookId);if(!row)return null;
  const query=new URLSearchParams({on_conflict:'card_id,guestbook_id'});
  await C.rest(`guestbook_moderation?${query.toString()}`,{
    method:'POST',
    headers:{'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=minimal'},
    body:JSON.stringify({card_id:String(cardId),guestbook_id:String(row.id),status:'hidden',updated_at:new Date().toISOString()})
  });
  return normalizeGuestbook(row,new Set([String(row.id)]));
}

async function showGuestbook(cardId,guestbookId){
  const row=await getOwnedGuestbookRow(cardId,guestbookId);if(!row)return null;
  const params=new URLSearchParams({card_id:`eq.${cardId}`,guestbook_id:`eq.${row.id}`});
  await C.rest(`guestbook_moderation?${params.toString()}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
  return normalizeGuestbook(row,new Set());
}

async function deleteGuestbook(cardId,guestbookId){
  const id=safeRowId(guestbookId);if(!id)return null;
  const params=new URLSearchParams({id:`eq.${id}`,card_id:`eq.${cardId}`});
  const rows=await C.rest(`guestbook?${params.toString()}`,{method:'DELETE',headers:{'Prefer':'return=representation'}});
  const deleted=Array.isArray(rows)?rows[0]||null:null;
  if(!deleted)return null;
  try{
    const modParams=new URLSearchParams({card_id:`eq.${cardId}`,guestbook_id:`eq.${id}`});
    await C.rest(`guestbook_moderation?${modParams.toString()}`,{method:'DELETE',headers:{'Prefer':'return=minimal'}});
  }catch(error){if(!isModerationMissing(error))console.warn('guestbook moderation cleanup deferred',error&&error.message);}
  return normalizeGuestbook(deleted,new Set());
}

async function handler(req,res){
  C.securityHeaders(res);
  if(String(req.method||'').toUpperCase()!=='POST'){
    res.setHeader('Allow','POST');
    return C.json(res,405,{ok:false,error:'허용되지 않은 요청입니다.'});
  }
  if(!C.configured())return apiError(res,503,'SERVER_NOT_CONFIGURED','관리 서버 설정이 필요합니다.',false);
  try{
    const body=C.parseBody(req);
    const owner=await C.verifyOwner(body.slug,body.editCode,body.manageToken);
    if(!owner)return apiError(res,401,'AUTH_REQUIRED','청첩장 관리 인증이 만료되었거나 올바르지 않습니다.',false);
    const action=String(body.action||'summary');
    if(action==='summary'){
      return C.json(res,200,{ok:true,summary:await getSummary(owner)});
    }
    if(action==='rsvp'){
      try{
        const rows=await listTable('rsvp',owner.id,'name,side,attendance,meal,plus_count,phone,memo,created_at',1000);
        return C.json(res,200,{ok:true,rows:rows.map(normalizeRsvp),generatedAt:new Date().toISOString()});
      }catch(error){
        console.error('owner-center rsvp error',error);
        return apiError(res,503,'RSVP_UNAVAILABLE','참석 응답을 일시적으로 불러오지 못했습니다.',true);
      }
    }
    if(action==='guestbook'){
      try{
        const bundle=await getGuestbookBundle(owner.id,200);
        const rows=bundle.rows.map(row=>normalizeGuestbook(row,bundle.hiddenSet));
        return C.json(res,200,{ok:true,rows,moderationReady:bundle.moderationReady,generatedAt:new Date().toISOString()});
      }catch(error){
        console.error('owner-center guestbook error',error);
        return apiError(res,503,'GUESTBOOK_UNAVAILABLE','방명록을 일시적으로 불러오지 못했습니다.',true);
      }
    }
    if(action==='guestbook_hide'||action==='guestbook_show'||action==='guestbook_delete'){
      const id=safeRowId(body.guestbookId);
      if(!id)return apiError(res,400,'INVALID_GUESTBOOK_ID','처리할 방명록 메시지를 확인할 수 없습니다.',false);
      try{
        const row=action==='guestbook_hide'?await hideGuestbook(owner.id,id):(action==='guestbook_show'?await showGuestbook(owner.id,id):await deleteGuestbook(owner.id,id));
        if(!row&&action==='guestbook_delete')return C.json(res,200,{ok:true,row:null,action,alreadyDeleted:true,generatedAt:new Date().toISOString()});
        if(!row)return apiError(res,404,'GUESTBOOK_NOT_FOUND','방명록 메시지를 찾을 수 없거나 이미 삭제되었습니다.',false);
        return C.json(res,200,{ok:true,row,action,generatedAt:new Date().toISOString()});
      }catch(error){
        console.error(`owner-center ${action} error`,error);
        if(isModerationMissing(error))return apiError(res,503,'MODERATION_NOT_INSTALLED','방명록 관리 기능의 Supabase 설치가 필요합니다.',false);
        return apiError(res,503,'GUESTBOOK_MODERATION_FAILED','방명록 상태를 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.',true);
      }
    }
    return apiError(res,400,'UNSUPPORTED_ACTION','지원하지 않는 관리 요청입니다.',false);
  }catch(error){
    console.error('owner-center error',error);
    return apiError(res,502,'OWNER_CENTER_UNAVAILABLE','관리 정보를 불러오지 못했습니다.',true);
  }
}

module.exports=handler;
module.exports._test={clampInt,safeRowId,isModerationMissing,normalizeRsvp,normalizeGuestbook,summarizeRsvp,listTable,listModeration,getGuestbookBundle,getSummary,apiError,getOwnedGuestbookRow,hideGuestbook,showGuestbook,deleteGuestbook};
