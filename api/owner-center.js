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

function normalizeGuestbook(row){
  return {
    name:String(row&&row.name||'이름 없음').slice(0,80),
    message:String(row&&row.message||'').slice(0,1000),
    created_at:String(row&&row.created_at||'')
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
  const [rsvpRows,guestbookRows,photoRows]=await Promise.all([
    listTable('rsvp',owner.id,'attendance,meal,plus_count',1000),
    listTable('guestbook',owner.id,'created_at',1000),
    C.listUploads(owner.id,['pending','approved'])
  ]);
  const rsvp=summarizeRsvp(rsvpRows);
  const pendingPhotos=photoRows.filter(row=>row.status==='pending').length;
  const approvedPhotos=photoRows.filter(row=>row.status==='approved').length;
  return {
    ...rsvp,
    guestbook:guestbookRows.length,
    pendingPhotos,
    approvedPhotos
  };
}

async function handler(req,res){
  C.securityHeaders(res);
  if(String(req.method||'').toUpperCase()!=='POST'){
    res.setHeader('Allow','POST');
    return C.json(res,405,{ok:false,error:'허용되지 않은 요청입니다.'});
  }
  if(!C.configured())return C.json(res,503,{ok:false,error:'관리 서버 설정이 필요합니다.'});
  try{
    const body=C.parseBody(req);
    const owner=await C.verifyOwner(body.slug,body.editCode,body.manageToken);
    if(!owner)return C.json(res,401,{ok:false,error:'청첩장 관리 권한을 다시 확인해 주세요.'});
    const action=String(body.action||'summary');
    if(action==='summary'){
      return C.json(res,200,{ok:true,summary:await getSummary(owner)});
    }
    if(action==='rsvp'){
      const rows=await listTable('rsvp',owner.id,'name,side,attendance,meal,plus_count,phone,memo,created_at',1000);
      return C.json(res,200,{ok:true,rows:rows.map(normalizeRsvp)});
    }
    if(action==='guestbook'){
      const rows=await listTable('guestbook',owner.id,'name,message,created_at',200);
      return C.json(res,200,{ok:true,rows:rows.map(normalizeGuestbook)});
    }
    return C.json(res,400,{ok:false,error:'지원하지 않는 관리 요청입니다.'});
  }catch(error){
    console.error('owner-center error',error);
    return C.json(res,502,{ok:false,error:'관리 정보를 불러오지 못했습니다.'});
  }
}

module.exports=handler;
module.exports._test={clampInt,normalizeRsvp,normalizeGuestbook,summarizeRsvp,listTable,getSummary};
