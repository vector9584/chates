import {createVoiceSettings} from './panel-voice-settings.js';
import {createSpeechService} from './panel-speech.js';
import {readFileSync,existsSync,mkdirSync,readdirSync,lstatSync,statSync,unlinkSync,realpathSync,renameSync,rmdirSync,closeSync} from 'fs';
import {join,dirname,relative,sep} from 'path';
import {randomUUID,createHash} from 'crypto';
import {StateFile, SessionDrafts, atomicWrite, safeId, stateError, digest} from './panel-state.js';
import {createSessionReasoning} from './panel-session-reasoning.js';
import {existingSessionWorkdir, ensureDirectory} from './panel-session-media.js';
import {openStaticFile} from './panel-files.js';
import {planSystem} from './panel-plans.js';
import {expertCatalog,getExpert,saveExpert,undoExpert} from './panel-experts.js';
import {execFile} from 'child_process';
import {promisify} from 'util';
const run=promisify(execFile);
const DATA=process.env.DATA_DIR||'/vol1/@apphome/hermes-agent/data';
const VAR=process.env.VAR_DIR||'/vol1/@appdata/hermes-agent';
const APP=process.env.APP_DIR||'/vol1/@appcenter/hermes-agent';
const PYTHON=process.env.PANEL_PYTHON||join(DATA,'venv/bin/python3');
const SERVER_ROOT=process.env.PANEL_SERVER_ROOT||APP;
const FILE=join(DATA,'panel-workspace.json');
const ROOT=join(VAR,'panel-state');
const overlay=new StateFile(join(ROOT,'workspace.json'),()=>({version:2}),{validate:d=>d&&d.version===2});
const drafts=new SessionDrafts(ROOT);
const sessionReasoning=createSessionReasoning(ROOT);
const defaults=()=>({version:1,folders:[],sessions:{},identity:{user_name:'Vector',user_avatar:'👤',assistant_name:'Hermes',assistant_avatar:'🤖',avatar_shape:'rounded'},voice:{engine:'windows',fallback:true,system_voice:'zh-CN-XiaoxiaoNeural'},favorites:[]});
function readLegacy(){const d=existsSync(FILE)?JSON.parse(readFileSync(FILE,'utf8')):{};return {...defaults(),...d,identity:{...defaults().identity,...d.identity},voice:{...defaults().voice,...d.voice}};}
export function readWorkspace(){const d=readLegacy(),o=overlay.read();return {...d,...o,identity:{...d.identity,...o.identity},voice:{...d.voice,...o.voice},sessions:{...d.sessions,...o.sessions}};}
/* ── 会话工作区目录（2026-11-16）──────────────────────────────────────
 * 需求原话：「创建新会话时，工作区文件夹就按照归类去创建文件夹……实际工作区
 * 也是隔离的，尤其是里面产生的一些附件、图片、文件等，只有表情包之类的是公共的」。
 *
 * 路径规则：data/sessions/<归类文件夹名>/<会话ID>/uploads
 * 未归类的落 未分类（2026-11-19 从 _未归类 改名：用户要的就是界面上那个「未分类」）。
 * 归类改了会把整个会话目录搬过去（见 PUT /session），附件不会失联。
 *
 * 为什么单独抽出来：monitor.js 的附件上传（upload-image / upload-file）也要落
 * 到会话目录，两处必须用同一套规则，否则目录名一会儿这样一会儿那样对不上。
 */
