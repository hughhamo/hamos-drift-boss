import { getStore } from '@netlify/blobs';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt=promisify(scryptCallback);
const storeName='drift-boss-cloud-accounts-v1';
const COOKIE='hamos_cloud_session',TTL=60*86400*1000;
const usernameOk=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{3,18}$/.test(v);
const idOk=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const hashToken=t=>createHash('sha256').update(t).digest('hex');
const json=(data,status=200,cookie)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(cookie?{'Set-Cookie':cookie}:{})}});
const err=(message,status=400)=>json({error:message},status);
const cookieFor=(token,age)=>COOKIE+'='+token+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+age;
const cleanNums=(v,max=100)=>Array.isArray(v)?Array.from(new Set(v.filter(x=>Number.isInteger(x)&&x>=0&&x<max))).slice(0,max):[];
const reasonable=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max?v:0;
function cleanProfile(raw){
 const p=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
 const name=String(p.nickname||'').replace(/[^a-zA-Z0-9 _-]/g,'').slice(0,18);
 const full=String(p.fullName||'').replace(/[^a-zA-ZÀ-ž '-]/g,'').slice(0,48);
 const counts=p.achievementCounts||{};
 return {nickname:name,fullName:full,showFullName:p.showFullName===true,wallet:reasonable(p.wallet,2000000000),
 smokeOwned:cleanNums(p.smokeOwned,32),smokeEquipped:reasonable(p.smokeEquipped,31),
 atmosOwned:cleanNums(p.atmosOwned,40),atmosEquipped:reasonable(p.atmosEquipped,39),
 carOwned:cleanNums(p.carOwned,10),carEquipped:reasonable(p.carEquipped,9),
 carSmoke:Array.isArray(p.carSmoke)&&p.carSmoke.length===10?p.carSmoke.map(x=>Number.isInteger(x)&&x>=0&&x<29&&x!==19?x:0):Array(10).fill(reasonable(p.smokeEquipped,28)),
 verifiedBest:reasonable(p.verifiedBest,50000000),
 achievementClaims:cleanNums(p.achievementClaims,32),
 achievementCounts:{loops:reasonable(counts.loops,1000000),bananas:reasonable(counts.bananas,1000000),green:reasonable(counts.green,1000000),red:reasonable(counts.red,1000000)},
 pSecretRedeemed:p.pSecretRedeemed===true,newsSeen:p.newsSeen===true,coinAchievementMigrationV2:p.coinAchievementMigrationV2===true,motorsportNewsSeen:p.motorsportNewsSeen===true,watercraftNewsSeen:p.watercraftNewsSeen===true,golfNewsSeen:p.golfNewsSeen===true,redPickupRewardV3:p.redPickupRewardV3===true};
}
async function currentSession(req,store){
 const cookie=req.headers.get('cookie')||'';
 const match=cookie.match(/(?:^|;\s*)hamos_cloud_session=([a-f0-9]{64})/);
 if(!match)return null;
 const key=hashToken(match[1]);const session=await store.get('sessions/'+key,{type:'json'});
 if(!session||session.expires<Date.now())return null;
 const user=await store.get('users/'+session.user,{type:'json'});
 if(!user)return null;
 return {user,session,token:match[1],key};
}
export default async function accountFunction(req){
 try{
  const store=getStore({name:storeName,consistency:'strong'});
  if(req.method==='GET'){
   const active=await currentSession(req,store);
   return active?json({loggedIn:true,username:active.user.username,playerId:active.user.playerId,profile:active.user.profile}):json({loggedIn:false});
  }
  if(req.method!=='POST')return err('Method not allowed',405);
  // Only same-origin scripts are expected to send credential or profile mutations.
  const origin=req.headers.get('origin');
  if(origin&&origin!==new URL(req.url).origin)return err('Invalid origin',403);
  if(Number(req.headers.get('content-length')||0)>11000)return err('Request too large',413);
  const raw=await req.text();if(raw.length>11000)return err('Request too large',413);
  let data;try{data=JSON.parse(raw)}catch{return err('Invalid JSON')}
  if(!data||typeof data!=='object'||Array.isArray(data))return err('Invalid request');
  const action=data.action;
  if(action==='register'||action==='login'){
   const name=String(data.username||'').trim().toLowerCase(),password=data.password;
   if(!usernameOk(name))return err('Username must be 3–18 letters, numbers, hyphens or underscores');
   if(typeof password!=='string'||password.length<8||password.length>72)return err('Password must be 8–72 characters');
   const key='users/'+name;
   const attemptsKey='attempts/'+name;
   const attempts=await store.get(attemptsKey,{type:'json'});
   if(attempts&&attempts.until>Date.now()&&attempts.count>=6)return err('Too many attempts. Try again in 15 minutes.',429);
   let user=await store.get(key,{type:'json'});
   if(action==='register'){
    if(user)return err('Username already taken',409);
    if(!idOk(data.playerId))return err('Invalid local player ID');
    const linked=await store.get('linked/'+data.playerId,{type:'json'});
    if(linked)return err('This player is already linked to a cloud account',409);
    const salt=randomBytes(16).toString('hex');
    const keyHash=await scrypt(password,salt,64);
    user={username:name,playerId:data.playerId,salt,passwordHash:keyHash.toString('hex'),profile:cleanProfile(data.profile),createdAt:Date.now()};
    // Preserve existing unregistered player ID and its leaderboard record.
    await store.setJSON(key,user);
    await store.setJSON('linked/'+data.playerId,{username:name});
   }else{
    const actual=user?Buffer.from(user.passwordHash,'hex'):randomBytes(64);
    const computed=await scrypt(password,user?.salt||randomBytes(16).toString('hex'),64);
    if(!user||actual.length!==computed.length||!timingSafeEqual(actual,computed)){
     const recent=attempts&&attempts.until>Date.now()?attempts.count:0;
     await store.setJSON(attemptsKey,{count:recent+1,until:Date.now()+15*60000});
     return err('Invalid username or password',401);
    }
    await store.delete(attemptsKey);
   }
   const token=randomBytes(32).toString('hex');
   await store.setJSON('sessions/'+hashToken(token),{user:name,expires:Date.now()+TTL});
   return json({loggedIn:true,username:name,playerId:user.playerId,profile:user.profile},200,cookieFor(token,Math.floor(TTL/1000)));
  }
  const active=await currentSession(req,store);
  if(!active)return err('Not signed in',401);
  if(action==='logout'){
   await store.delete('sessions/'+active.key);
   return json({loggedIn:false},200,cookieFor('',0));
  }
  if(action==='save'||action==='reset'){
   // Only the authenticated user's document may be modified; never take a user ID from the body.
   const profile=cleanProfile(data.profile);
   const merged={...active.user,profile:action==='reset'?profile:{...profile,verifiedBest:Math.max(profile.verifiedBest,active.user.profile.verifiedBest)}};
   await store.setJSON('users/'+active.user.username,merged);
   return json({saved:true});
  }
  return err('Unknown action');
 }catch(e){console.error('Cloud account error',e);return err('Cloud account service unavailable',503)}
}
