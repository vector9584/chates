/* 运行状态提示（配置待生效 / 重启进行中 / 连接中断 / 配置恢复）
 *
 * 2026-11-14 改造一：原来是自己 createElement 一个 <section class="panel-runtime-bar"> 直塞 body，
 * 并且用 ResizeObserver 往文档根写 --runtime-banner-space 给页面让位 —— 用户看到的就是
 * 「面板底下常驻一条黄色横条，还占着布局」。现在统一走 js/core/utils.js 的通知组件
 * （window.toast / __hzToast），带 key='runtime' 去重：状态没变就原位改字，不变位置、不重放动画。
 *
 * 2026-11-14 改造二（文案）：用户嫌「下一轮生效」含糊。改成分两类说清楚——
 *   热生效（模型/路线/配置恢复）：标题「X 已保存」，正文「下一条消息起生效，不用重启」，
 *     只给一个「知道了」，点了记住这条不再弹（localStorage 按内容签名去重）。
 *     依据：gateway 每轮重新读 config.yaml，模型元数据走 load_config()，(mtime,size) 失效。
 *   需重启（消息渠道 / 输入状态 / MCP）：adapter 在启动时构建，改的是进程内对象，必须重启。
 *   分类只看 reason 前缀，前端算，后端不落字段——改 server JS 要重启，为一个展示字段不值。
 *
 * 语义一条不少：
 *   配置恢复待处理 → 错误级 + 「去核对」
 *   正在重启 / 正在重连 → boot-mask 的输入区面板（真的开始动进程才顶替输入区，排队等待时不显示）
 *   重启失败 / 未获确认 → 通知，可关掉继续说话；记录留在本地，下次进面板仍能看到，成功重启后清掉
 *   热生效改动     → 信息级 + 「知道了」（可记住）
 *   需重启改动     → 警告级 + 「重启应用」「稍后」（忙时排队）
 *   连接连续中断   → 错误级 + 「刷新页面」
 */
