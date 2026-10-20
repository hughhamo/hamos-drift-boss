import { getStore } from '@netlify/blobs';

const cleanName = v => String(v ?? '').trim().replace(/[^a-zA-Z0-9 _-]/g,'').replace(/\s+/g,' ').slice(0,18);
const cleanFull = v => String(v ?? '').trim().replace(/[^a-zA-ZÀ-ž '\-]/g,'').replace(/\s+/g,' ').slice(0,48);
const isID = v => typeof v==='string' && /^[0-9a-f-]{36}$/i.test(v);
const json = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const bad = (message,status=400)=>json({error:message},status);
const storeName='drift-boss-global-leaderboard';

async function scores(store){
  let cursor,records=[];
  do{
    const page=await store.list({prefix:'scores/',...(cursor?{cursor}:{})});
    records.push(...await Promise.all(page.blobs.map(x=>store.get(x.key,{type:'json'}).catch(()=>null))));
    cursor=page.cursor;
  }while(cursor&&records.length<3000);
  return records.filter(x=>x&&typeof x.name==='string'&&Number.isInteger(x.score))
    .map(x=>({name:cleanName(x.name),score:x.score,id:x.id,fullName:x.showFullName?cleanFull(x.fullName):'',updatedAt:x.updatedAt||''}))
    .sort((a,b)=>b.score-a.score||a.updatedAt.localeCompare(b.updatedAt));
}
export default async function leaderboard(req){
  try{
    const store=getStore({name:storeName,consistency:'strong'});
    if(req.method==='GET'){
      const all=await scores(store);
      return json({online:true,top:all.slice(0,50).map(({name,fullName,score,updatedAt})=>({name,fullName,score,updatedAt})),players:all.length});
    }
    if(req.method!=='POST')return bad('Method not allowed',405);
    if(Number(req.headers.get('content-length')||0)>2048)return bad('Too large',413);
    const raw=await req.text();
    if(raw.length>2048)return bad('Too large',413);
    let data;try{data=JSON.parse(raw)}catch{return bad('Invalid JSON')}
    if(!data||typeof data!=='object')return bad('Invalid data');
    const id=data.playerId;
    // Keep the old competition record out of the rankings before acknowledging a reset.
    // This separate deletion never modifies any other player's stored record.
    if(data.action==='delete'){
      if(!isID(id))return bad('Invalid player ID');
      const key='scores/'+id;
      await store.setJSON('resets/'+id,{at:Date.now()});
      await store.delete(key);
      return json({deleted:true});
    }
    const name=cleanName(data.name),fullName=cleanFull(data.fullName),showFullName=data.showFullName===true&&fullName.length>=3;
    if(!isID(id)||name.length<2)return bad('Choose a nickname of at least two characters');
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
      const {score,seconds,runId}=data;
      if(!isID(runId)||!Number.isInteger(score)||score<1||score>50000000||!Number.isFinite(seconds)||seconds<0||seconds>86400)return bad('Invalid score');
      const runKey='runs/'+runId,run=await store.get(runKey,{type:'json'});
      if(!run||run.used||run.id!==id)return bad('Run expired or already submitted',409);
      const reset=await store.get('resets/'+id,{type:'json'});
      if(reset && Number(reset.at)>=run.startedAt)return bad('This run belongs to a reset account',409);
      const elapsed=(Date.now()-run.startedAt)/1000;
      if(elapsed<0||elapsed>86400||seconds>elapsed+7||score>(elapsed+8)*145||Math.abs(score-Math.floor(seconds*145))>3)return bad('Score verification failed',422);
      await store.setJSON(runKey,{...run,used:true});
      // Recheck right before writing, in case the player reset while a score was being verified.
      const latestReset=await store.get('resets/'+id,{type:'json'});
      if(latestReset && Number(latestReset.at)>=run.startedAt)return bad('This run belongs to a reset account',409);
      const key='scores/'+id,prior=await store.get(key,{type:'json'});
      const best=Math.max(score,Number(prior?.score)||0);
      await store.setJSON(key,{...prior,id,name,fullName,showFullName,score:best,updatedAt:new Date().toISOString()});
      const all=await scores(store);
      return json({saved:true,score:best,isPersonalBest:score>(Number(prior?.score)||0),rank:all.findIndex(x=>x.id===id)+1,players:all.length});
    }
    return bad('Unknown action');
  }catch(err){
    console.error('Leaderboard API',err);
    return bad('Leaderboard temporarily unavailable',503);
  }
}
