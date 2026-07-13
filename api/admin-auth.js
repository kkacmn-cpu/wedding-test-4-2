'use strict';

const crypto=require('crypto');

const COOKIE_NAME='__Host-mi_admin_session';
const SESSION_SECONDS=8*60*60;

function text(value){return String(value==null?'':value);}
function base64url(value){return Buffer.from(value).toString('base64url');}
function fromBase64url(value){return Buffer.from(value,'base64url').toString('utf8');}
function secureEqual(a,b){
  const aa=Buffer.from(text(a));
  const bb=Buffer.from(text(b));
  if(aa.length!==bb.length){
    crypto.timingSafeEqual(aa,Buffer.alloc(aa.length));
    return false;
  }
  return crypto.timingSafeEqual(aa,bb);
}
function config(){
  return {
    username:text(process.env.ADMIN_USERNAME).trim(),
    password:text(process.env.ADMIN_PASSWORD),
    secret:text(process.env.ADMIN_SESSION_SECRET)
  };
}
function configured(){
  const c=config();
  return Boolean(c.username&&c.password&&c.secret.length>=32);
}
function sign(input,secret){return crypto.createHmac('sha256',secret).update(input).digest('base64url');}
function makeSession(username,now=Date.now()){
  const c=config();
  if(!configured())throw new Error('ADMIN_NOT_CONFIGURED');
  const payload=base64url(JSON.stringify({u:username,exp:Math.floor(now/1000)+SESSION_SECONDS}));
  return `${payload}.${sign(payload,c.secret)}`;
}
function verifySession(token,now=Date.now()){
  try{
    const c=config();
    if(!configured())return null;
    const [payload,sig,extra]=text(token).split('.');
    if(!payload||!sig||extra)return null;
    const expected=sign(payload,c.secret);
    if(!secureEqual(sig,expected))return null;
    const data=JSON.parse(fromBase64url(payload));
    if(!data||data.u!==c.username||!Number.isFinite(data.exp))return null;
    if(data.exp<=Math.floor(now/1000))return null;
    return {username:data.u,expiresAt:data.exp};
  }catch(_){return null;}
}
function parseCookies(header){
  const out={};
  text(header).split(';').forEach(part=>{
    const i=part.indexOf('=');
    if(i<0)return;
    const key=part.slice(0,i).trim();
    const value=part.slice(i+1).trim();
    if(!key)return;
    try{out[key]=decodeURIComponent(value);}
    catch(_){/* Ignore malformed cookie values so admin status/data checks keep working. */}
  });
  return out;
}
function readSession(req){
  const cookies=parseCookies(req&&req.headers&&req.headers.cookie);
  return verifySession(cookies[COOKIE_NAME]);
}
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
async function readJson(req){
  if(req.body&&typeof req.body==='object')return req.body;
  let raw='';
  for await(const chunk of req){
    raw+=chunk;
    if(raw.length>16*1024)throw new Error('BODY_TOO_LARGE');
  }
  if(!raw)return {};
  return JSON.parse(raw);
}
function cookie(value,maxAge){
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function handler(req,res){
  const method=text(req.method).toUpperCase();
  const url=new URL(req.url||'/api/admin-auth','https://localhost');
  const action=text((req.query&&req.query.action)||url.searchParams.get('action')||'status').toLowerCase();

  if(action==='status'&&method==='GET'){
    const session=readSession(req);
    return json(res,200,{ok:true,configured:configured(),authenticated:Boolean(session),expiresAt:session&&session.expiresAt||null});
  }

  if(action==='login'&&method==='POST'){
    if(!configured())return json(res,503,{ok:false,error:'관리자 환경변수가 아직 설정되지 않았습니다.'});
    try{
      const body=await readJson(req);
      const c=config();
      const userValid=secureEqual(text(body.username).trim(),c.username);
      const passwordValid=secureEqual(text(body.password),c.password);
      const valid=userValid&&passwordValid;
      if(!valid){
        await new Promise(resolve=>setTimeout(resolve,350));
        return json(res,401,{ok:false,error:'관리자 정보가 일치하지 않습니다.'});
      }
      const token=makeSession(c.username);
      res.setHeader('Set-Cookie',cookie(token,SESSION_SECONDS));
      return json(res,200,{ok:true,authenticated:true,expiresAt:verifySession(token).expiresAt});
    }catch(error){
      return json(res,400,{ok:false,error:error&&error.message==='BODY_TOO_LARGE'?'요청 내용이 너무 큽니다.':'로그인 요청을 처리하지 못했습니다.'});
    }
  }

  if(action==='logout'&&method==='POST'){
    res.setHeader('Set-Cookie',cookie('',0));
    return json(res,200,{ok:true,authenticated:false});
  }

  res.setHeader('Allow',action==='status'?'GET':'POST');
  return json(res,405,{ok:false,error:'허용되지 않은 요청입니다.'});
}

module.exports=handler;
module.exports._test={COOKIE_NAME,SESSION_SECONDS,secureEqual,configured,makeSession,verifySession,parseCookies,readSession,cookie,config};