const slugPart=v=>String(v||'').replace(/[^\w\u4e00-\u9fa5-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40);
/* 归类是树：父级必须落进路径，否则「NAS管理/文件处理」和单独的「文件处理」
   会撞进同一个 sessions/文件处理/。按 parent_id 往上走，最多 8 层防环。 */
function groupChain(d,folder){
 const out=[];let cur=folder,guard=0;
 while(cur&&guard++<8){out.unshift(slugPart(cur.name)||'未分类');cur=d.folders.find(f=>f.id===cur.parent_id);}
 return out.length?out:['未分类'];
}
/* 每会话产物目录（2026-11-20 用户两次校准后定稿）。
   第一版按文件格式分了六个（截图/语音/生图/杂项…），用户当场否掉：
   「分类也不要太多不然你又要建很多空文件夹」。格式不是业务，按用途分三类就够：
   uploads=你发我的，artifacts=我给你的成品（图/表/截图/音频/生图/文档），
   code=脚本与代码。stickers 不在分类里，它是 preserveSessionStickers 的归档目标，
   历史消息里 session-sticker URL 直接指着它，只为兼容保留。
   骨架只建 uploads（上传接口要立刻可写），其余按需建 —— 不产生空目录。 */
export const SESSION_SUBDIRS=Object.freeze(['uploads','artifacts','code','stickers']);
export function sessionGroupDir(sid){
 const d=readWorkspace(),meta=d.sessions[sid]||{},folder=d.folders.find(f=>f.id===meta.folder_id);
 const parts=groupChain(d,folder);
 return {group:parts.join('/'),rel:join('sessions',...parts,sid)};
}
/* 归类变更时把整个会话目录搬到新组（2026-11-19）。
 * 不搬会怎样：路径按当前 folder_id 现算，改完归类新路径指向新组，
 * 旧附件留在旧目录 → session-file 一律 404，用户以为附件没了。 */
/* 搬完把空出来的归类目录收掉：不清就会在「全部会话」里留一串空文件夹，
   下次同名归类还可能撞进去，看着像会话还在那儿。只在目录真的空时才 rmdir。 */
function pruneEmptyGroups(from){
 let dir=dirname(from);const root=join(DATA,'sessions');
 while(dir!==root&&dir.startsWith(root+sep)){
  let names;try{names=readdirSync(dir);}catch(e){return;}
  if(names.length)return;
  try{rmdirSync(dir);}catch(e){return;}
  dir=dirname(dir);
 }
}
function moveSessionDir(sid,oldRel){
 const newRel=sessionGroupDir(sid).rel;
 if(!oldRel||oldRel===newRel)return newRel;
 const from=join(DATA,oldRel),to=join(DATA,newRel);
 try{
  if(existsSync(from)&&!existsSync(to)){
   ensureDirectory(DATA,...newRel.split('/').slice(0,-1));
   renameSync(from,to);
  }else if(existsSync(from)&&existsSync(to)){
   for(const n of readdirSync(from)){
    const f=join(from,n),t=join(to,n);
    if(!existsSync(t))renameSync(f,t);
   }
   try{rmdirSync(from);}catch(e){}
  }
 }catch(e){/* 搬迁失败不该挡住建档，路径已按新组算，下次上传会重建 */}
 if(!existsSync(from))pruneEmptyGroups(from);
 return newRel;
}
/* 文件夹改名/换父级/删除都会改整条归类链，磁盘目录必须跟着搬（2026-11-20）。
 * 不搬的后果不是「旧图显示不出来」那么轻：读路径按会话 ID 扫盘，会扫到旧目录；
 * 新产物按新链算路径，写进另一处同名会话目录。两处并存后 groupDirs 命中 2 个，
 * 文件列表只能挑一个 —— 用户看到的就是「图凭空少了一半」。 */
function subtreeSessionIds(d,folderId){
 const ids=new Set([folderId]);
 for(let grew=true;grew;){
  grew=false;
  for(const f of d.folders)if(!ids.has(f.id)&&ids.has(f.parent_id)){ids.add(f.id);grew=true;}
 }
 return Object.entries(d.sessions).filter(([,m])=>ids.has(m&&m.folder_id)).map(([sid])=>sid);
}
function relativeWorkdirs(sids){
 const out=new Map();
 for(const sid of sids){
  try{out.set(sid,relative(DATA,existingSessionWorkdir(DATA,sid,sessionGroupDir(sid).rel)));}catch(e){}
 }
 return out;
}
function relocateWorkdirs(sids,oldRels){
 for(const sid of sids)if(oldRels.has(sid))try{moveSessionDir(sid,oldRels.get(sid));}catch(e){}
}
// Only the file routes accept kernel-only sessions. Drafts, plans and the rail
// still require an actual panel chat; do not fabricate a JSON record for them.
const DB_SESSION_QUERY=`import sqlite3,sys
from pathlib import Path
with sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True,timeout=1) as db:
 print(1 if db.execute('SELECT 1 FROM sessions WHERE id=?',(sys.argv[2],)).fetchone() else 0)
`;
const fileSessionLookups=new Map();
async function validFileSession(sid){
 if(validSession(sid))return true;
 if(existsSync(join(VAR,'chat/archived-sessions',sid+'.json')))return false;
 let pending=fileSessionLookups.get(sid);
 if(!pending){
  pending=run(PYTHON,['-B','-c',DB_SESSION_QUERY,join(DATA,'state.db'),sid],{timeout:2000,maxBuffer:4096,env:{...process.env,PYTHONIOENCODING:'utf-8'}})
   .then(({stdout})=>stdout.trim()==='1',()=>{throw stateError('无法核实会话，暂不能访问会话文件',503);})
   .finally(()=>fileSessionLookups.delete(sid));
  fileSessionLookups.set(sid,pending);
 }
 return pending;
}
export async function resolveSessionFileDir(sid){
 if(!sid||!await validFileSession(sid))throw stateError('会话不存在',404);
 const {rel}=sessionGroupDir(sid);
 return existingSessionWorkdir(DATA,sid,rel);
}
export async function ensureSessionUploadDir(sid){
 const workdir=await resolveSessionFileDir(sid);
 const dir=relative(DATA,workdir);
 /* 只建 uploads：上传接口要立刻可写。artifacts/code 由 session_dir.py 按需建，
    不预建 —— 几百个会话各建三个空目录等于把树撑爆（用户原话：别建很多空文件夹）。 */
 const base=ensureDirectory(DATA,...dir.split('/'));
 const dirs={};
 for(const sub of SESSION_SUBDIRS)dirs[sub]=relative(DATA,join(base,sub));
 ensureDirectory(base,'uploads');
 return {group:dir.split('/').slice(1,-1).join('/'),dir,uploads:dirs.uploads,dirs,abs:join(DATA,...dirs.uploads.split('/'))};
}
export function bindSessionPlan(id,plan){if(!validSession(id))throw stateError('会话不存在',404);const d=readWorkspace(),meta=d.sessions[id]||{};if(meta.plan)return meta;d.sessions[id]={...meta,plan};save(d);return d.sessions[id];}
function save(d){
 const base=readLegacy(),o={version:2};
 for(const key of Object.keys(d)){
  if(key==='version')continue;
  if(['identity','voice','sessions'].includes(key)){
   const changed={};for(const [k,v]of Object.entries(d[key]||{}))if(digest(v)!==digest(base[key]?.[k]??null))changed[k]=v;
   if(Object.keys(changed).length)o[key]=changed;
  }else if(digest(d[key])!==digest(base[key]??null))o[key]=d[key];
 }
 overlay.write(o);
}
export function sessionSnapshot(sid,system=''){
 const d=readWorkspace(),meta=d.sessions[sid]||{};
 // 头像/名称单一来源（2026-11-19）：只给发送者类型，不给头像快照。
 // 前端 pwDecorateMsg 按 sender_kind 实时读 workspace.identity，改头像只需改一处。
 return {system:sessionSystem(sid,system),identity:sessionIdentity(sid,system),user_identity:{sender:d.identity.user_name,sender_kind:'user'},expert:meta.expert||null,personality:meta.personality||null,plan:meta.plan||null,type:SESSION_TYPES.includes(meta.type)?meta.type:'chat'};
}
export function sessionExpert(sid){return readWorkspace().sessions[sid]?.expert||null;}
export function sessionIdentity(sid,system=''){
 const d=readWorkspace(),meta=d.sessions[sid]||{},e=meta.expert;
 if(meta.plan)return {sender:meta.plan.name,sender_avatar:'🧭',sender_kind:'coordinator',plan_id:meta.plan.id};
 if(e)return {sender:e.name,sender_avatar:e.emoji,sender_kind:'expert',expert_id:e.id};
 const named=String(system).match(/【专家角色】([^\n]+)/);
 // default 分支同样不写头像快照；只有具名专家（🧠）保留固定图标
 return named?{sender:named[1].trim(),sender_avatar:'🧠',sender_kind:'expert'}:{sender:d.identity.assistant_name,sender_kind:'default'};
}
/* 会话类型（2026-11-16）：普通对话 / 画板。
 * 画板复用完整会话链路（消息、模型、附件上传），只在渲染层换一套界面，
 * 所以类型只做渲染分流与模型筛选，不新建独立存储。 */
export const SESSION_TYPES=Object.freeze(['chat','canvas']);
export const PERSONALITIES=Object.freeze([
 {id:'default',name:'默认表达',prompt:''},
 {id:'concise',name:'简洁',prompt:'直接给结论和必要步骤，减少重复和铺垫，保留关键条件。'},
 {id:'technical',name:'技术',prompt:'使用准确的专业术语，解释关键机制，提供可验证的细节与依据。'},
 {id:'teacher',name:'教学',prompt:'循序渐进解释，先建立必要概念，再用具体例子说明；根据用户基础调整深度。'},
 {id:'creative',name:'创意',prompt:'在事实与约束范围内提出多样思路，明确区分构想与已验证的事实。'},
]);
export function sessionSystem(sid,system=''){
 const meta=readWorkspace().sessions[sid]||{},e=meta.expert,p=PERSONALITIES.find(p=>p.id===meta.personality);
 // Fixed order and fixed text: no per-turn input, time, or fake tool list in system.
 const parts=[system];
 if(meta.plan)parts.push(planSystem(meta.plan));
 if(e&&!meta.plan)parts.push('【会话专家职责】'+e.name+'\n'+e.prompt+'\n专家设定不授予额外工具或权限。实际能力以当前工具定义与技能索引为准。');
 if(p?.prompt)parts.push('【表达偏好：'+p.name+'】\n'+p.prompt+'\n本层只调整表达，不改变 SOUL、项目规范、专家职责或工具权限；有冲突时保留上述规则。');
 return parts.filter(Boolean).join('\n\n');
}
const json=(d,status=200)=>new Response(JSON.stringify(d),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const clean=(x,n)=>String(x??'').trim().slice(0,n);
function validSession(id){safeId(id);return existsSync(join(VAR,'chat/sessions',id+'.json'));}
function avatar(value){const v=String(value||'').trim();
 // 外链头像（2026-11-11 主人要求）：允许直接存 http(s) 图片地址，
 // 省掉上传体积上限的折腾，也方便挂自己的图床。
 if(/^https?:\/\//i.test(v)){
  if(v.length>512)throw stateError('头像网址过长（上限 512 字符）');
  let u;try{u=new URL(v);}catch{throw stateError('头像网址格式不对');}
  if(!/^https?:$/.test(u.protocol))throw stateError('只支持 http/https 图片地址');
  const host=u.hostname.toLowerCase();
  // 内网/环回地址一律拒绝：浏览器端点不开，而且不该把内网地址写进头像存下来
  if(host==='localhost'||host==='::1'||/^127\./.test(host)||/^0\.0\.0\.0$/.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)||/^169\.254\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host))throw stateError('不支持内网地址，请用公网图片网址');
  return v;
 }
 if(v.startsWith('/api/workspace-ui/avatars/')){if(!/^\/api\/workspace-ui\/avatars\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(v)||!existsSync(join(ROOT,'avatars',v.split('/').pop())))throw stateError('头像文件不存在，请重新上传');return v;}
 if(v.length>16||/[<>\/]/.test(v))throw stateError('请上传图片、填写一个表情或粘贴图片网址');return v;}
