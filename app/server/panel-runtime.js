import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRestartWorker,launchRestartWorker} from './panel-restart-worker.js';
import {StateFile,stateError} from './panel-state.js';

export class PanelRuntime{
 constructor({root,source,started=Date.now(),available=()=>true,busy=()=>false,activity=()=>0,quietSeconds=90,observation=()=>null,prepare=async()=>{},drain=null,receipt=null,worker=createRestartWorker(),recovery=()=>({ok:true,pending:null}),start=spawn,now=Date.now}){
  Object.assign(this,{root,source,started,available,busy,activity,quietSeconds,observation,prepare,drain,receipt,worker,recovery,start,now});this.timer=null;this.cleanupRetryAt=0;this.pendingFailure=null;this.pumping=false;
  this.file=new StateFile(join(root,'runtime-apply.json'),()=>({version:1,changes:[],restart:null,queue:null}),{validate:d=>d?.version===1&&Array.isArray(d.changes)});
  // 单飞排队：全局只有一个待执行重启，多个会话重复请求只保留一条。
  // 定时复查忙闲，空闲才走正式脚本；定时器不阻止进程退出。
  this.pumpTimer=setInterval(()=>this.pumpQueue(),4000);this.pumpTimer.unref?.();
 }
 /* activity() 的两种返回值都认：数字（旧：最后活动时间）或 {at,desc,age,sid}（新：带 gateway 实时状态） */
 activityFacts(){
  const raw=this.activity?.()||{},t=this.now()/1000;
  const obj=raw&&typeof raw==='object';
  const lastAt=Number(obj?raw.at||0:raw)||0;
  const desc=String((obj&&raw.desc)||'').trim();
  const age=obj&&raw.age!=null?Number(raw.age)||0:lastAt?Math.max(0,Math.round(t-lastAt)):Infinity;
  return {lastAt,desc,age,sid:obj?raw.sid||'':'',idleFor:lastAt?t-lastAt:Infinity,quiet:Number(this.quietSeconds)||90};
 }
 queueTrace(event,extra={}){
  try{fs.mkdirSync(this.root,{recursive:true,mode:0o700});fs.appendFileSync(join(this.root,'restart-queue.log'),JSON.stringify({at:new Date(this.now()).toISOString(),event,...extra})+'\n',{mode:0o600});}catch{}
 }
 queueSnapshot(queue,state={}){
  if(!queue)return null;
  const a=this.activityFacts();
  const reason=state.blocked?'blocked':state.pending?'restart_pending':a.desc?'session_active':state.busy?'busy':a.idleFor<a.quiet?'quiet_window':state.workUnknown?'work_unknown':state.configPending?'config_recovery':'idle';
  return {id:queue.id,requested_at:queue.requested_at,note:queue.note||'',waiting_since:queue.requested_at,reason,detail:a.desc||'',error:queue.error||null};
 }
 /* 撤掉排队：用户在输入区面板上点「先不重启」走这里。真把队列清掉，不是把提示关掉。 */
 cancel(){const q=this.file.read().queue;if(!q)return {ok:true,cancelled:null};this.clearQueue();return {ok:true,cancelled:q.id};}
 clearQueue(){let cleared=null;try{this.file.update(data=>{if(data.queue){cleared=data.queue;data.queue=null;}});}catch{}if(cleared)this.queueTrace('cleared',{id:cleared.id});}
 async pumpQueue(){
  if(this.pumping)return;this.pumping=true;
  try{
   const queued=this.file.read().queue;if(!queued)return;
   let status;try{await this.prepare();status=this.status();}catch{this.queueTrace('skip',{id:queued.id,reason:'status_unavailable'});return;}
   if(status.restart_pending||status.restart_blocked){this.queueTrace('skip',{id:queued.id,reason:status.restart_blocked||'restart_pending'});return;}
   if(!status.config_recovery.ok||status.config_recovery.pending){this.queueTrace('skip',{id:queued.id,reason:'config_recovery'});return;}
   /* 两个判据，缺一不可：
      ① 会话实时状态（gateway 写在 sessions.last_activity_description，如 "receiving stream response"）
         非空 = 这轮真的还在跑，哪怕已经 10 分钟没落库也不许打断——长生成就是这种形状。
      ② 状态已清空 = 一轮结束，再看 quietSeconds 内有没有人写过消息，防止「刚说完最后一句」那一下被抢。
      只按 busy 快照会在 06:37:02 派发、06:37:03 人家还在写（用户当场就问「明明有会话在跑」）；
      只看时间戳又会在长生成里静默 90 秒就当成空闲。 */
   const a=this.activityFacts();
   if(!a.lastAt&&!a.desc)this.queueTrace('warn',{id:queued.id,reason:'activity_unreadable'});   /* 读不到就照旧放行，但留痕，别悄悄退化成老行为 */
   if(a.desc){this.queueTrace('wait',{id:queued.id,reason:'session_active',desc:a.desc,age_s:a.age,session:a.sid||''});return;}
   if(a.idleFor<a.quiet){this.queueTrace('wait',{id:queued.id,reason:'quiet_window',idle_s:Math.round(a.idleFor)});return;}
   if(status.busy){this.queueTrace('wait',{id:queued.id,reason:'busy'});return;}
   if(status.observation?.gateway?.work_known===false){this.queueTrace('wait',{id:queued.id,reason:'work_unknown'});return;}
   let taken=null;this.file.update(data=>{if(data.queue&&data.queue.id===queued.id){taken=data.queue;data.queue=null;}});
   if(!taken)return;
   this.queueTrace('dispatch',{id:taken.id});
   try{this.restart({interrupt:false,note:taken.note||'queued'});}
   catch(error){
    // 派发瞬间忙闲变化：放回队列（沿用同一个 id，不重复建任务）
    try{this.file.update(data=>{if(!data.queue)data.queue={...taken,error:error.status?error.message:'重启派发失败'};});}catch{}
    this.queueTrace('requeue',{id:taken.id,error:error.status?error.message:'dispatch_failed'});
   }
  }finally{this.pumping=false;}
 }
 releaseDrain(restart){
  try{this.drain?.release(restart.id);restart.drain_cleanup={status:'released',at:this.now()};}
  catch{restart.drain_cleanup={status:'pending',at:this.now(),error:'暂停接收状态尚未释放，正在重试；释放完成前不能再次重启'};}
  this.cleanupRetryAt=this.now()+5000;
 }
 status(){if(this.pendingFailure){const pending=this.pendingFailure;this.failed(pending.id,pending.error);if(this.pendingFailure)throw stateError('重启结果暂时无法保存，请检查状态目录后重试',503);}const data=this.file.read(),restart=data.restart,healthy=this.available(),config_recovery=this.recovery();let dirty=false;
  /* 待重启清单只认「当前进程启动之前/之后」这条界：进程启动前改的配置，当前进程装载时已经读进去了，
     不需要再重启。旧逻辑用 restart.requested_at 当界线，只有面板自己发起的重启才会更新它；
     用户用 fnos-cli 手工重启时不经过面板，界线永远停在很久以前，旧的改动就永远清不掉
     （2026-11-17 实测：restart.requested_at 停在 11-14 22:13，16:48 改的「扩展配置」一直报需要重启）。 */
  {const live=Array.isArray(data.changes)?data.changes.filter(change=>Number(change.at)>this.started):[];
   if(live.length!==(data.changes||[]).length){data.changes=live;dirty=true;}}
  if(restart?.drain_cleanup?.status==='pending'&&this.now()>=this.cleanupRetryAt){this.releaseDrain(restart);dirty=true;}
  const awaitingReceipt=restart?.status==='requested'||(restart?.status==='failed'&&restart.failure_reason==='timeout');
  if(awaitingReceipt&&(this.receipt?this.receipt.verify(restart.before,restart.id,restart.worker&&{pid:restart.worker.pid,start:restart.worker.start}):this.started>restart.requested_at)){restart.status='restarted';restart.observed_at=this.started;dirty=true;}
  if(restart?.status==='restarted'&&healthy&&config_recovery.ok&&!config_recovery.pending&&restart.drain_cleanup?.status!=='pending'){
   restart.status='ready';restart.ready_at=this.now();delete restart.error;delete restart.failure_reason;data.changes=data.changes.filter(change=>change.at>restart.requested_at);dirty=true;
  }
  if(['requested','restarted'].includes(restart?.status)&&this.now()-restart.requested_at>90000){
   restart.status='failed';restart.failure_reason='timeout';restart.error='应用未在预期时间内恢复健康，仍在核实恢复结果；请检查维护记录';
   if(!restart.drain_cleanup)this.releaseDrain(restart);dirty=true;
  }
  if(dirty)this.file.write(data);
  const worker_state=restart?.worker&&!restart.worker_finished?this.worker.observe(restart.worker).state:'exited';
  const restart_block_reason=restart?.drain_cleanup?.status==='pending'?restart.drain_cleanup.error:worker_state==='running'?'正式重启脚本仍在执行，正在核实结果；暂不能再次重启':worker_state==='unverified'?'暂时无法核实正式重启脚本是否结束，请检查运行状态后重试':null;
  const busy=!!this.busy(),observation=this.observation();
  const restart_pending=['requested','restarted'].includes(restart?.status),restart_blocked=!!restart_block_reason;
  const {queue:queued,...rest}=data;
  return {...rest,config_recovery,healthy,observation,busy,started_at:this.started,restart_pending,restart_worker_state:worker_state,restart_block_reason,restart_blocked,
   restart_queue:this.queueSnapshot(queued,{busy,pending:restart_pending,blocked:restart_blocked,workUnknown:observation?.gateway?.work_known===false,configPending:!config_recovery.ok||!!config_recovery.pending}),
   ready:restart?.status==='ready'&&healthy&&config_recovery.ok&&!config_recovery.pending};
 }
 changed(reason){return this.file.update(data=>{const label=String(reason||'配置修改').slice(0,120);const same=data.changes.find(item=>item.reason===label);if(same)same.at=this.now();else data.changes.push({id:randomUUID(),reason:label,at:this.now()});});}
 async requestRestart(body={}){await this.prepare();return this.restart(body);}
 restart(body={}){
  if(!body||typeof body!=='object'||Array.isArray(body)||('interrupt'in body&&typeof body.interrupt!=='boolean'))throw stateError('重启请求格式不正确');
  const interrupt=body.interrupt===true;
  const status=this.status();
  if(status.restart_blocked)throw stateError(status.restart_block_reason,409);if(status.restart_pending)return {ok:true,queued:true,pending:true,already_queued:true,id:status.restart?.id||null,waiting_reason:'应用重启已在进行'};
  if(!status.config_recovery.ok||status.config_recovery.pending)throw stateError('有未处理的配置保存，请先到本地维护核对并恢复',409);
  /* 单飞排队（2026-11-19）：忙不报错，改为入队。全局只有一个待执行项，
     多个会话连点只保留第一条；由 pumpQueue 在真正空闲后走正式脚本。 */
  const workUnknown=status.observation?.gateway?.work_known===false;
  if((status.busy||workUnknown)&&!interrupt){
   const note=String(body.note||'').slice(0,120);let entry=null,created=false;
   this.file.update(data=>{if(!data.queue){data.queue={id:randomUUID(),requested_at:this.now(),note};created=true;}entry={...data.queue};});
   this.queueTrace(created?'enqueue':'dedupe',{id:entry.id,busy:!!status.busy,work_unknown:workUnknown});
   return {ok:true,queued:true,restart_requested:false,id:entry.id,already_queued:!created,waiting_reason:workUnknown?'暂时无法核实外部渠道与定时任务是否空闲':'仍有会话或任务在执行'};
  }
  if(interrupt)this.clearQueue();
  const script=join(this.source,'dev/hermes-dev.sh');if(!fs.existsSync(script))throw stateError('正式重启脚本不存在，尚未发起重启',503);
  const before=this.receipt?this.receipt.capture():null;const requested_at=this.now(),id=randomUUID();this.file.update(data=>{data.restart={id,status:'requested',requested_at,interrupt:!!interrupt,before};});
  // Respond before fnOS replaces this Monitor. Only the approved script controls
  // process lifecycle. On the next boot, status() observes a new Monitor start.
  this.timer=setTimeout(async()=>{
   let fd,drainResult;
   try{await this.prepare();const latest=this.status();if(latest.restart?.id!==id||latest.restart.status!=='requested')return;if(!latest.config_recovery.ok||latest.config_recovery.pending){this.failed(id,'执行重启前发现待恢复配置，尚未重启');return;}if(!interrupt&&(latest.busy||latest.observation?.gateway?.work_known===false)){this.requeue(id,'busy_at_dispatch','执行前检测到新的会话或任务，已改为排队等待空闲');return;}}catch{this.failed(id,'执行重启前无法核实运行状态，尚未重启');return;}
   try{if(this.drain)drainResult=await this.drain.begin(id,{interrupt});const latest=this.status();if(latest.restart?.id!==id||latest.restart.status!=='requested'||!latest.config_recovery.ok||latest.config_recovery.pending)throw stateError('排空期间运行状态或配置发生变化，已取消重启',409);if(!interrupt&&latest.busy)throw stateError('排空期间出现新的面板任务，已取消重启',409);}catch(error){if(!interrupt&&error.status){this.requeue(id,'busy_during_drain',error.message);return;}this.failed(id,error.status?error.message:'重启排空未完成，尚未重启');return;}
   try{if(this.receipt){const current=this.receipt.capture();if(current.pid!==before.pid||current.start!==before.start)throw stateError('派发前Monitor身份已改变，尚未执行重启',409);}if(this.drain&&!drainResult?.skipped){this.drain.validate?.(id);this.drain.dispatch?.(id);}fs.mkdirSync(this.root,{recursive:true,mode:0o700});fd=fs.openSync(join(this.root,'restart.log'),'a',0o600);
    launchRestartWorker({start:this.start,source:this.source,fd,worker:this.worker,requestId:id,python:this.receipt?.python,app:this.receipt?.app,home:this.receipt?.home,varDir:this.receipt?.varDir,node:this.receipt?.node,
     persist:identity=>this.file.update(data=>{if(data.restart?.id!==id||data.restart.status!=='requested')throw Error('restart request changed');data.restart.worker=identity;}),
     onError:()=>this.failed(id,'正式重启脚本启动通道失败，请查看维护记录'),
     onExit:(code,signal)=>{try{this.file.update(data=>{if(data.restart?.id===id)data.restart.worker_finished={at:this.now(),code,signal:signal||null};});}catch{}if(code!==0)this.failed(id,signal?'正式重启脚本被中断，请查看维护记录':'正式重启脚本未成功退出，请查看维护记录');}
    });
   }catch(_){this.failed(id,'重启启动确认未完成，请检查状态存储与权限；正在核实子进程结果');}finally{if(fd!==undefined)fs.closeSync(fd);}
  },500);this.timer.unref?.();return {ok:true,restart_requested:true,id};
 }
 requeue(id,note,message){
  this.failed(id,message);
  try{this.file.update(data=>{if(!data.queue)data.queue={id:randomUUID(),requested_at:this.now(),note};});}catch{}
  this.queueTrace('requeue',{id,note,message});
 }
 failed(id,error){
  // Ignore late events belonging to an older request or an already verified restart.
  try{this.file.update(data=>{if(data.restart?.id!==id||data.restart.status!=='requested')return;
   Object.assign(data.restart,{status:'failed',failure_reason:'execution',error});this.releaseDrain(data.restart);
  });this.pendingFailure=null;}catch{this.pendingFailure={id,error};}
 }
 stop(){clearTimeout(this.timer);clearInterval(this.pumpTimer);}
}
export function createRuntimeHandler({runtime,checkToken}){
 return async(req,path)=>{if(!path.startsWith('/api/panel-runtime/'))return null;const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理运行状态'},401);
  try{if(path==='/api/panel-runtime/status'&&req.method==='GET')return reply({ok:true,...(await runtime.prepare(),runtime.status())});if(path==='/api/panel-runtime/restart'&&req.method==='POST')return reply(await runtime.requestRestart(await req.json()));if(path==='/api/panel-runtime/cancel'&&req.method==='POST')return reply(runtime.cancel());throw stateError('运行状态操作不存在',404);}catch(error){return reply({ok:false,error:error.status?error.message:'运行状态读取失败，请重试'},error.status||503);}
 };
}
