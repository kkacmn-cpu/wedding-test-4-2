'use strict';

const SUPABASE_URL=process.env.SUPABASE_URL||'https://jchohaqvaoytplinlylt.supabase.co';
const SUPABASE_KEY=process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY||'sb_publishable_pinNIcaU11HhbSz3TR__mQ_Ln4cJ79a';
const FALLBACK_BASE_URL='https://wedding-test-4-2.vercel.app';
const CARD_BASE_URL=process.env.CARD_BASE_URL||'';
const DEFAULT_OG_IMAGE=process.env.DEFAULT_OG_IMAGE||'';

function esc(value){
  return String(value==null?'':value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function safeHttpUrl(value,fallback=''){
  try{
    const u=new URL(String(value||''));
    return (u.protocol==='https:'||u.protocol==='http:')?u.href:fallback;
  }catch(_){
    return fallback;
  }
}

function parseOptions(value){
  if(value&&typeof value==='object')return value;
  if(typeof value==='string'){
    try{return JSON.parse(value)||{};}catch(_){return {};}
  }
  return {};
}

function formatDate(value){
  const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m)return String(value||'');
  const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);
  const weekday=['일','월','화','수','목','금','토'][new Date(Date.UTC(y,mo-1,d)).getUTCDay()];
  return `${y}년 ${mo}월 ${d}일 ${weekday}요일`;
}

function formatTime(value){
  const m=String(value||'').match(/^(\d{1,2}):(\d{2})/);
  if(!m)return '';
  let h=Number(m[1]);
  const min=Number(m[2]);
  const ap=h<12?'오전':'오후';
  h=h%12||12;
  return `${ap} ${h}시${min?` ${min}분`:''}`;
}

function appendVersion(value,version){
  const url=safeHttpUrl(value,'');
  if(!url)return '';
  try{
    const u=new URL(url);
    if(version)u.searchParams.set('v',String(version));
    return u.href;
  }catch(_){return url;}
}

/* Supabase public storage URL이면 1200×600 cover 변환 URL을 사용한다.
   변환 기능이 비활성인 환경에서는 원본 URL을 그대로 사용하도록 외부 URL은 변경하지 않는다. */
function buildOgImage(value,version){
  const original=safeHttpUrl(value,DEFAULT_OG_IMAGE||new URL('/og-default.jpg',FALLBACK_BASE_URL).href);
  try{
    const u=new URL(original);
    if(u.hostname.endsWith('.supabase.co')&&u.pathname.includes('/storage/v1/object/public/')){
      u.pathname=u.pathname.replace('/storage/v1/object/public/','/storage/v1/render/image/public/');
      u.searchParams.set('width','1200');
      u.searchParams.set('height','600');
      u.searchParams.set('resize','cover');
      u.searchParams.set('quality','85');
      u.searchParams.set('format','origin');
      if(version)u.searchParams.set('v',String(version));
      return u.href;
    }
  }catch(_){/* 원본 사용 */}
  return appendVersion(original,version);
}

function getCardImage(card){
  const gallery=Array.isArray(card&&card.gallery_urls)?card.gallery_urls:[];
  const options=parseOptions(card&&card.options);
  return safeHttpUrl(options.share_image_url,'')
    ||safeHttpUrl(card&&card.main_photo_url,'')
    ||safeHttpUrl(card&&card.cover_image,'')
    ||gallery.map(v=>safeHttpUrl(v,'')).find(Boolean)
    ||DEFAULT_OG_IMAGE;
}

function getNames(card){
  const groom=String(card&&card.groom_name||'신랑').trim()||'신랑';
  const bride=String(card&&card.bride_name||'신부').trim()||'신부';
  const options=parseOptions(card&&card.options);
  return options.order_gb===false?`${bride} ♥ ${groom}`:`${groom} ♥ ${bride}`;
}

function buildMeta(card,version,baseUrl){
  const names=getNames(card);
  const date=formatDate(card&&card.wedding_date);
  const time=formatTime(card&&card.wedding_time);
  const venue=[card&&card.venue_name,card&&card.venue_hall].filter(Boolean).join(' ');
  const detail=[date,time].filter(Boolean).join(' ');
  const description=[detail,venue].filter(Boolean).join(' · ')||'저희 결혼식에 초대합니다';
  const options=parseOptions(card&&card.options);
  const prepared=safeHttpUrl(options.share_image_url,'');
  const imageVersion=options.share_image_version||version;
  return {
    title:`${names}의 결혼식에 초대합니다`,
    description,
    image:prepared?appendVersion(prepared,imageVersion):buildOgImage(getCardImage(card)||(DEFAULT_OG_IMAGE||new URL('/og-default.jpg',baseUrl||FALLBACK_BASE_URL).href),imageVersion)
  };
}

