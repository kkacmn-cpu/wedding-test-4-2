'use strict';

const auth=require('./admin-auth.js');

const SUPABASE_URL=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const SERVICE_ROLE_KEY=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'');
const MAX_ROWS=500;
const REQUEST_TIMEOUT_MS=10_000;

const TABLES={
  cards:{
    order:'created_at.desc',
    select:[
      'id','slug','groom_name','bride_name','wedding_date','wedding_time',
      'venue_name','venue_hall','theme','created_at','updated_at',
      'editable_until','data_expires_at','main_photo_url','gallery_urls','options'
    ].join(',')
  },
  purchases:{
    order:'created_at.desc',
    select:[
      'id','naver_product_order_id','buyer_name','product_type','status',
      'used_card_id','created_at','used_at','buyer_phone_hash'
    ].join(',')
  }
};

function setSecurityHeaders(res){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Pragma','no-cache');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
}
function json(res,status,payload){
  setSecurityHeaders(res);
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
function configured(){return Boolean(SUPABASE_URL&&SERVICE_ROLE_KEY);}
function headers(){
  return {
    'Accept':'application/json',
    'apikey':SERVICE_ROLE_KEY,
    'Authorization':`Bearer ${SERVICE_ROLE_KEY}`
  };
}
async function fetchRows(table){
  const spec=TABLES[table];
  if(!spec)throw new Error('UNSUPPORTED_TABLE');
  const params=new URLSearchParams({
    select:spec.select,
    order:spec.order,
    limit:String(MAX_ROWS)
  });
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params.toString()}`,{
      headers:headers(),
      signal:controller.signal
    });
    if(!response.ok){
      const detail=await response.text().catch(()=>'');
      throw new Error(`${table.toUpperCase()}_${response.status}:${detail.slice(0,180)}`);
    }
    const rows=await response.json();
    return Array.isArray(rows)?rows:[];
  }finally{
    clearTimeout(timer);
  }
}
function cleanCard(card){
  const options=card&&typeof card.options==='object'&&card.options?card.options:{};
  return {
    id:card.id||'',
    slug:card.slug||'',
    groomName:card.groom_name||'',
    brideName:card.bride_name||'',
    weddingDate:card.wedding_date||'',
    weddingTime:card.wedding_time||'',
    venueName:card.venue_name||'',
    venueHall:card.venue_hall||'',
    theme:card.theme||'',
    createdAt:card.created_at||'',
    updatedAt:card.updated_at||'',
    editableUntil:card.editable_until||'',
    dataExpiresAt:card.data_expires_at||'',
    hasMainPhoto:Boolean(card.main_photo_url),
    galleryCount:Array.isArray(card.gallery_urls)?card.gallery_urls.length:0,
    rsvpEnabled:options.rsvp!==false,
    guestbookEnabled:options.guest!==false
  };
}
function cleanPurchase(purchase){
  return {
    id:purchase.id||'',
    productOrderId:purchase.naver_product_order_id||'',
    buyerName:purchase.buyer_name||'',
    productType:purchase.product_type||'',
    status:purchase.status||'',
    usedCardId:purchase.used_card_id||'',
    createdAt:purchase.created_at||'',
    usedAt:purchase.used_at||'',
    hasPhoneHash:Boolean(purchase.buyer_phone_hash)
  };
}
function buildRows(cards,purchases){
  const purchaseByCard=new Map();
  purchases.forEach(p=>{if(p.used_card_id&&!purchaseByCard.has(p.used_card_id))purchaseByCard.set(p.used_card_id,p);});
  const cardIds=new Set(cards.map(c=>c.id).filter(Boolean));
  const rows=cards.map(card=>{
    const p=purchaseByCard.get(card.id)||null;
    return {...cleanCard(card),purchase:p?cleanPurchase(p):null};
  });
  const unlinkedPurchases=purchases.filter(p=>!p.used_card_id||!cardIds.has(p.used_card_id)).map(cleanPurchase);
  return {rows,unlinkedPurchases};
}
function summary(cards,purchases,unlinkedPurchases){
  const today=new Date().toISOString().slice(0,10);
  return {
    cards:cards.length,
    purchases:purchases.length,
    publishedWithPurchase:cards.filter(c=>purchases.some(p=>p.used_card_id===c.id)).length,
    unlinkedPurchases:unlinkedPurchases.length,
    upcomingWeddings:cards.filter(c=>c.wedding_date&&c.wedding_date>=today).length,
    pastWeddings:cards.filter(c=>c.wedding_date&&c.wedding_date<today).length
  };
}

async function handler(req,res){
  if(String(req.method||'').toUpperCase()!=='GET'){
    res.setHeader('Allow','GET');
    return json(res,405,{ok:false,error:'허용되지 않은 요청입니다.'});
  }
  if(!auth._test.readSession(req))return json(res,401,{ok:false,error:'관리자 로그인이 필요합니다.'});
  if(!configured())return json(res,503,{ok:false,error:'Supabase 관리자 환경변수가 설정되지 않았습니다.'});

  try{
    const [cards,purchases]=await Promise.all([fetchRows('cards'),fetchRows('purchases')]);
    const joined=buildRows(cards,purchases);
    return json(res,200,{
      ok:true,
      readOnly:true,
      generatedAt:new Date().toISOString(),
      summary:summary(cards,purchases,joined.unlinkedPurchases),
      cards:joined.rows,
      unlinkedPurchases:joined.unlinkedPurchases
    });
  }catch(error){
    console.error('admin-data error',error);
    return json(res,502,{ok:false,error:'관리 데이터를 불러오지 못했습니다. Supabase 설정과 테이블 권한을 확인해 주세요.'});
  }
}

module.exports=handler;
module.exports._test={configured,cleanCard,cleanPurchase,buildRows,summary,fetchRows,MAX_ROWS,REQUEST_TIMEOUT_MS,TABLES};
