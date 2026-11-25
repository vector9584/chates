import * as fs from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve,relative,sep,basename} from 'node:path';
import {Readable} from 'node:stream';
import {stateError} from './panel-state.js';

// Static assets are served from a pinned application tree, never user links.
export function openStaticFile(root,path,{allowHardlinks=false}={}){
 const base=fs.realpathSync(root),part=relative(resolve(root),resolve(path)),target=resolve(base,part);
 if(!part||part.startsWith('..'+sep)||part==='..'||part.startsWith(sep))throw stateError('静态文件路径越界',403);
 let cursor=base;
 for(const segment of part.split(sep)){if(segment.startsWith('.'))throw stateError('禁止隐藏资源',403);cursor=join(cursor,segment);if(fs.lstatSync(cursor).isSymbolicLink())throw stateError('静态文件不允许链接',403);}
 const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||(!allowHardlinks&&stat.nlink!==1))throw stateError('静态资源不是普通文件',403);
  if(process.platform==='linux'){const actual=fs.readlinkSync('/proc/self/fd/'+fd);if(actual!==target)throw stateError('静态资源路径发生变化',403);}
  return {fd,stat};
 }catch(error){fs.closeSync(fd);throw error;}
}

export function createFileRoots({data,varDir,librarySources=()=>[]}){
 const canonical=path=>fs.existsSync(path)?fs.realpathSync(path):resolve(path);
 data=canonical(data);varDir=canonical(varDir);
 return ()=>{
  const roots=[{id:'workspace',name:'工作区',path:join(data,'workspace'),editable:true},
   {id:'uploads',name:'对话附件',path:join(data,'uploads'),editable:false,upload:true},
   {id:'temporary',name:'临时产物',path:join(varDir,'tmp'),editable:false},
   {id:'session-tmp',name:'会话产物',path:join(data,'tmp'),editable:false},
   /* 2026-11-16：生成图原来落在 cache/images（与用户上传的 img_* 混放），
      而这两个目录都不在可访问白名单里 —— 面板里 <img> 打过去一律 403
      「此文件不在可访问的工作目录中」，用户看到的就是裂图。
      只读挂进来，旧消息里的既有路径也不用改。 */
   {id:'generated',name:'生成图库',path:join(data,'assets','generated'),editable:false},
   {id:'image-cache',name:'图片缓存',path:join(data,'cache','images'),editable:false},
   /* 2026-11-19：表情包（data/assets/nekowhale-stickers）也不在白名单里，和上面生成图是同一个病 ——
      对话里的 <img src="/app/hermes-agent/data/assets/..."> 打到文件服务，一律 403
      「此文件不在可访问的工作目录中」，用户看到的就是"这个会话所有表情都看不到"。
      assets 整个挂成只读根：表情包、生成图、以后的公共素材都从这一个口进，别再一个个补。 */
   {id:'assets',name:'应用资源',path:join(data,'assets'),editable:false},
   /* 2026-11-19：会话工作区（data/sessions/<归类>/<会话ID>/{uploads,generated}）。
      生成图和附件开始按会话归位，路径形如 /app/hermes-agent/data/sessions/...
      不挂进来同样是 403 裂图。只读，删除/移动走面板自己的会话接口。 */
   {id:'sessions',name:'会话工作区',path:join(data,'sessions'),editable:false},
   /* 2026-11-20：应用数据的回收站。fnOS 系统回收站只覆盖 /vol1/<uid>/…，
     应用目录（@apphome/@appdata）删了找不回，所以自己的删除先进 data/trash/<批次>/files/，
     带 manifest.json + sha256，可列、可还原、可彻底清。只读挂载，删除/还原走 scripts/app_trash.py。 */
   {id:'trash',name:'回收站',path:join(data,'trash'),editable:false},
   /* 2026-11-20：主人要求「所有 hermes 的文件我都要看得到进得去，我看不到的就是位置放错的」。
      知识库根从这里撤掉（知识库内容只在资料页看），改挂整个 data 目录做兜底根：
      任何一个落在 data 下的文件都能从这里走进去，不再需要为每个新目录补一条。
      只读；点开头的文件与符号链接照旧被文件服务挡住，不会从这里漏出来。 */
   {id:'data',name:'全部文件',path:data,editable:false}];
  for(const source of librarySources())if(source.id==='knowledge')roots.push({id:'knowledge',name:'知识库附件',path:canonical(source.root),editable:false});
  const profiles=join(data,'profiles');if(fs.existsSync(profiles))for(const entry of fs.readdirSync(profiles,{withFileTypes:true})){if(!entry.isDirectory()||!/^[\w-]{1,100}$/.test(entry.name))continue;for(const kind of ['workspace','uploads']){const path=join(profiles,entry.name,kind);if(fs.existsSync(path)||kind==='uploads')roots.push({id:'profile-'+entry.name+'-'+kind,name:entry.name+' · '+(kind==='workspace'?'工作区':'附件'),path,editable:kind==='workspace',upload:kind==='uploads'});}}
  return roots;
 };

}
export function fileReference(input,{roots,data,varDir,basePath=''}){
 if(typeof input!=='string'||!input||input.includes('\0')||input.includes('\\'))throw stateError('文件路径不正确');
 data=fs.existsSync(data)?fs.realpathSync(data):resolve(data);varDir=fs.existsSync(varDir)?fs.realpathSync(varDir):resolve(varDir);
 let path=input;
 if(basePath&&path.startsWith(basePath+'/'))path=path.slice(basePath.length);
 if(path.startsWith('/api/download?')||path.startsWith('/api/preview?'))path=new URL(path,'http://localhost').searchParams.get('path')||'';
 const alreadyAbsolute=roots().some(root=>path.startsWith(resolve(root.path)+sep));
 if(alreadyAbsolute){}
 else if(path.startsWith('/uploads/p/')){const match=path.match(/^\/uploads\/p\/([\w-]{1,100})\/(.*)$/);if(!match)throw stateError('附件路径不正确');path=join(data,'profiles',match[1],'uploads',decodeURIComponent(match[2]));}
 else if(path.startsWith('/uploads/'))path=join(data,'uploads',decodeURIComponent(path.slice(9)));
 else if(path.startsWith('/workspace/'))path=join(data,'workspace',decodeURIComponent(path.slice(11)));
 else if(path.startsWith('/tmp/')&&!fs.existsSync(path))path=join(varDir,'tmp',decodeURIComponent(path.slice(5)));
 else if(path.startsWith('/data/'))path=join(data,decodeURIComponent(path.slice(6)));
 else if(path.startsWith('~/'))path=join(data,path.slice(2));
 else if(!path.startsWith('/'))path=join(data,path);
 const absolute=resolve(path);
 const source=roots().filter(root=>absolute===resolve(root.path)||absolute.startsWith(resolve(root.path)+sep)).sort((a,b)=>b.path.length-a.path.length)[0];
 if(!source)throw stateError('此文件不在可访问的工作目录中',403);
 const rel=relative(resolve(source.path),absolute);if(!rel||rel.split(sep).some(part=>part.startsWith('.')))throw stateError('请选择工作目录中的普通文件',403);
 return {root:source.id,path:rel.split(sep).join('/'),absolute};
}
// Historical generated assets were hard-linked into the originating session.
// Keep their authenticated URLs readable without enabling hardlinks in the general file service.
const legacyImageName=/^custom_[a-z0-9-]+_\d{8}_\d{6}_[a-f0-9]{8}(?:\.thumb\.webp|\.(?:png|jpe?g|webp|gif))$/i;
export function hasRasterHeader(fd,ext){
 const b=Buffer.alloc(12);if(fs.readSync(fd,b,0,b.length,0)<12)return false;
 return ext==='png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
  ext==='jpg'||ext==='jpeg'?b[0]===255&&b[1]===216&&b[2]===255:
  ext==='gif'?/^GIF8[79]a$/.test(b.toString('ascii',0,6)):
  ext==='webp'&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
}
const types={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp',ico:'image/x-icon',pdf:'application/pdf',html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',mp3:'audio/mpeg',wav:'audio/wav',mp4:'video/mp4',webm:'video/webm'};
export function createFileHandler({python,serverRoot,state,roots,data,varDir,basePath='',checkToken,start=spawn}){
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
 function childFor(body){const child=start(python,['-B',join(serverRoot,'panel-files.py')],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'}});child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({roots:roots(),state,body}));return child;}
 async function call(body){return new Promise((resolve,reject)=>{let output='',settled=false;const child=childFor(body),timer=setTimeout(()=>{child.kill('SIGTERM');finish(null,stateError('文件操作超时，记录已保留，请刷新核对',504));},30000);
  function finish(value,error){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);}
  child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>52*1024*1024){child.kill('SIGTERM');finish(null,stateError('返回内容过大，请缩小读取范围',413));}});
  child.on('error',()=>finish(null,stateError('文件服务无法启动',503)));child.on('close',()=>{try{const result=JSON.parse(output);if(!result.ok)throw stateError(result.error,result.status||500);finish(result);}catch(error){finish(null,error.status?error:stateError('文件服务返回异常，请刷新核对',502));}});
 });}
 async function stream(ref,{download=false,office=false,signal}={}){
  const child=childFor({action:'stream',root:ref.root,path:ref.path}),iterator=child.stdout[Symbol.asyncIterator]();let prefix=Buffer.alloc(0),first=Buffer.alloc(0),metadata;
  child.on('error',()=>{});const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
  const cancel=()=>child.kill('SIGTERM');signal?.addEventListener('abort',cancel,{once:true});
  try{while(true){const next=await iterator.next();if(next.done)throw stateError('文件读取未完成',502);prefix=Buffer.concat([prefix,next.value]);const at=prefix.indexOf(10);if(at<0){if(prefix.length>65536)throw stateError('文件服务返回异常',502);continue;}metadata=JSON.parse(prefix.subarray(0,at));first=prefix.subarray(at+1);break;}
   if(!metadata.ok)throw stateError(metadata.error,metadata.status||500);
  }catch(error){cancel();signal?.removeEventListener('abort',cancel);throw error;}finally{clearTimeout(timer);}
  const name=basename(ref.path),ext=name.split('.').pop().toLowerCase();
  if(office){
   // The converter receives a private temporary copy of the descriptor stream,
   // never a mutable user path. Conversion output is sandboxed by the response.
   const temp=fs.mkdtempSync(join(varDir,'tmp','panel-preview-')),file=join(temp,'source.'+ext);let fd;
   try{fd=fs.openSync(file,'wx',0o600);fs.writeSync(fd,first);let bytes=first.length;for await(const chunk of iterator){bytes+=chunk.length;if(bytes>64*1024*1024)throw stateError('Office文件超过64MB，请下载查看',413);fs.writeSync(fd,chunk);}fs.closeSync(fd);fd=undefined;
    const html=await new Promise((resolve,reject)=>{const process=start(python,['-B',join(serverRoot,'preview_conv.py'),file],{stdio:['ignore','pipe','pipe']});let output='',done=false;const limit=setTimeout(()=>{process.kill();finish(stateError('预览转换超时，请下载查看',504));},30000);function finish(error){if(done)return;done=true;clearTimeout(limit);error?reject(error):resolve(output);}process.stdout.on('data',part=>{output+=part;if(Buffer.byteLength(output)>32*1024*1024){process.kill();finish(stateError('预览内容过大，请下载查看',413));}});process.stderr.resume();process.on('error',()=>finish(stateError('预览服务无法启动',503)));process.on('close',code=>finish(code?stateError('预览转换失败，请下载原文件',422):null));});
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",'Cache-Control':'no-store'}});
   }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temp,{recursive:true,force:true});cancel();signal?.removeEventListener('abort',cancel);}
  }
  const iterable=async function*(){try{if(first.length)yield first;for await(const chunk of iterator)yield chunk;}finally{cancel();signal?.removeEventListener('abort',cancel);}};
  /* 2026-11-22：PDF 不发 CSP。原来的 `sandbox; default-src 'none' …` 会把文档
     降级成唯一源沙箱，而 Chrome 内置 PDF 查看器是 chrome-extension:// 页面，
     在里面起不来，Chrome 就弹「此页面已被 Chrome 屏蔽」。PDF 本身不是可执行
     文档，不需要这套防护；其它类型（html 等）照旧带 CSP。 */
  const headers={'Content-Type':types[ext]||'application/octet-stream','Content-Disposition':(download?'attachment':'inline')+"; filename*=UTF-8''"+encodeURIComponent(name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(ext!=='pdf')headers['Content-Security-Policy']="sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'";
  return new Response(Readable.toWeb(Readable.from(iterable())),{headers});
 }
 /* 归类文件夹改过名之后，历史消息里存的还是旧绝对路径（data/sessions/旧名/<sid>/...）。
 * 字面路径找不到时按会话 ID 到磁盘认一次真实目录，只放行该会话目录里的位图：
 * 否则改个文件夹名，聊天记录里的老图就全变成破图。 */
function sessionDirsFor(root,sid){
 const found=[];let level=[root];
 for(let depth=0;depth<7&&level.length;depth++){
  const next=[];
  for(const dir of level){
   let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch(e){continue;}
   for(const entry of entries){
    if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
    const full=join(dir,entry.name);
    if(entry.name===sid)found.push(full);else next.push(full);
   }
  }
  level=next;
 }
 return found;
}
const handler=async(req,path)=>{
  const workspaceAPI=path==='/api/files'||path.startsWith('/api/files/'),preview=['/api/preview','/api/download','/api/preview/office'].includes(path),alias=/^\/(?:uploads|workspace|data|tmp)\//.test(path);
  if(!workspaceAPI&&!preview&&!alias)return null;
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后查看文件'},401);
  try{
   const url=new URL(req.url);
   const old=path.match(/^\/data\/assets\/generated\/([^/]+)$/);
   if(old&&req.method==='GET'&&legacyImageName.test(old[1])){
    const name=old[1],ext=name.split('.').at(-1).toLowerCase();
    let opened;try{opened=openStaticFile(data,join(data,'assets','generated',name),{allowHardlinks:true});}
    catch(e){if(e.code==='ENOENT')throw stateError('图片不存在',404);throw e;}
    const {fd,stat}=opened;
    try{if(!hasRasterHeader(fd,ext))throw stateError('不是有效图片',404);}
    catch(e){fs.closeSync(fd);throw e;}
    return new Response(Readable.toWeb(fs.createReadStream('',{fd,autoClose:true})),{headers:{'Content-Type':types[ext],'Content-Length':String(stat.size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
   }
   const drifted=/^\/data\/sessions\/(.+)$/.exec(path);
   if(drifted&&req.method==='GET'){
    const parts=drifted[1].split('/');
    if(parts.length>=4){
     const name=parts.at(-1),kind=parts.at(-2),sid=parts.at(-3),chain=parts.slice(0,-3);
     if(['artifacts','uploads','code','stickers'].includes(kind)&&/^[A-Za-z0-9_-]{6,64}$/.test(sid)&&/\.(png|jpe?g|webp|gif)$/i.test(name)&&!name.startsWith('.')&&!name.includes('\\')){
      const literal=join(data,'sessions',...chain,sid,kind,name);
      if(!fs.existsSync(literal)){
       const hit=sessionDirsFor(join(data,'sessions'),sid).map(dir=>join(dir,kind,name)).find(file=>{try{return fs.statSync(file).isFile();}catch(e){return false;}});
       if(hit){
        const ext=name.split('.').pop().toLowerCase();
        let opened;try{opened=openStaticFile(data,hit,{allowHardlinks:true});}catch(e){throw stateError('图片不存在',404);}
        const {fd,stat}=opened;
        try{if(!hasRasterHeader(fd,ext))throw stateError('不是有效图片',404);}catch(e){fs.closeSync(fd);throw e;}
        return new Response(Readable.toWeb(fs.createReadStream('',{fd,autoClose:true})),{headers:{'Content-Type':types[ext],'Content-Length':String(stat.size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
       }
      }
     }
    }
   }
   if(preview||alias){if(req.method!=='GET')throw stateError('此入口仅支持读取',405);const ref=fileReference(alias?path:url.searchParams.get('path'),{roots,data,varDir,basePath}),ext=ref.path.split('.').pop().toLowerCase();if(path==='/api/preview'&&!types[ext])return reply(await call({action:'read',root:ref.root,path:ref.path}));return await stream(ref,{download:path==='/api/download',office:path==='/api/preview/office',signal:req.signal});}
   if(path==='/api/files/roots'&&req.method==='GET')return reply({ok:true,roots:roots().map(({path,...root})=>({...root,available:fs.existsSync(path)}))});
   const params=Object.fromEntries(url.searchParams),body=req.method==='GET'?params:await req.json();
   const action=path==='/api/files'?'list':path.slice('/api/files/'.length);
   const allowed={list:'GET',read:'GET',history:'GET',version:'GET',write:'POST',mkdir:'POST',archive:'POST',restore:'POST',undo:'POST'};
   if(!(action==='draft'&&['GET','POST'].includes(req.method))&&req.method!==allowed[action])throw stateError('文件操作不存在，请刷新面板',405);
   return reply(await call({...body,action,root:body.root||'workspace'}));
  }catch(error){return reply({ok:false,error:error.status?error.message:'文件操作未完成，请刷新核对'},error.status||500);}
 };
 handler.upload=async(profile,kind,name,bytes)=>{if(profile&&!/^[\w-]{1,100}$/.test(profile))throw stateError('附件环境标识不正确');return call({action:'upload',root:profile&&profile!=='default'?'profile-'+profile+'-uploads':'uploads',kind,name,base64:bytes.toString('base64')});};
 handler.inspect=async(path,image=false)=>{const ref=fileReference(path,{roots,data,varDir,basePath});return call({action:image?'image':'inspect',root:ref.root,path:ref.path});};
 return handler;
}