function getRequestBaseUrl(req){
  const proto=(req&&req.headers&&(req.headers['x-forwarded-proto']||req.headers['x-vercel-forwarded-proto']))||'https';
  const host=req&&req.headers&&req.headers.host;
  return host?`${proto}://${host}`:FALLBACK_BASE_URL;
}

function buildCardUrl(slug,version,baseUrl){
  const u=new URL(CARD_BASE_URL||'/card.html',baseUrl||FALLBACK_BASE_URL);
  u.searchParams.set('slug',slug);
  if(version)u.searchParams.set('share_v',String(version));
  return u.href;
}

function renderHtml({meta,cardUrl,status=200,message=''}){
  const title=esc(meta&&meta.title||'모바일 청첩장');
  const description=esc(meta&&meta.description||message||'저희 결혼식에 초대합니다');
  const image=esc(meta&&meta.image||DEFAULT_OG_IMAGE);
  const target=esc(cardUrl||CARD_BASE_URL);
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${image}">
<meta property="og:image:secure_url" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="600">
<meta property="og:url" content="${target}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
<meta name="robots" content="noindex,nofollow,noarchive">
${status===200?`<meta http-equiv="refresh" content="0;url=${target}">`:''}
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#fcf9f4;color:#5c4e42;font-family:system-ui,-apple-system,sans-serif;text-align:center}.box{padding:28px}.box p{font-size:14px;line-height:1.7}.box a{color:#9a7740}</style>
</head>
<body><div class="box"><p>${status===200?'청첩장으로 이동하고 있습니다.':esc(message||'청첩장을 찾을 수 없습니다.')}</p>${status===200?`<p><a href="${target}">바로 열기</a></p>`:''}</div>${status===200?`<script>location.replace(${JSON.stringify(cardUrl)});</script>`:''}</body>
</html>`;
}

async function fetchCard(slug){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_card_by_slug`,{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'Accept':'application/json',
      'apikey':SUPABASE_KEY,
      'Authorization':`Bearer ${SUPABASE_KEY}`
    },
    body:JSON.stringify({p_slug:slug})
  });
  if(!response.ok){
    const detail=await response.text().catch(()=>'');
    throw new Error(`Supabase RPC ${response.status}${detail?`: ${detail.slice(0,200)}`:''}`);
  }
  const payload=await response.json();
  return Array.isArray(payload)?payload[0]||null:payload||null;
}

async function handler(req,res){
  if(req.method!=='GET'&&req.method!=='HEAD'){
    res.setHeader('Allow','GET, HEAD');
    res.statusCode=405;
    res.end('Method Not Allowed');
    return;
  }

  const parsed=new URL(req.url||'/',`https://${req.headers&&req.headers.host||'localhost'}`);
  const slug=String((req.query&&req.query.slug)||parsed.searchParams.get('slug')||'').trim();
  const version=String((req.query&&req.query.v)||parsed.searchParams.get('v')||'').replace(/[^0-9A-Za-z_-]/g,'').slice(0,64);

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','private, no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');

  if(!/^[A-Za-z0-9가-힣_-]{2,120}$/.test(slug)){
    res.statusCode=400;
    if(req.method==='HEAD'){res.end();return;}
    res.end(renderHtml({status:400,message:'올바르지 않은 청첩장 주소입니다.'}));
    return;
  }

  try{
    const card=await fetchCard(slug);
    if(!card){
      res.statusCode=404;
      if(req.method==='HEAD'){res.end();return;}
      res.end(renderHtml({status:404,message:'청첩장을 찾을 수 없습니다.'}));
      return;
    }
    const baseUrl=getRequestBaseUrl(req);
    const meta=buildMeta(card,version,baseUrl);
    const cardUrl=buildCardUrl(slug,version,baseUrl);
    res.statusCode=200;
    if(req.method==='HEAD'){res.end();return;}
    res.end(renderHtml({meta,cardUrl,status:200}));
  }catch(error){
    console.error('wedding-share error',error);
    res.statusCode=502;
    if(req.method==='HEAD'){res.end();return;}
    res.end(renderHtml({status:502,message:'청첩장 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.'}));
  }
}

module.exports=handler;
module.exports._test={esc,safeHttpUrl,formatDate,formatTime,buildOgImage,getCardImage,getNames,buildMeta,buildCardUrl,renderHtml,fetchCard,getRequestBaseUrl};