function expert(e){if(e===null)return null;if(!e||!clean(e.name,80)||!clean(e.prompt,100000))throw Error('专家名称和设定不能为空');const snapshot={id:clean(e.id,100),name:clean(e.name,80),emoji:avatar(e.emoji)||'🧠',prompt:clean(e.prompt,100000),quick_prompts:Array.isArray(e.quick_prompts)?e.quick_prompts.map(x=>clean(x,2000)).slice(0,12):[],skills:Array.isArray(e.skills)?e.skills.map(x=>clean(x,100)).slice(0,30):[]};return {...snapshot,revision:digest(snapshot),captured_at:Date.now()};}
async function ttsApi(path,body,signal){const r=await fetch('http://127.0.0.1:8902'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Auth-User':'hermes-agent'},body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});if(!r.ok)throw Error('语音工作台暂不可用 ('+r.status+')');const d=await r.json();if(d.ok===false)throw Error(d.error||'语音设置失败');return d;}
const voiceSettings=createVoiceSettings({api:ttsApi,read:()=>readWorkspace().voice,save:voice=>{const state=readWorkspace();state.voice={...state.voice,...voice};save(state);},ledger:new StateFile(join(ROOT,'voice-save.json'),()=>({status:'none'}))});
const speech=createSpeechService({data:DATA,voice:()=>readWorkspace().voice,windowsCurrent:async signal=>(await ttsApi('/voice/current',undefined,signal)).current});
export async function handleWorkspace(req,checkToken,routePath){
 const u=new URL(req.url),p=routePath||u.pathname;if(!p.startsWith('/api/workspace-ui'))return null;
 const method=req.method;
 // Workspace metadata and prompt content are private even when read-only.
 // Content-addressed avatar files are the sole public exception because they
 // are consumed by <img src> and contain no workspace metadata.
 if(!(method==='GET'&&p.startsWith('/api/workspace-ui/avatars/'))&&!checkToken(req))return json({error:'Unauthorized'},401);
 try{
 if(p==='/api/workspace-ui'&&method==='GET')return json(readWorkspace());
 if(p==='/api/workspace-ui/experts'&&method==='GET')return json(expertCatalog({query:clean(u.searchParams.get('q'),160),offset:Math.max(0,Number(u.searchParams.get('offset'))||0),limit:Math.max(1,Number(u.searchParams.get('limit'))||60),details:u.searchParams.get('details')==='1',scene:clean(u.searchParams.get('scene'),100),ids:u.searchParams.get('favorites')==='1'?readWorkspace().favorites:null}));
 if(/^\/api\/workspace-ui\/experts\/[\w-]+\/undo$/.test(p)&&method==='POST')return json({ok:true,expert:undoExpert(p.split('/').at(-2),(await req.json()).revision)});
 if(/^\/api\/workspace-ui\/experts\/[\w-]+$/.test(p)){
  const id=p.split('/').pop();if(method==='GET')return json({expert:getExpert(id)});if(method==='PUT')return json({ok:true,expert:saveExpert(id,await req.json())});
 }
 if(p==='/api/workspace-ui/personalities'&&method==='GET')return json({personalities:PERSONALITIES.map(({id,name})=>({id,name}))});
 /* 会话类型（2026-11-16）：对话 / 画板。前端新建面板按此渲染。 */
 if(p==='/api/workspace-ui/session-types'&&method==='GET')return json({types:[{id:'chat',name:'对话',desc:'普通对话，可选任意对话模型'},{id:'canvas',name:'画板',desc:'无限画布，模型限定为可生图的模型'}]});
 /* 可生图模型（2026-11-16）：不写死模型名。
  * 唯一真源是 config.yaml 的 image_gen 段 —— 实测 gpt-image-2 并不在 provider 的
  * models 列表里，它只借用该 provider 的 base_url/密钥，所以不能从 models 反推。 */
 if(p==='/api/workspace-ui/image-targets'&&method==='GET'){
  const st=await run(PYTHON,[join(SERVER_ROOT,'server/panel_image_targets.py'),join(DATA,'config.yaml')],{timeout:15000,maxBuffer:2*1024*1024});
  return json(JSON.parse(st.stdout));
 }
 /* 生成图目录（2026-11-16）：画板里那个「目录」抽屉的数据源。
  * 只扫两个白名单目录 —— image_generate 工具落 assets/generated，
  * 临时产物落 tmp。别处的不列，也不允许删。
  * 删除走 DELETE 且必须 realpath 落在白名单内，防 ../ 穿越。 */
 const GEN_DIRS=[
  {key:'generated',dir:join(DATA,'assets/generated'),url:'/app/hermes-agent/data/assets/generated/'},
  {key:'tmp',dir:join(DATA,'tmp'),url:'/app/hermes-agent/data/tmp/'}
 ];
 const IMG_RE=/\.(png|jpe?g|webp|gif)$/i;
 function genImageList(limit){
  const out=[];
  for(const g of GEN_DIRS){
   if(!existsSync(g.dir))continue;
   let names=[];
   try{names=readdirSync(g.dir);}catch(e){continue;}
   for(const name of names){
    if(!IMG_RE.test(name))continue;
    const full=join(g.dir,name);
    let st;try{st=statSync(full);}catch(e){continue;}
    if(!st.isFile())continue;
    out.push({name,dir_key:g.key,path:full,url:g.url+encodeURIComponent(name),size:st.size,mtime:Math.round(st.mtimeMs)});
   }
  }
  out.sort((a,b)=>b.mtime-a.mtime);
  return limit>0?out.slice(0,limit):out;
 }
 function genImageDelete(raw){
  const p=String(raw||'').trim();
  if(!p)throw stateError('缺少文件路径',400);
  const full=realpathSync(p);
  const ok=GEN_DIRS.some(g=>{
   if(!existsSync(g.dir))return false;
   const base=realpathSync(g.dir);
   return full===base||full.startsWith(base+'/');
  });
  if(!ok)throw stateError('只能删除生成图目录内的文件',403);
  if(!IMG_RE.test(full))throw stateError('只能删除图片文件',403);
  unlinkSync(full);
  return {ok:true,path:full};
 }
 // The same session image inventory drives the canvas drawer and the Files tab.
 if(p==='/api/workspace-ui/session-images'&&['GET','DELETE'].includes(method)){
  const sid=safeId(u.searchParams.get('sid'));
  if(!validSession(sid))throw stateError('会话不存在',404);
  const workdir=existingSessionWorkdir(DATA,sid,sessionGroupDir(sid).rel), canonical=realpathSync(DATA);
  const thumbRe=/\.thumb\.webp$/i;
  const thumbName=name=>name.replace(IMG_RE,'.thumb.webp');
  function imageAt(dir,name){
   if(typeof name!=='string'||name.startsWith('.')||name.includes('..')||/[/\\\x00-\x1f]/.test(name)||!IMG_RE.test(name))throw stateError('无效图片名',400);
   const file=join(dir,name);let st;
   try{st=lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
   if(!st.isFile()||realpathSync(file)!==join(canonical,relative(DATA,file)))throw stateError('不是会话中的普通图片文件',403);
   return {file,st};
  }
  const revision=st=>digest([st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs]);
  function legacyTwin(image,name){
   if(image.st.nlink===1)return null;
   const twin=imageAt(join(DATA,'assets','generated'),name);
   if(image.st.nlink!==2||!twin||twin.st.dev!==image.st.dev||twin.st.ino!==image.st.ino)throw stateError('此图片还有未确认的硬链接，未操作',409);
   return twin;
  }
  if(method==='GET'){
   const images=[], includeThumbs=u.searchParams.get('thumbs')==='1';
   for(const kind of ['artifacts','uploads']){
    const dir=join(workdir,kind);
    if(!existsSync(dir))continue;
    if(realpathSync(dir)!==join(canonical,relative(DATA,dir)))throw stateError('无效会话图片目录',403);
    const url='/api/workspace-ui/session-file/'+sid+'/'+kind+'/';
    for(const entry of readdirSync(dir,{withFileTypes:true})){
     const name=entry.name,isThumb=thumbRe.test(name);
     if(!entry.isFile()||name.startsWith('.')||name.includes('..')||!IMG_RE.test(name)||(!includeThumbs&&isThumb))continue;
     let image,preview;try{image=imageAt(dir,name);if(!image)continue;legacyTwin(image,name);}catch{continue;}
     try{preview=!isThumb&&imageAt(dir,thumbName(name));if(preview)legacyTwin(preview,thumbName(name));}catch{preview=null;}
     images.push({name,kind,url:url+encodeURIComponent(name),thumb_url:preview?url+encodeURIComponent(thumbName(name)):null,is_thumb:isThumb,size:image.st.size,mtime:Math.round(image.st.mtimeMs),revision:revision(image.st)});
    }
   }
   return json({ok:true,images:images.sort((a,b)=>b.mtime-a.mtime||a.name.localeCompare(b.name))});
  }
  const b=await req.json();
  if(!['artifacts','uploads'].includes(b.kind))throw stateError('只能删除当前会话的图片',400);
  const dir=join(workdir,b.kind), image=imageAt(dir,b.name);
  if(!image)throw stateError('图片不存在，请刷新',404);
  if(b.revision!==revision(image.st))throw stateError('图片已变化，请刷新后重试',409);
  const names=[b.name];
  if(!thumbRe.test(b.name)&&imageAt(dir,thumbName(b.name)))names.push(thumbName(b.name));
  const paths=[];
  for(const name of names){
   const item=imageAt(dir,name);
   if(!item)throw stateError('图片已变化，请刷新后重试',409);
   paths.push(item.file);
   const twin=legacyTwin(item,name);
   if(twin)paths.push(twin.file);
  }
  const script=join(DATA,'scripts','app_trash.py');
  if(!existsSync(script))throw stateError('应用回收站暂不可用，未删除图片',503);
  const {stdout}=await run(PYTHON,['-B',script,'put',...paths,'--reason','面板删除会话图片','--force','--apply'],{timeout:30000,maxBuffer:8192});
  const batch=/已搬入批次 ([\d-]+)：/.exec(stdout)?.[1];
  if(!batch||paths.some(path=>existsSync(path)))throw stateError('删除未确认，请刷新并检查回收站',409);
  return json({ok:true,batch,names,kind:b.kind});
 }
 if(p==='/api/workspace-ui/generated-images'&&method==='GET'){
  const lim=Number(u.searchParams.get('limit')||0)||0;
  return json({ok:true,images:genImageList(lim)});
 }
 if(p==='/api/workspace-ui/generated-images'&&method==='DELETE'){
  if(!checkToken(req))return json({error:'请重新连接面板'},401);
  const b=await req.json().catch(()=>({}));
  return json(genImageDelete(b.path));
 }
 /* 会话工作区目录（2026-11-16）：按会话树归类落盘，附件/图片各归各家。
  * 规则与 monitor.js 的附件上传共用 ensureSessionUploadDir()，见文件头注释。 */
  if(p==='/api/workspace-ui/session-dir'&&method==='POST'){
   const b=await req.json(),sid=clean(b.id,120);
   const r=await ensureSessionUploadDir(sid);
   return json({ok:true,group:r.group,dir:r.dir,uploads:r.uploads,dirs:r.dirs});
  }

  /* 会话附件读取（2026-11-16）：附件改成落会话目录后得有个取回入口。
   * 只认 /api/workspace-ui/session-file/<sid>/<文件名>：sid 必须真实存在，
   * 文件名禁分隔符与 ..，realpath 再确认落点在该会话 uploads 内，防穿越。
   * 2026-11-20 扩到产物子目录：/session-file/<sid>/<子目录>/<文件名>，
   * 子目录只认 SESSION_SUBDIRS 白名单。不带子目录的老链接仍指 uploads。 */
  if(p.startsWith('/api/workspace-ui/session-file/')&&method==='GET'){
   const parts=p.split('/').filter(Boolean);
   const sid=parts[3]||'';
   const sub=parts.length===6?parts[4]:'uploads';
   if(![5,6].includes(parts.length)||!SESSION_SUBDIRS.includes(sub))return json({error:'无效会话文件地址'},400);
   const name=decodeURIComponent(parts.at(-1));
   if(!name||/[/\\]/.test(name)||name.includes('..'))return json({error:'文件名不正确'},400);
   const dir=await resolveSessionFileDir(sid);
   const file=join(dir,sub,name);
   let fd;
   try{
    const opened=openStaticFile(join(DATA,'sessions'),file,{allowHardlinks:sub==='artifacts'&&IMG_RE.test(name)});
    fd=opened.fd;
    if(opened.stat.nlink!==1){
     try{
      const twin=openStaticFile(DATA,join(DATA,'assets','generated',name),{allowHardlinks:true});
      try{if(twin.stat.ino!==opened.stat.ino||twin.stat.dev!==opened.stat.dev)throw Error('mismatch');}finally{closeSync(twin.fd);}
     }catch{closeSync(fd);throw stateError('未确认的图片硬链接',403);}
    }
   }
   catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))return json({error:'文件不存在'},404);throw e;}
   const ext=(name.split('.').pop()||'').toLowerCase();
   const MIME={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',pdf:'application/pdf',txt:'text/plain; charset=utf-8',json:'application/json',zip:'application/zip',mp4:'video/mp4',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
   const type=MIME[ext]||'application/octet-stream';
   let buf;
   try{buf=readFileSync(fd);}finally{closeSync(fd);}
   /* 2026-11-22：PDF 单独一套响应头。原来所有文件共用
      `Content-Security-Policy: default-src 'none'; …; sandbox`，而 CSP 的
      sandbox 指令会把文档降级成唯一源沙箱 —— Chrome 内置 PDF 查看器是
      chrome-extension:// 页面，在里面根本起不来，Chrome 直接显示「此页面
      已被 Chrome 屏蔽」。PDF 不需要这套防护（它本身不是可执行文档），
      只要 inline + application/pdf 即可；其余类型维持原样。 */
   const pdf=ext==='pdf';
   const csp=pdf?null:"default-src 'none'; style-src 'unsafe-inline'; sandbox";
   const headers={'Content-Type':type,'Content-Length':String(buf.length),'Cache-Control':['artifacts','uploads'].includes(sub)?'private,no-cache':'private,max-age=86400','X-Content-Type-Options':'nosniff','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(name)}`};
   if(csp)headers['Content-Security-Policy']=csp;
   return new Response(buf,{headers});
  }
 /* 会话思考强度（2026-11-21）：面板把用户选的档位存服务端，刷新/换设备都以它为准。
    GET  返回 {ok:true, level:'off|low|medium|high'}；没设过就是 off。
    PUT  接受 {level:'low'} 或 {reasoning:{enabled:true,effort:'low'}} 两种写法，
         后者与内核请求体同形，前端可以原样转发。 */
 if(p.startsWith('/api/workspace-ui/session-reasoning/')){
  const sid=decodeURIComponent(p.slice('/api/workspace-ui/session-reasoning/'.length));
  if(!validSession(sid))return json({error:'会话不存在'},404);
  if(method==='GET')return json({ok:true,level:sessionReasoning.get(sid)});
  if(method==='PUT'||method==='POST'){
   const b=await req.json();
   const raw=b&&b.reasoning&&typeof b.reasoning==='object'
     ? (b.reasoning.enabled===false?'off':(b.reasoning.effort||'off'))
     : (b&&b.level);
   const level=sessionReasoning.put(sid,raw);
   if(level===null)return json({error:'无效的思考强度档位'},400);
   return json({ok:true,level});
  }
  return json({error:'方法不支持'},405);
 }
 if(p==='/api/workspace-ui/draft'){
  if(!checkToken(req))return json({error:'请重新连接面板'},401);
  const id=u.searchParams.get('session_id');if(id!=='new'&&!validSession(id))return json({error:'会话不存在'},404);
  if(method==='GET')return json(drafts.get(id));
  if(method==='PUT'){const result=drafts.put(id,await req.json());return json(result,result.conflict?409:200);}
 }
 if(p==='/api/workspace-ui/avatars'&&method==='POST'){
  const form=await req.formData(),file=form.get('file');if(!file||typeof file==='string')throw stateError('请选择头像图片');
  if(file.size>5*1024*1024)throw stateError('头像不得超过 5 MB',413);
  const b=Buffer.from(await file.arrayBuffer());
  const kind=b.length>24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':b.length>12&&b[0]===255&&b[1]===216&&b[2]===255?'jpg':b.length>16&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'?'webp':b.length>13&&b[0]===71&&b[1]===73&&b[2]===70&&b[3]===56&&[55,57,97].includes(b[4])?'gif':null;
  if(!kind)throw stateError('请使用 PNG、JPEG、GIF 或 WebP 图片',415);
  const name=createHash('sha256').update(b).digest('hex')+'.'+kind;
  atomicWrite(join(ROOT,'avatars',name),b);
  return json({ok:true,url:'/api/workspace-ui/avatars/'+name});
 }
 if(p.startsWith('/api/workspace-ui/avatars/')&&method==='GET'){
  const name=p.split('/').pop();if(!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(name))return json({error:'头像不存在'},404);
  const file=join(ROOT,'avatars',name);if(!existsSync(file))return json({error:'头像不存在'},404);
  return new Response(readFileSync(file),{headers:{'Content-Type':name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':name.endsWith('.gif')?'image/gif':'image/webp','X-Content-Type-Options':'nosniff','Cache-Control':'private,max-age=31536000,immutable'}});
 }
 if(p==='/api/workspace-ui/folders'&&method==='POST'){
  const b=await req.json(),d=readWorkspace(),name=clean(b.name,80),parent=clean(b.parent_id,80);if(!name)throw Error('请输入文件夹名称');if(parent&&!d.folders.some(f=>f.id===parent))throw Error('上级文件夹不存在');
  const folder={id:randomUUID(),name,parent_id:parent};d.folders.push(folder);save(d);return json({ok:true,folder});
 }
 if(p==='/api/workspace-ui/folders'&&method==='PUT'){
  const b=await req.json(),d=readWorkspace(),f=d.folders.find(f=>f.id===b.id);if(!f)throw Error('文件夹不存在');const name=clean(b.name,80),parent=clean(b.parent_id,80);if(!name)throw Error('请输入名称');let node=parent;const visited=new Set([f.id]);while(node){if(visited.has(node))throw Error('不能移动到自身或子文件夹');visited.add(node);const par=d.folders.find(f=>f.id===node);if(!par)throw Error('上级文件夹不存在');node=par.parent_id;}const _sids=subtreeSessionIds(d,f.id),_old=relativeWorkdirs(_sids);f.name=name;f.parent_id=parent;save(d);relocateWorkdirs(_sids,_old);return json({ok:true});
 }
 if(p==='/api/workspace-ui/folders'&&method==='DELETE'){
  const b=await req.json(),d=readWorkspace(),f=d.folders.find(f=>f.id===b.id);if(!f)throw Error('文件夹不存在');const _sids=subtreeSessionIds(d,f.id),_old=relativeWorkdirs(_sids);d.folders=d.folders.filter(x=>x.id!==f.id);d.folders.forEach(x=>{if(x.parent_id===f.id)x.parent_id=f.parent_id;});Object.values(d.sessions).forEach(s=>{if(s.folder_id===f.id)s.folder_id=f.parent_id;});save(d);relocateWorkdirs(_sids,_old);return json({ok:true});
 }
 if(p==='/api/workspace-ui/session'&&method==='PUT'){
  const b=await req.json(),d=readWorkspace();if(!validSession(b.id))return json({error:'会话不存在'},404);const meta={...(d.sessions[b.id]||{})};let _oldRel=null;if('folder_id'in b){const id=clean(b.folder_id,80);if(id&&!d.folders.some(f=>f.id===id))throw Error('文件夹不存在');if((meta.folder_id||'')!==id)_oldRel=relative(DATA,existingSessionWorkdir(DATA,b.id,sessionGroupDir(b.id).rel));meta.folder_id=id;}if('expert'in b)meta.expert=expert(b.expert);if('expert_id'in b)meta.expert=b.expert_id?expert(getExpert(b.expert_id)):null;if('personality'in b){if(!PERSONALITIES.some(p=>p.id===b.personality))throw stateError('请选择有效的表达风格');meta.personality=b.personality;}if('type'in b){if(!SESSION_TYPES.includes(b.type))throw stateError('请选择有效的会话类型');meta.type=b.type;}if(('expert_id'in b)||('expert'in b))delete meta.plan;if(b.clear_plan===true)delete meta.plan;d.sessions[b.id]=meta;save(d);const _dir=moveSessionDir(b.id,_oldRel);return json({ok:true,meta,dir:_dir});
 }
 if(p==='/api/workspace-ui/preferences'&&method==='PUT'){
 const b=await req.json(),d=readWorkspace();if(b.identity)for(const k of ['user_name','assistant_name','user_avatar','assistant_avatar'])if(k in b.identity)d.identity[k]=(k.endsWith('avatar')?avatar(b.identity[k]):clean(b.identity[k],60))||defaults().identity[k];if(b.identity&&'avatar_shape'in b.identity){if(!['rounded','circle'].includes(b.identity.avatar_shape))throw stateError('请选择圆角方形或圆形头像');d.identity.avatar_shape=b.identity.avatar_shape;}
  if(b.display){if(!['collapsed','expanded','hidden'].includes(b.display.tools_mode))throw stateError('请选择有效的工具记录显示方式');d.display={...(d.display||{}),tools_mode:b.display.tools_mode};}
  if(b.voice)throw stateError('请刷新面板后通过声音设置保存',409);if(Array.isArray(b.favorites))d.favorites=b.favorites.filter(x=>typeof x==='string').slice(0,400);save(d);return json({ok:true,state:d});
 }
 if(p==='/api/workspace-ui/search'&&method==='GET'){
  /* 查询缓存（2026-11-11，第 36 项）：每敲一个字都 spawn 一个 python 去扫盘，
   * 结果还都一样。这里按 q+offset 缓存 60 秒，最多 40 条，连打同一个词零成本。 */
  const q=clean(u.searchParams.get('q'),160),offset=Math.max(0,Number(u.searchParams.get('offset'))||0);if(!q)return json({results:[],total:0});
  const g=globalThis;if(!g.__wsSearchCache)g.__wsSearchCache=new Map();const ck=q+'|'+offset;const hit=g.__wsSearchCache.get(ck);
  if(hit&&Date.now()-hit.at<60000)return json(hit.data);
  const {stdout}=await run(PYTHON,[join(SERVER_ROOT,'server/panel-search.py'),DATA,VAR,q,String(offset)],{timeout:15000,maxBuffer:4*1024*1024});
  const data=JSON.parse(stdout);
  g.__wsSearchCache.set(ck,{at:Date.now(),data});if(g.__wsSearchCache.size>40)g.__wsSearchCache.delete(g.__wsSearchCache.keys().next().value);
  return json(data);
 }
 if(p==='/api/workspace-ui/channel-context'&&method==='GET'){
  const id=u.searchParams.get('id')||'',mid=Number(u.searchParams.get('message'))||0;
  const script=`import sqlite3,json,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row\nrows=c.execute("SELECT id,role,content,timestamp FROM messages WHERE session_id=? AND active=1 AND role IN ('user','assistant') AND id>=COALESCE((SELECT id FROM messages WHERE session_id=? AND id<=? AND active=1 AND role IN ('user','assistant') ORDER BY id DESC LIMIT 1 OFFSET 12),0) ORDER BY id LIMIT 40",(sys.argv[2],sys.argv[2],int(sys.argv[3]))).fetchall()\nprint(json.dumps([dict(r) for r in rows],ensure_ascii=False))`;
  const {stdout}=await run(PYTHON,['-c',script,join(DATA,'state.db'),id,String(mid)],{timeout:10000,maxBuffer:5*1024*1024});return json({messages:JSON.parse(stdout)});
 }
 if(p==='/api/workspace-ui/voice'){if(!checkToken(req))return json({error:'请重新登录后管理声音'},401);if(method==='GET')return json(await voiceSettings.inspect());if(method==='PUT')return json(await voiceSettings.update(await req.json()));}
 if(p==='/api/workspace-ui/speech-cancel'&&method==='POST')return json(speech.cancel((await req.json()).request_id));
 if(['/api/workspace-ui/speak','/api/workspace-ui/system-speak'].includes(p)&&method==='POST')return await speech.synthesize(await req.json(),p.endsWith('/system-speak')?'system':'windows',req.signal);
 return json({error:'not found'},404);
 }catch(e){const upstream=String(e.stderr||'').match(/TTS 服务 HTTP (\d+)/);const message=upstream?'Windows 合成服务返回 HTTP '+upstream[1]:e.message||String(e);return json({error:message,code:e.code},e.status||400);}
}
