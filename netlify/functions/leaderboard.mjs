import { getStore } from '@netlify/blobs';
import { timingSafeEqual, createHash } from 'node:crypto';

const cleanName = v => String(v ?? '').trim().replace(/[^a-zA-Z0-9 _-]/g,'').replace(/\s+/g,' ').slice(0,18);
const cleanFull = v => String(v ?? '').trim().replace(/[^a-zA-ZÀ-ž '\-]/g,'').replace(/\s+/g,' ').slice(0,48);
const isID = v => typeof v==='string' && /^[0-9a-f-]{36}$/i.test(v);
const json = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const bad = (message,status=400)=>json({error:message},status);
const storeName='drift-boss-global-leaderboard';
// Release event begins with the first production request after deployment and
// expires 48 hours later without needing a second deployment. Stored per site.
const RELEASE_KEY='events/garage-release-20261021';
async function releaseEvent(store){
 let saved=await store.get(RELEASE_KEY,{type:'json'});
 if(!saved||!Number.isFinite(saved.start)){saved={start:Date.now()};await store.setJSON(RELEASE_KEY,saved);}
 return {start:saved.start,end:saved.start+48*3600*1000};
}
function validAdminKey(value){
 const secret=process.env.HAMOS_MODERATOR_KEY||'';
 if(secret.length<24||typeof value!=='string')return false;
 const incoming=Buffer.from(value,'utf8'),expected=Buffer.from(secret,'utf8');
 return incoming.length===expected.length&&timingSafeEqual(incoming,expected);
}
function publicDisplay(x){
 const o=x.moderatorDisplay;
 return {name:cleanName(o?o.name:x.name),fullName:(o?o.showFullName:x.showFullName)?cleanFull(o?o.fullName:x.fullName):'',moderated:!!o};
}


// Persistent, private player-ID bans; a browser-created ID is not a verified human identity.
const banKey = id => 'bans/'+id;
// Once a guest player ID has been linked to an optional cloud account,
// only that owner's signed-in session may change its leaderboard record.
async function canEditLinkedPlayer(req,id){
 const cloud=getStore({name:'drift-boss-cloud-accounts-v1',consistency:'strong'});
 const link=await cloud.get('linked/'+id,{type:'json'});
 if(!link)return true;
 const cookie=req.headers.get('cookie')||'';
 const match=cookie.match(/(?:^|;\s*)hamos_cloud_session=([a-f0-9]{64})/);
 if(!match)return false;
 const tokenHash=createHash('sha256').update(match[1]).digest('hex');
 const session=await cloud.get('sessions/'+tokenHash,{type:'json'});
 if(!session||session.expires<Date.now()||session.user!==link.username)return false;
 const owner=await cloud.get('users/'+session.user,{type:'json'});
 return !!owner&&owner.playerId===id;
}
const isBanned = async (store,id) => !!(await store.get(banKey(id),{type:'json'}));
async function scores(store,includeBanned=false){
  let cursor,records=[];
  do{
    const page=await store.list({prefix:'scores/',...(cursor?{cursor}:{})});
    records.push(...await Promise.all(page.blobs.map(x=>store.get(x.key,{type:'json'}).catch(()=>null))));
    cursor=page.cursor;
  }while(cursor&&records.length<3000);
  return records.filter(x=>x&&typeof x.name==='string'&&Number.isInteger(x.score))
    .map(x=>({...publicDisplay(x),score:x.score,id:x.id,updatedAt:x.updatedAt||'',banned:!!x.bannedAt,bannedAt:x.bannedAt||'',banReason:x.banReason||''}))
    .filter(x=>includeBanned||!x.banned)
    .sort((a,b)=>b.score-a.score||a.updatedAt.localeCompare(b.updatedAt));
}
export default async function leaderboard(req){
  try{
    const store=getStore({name:storeName,consistency:'strong'});
    const event=await releaseEvent(store);
    if(req.method==='GET'){
      const all=await scores(store);
      return json({online:true,top:all.slice(0,50).map(({name,fullName,score,updatedAt})=>({name,fullName,score,updatedAt})),players:all.length,event,serverNow:Date.now()});
    }
    if(req.method!=='POST')return bad('Method not allowed',405);
    if(Number(req.headers.get('content-length')||0)>2048)return bad('Too large',413);
    const raw=await req.text();
    if(raw.length>2048)return bad('Too large',413);
    let data;try{data=JSON.parse(raw)}catch{return bad('Invalid JSON')}
    if(!data||typeof data!=='object')return bad('Invalid data');
    // Global gamechat: public to read, verified-score gated to post.
    // Server-side daily slots enforce a maximum of two messages per player per UTC day.
    if(data.action==='chatList'||data.action==='chatPost'||data.action==='chatReport'){
      const chatStore=getStore({name:'hamos-drift-boss-gamechat-v1',consistency:'strong'});
      const feedKey='feed/recent';
      const fetchFeed=async()=>{
        const list=await chatStore.get(feedKey,{type:'json'});
        return Array.isArray(list)?list.filter(m=>m&&typeof m.text==='string'&&m.id).slice(-70):[];
      };
      if(data.action==='chatList'){
        const feed=await fetchFeed();
        let remaining=null;
        if(isID(data.playerId)){
          const day=new Date().toISOString().slice(0,10);
          const quota=await chatStore.get('quota/'+day+'/'+data.playerId,{type:'json'});
          remaining=Math.max(0,2-Math.min(2,Math.max(0,Number(quota?.used)||0)));
        }
        return json({messages:feed.slice(-50).map(({id,name,text,at})=>({id,name,text,at})),limitPerDay:2,maxWords:10,unlockScore:20000,remaining});
      }
      const id=data.playerId;
      if(!isID(id)||!(await canEditLinkedPlayer(req,id)))return bad('Sign in to your linked account to post',403);
      const player=await store.get('scores/'+id,{type:'json'});
      if(!player||player.bannedAt||(await isBanned(store,id)))return bad('A valid leaderboard record is required',403);
      const day=new Date().toISOString().slice(0,10);
      if(data.action==='chatReport'){
        const messageId=String(data.messageId||'');
        const feed=await fetchFeed(),message=feed.find(m=>m.id===messageId);
        if(!message)return bad('Chat message not found',404);
        const reportKey='reports/'+day+'/'+id+'/'+messageId.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,72);
        if(await chatStore.get(reportKey,{type:'json'}))return json({reported:true});
        await chatStore.setJSON(reportKey,{messageId,reporter:id,at:Date.now()});
        const countKey='reports/count/'+messageId.replace(/[^a-zA-Z0-9_-]/g,'');
        const old=await chatStore.get(countKey,{type:'json'});
        const reports=Math.min(50,(Number(old?.reports)||0)+1);
        await chatStore.setJSON(countKey,{reports});
        if(reports>=2){
          await chatStore.setJSON(feedKey,feed.map(item=>item.id===messageId?{...item,text:'[Message hidden after community reports]'}:item));
        }
        return json({reported:true});
      }
      if(player.score<=20000)return bad('Gamechat unlocks once your verified best score exceeds 20,000 points',403);
      const message=String(data.message||'').trim().replace(/\s+/g,' ');
      const words=message.split(' ').filter(Boolean);
      if(message.length<1||message.length>160||words.length>10)return bad('Send 1–10 words (160 characters maximum)');
      // Prevent sharing contact details, links, social handles or obvious abusive language.
      if(/(?:https?:\/\/|www\.|\S+@\S+|@\w+|\b\d[\d() .-]{6,}\d\b)/i.test(message))
        return bad('Links, handles and contact details are not allowed');
      if(/\b(?:fuck|shit|bitch|cunt|nigg\w*|fagg\w*|retard\w*|kill yourself|kys)\b/i.test(message))
        return bad('Please keep gamechat respectful');
      if(/[<>]/.test(message))return bad('HTML markup is not allowed');
      const quotaKey='quota/'+day+'/'+id;
      const current=await chatStore.get(quotaKey,{type:'json'});
      const used=Math.min(2,Math.max(0,Number(current?.used)||0));
      if(used>=2)return bad('You have used both messages for today',429);
      const feed=await fetchFeed();
      if(feed.some(m=>m.playerId===id&&m.text.toLowerCase()===message.toLowerCase()&&m.at.slice(0,10)===day))
        return bad('You have already posted this message today',409);
      const at=new Date().toISOString(),post={id:crypto.randomUUID(),playerId:id,name:cleanName(player.name),text:message,at};
      // Slot keys also cap per-day writes independently of the rolling message feed.
      const slotBase='slots/'+day+'/'+id+'/';
      const occupied1=await chatStore.get(slotBase+'1',{type:'json'});
      const occupied2=await chatStore.get(slotBase+'2',{type:'json'});
      const slot=!occupied1?1:!occupied2?2:0;
      if(!slot)return bad('You have used both messages for today',429);
      await chatStore.setJSON(slotBase+slot,post);
      await chatStore.setJSON(quotaKey,{used:Math.max(used,slot),lastAt:at});
      await chatStore.setJSON(feedKey,[...feed,post].slice(-70));
      return json({posted:true,remaining:Math.max(0,2-slot),message:{id:post.id,name:post.name,text:post.text,at}});
    }
    // Administrative corrections require a private key held ONLY in Netlify's environment.
    // The discoverable shortcut key '9' is never sufficient authorization.
    if(['adminList','adminEdit','adminClear','adminBan','adminUnban'].includes(data.action)){
      const configuredSecret=process.env.HAMOS_MODERATOR_KEY||'';
      if(configuredSecret.length<24)return bad('The server has no valid HAMOS_MODERATOR_KEY. Set at least 24 characters in Netlify Production and deploy again.',503);
      if(!validAdminKey(data.adminKey))return bad('The entered password does not match the Netlify Production password. Check for extra spaces or replace and redeploy.',403);
      if(data.action==='adminList'){
        const rows=(await scores(store,true)).slice(0,250);
        return json({players:rows.length,rows});
      }
      const targetId=data.targetId;
      if(!isID(targetId))return bad('Invalid target');
      const key='scores/'+targetId;
      const record=await store.get(key,{type:'json'});
      if(!record)return bad('Player not found',404);
      if(data.action==='adminBan'){
        if(record.bannedAt)return bad('Player is already permanently banned',409);
        const reason=String(data.reason||'').trim().slice(0,160);
        if(reason.length<6)return bad('A reason of at least 6 characters is required');
        const at=new Date().toISOString();
        // Preserve the score for a possible appeal, but hide it from public rankings.
        // The separate ban record survives attempts to re-submit with the same player ID.
        await store.setJSON(banKey(targetId),{id:targetId,reason,at});
        await store.setJSON(key,{...record,bannedAt:at,banReason:reason});
        await store.setJSON('moderation-log/'+crypto.randomUUID(),{id:targetId,action:'permanent-ban',reason,at});
        return json({saved:true,banned:true});
      }
      if(data.action==='adminUnban'){
        if(!record.bannedAt && !(await isBanned(store,targetId)))return bad('Player is not banned',409);
        const {bannedAt,banReason,...restored}=record;
        await store.setJSON(key,restored);
        await store.delete(banKey(targetId));
        await store.setJSON('moderation-log/'+crypto.randomUUID(),{id:targetId,action:'unban',at:new Date().toISOString()});
        return json({saved:true,banned:false});
      }
      if(data.action==='adminClear'){
        const {moderatorDisplay,...original}=record;
        await store.setJSON(key,original);
        await store.setJSON('moderation-log/'+crypto.randomUUID(),{id:targetId,action:'clear',before:record.moderatorDisplay||null,at:new Date().toISOString()});
        return json({saved:true});
      }
      const newName=cleanName(data.newName);
      const newFull=cleanFull(data.newFullName);
      const displayFull=data.showFullName===true&&newFull.length>=3;
      const reason=String(data.reason||'').trim().slice(0,160);
      if(newName.length<2||reason.length<6)return bad('Enter a nickname and a short reason');
      const next={...record,moderatorDisplay:{name:newName,fullName:newFull,showFullName:displayFull},moderatedAt:new Date().toISOString()};
      await store.setJSON(key,next);
      await store.setJSON('moderation-log/'+crypto.randomUUID(),{id:targetId,action:'edit',before:record.moderatorDisplay||null,after:next.moderatorDisplay,reason,at:next.moderatedAt});
      return json({saved:true});
    }
    const id=data.playerId;
    if(!isID(id))return bad('Invalid player ID');
    if(!(await canEditLinkedPlayer(req,id)))return bad('Please sign in to your cloud account to use this leaderboard record',403);
    // Keep the old competition record out of the rankings before acknowledging a reset.
    // This separate deletion never modifies any other player's stored record.
    if(data.action==='delete'){
      if(!isID(id))return bad('Invalid player ID');
      if(await isBanned(store,id))return bad('This player account is banned from the leaderboard',403);
      const key='scores/'+id;
      await store.setJSON('resets/'+id,{at:Date.now()});
      await store.delete(key);
      return json({deleted:true});
    }
    const name=cleanName(data.name),fullName=cleanFull(data.fullName),showFullName=data.showFullName===true&&fullName.length>=3;
    if(!isID(id)||name.length<2)return bad('Choose a nickname of at least two characters');
    if(await isBanned(store,id))return bad('This player account has been permanently banned from the leaderboard',403);
    if(data.action==='start'){
      const runId=crypto.randomUUID();
      await store.setJSON('runs/'+runId,{id,startedAt:Date.now(),used:false});
      return json({runId,ready:true});
    }
    if(data.action==='rename'){
      const key='scores/'+id,record=await store.get(key,{type:'json'});
      if(!record)return json({saved:false,message:'Finish a run to appear on the board.'});
      await store.setJSON(key,{...record,name,fullName,showFullName,updatedAt:new Date().toISOString()});
      return json({saved:true});
    }
    if(data.action==='finish'){
      const {score,seconds,runId,bonusSeconds=0}=data;
      if(!isID(runId)||!Number.isInteger(score)||score<1||score>50000000||!Number.isFinite(seconds)||seconds<0||seconds>86400||typeof bonusSeconds!=='number'||!Number.isFinite(bonusSeconds)||bonusSeconds<0||bonusSeconds>seconds+.03)return bad('Invalid score');
      const runKey='runs/'+runId,run=await store.get(runKey,{type:'json'});
      if(!run||run.used||run.id!==id)return bad('Run expired or already submitted',409);
      const reset=await store.get('resets/'+id,{type:'json'});
      if(reset && Number(reset.at)>=run.startedAt)return bad('This run belongs to a reset account',409);
      const now=Date.now(),elapsed=(now-run.startedAt)/1000;
      // The server independently checks whether the run overlapped the limited-time
      // event. Paused runs may earn less bonus time than the actual clock overlap.
      const eventOverlap=Math.max(0,(Math.min(now,event.end)-Math.max(run.startedAt,event.start))/1000);
      const permittedBonus=eventOverlap>0?Math.min(seconds,eventOverlap+7):0;
      const expectedScore=Math.floor((seconds+bonusSeconds)*145);
      if(elapsed<0||elapsed>86400||seconds>elapsed+7||bonusSeconds>permittedBonus+.1||score>(elapsed+8+eventOverlap+7)*145||Math.abs(score-expectedScore)>3)return bad('Score verification failed',422);
      await store.setJSON(runKey,{...run,used:true});
      // Recheck right before writing, in case the player reset while a score was being verified.
      const latestReset=await store.get('resets/'+id,{type:'json'});
      if(latestReset && Number(latestReset.at)>=run.startedAt)return bad('This run belongs to a reset account',409);
      const key='scores/'+id,prior=await store.get(key,{type:'json'});
      // Recheck persistent ban after run verification and immediately before writing.
      if(prior?.bannedAt||await isBanned(store,id))return bad('This player account has been permanently banned from the leaderboard',403);
      const best=Math.max(score,Number(prior?.score)||0);
      await store.setJSON(key,{...prior,id,name,fullName,showFullName,score:best,updatedAt:new Date().toISOString()});
      const all=await scores(store);
      return json({saved:true,score:best,isPersonalBest:score>(Number(prior?.score)||0),rank:all.findIndex(x=>x.id===id)+1,players:all.length,top:all.slice(0,10).map(({name,fullName,score})=>({name,fullName,score}))});
    }
    return bad('Unknown action');
  }catch(err){
    console.error('Leaderboard API',err);
    return bad('Leaderboard temporarily unavailable',503);
  }
}