(function(){
 'use strict';
 var fails=0;            /* 连续失败计数：单次失败不打扰用户 */
 var latest=null, polling=false, submitting=false, tracking=false, rejected='';
 /* 失败记录落本地：关掉通知还能继续用，下次进来还看得见上次失败；本次会话关过就不再复弹。
    只在同一请求真恢复（或成功重试）后清除，不靠「关了就当没发生」。 */
 var FAILED='panel-restart-failed-v2', SEEN='panel-restart-failed-seen-v2';
 function savedFailure(){
  try{
   var f=JSON.parse(localStorage.getItem(FAILED)||'null');
   if(!f||!f.id||!f.at) return null;
   if(Date.now()-Number(f.at)>3*864e5) return null;   /* 三天前的失败不再提 */
   return f;
  }catch(e){ return null; }
 }
 function saveFailure(f){ try{ localStorage.setItem(FAILED,JSON.stringify(f)); }catch(e){} }
 function dropFailure(){ try{ localStorage.removeItem(FAILED); }catch(e){} }
 function seenFailure(id){ try{ return sessionStorage.getItem(SEEN)===id; }catch(e){ return false; } }
 function markSeen(id){ try{ sessionStorage.setItem(SEEN,id); }catch(e){} }
 /* 一条失败只主动弹一次：用户点右上角 × 关掉后，5 秒轮询不许把它再推回来。
    下次进面板（新的一次加载）仍会弹，这就是「下次上来还看得见」。 */
 var offered=false;
 var generation=0, requestId=null, baseline=null, submittedAt=0;
 var KEY='runtime', snooze=null;   /* snooze={sig,until}：用户点过「稍后」就别每 5 秒再弹 */
 /* 哪些改动下一轮就生效、哪些必须重启：只认 reason 前缀。
    模型与路线、配置保存恢复 = 热生效（gateway 每轮重读 config.yaml）；
    消息渠道 / 输入状态 / MCP = adapter 与进程内连接，重启才换得掉。 */
 var HOT=/^(模型服务与路线|配置保存恢复)/;
 function isHot(c){ return HOT.test(String((c&&c.reason)||'')); }

 /* 「知道了」按内容签名记住：热生效的卡片不该每 5 秒轮询又冒出来 */
 var ACK='panel-runtime-ack-v1';
 function acked(s){ try{ return localStorage.getItem(ACK)===s; }catch(e){ return false; } }
 function ack(s){ try{ localStorage.setItem(ACK,s); }catch(e){} }

 /* 配置变更项的人话：后端只给 'models:update' 这种，直接摆给用户看不懂 */
 var REASON={models:'模型与供应商',model:'模型与供应商',channels:'消息渠道',channel:'消息渠道',
  agents:'助手与提示词',agent:'助手与提示词',mcp:'MCP',tools:'工具集',cron:'定时任务',
  ui:'界面设置',tts:'语音',voice:'语音',plugins:'插件',memory:'记忆',providers:'模型供应商',
  gateway:'网关',security:'安全',workspace:'工作区',
  /* 后端 changed() 传的是中文短语，也得翻成人话，否则卡片标题直接摆一句「模型服务与路线已保存」 */
  '模型服务与路线':'模型与供应商','通讯渠道配置':'消息渠道','配置保存恢复':'配置恢复',
  '输入状态':'输入状态'};
 function reasons(changes){
  var seen={},out=[];
  (changes||[]).forEach(function(c){
   var raw=String((c&&c.reason)||'其他配置').trim();
   /* '输入状态 · qqbot' / 'MCP · zotero' 这种带实例名的，卡片上只留类别，别把服务器名一起喊 */
   var cat=raw.split(' · ')[0], head=cat.split(':')[0];
   var name=REASON[cat]||REASON[head]||REASON[raw]||cat;
   if(!seen[name]){ seen[name]=1; out.push(name); }
  });
  return out.join('、');
 }
 function sig(o){ return o.type+'|'+o.title+'|'+o.message; }
 function show(o){
  var s=sig(o);
  if(o.persist && acked(s)) return;                  /* 热生效卡：点过「知道了」就别再冒出来 */
  if(snooze && snooze.sig===s && Date.now()<snooze.until) return;
  if(snooze && snooze.sig!==s) snooze=null;
  var t=window.__hzToast; if(!t) return;
  var actions=(o.actions||[]).slice();
  /* 主操作放最右（中文界面习惯：次要左、主要右） */
  if(o.snoozable!==false) actions.unshift({label:'稍后',onClick:function(){ snooze={sig:s,until:Date.now()+30*60*1000}; }});
  /* 失败通知用独立 key：它得活得比这轮轮询长，不能被 hide() 或变更卡顺手抹掉 */
  t({key:o.key||KEY,type:o.type,title:o.title,message:o.message,duration:0,closable:o.closable!==false,actions:actions});
 }
 function hide(key){ if(window.__hzToast && window.__hzToast.dismiss) window.__hzToast.dismiss(key||KEY); }

 /* WebKit(Safari/iOS) 对空响应体调 response.json() 会抛 "The string did not match the expected pattern."，
    304、网关空回包、被中间层吞掉响应都会命中，桌面 Chrome 只是报 "Unexpected end of JSON input" 所以看不出来。
    这里改成：先按 document.baseURI 算绝对地址（脚本在 DOMContentLoaded 之前就跑，apiUrl 的 BASE 那时还是空串），
    再取 text 自己解析，空响应换下一个地址并带时间戳重试，最后把 HTTP 状态和字节数写进提示里。 */
 function endpointList(action){
  var path='/api/panel-runtime/'+action,list=[],add=function(u){if(u&&list.indexOf(u)<0)list.push(u);};
  /* 脚本在 DOMContentLoaded 之前执行，此刻全局 BASE 还是空串；<base href> 已经在 head 里解析过了，
     直接读它才能拼出真正的 /app/<应用>/api/... 地址。根路径 '/api/...' 会绕开 base，落到站点根上的别的服务。 */
  try{var tag=document.querySelector('base'),href=tag&&tag.getAttribute('href');if(href){var abs=new URL(href,document.baseURI).pathname.replace(/\/+$/,'');if(abs)add(abs+path);}}catch(e){}
  if(BASE)add(String(BASE).replace(/\/+$/,'')+path);
  try{add(new URL(path,document.baseURI).pathname);}catch(e){}
  try{add(apiUrl(path));}catch(e){}
  add(path);
  return list;
 }
 async function once(url,body){var response=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||'','Cache-Control':'no-cache'},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(5000)});var text='';try{text=await response.text();}catch(e){text='';}if(!text)return {status:response.status,empty:true};try{return {status:response.status,ok:response.ok,data:JSON.parse(text)};}catch(e){return {status:response.status,text:text,badJson:true};}}
 async function request(action,body){
  // POST 返回丢失不等于未受理；不要换地址再发一次，改从状态接口核对。
  var urls=endpointList(action),tries=body?1:2,last='运行状态接口没有响应';
  if(body||tracking){urls=urls.slice(0,1);tries=1;}
  for(var i=0;i<urls.length;i++){
   for(var n=0;n<tries;n++){
    var url=urls[i]+(n?((urls[i].indexOf('?')<0?'?':'&')+'t='+Date.now()):''),out;
    try{out=await once(url,body);}catch(e){out={error:(e&&e.message)||String(e)};}
    if(out.data){if(!out.ok||!out.data.ok){var err=Error(out.data.error||('运行状态读取失败（HTTP '+out.status+'）'));err.confirmed=out.data.ok===false&&out.status<500;throw err;}return out.data;}
    if(out.error){last='网络不可达：'+out.error;continue;}
    last=out.empty?('接口返回空响应（HTTP '+out.status+'）'):('接口返回非 JSON（HTTP '+out.status+'，'+out.text.length+' 字节）');
    if(!out.empty)break;
   }
  }
  throw Error(last+'［已试 '+urls.length+' 个地址］');
 }
 function mask(kind,title,message,actions){hide();window.bootMaskRuntime(kind,title,message,actions);}
 /* 失败一律走通知：不锁输入、能直接关掉，关掉后照常聊天；记录留盘，下次进来还看得到。 */
 function failNotice(rec,data){
  var gateway=data&&data.observation&&data.observation.gateway;
  var usable=(gateway&&gateway.healthy===true)||(data&&data.healthy===true);
  var recovery=data&&data.config_recovery;
  var actions=[{label:'再查一次',run:load}];
  if(usable)actions.push({label:'继续使用',onClick:function(){markSeen(rec.id);hide();return true;}});
  if(recovery&&recovery.ok&&!recovery.pending)actions.push({label:'重试重启',primary:!usable,onClick:function(){markSeen(rec.id);hide();restart();}});
  show({key:'runtime-failure',type:'error',title:rec.title,message:rec.message,snoozable:false,closable:true,actions:actions});
 }
 function offerFailure(rec,data){
  if(!rec||offered||seenFailure(rec.id))return false;
  offered=true;failNotice(rec,data);return true;
 }
 /* 排队状态由状态接口驱动，不再自己记「弹过/关过」——面板按 queue.id 重绘，撤队列才是真结束。 */
 var qShownId=null;
 /* 排队提示也走输入区面板：不许在输入框上方再摞一条浮层（用户 2026-11-20 两次点这个名字）。
    面板在位 = 输入区被接管；想接着说话就点「先不重启」，那是真把队列撤掉，不是把通知关掉。 */
 function queueNotice(queue,text){
  if(!queue)return;
  qShownId=String(queue.id||'');
  mask('queued','重启已排队',text+'\n重启完成后自动回来，不会打断你正在做的事',[{label:'先不重启',run:cancelQueue}]);
 }
 async function cancelQueue(){
  try{await request('cancel',{});}catch(e){}
  queueReset();load();return true;
 }
 function queueReset(){ if(qShownId)window.bootMaskRuntime(); qShownId=null; }
 function queueInfo(queue){
  var text=queue?({busy:'已排队：等待当前会话或后台任务结束',quiet_window:'已排队：等各会话安静下来（约 90 秒）',session_active:'已排队：'+(queue.detail||'还有会话在跑')+'，等它跑完',work_unknown:'已排队：正在核实后台任务状态',blocked:'已排队：等待上一次重启结束',config_recovery:'已排队：等待配置恢复'})[queue.reason]||'已排队：空闲后自动重启':'';
  var label=document.getElementById('overviewRestartStatus');if(label)label.textContent=text;
  return text;
 }
 async function restart(){
  if(submitting||latest?.restart_pending||latest?.restart_blocked)return;
  ++generation;submitting=true;tracking=true;rejected='';fails=0;
  requestId=null;baseline=latest?.restart?.id||null;submittedAt=Date.now();
  var retrying=savedFailure();if(retrying)markSeen(retrying.id);   /* 重试进行中：旧失败先别在排队期反复冒出来 */
  try{
   var result=await request('restart',{interrupt:false});
   if(result.queued&&!result.pending){
    /* 排队等会话/任务结束：不动输入，也不假装在重启。真过了空闲才由状态接口给出 pending。 */
    tracking=false;requestId=null;queueInfo({reason:/核实/.test(result.waiting_reason||'')?'work_unknown':'busy'});
   }else{requestId=result.id||null;mask('restarting','正在重启 Hermes…','服务恢复后自动继续');}
  }catch(e){
   rejected=e.confirmed?e.message:'暂未收到重启回执，请先核对服务状态';
   tracking=false;requestId=null;
   if(e.confirmed){
    var rec={id:'submit-'+submittedAt,at:Date.now(),title:'重启未能开始',message:rejected};
    saveFailure(rec);offered=false;offerFailure(rec,latest||{});
   }else{
    mask('reconnecting','正在确认重启请求…',rejected,[{label:'再查一次',run:load}]);
   }
  }finally{submitting=false;load();}
 }
 window.panelRuntimeRestart=restart;

 function renderRestart(data){
  var rs=data.restart||{},queue=data.restart_queue;
  queueInfo(queue);
  if(data.restart_blocked||data.restart_pending){
   /* 进程真开始动了：这一刻才锁输入 */
   tracking=true;rejected='';requestId=rs.id||null;
   var checking=data.restart_blocked&&!data.restart_pending;
   mask(checking?'reconnecting':'restarting',checking?'正在确认重启结果…':'正在重启 Hermes…',checking?(data.restart_block_reason||'确认完成后自动继续'):'服务恢复后自动继续',checking?[{label:'再查一次',run:load}]:[]);
   return true;
  }
  if(queue){
   /* 排队：同一块输入区面板换文案，不另起浮层、也不假装在重启（进程还没动） */
   tracking=false;rejected='';requestId=null;
   queueNotice(queue,queueInfo(queue));
   return true;
  }
  queueReset();
  window.bootMaskRuntime();
  var matches=requestId?rs.id===requestId:!!rs.id&&rs.id!==baseline&&(!submittedAt||Number(rs.requested_at)>=submittedAt-5000);
  if(tracking&&matches&&data.ready){
   /* 同一请求真恢复：旧失败记录到此为止 */
   tracking=false;rejected='';requestId=null;dropFailure();hide('runtime-failure');window.bootMaskRuntime();
   if(typeof tickStatus==='function')tickStatus();
   return false;
  }
  var failed=rs.status==='failed'&&(tracking?matches:Date.now()-Number(rs.requested_at||0)<10*60*1000);
  if(failed){
   var rec={id:rs.id,at:Number(rs.requested_at)||Date.now(),
    title:rs.failure_reason==='timeout'?'未确认重启成功':'重启失败',
    message:rs.error||'重启未完成，请再查一次'};
   var old=savedFailure();if(!old||old.id!==rec.id)saveFailure(rec);
   /* 失败不是「正在重启」：先撤锁，再走通知，别再拿 reconnecting 蒙版糊着 */
   tracking=false;rejected='';window.bootMaskRuntime();
   if(offerFailure(savedFailure(),data))return true;
  }
  /* 之后又有一次重启成功了：旧的失败记录自动作废，别一直挂着一周前的红字 */
  var stale=savedFailure();
  if(stale&&rs.id&&rs.id!==stale.id&&rs.status==='ready'){dropFailure();hide('runtime-failure');}
  if(tracking&&!data.ready){mask('reconnecting','正在确认重启结果…','正在等待服务返回可用状态',[{label:'再查一次',run:load}]);return true;}
  if(tracking){tracking=false;requestId=null;}
  window.bootMaskRuntime();
  if(offerFailure(savedFailure(),data))return true;
  return false;
 }
 function render(data){
  if(renderRestart(data))return;
  var recovery=data.config_recovery, needsRecovery=recovery&&(!recovery.ok||recovery.pending);
  if(needsRecovery){
   show({type:'error',title:recovery.ok?'上次配置没保存完':'配置保存出错',message:String(recovery.ok?'点开核对后恢复，已存的数据不会丢':recovery.error||''),
    snoozable:false,actions:[{label:'去核对',primary:true,onClick:function(){switchPage('updates');window.renderConfigRecovery?.();document.getElementById('configRecovery')?.scrollIntoView({block:'start'});return true;}}]});
   return;
  }

  var changes=data.changes||[], n=changes.length;
  if(n<1){hide();return;}

  var hotList=changes.filter(isHot), coldList=changes.filter(function(c){return !isHot(c);});
  var workUnknown=!!(data.observation&&data.observation.gateway&&data.observation.gateway.work_known===false);

  /* 一、全是热生效的：下一条消息就用新的。别挂重启按钮，也别再提「重启」两个字 */
  if(!coldList.length){
   var hot={type:'info',persist:true,snoozable:false,
    title:reasons(hotList||changes)+'已保存',
    message:'下一条消息起生效，不用重启'};
   hot.actions=[{label:'知道了',primary:true,onClick:function(){ack(sig(hot));hide();return true;}}];
   show(hot);
   return;
  }
  /* 二、有必须重启的：只点名这些；热生效的会跟着一起过去，不重复念叨 */
  var line=(data.busy||workUnknown)?'会等当前会话与后台任务结束后重启，不打断正在执行的任务':'应用重启后加载新配置';
  var cnames=reasons(coldList);
  show({type:'warning',title:cnames+(coldList.length>1?' 等 '+coldList.length+' 项':'')+'需要重启',message:line,
   actions:[{label:'重启应用',primary:true,onClick:restart}]});
 }
 async function load(){
  if(polling||submitting||!monitorToken)return;
  polling=true;var observedGeneration=generation;
  try{var data=await request('status');if(submitting||observedGeneration!==generation)return;latest=data;fails=0;render(data);}
  catch(error){if(submitting||observedGeneration!==generation)return;fails++;
   /* 单次失败不弹：iOS 回前台、切网、代理重连都会丢一两包。连续 6 次（30s）还不回来才升级成通知，
      而且只说人话，不把「网络不可达：...［已试 N 个地址］」这种内部排查信息甩到用户脸上。 */
   if(tracking||latest?.restart_queue){
    mask('reconnecting','正在重新连接 Hermes…','服务恢复后自动继续',[{label:'再查一次',run:load}]);
   }else if(window.__bootMaskActive){hide();}
   else if(fails>=6){
    show({type:'error',title:'连接已中断 '+(fails*5)+' 秒，仍在重试',message:'网络恢复后会自动连上；也可以手动刷新',snoozable:false,
     actions:[{label:'刷新页面',primary:true,onClick:function(){location.reload();return true;}}]});
   }else if(window.console)console.warn('[panel-runtime] 读取失败，静默重试：',(error&&error.message)||error);
  }finally{polling=false;}
 }
 window.panelRuntimeRefresh=load;
 load();
/* monitorToken 由 index 内联脚本赋值，本文件可能先执行 → 补两次近距重试，别让用户干等 5 秒才看到通知 */
setTimeout(load,700);setTimeout(load,1800);
setInterval(function(){if(!document.hidden)load();},5000);
 document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')setTimeout(load,800);});
})();
