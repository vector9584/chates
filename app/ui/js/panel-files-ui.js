(function(){
 'use strict';
 var pane=document.getElementById('ws-files');if(!pane)return;
 var state={roots:[],root:'workspace',path:'',offset:0,query:'',listing:null,document:null,draftRevision:0,sort:{by:'name',dir:1}},sequence=0,contextId=null,sessionPath=null,draftTimer,mdRenderTimer,saveBusy=false;
 function node(tag,text,cls){var element=document.createElement(tag);if(text!=null)element.textContent=text;if(cls)element.className=cls;return element;}
 function button(text,run,cls){var element=node('button',text,cls||'btn');element.type='button';element.onclick=run;return element;}
 /* 状态文案只写一处：表头的 .pf-count。
    2026-11-22 主人判「重复了」——原先 feedback() 同时写 status 和 headCount，
    「4 项」就在工具条下面和表头各出现一次。status 槽位留着（空时会撑出 6px 空白，
    由 CSS #ws-files>.pf-status 收掉），但不再往里写。 */
 function feedback(text){headCount.textContent=text||'';}

 function key(doc){return 'panel-file-draft:'+doc.root+':'+doc.path;}
 function localDraft(doc,text){try{localStorage.setItem(key(doc),JSON.stringify({text:text,base_revision:doc.revision,root_revision:doc.root_revision}));}catch(_){feedback('浏览器空间不足，请保存文件或下载草稿');}}
 async function api(action,body,write){var query=new URLSearchParams(body||{}),response=await fetch(apiUrl('/api/files'+(action?'/'+action:'')+(write?'':'?'+query)),{method:write?'POST':'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:write?JSON.stringify(body):undefined,cache:'no-store'});var out=await response.json();if(!response.ok||!out.ok){var error=Error(out.error||'文件操作失败');error.status=response.status;throw error;}return out;}
 pane.replaceChildren();

 /* ── 图标：一套描边 SVG，颜色只跟 --text3/--accent 走，不搞彩虹 ── */
 var ICON={
  folder:'<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l1.6 2h7.8A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  image:'<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.6-4.2a1.6 1.6 0 0 1 2.2 0L20 19"/>',
  video:'<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m10.5 9 4.2 3-4.2 3z"/>',
  audio:'<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  doc:'<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  sheet:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M9 9v12M4 15h16"/>',
  code:'<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  archive:'<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  file:'<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/>'
 };
 var KIND={png:'image',jpg:'image',jpeg:'image',gif:'image',webp:'image',svg:'image',bmp:'image',avif:'image',ico:'image',
  mp4:'video',webm:'video',mov:'video',mkv:'video',avi:'video',m4v:'video',
  mp3:'audio',wav:'audio',flac:'audio',m4a:'audio',ogg:'audio',opus:'audio',
  txt:'doc',md:'doc',pdf:'doc',doc:'doc',docx:'doc',rtf:'doc',pptx:'doc',ppt:'doc',html:'doc',htm:'doc',
  csv:'sheet',xlsx:'sheet',xls:'sheet',
  js:'code',mjs:'code',ts:'code',py:'code',json:'code',sh:'code',bash:'code',css:'code',yml:'code',yaml:'code',toml:'code',sql:'code',c:'code',h:'code',go:'code',rs:'code',java:'code',
  zip:'archive',gz:'archive',tgz:'archive',tar:'archive',rar:'archive','7z':'archive',fpk:'archive',dmg:'archive',exe:'archive'};
 function kindOf(item){if(item.type==='dir')return 'folder';return KIND[(item.name.split('.').pop()||'').toLowerCase()]||'file';}
 function ico(kind){var el=node('span',null,'pf-ico pf-ico-'+kind);el.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+(ICON[kind]||ICON.file)+'</svg>';return el;}
 function fmtSize(bytes){if(bytes==null)return '';if(bytes<1024)return bytes+' B';if(bytes<1024*1024)return (bytes/1024).toFixed(bytes<10240?1:0)+' KB';if(bytes<1024*1024*1024)return (bytes/1048576).toFixed(bytes<10485760?1:0)+' MB';return (bytes/1073741824).toFixed(1)+' GB';}
 function fmtTime(ms){if(!ms)return '';var d=new Date(ms),now=new Date(),diff=now-d;if(diff<60000)return '刚刚';if(diff<3600000)return Math.floor(diff/60000)+' 分钟前';var sameDay=d.toDateString()===now.toDateString();var hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');if(sameDay)return '今天 '+hm;var yest=new Date(now.getTime()-86400000);if(d.toDateString()===yest.toDateString())return '昨天 '+hm;if(d.getFullYear()===now.getFullYear())return (d.getMonth()+1)+'月'+d.getDate()+'日';return d.getFullYear()+'年'+(d.getMonth()+1)+'月'+d.getDate()+'日';}
 function fmtFull(ms){return ms?new Date(ms).toLocaleString('zh-CN'):'';}
 /* 附件名常是整串哈希（17fa5d9b…png），直接铺在行里等于没有信息。
    中间省略：留前 8 位和后 6 位，后缀完整，一眼能看出是同一张还是另一张。 */
 function displayName(name){
  var match=/^([0-9a-f]{16,})(\.[a-z0-9]{1,6})$/i.exec(name);
  if(!match)return name;
  var head=match[1].slice(0,8),tail=match[1].slice(-6);
  return head+'…'+tail+match[2];
 }

 /* ── 工具条：一行操作 + 一行搜索，按钮全部同一种胶囊/方角语言 ── */
 var toolbar=node('div',null,'pf-toolbar'),rootSelect=node('select'),lastLocationSig='',search=node('input'),crumb=node('div','','pf-path'),list=node('div',null,'pf-list'),status=node('p','','pf-status'),pages=node('div',null,'pf-actions'),editorPane=node('section',null,'pf-editor-pane');
 rootSelect.setAttribute('aria-label','文件位置');search.type='search';search.placeholder='在当前目录筛选…';search.setAttribute('aria-label','筛选当前目录');status.setAttribute('role','status');
 /* 下拉外壳：原生 select 右边永远留一大块系统箭头空白、宽度还会跟着选中项文字变。
     2026-11-22 主人判「太丑、空白多、长度会变」——改成 外壳给边框和自绘箭头 +
     select appearance:none 透明铺满。宽度由父级 grid 的 1fr 锁死，和筛选框等宽。 */
 var rootSelectWrap=node('span',null,'pf-select');
 rootSelectWrap.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
 rootSelectWrap.prepend(rootSelect);
 function iconButton(label,glyph,run){var b=button('',run,'pf-ibtn');b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+glyph+'</svg>';b.setAttribute('aria-label',label);b.title=label;return b;}
 var up=iconButton('上一级','<path d="M15 6l-6 6 6 6"/>',()=>{if(state.path)navigate(state.root,state.path.split('/').slice(0,-1).join('/'));});
 var refresh=iconButton('刷新','<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',()=>refreshLocation());
 var newFile=button('新建文件',()=>create(false),'pf-chip'),newDir=button('新建目录',()=>create(true),'pf-chip'),archiveView=button('归档',()=>history(true),'pf-chip');
 /* 排序（2026-11-22 主人要的）：点同一列 = 正序/倒序互换，点另一列 = 换列并从正序开始。
    目录永远在前，只排同组内部 —— 文件夹被时间序冲散比不排序更难找。
    图标跟在文字后面：箭头朝上=正序、朝下=倒序。图标常驻（不靠 ::after 插入），
    所以切换方向时按钮宽度恒定，不会忽大忽小；未选中只是变灰，不是不显示。 */
 var ICON_UP='<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',ICON_DOWN='<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>';
 var sortBar=node('div',null,'pf-sort'),sortBtns={};
 [['name','名称'],['time','时间']].forEach(function(pair){
  var b=node('button',null,'pf-sortbtn');b.type='button';
  b.innerHTML='<span>'+pair[1]+'</span><svg class="pf-sortarrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+ICON_UP+'</svg>';
  b.onclick=function(){var s=state.sort;s.dir=s.by===pair[0]?-s.dir:1;s.by=pair[0];paintSort();load();};
  sortBar.append(b);sortBtns[pair[0]]=b;
 });
 function paintSort(){
  var s=state.sort;
  Object.keys(sortBtns).forEach(function(k){
   var b=sortBtns[k],on=k===s.by,asc=s.dir>0;
   b.classList.toggle('is-on',on);
   b.setAttribute('aria-pressed',on?'true':'false');
   b.title='按'+(k==='time'?'时间':'名称')+'排序'+(on?(asc?'（正序，再点变倒序）':'（倒序，再点变正序）'):'');
   b.querySelector('svg').innerHTML=on&&!asc?ICON_DOWN:ICON_UP;
  });
 }
 function sortItems(items){
  var s=state.sort;return items.slice().sort(function(a,b){
   var ad=a.type==='dir'?0:1,bd=b.type==='dir'?0:1;if(ad!==bd)return ad-bd;
   var cmp=s.by==='time'?(a.mtime||0)-(b.mtime||0):String(a.name).localeCompare(String(b.name),'zh-Hans-CN',{numeric:true,sensitivity:'base'});
   return cmp*s.dir||String(a.name).localeCompare(String(b.name),'zh-Hans-CN',{numeric:true});
  });
 }
 var locations=node('div',null,'pf-locations'),manage=node('div',null,'pf-manage'),searchRow=node('div',null,'pf-searchrow');
 var head=node('div',null,'pf-head'),headCount=node('div','','pf-count');
 /* 两层结构（2026-11-22 二次重做：主人判「挤在一起用不了、字号比周围大一圈」）：
    · 工具条第一行只留操作 —— 上一级 / 下拉 / 筛选框 / 刷新，四个控件不打架；
    · 第二行面包屑（本会话/自我修复……）独行，不再和按钮抢宽度；
    · 排序从按钮条降级为表头附着的小三角（24px，11.5px 字），跟文件名同一行；
    · 新建/归档仍在列表下方 .pf-manage，不进工具条。 */
 locations.append(up,rootSelectWrap,search,refresh);
 searchRow.append(crumb);
 head.append(headCount,sortBar);
 toolbar.append(locations,searchRow);
 /* 2026-11-23：列表与预览分成上下两块，各自滚动。
   listRegion 装「工具条+状态+表头+列表+分页」，editorPane 单独在下面，
   面板本身不再滚动（见 panel-durable.css #ws-files 那段注释）。 */
var listRegion=node('div',null,'pf-list-region');
listRegion.append(toolbar,status,head,list,manage,pages);
pane.append(listRegion,editorPane);
 manage.append(newFile,newDir,archiveView);paintSort();
 var title=node('h3'),editor=node('textarea'),editorFeedback=node('p','','pf-status'),actions=node('div',null,'pf-actions'),preview=node('div',null,'pf-preview');editor.spellcheck=false;editor.setAttribute('aria-label','文件内容');editorFeedback.setAttribute('role','status');
 /* markdown 渲染区：和档案页 .arc-md 完全同一套 DOM 与样式（archive.css 已全局加载），
    亮/暗主题靠 body.theme-light 覆盖 + CSS 变量自动切换，这里不复制任何主题规则。 */
 var mdView=node('article',null,'arc-md pf-md-view');mdView.hidden=true;preview.append(mdView);
 function mdModule(){try{return window.Archive&&window.Archive.modules&&window.Archive.modules.md;}catch(_){return null;}}
 function paintMarkdownPreview(){
   var m=mdModule();if(!m||!state.document)return false;
   try{m.paint(mdView,editor.value||'');return true;}catch(e){mdView.textContent=editor.value||'';return false;}
 }
 /* 渲染 / 源码 两态：默认渲染，点按钮互切；切到源码时 textarea 拿原草稿，改完切回来重渲染 */
 var mdToggle=button('编辑源码',function(){
   var toSource=!editor.hidden;
   if(toSource){setMdMode(false);mdToggle.textContent='预览';editorFeedback.textContent='源码模式 · 改完点「预览」看效果';}
   else{setMdMode(true);mdToggle.textContent='编辑源码';editorFeedback.textContent='Markdown 已渲染';}
 });
 mdToggle.hidden=true;
 function setMdMode(render){
   /* render=true → 显示渲染结果；false → 显示 textarea 源码 */
   state.mdPreview=!!render;
   mdView.hidden=!render;editor.hidden=render;
   preview.hidden=false;
 }
 var save=button('保存修改',saveFile),versions=button('修改记录',()=>history(false)),merge=button('读取最新版本并合并',mergeLatest),downloadDraft=button('下载草稿',function(){downloadBlob(new Blob([editor.value],{type:'text/plain'}),(state.document?.path.split('/').pop()||'文件')+'.draft.txt');});
 actions.append(mdToggle,save,merge,versions,downloadDraft,button('关闭',closeEditor));editorPane.append(title,actions,editorFeedback,preview,editor);editorPane.hidden=true;merge.hidden=true;
 function downloadBlob(blob,name){var url=URL.createObjectURL(blob),link=node('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
 function activeSession(){return window._channelViewActive?'':window.currentSession||'';}
 function imageApi(sid,body){return fetch(apiUrl('/api/workspace-ui/session-images?sid='+encodeURIComponent(sid)+(body?'':'&thumbs=1')),{method:body?'DELETE':'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:body?JSON.stringify(body):undefined,cache:'no-store'}).then(async r=>{var d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'图片操作失败');return d;});}
 async function deleteImage(item,sid){
  if(!await ui.confirm(item.is_thumb?'删除这张缩略图？原图保留，可从回收站恢复。':'删除这张原图及其缩略图？引用同一张图的会话也会受影响，可从回收站恢复。'))return;
  if(sid!==activeSession())return;
  try{var out=await imageApi(sid,{kind:item.kind,name:item.name,revision:item.revision});window.dispatchEvent(new CustomEvent('panel-session-image-deleted',{detail:{sid:sid,item:item,names:out.names}}));if(sid===activeSession()){closeEditor();await load();feedback('已移入回收站：'+out.batch);}}catch(e){if(sid===activeSession())feedback(e.message);}
 }
 async function imageDownload(item){try{var r=await fetch(apiUrl(item.url),{headers:{'X-Monitor-Token':monitorToken||''},cache:'no-store'});if(!r.ok)throw Error('图片下载失败，请刷新');downloadBlob(await r.blob(),item.name);}catch(e){feedback(e.message);}}
 function showImage(item){
  closeEditor();title.textContent=item.name;editorPane.hidden=false;actions.hidden=true;editor.hidden=true;preview.hidden=false;
  editorFeedback.textContent=item.is_thumb?'预览缩略图':'预览原图';
  var img=node('img');img.src=apiUrl(item.url);
  preview.replaceChildren(mdView,img,button(item.is_thumb?'下载缩略图':'下载原图',()=>imageDownload(item)),button('关闭',closeEditor));
 }
 function resetNavigation(){closeEditor();clearTimeout(search.timer);search.value=state.query='';state.offset=0;}
 /* 2026-11-22 主人报「输入一个字母就失焦」的真根因在这里：
   禁用一个正持焦点的 input 会把焦点扔回 body，再启用也不会自动还回来。
   load() 每次都先 clearListing() → search.disabled=true → 220ms 后回来再设 false，
   等于每敲一个字就被踢出输入框一次。搜索框没有理由参与「读取中」的禁用。 */
function clearListing(){state.listing=null;headCount.textContent='';list.replaceChildren();pages.replaceChildren();up.disabled=true;manage.hidden=true;}
 function navigate(root,path){resetNavigation();rootSelect.disabled=false;state.root=root;state.path=path;return load();}
 /* 2026-11-22 主人报「输入一个字母就失焦」：
     原先 load() 每次完成都调 renderLocations()，而它一上来就 rootSelect.replaceChildren()
     把 <select> 清空重建。筛选输入 220ms 后触发 load() → 下拉选项被整体重建 →
     焦点丢失，只能再敲一个字。现在渲染前先比对，选项没变就一个节点都不动。
     判据用「id + 文字 + disabled + 分组」拼出的签名，任何一项不同才真正重建。 */
 /* 下拉内容的指纹：本会话是否可选、工作区根、下拉里出现哪些根。
     只有这些真变了才重建 option，否则筛选框每敲一个字就会被打断。 */
 function signature(){
  var ids=['current','workspace'];
  if(state.roots){var v={sessions:1,generated:1,trash:1,data:1};state.roots.forEach(function(r){if(r.available&&v[r.id])ids.push(r.id);});}
  return (contextId?'1':'0')+'|'+ids.join(',');
 }
 function renderLocations(){
  var sig=signature();
  if(sig===lastLocationSig){sizeSelect();return;}
  lastLocationSig=sig;
  rootSelect.replaceChildren();
  function option(parent,id,label,disabled){var o=node('option',label);o.value=id;o.disabled=!!disabled;parent.append(o);}
  option(rootSelect,'current','本会话',!contextId);
  option(rootSelect,'workspace','共享工作区');
  var other=node('optgroup');other.label='其他位置';
  /* 2026-11-20：下拉里只留人真会去翻的位置。临时产物、图片缓存、别 profile 的
     工作区都属于内部目录，从下拉里撤掉（根仍挂载，URL 访问不受影响），
     否则主人看到的就是一列不知道是什么的东西。
     2026-11-20 晚：加回「回收站」——应用目录没有系统回收站，删的东西进 data/trash，
     这里是他唯一看得见、能还原的入口。 */
  /* 2026-11-20 晚：知识库根从下拉撤掉 —— 目录里的非文本附件已搬去共享工作区，
     剩下 1032 篇笔记与「档案 → 知识库」逐条一致，看笔记去资料页就够了。
     兜底根「全部文件」挂的是整个 data，任何落错位置的文件都能从这里找回来。 */
  /* 2026-11-20 晚二次：uploads 根（历史对话附件）也撤了 —— 那是会话目录改造前的旧落点，
     39 个零引用文件已进回收站、2 张被旧消息点名的图搬去 workspace/历史对话附件/。
     空目录保留给 roots 兜底，从「全部文件 → uploads」仍进得去。 */
  var visible={sessions:'全部会话',generated:'公共生成图库',trash:'回收站',data:'全部文件'};
  state.roots.forEach(r=>{if(r.available&&visible[r.id])option(other,r.id,visible[r.id]);});
  rootSelect.append(other);
  rootSelect.value=state.root==='sessions'&&sessionPath&&(state.path===sessionPath||state.path.startsWith(sessionPath+'/'))?'current':state.root;
  sizeSelect();
 }
 /* 2026-11-22：下拉宽度按「最长选项」定，不按当前选中项。
     之前的毛病是外层吃 1fr（约 119px），选到「回收站」这种两个字的位置时，
     文字右边到箭头之间就是一大片空——主人判「很多空白区域」。
     量法：离屏 canvas 按 select 的字体算每个 option 的宽度，取最大值 + 左右内边距
     + 箭头位。用 max-content 兜底，`ch` 单位在中文下不准所以不用。
   2026-11-22 二改：主人仍嫌「太长」。按最长选项定宽必然被「公共生成图库」撑到 103px，
     但绝大多数时候看的是「本会话 / 共享工作区」（3~5 字）。改成：
     宽度只保证「当前选中项」不省略，最短 88px；选中项变长时靠 JS 再加，
     不再为一年点一次的「公共生成图库」常驻六个字的宽度。 */
 function sizeSelect(){
  var wrap=rootSelectWrap;if(!wrap||!rootSelect.options.length)return;
  var font=getComputedStyle(rootSelect).font,c=window.__pfSelCanvas||(window.__pfSelCanvas=document.createElement('canvas')),ctx=c.getContext('2d');
  if(ctx){ctx.font=font;}
  var cur=rootSelect.selectedOptions[0],curText=cur?cur.textContent:'',curW=ctx?ctx.measureText(curText).width:curText.length*13;
  var total=Math.ceil(curW)+9+22;             /* 左 9 内边距 + 右 22（箭头 12 + 间距 7 + 余量 3） */
  var max=Math.max(96,Math.round(wrap.parentElement.getBoundingClientRect().width*0.42));
  wrap.style.setProperty('--pf-sel-w',Math.min(Math.max(total,92),max)+'px');
 }
 /* 面包屑：每段可点，跳到该层；末段是当前位置，不再可点 */
 function renderPath(){
  var parts=state.path?state.path.split('/'):[],label=rootSelect.selectedOptions[0]?.textContent||'文件';
  if(rootSelect.value==='current'){
   var session=(window._sessions||[]).find(s=>s.id===contextId);
   var home=sessionPath.split('/');
   parts=[...home.slice(0,-1),session?.title||'当前会话',...parts.slice(home.length)];
  }
  var segments=[label,...parts];
  crumb.replaceChildren();
  segments.forEach(function(text,index){
   var last=index===segments.length-1;
   if(last){crumb.append(node('span',text,'pf-crumb-here'));return;}
   var b=node('button',text,'pf-crumb-link');b.type='button';
   b.title=text;
   b.onclick=function(){navigate(state.root,state.path.split('/').slice(0,Math.max(0,index-0)).slice(0,Math.max(0,index)).join('/'));};
   if(index===0&&rootSelect.value==='current'){b.onclick=goSession;}
   else if(index===0){b.onclick=function(){navigate(state.root,'');};}
   crumb.append(b,node('span','/','pf-crumb-sep'));
  });
  crumb.title=state.listing?.absolute_path||'';
 }
 async function goSession(){
  var sid=activeSession();
  if(!sid)return navigate('workspace','');
  var request=++sequence;resetNavigation();clearListing();rootSelect.disabled=true;crumb.textContent='本会话文件';crumb.title='';feedback('正在定位会话文件…');
  try{
   var r=await fetch(apiUrl('/api/workspace-ui/session-dir'),{method:'POST',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:JSON.stringify({id:sid})});
   var d=await r.json();if(!r.ok||!d.ok||!/^sessions\/.+/.test(d.dir||''))throw Error(d.error||'取会话目录失败');
   if(request!==sequence||sid!==activeSession())return;
   sessionPath=d.dir.slice('sessions/'.length);
   /* 2026-11-23 主人报「会话文件的图片就是画板文件，为什么出来两套」：
      原来画板会话被导向 sessionPath+'/@images' —— 一个不存在的假目录，
      load() 见到它就改调 session-images 接口，渲染出第二份列表（图片），
      面包屑再配一条「会话全部文件」的 chip 当第二个入口。等于一个会话两套账。
      实测普通目录列表已具备主人要的全部行为：rowFor 第 312-314 行对会话目录里的图
      先 locateImage（画板模式跳节点 / 对话模式跳气泡），跳不到才 openFile 预览。
      所以假目录整个删掉，两种会话类型都进同一个会话目录，一份数据一个入口。 */
   return navigate('sessions',sessionPath);
  }catch(e){if(request===sequence&&sid===activeSession()){renderLocations();rootSelect.value='current';rootSelect.disabled=false;list.append(node('p',e.message,'empty-state'),button('重试',goSession));feedback(e.message);}}
 }
 function refreshLocation(){
  var sid=activeSession();
  if(sid!==contextId){contextId=sid;sessionPath=null;state.root='workspace';state.path='';return goSession();}
  if(sid&&rootSelect.disabled)return; // A session lookup is already pending.
  if(sid&&!sessionPath&&rootSelect.value==='current')return goSession();
  return load();
 }
 rootSelect.onchange=function(){sizeSelect();if(this.value==='current')goSession();else navigate(this.value,'');};
 search.oninput=function(){clearTimeout(this.timer);this.timer=setTimeout(()=>{state.query=search.value;state.offset=0;load();},220);};
 function absolute(path){var prefix=state.listing.absolute_path;if(state.path)prefix=prefix.slice(0,-state.path.length);else if(!prefix.endsWith('/'))prefix+='/';return prefix+path;}
 /* 会话里的图，点名字先「找到它在哪」（2026-11-20 用户要求）：
    画板模式跳到画布上那张图的节点，对话模式滚到发这张图的那条消息。
    两边都找不到才退回原来的打开预览 —— 定位是加法，不能把原来的预览弄丢。 */
 function locateImage(name,fallback){
  var cv=window.CanvasMode;
  /* 只有「正看着画布」才跳节点。画板会话里也能切到对话视图，
     那种时候用户要看的是消息，不能被 reveal 又拽回画布。 */
  var onCanvas=cv&&cv.isOn&&cv.isOn()&&(!cv.viewMode||cv.viewMode()==='canvas');
  if(onCanvas&&typeof cv.reveal==='function'&&cv.reveal(name))return true;
  if(window.focusFileInChat){
   window.focusFileInChat(name).then(function(ok){if(!ok)fallback();},function(){fallback();});
   return true;
  }
  return false;
 }
 function linkFor(path,kind){return apiUrl('/api/'+kind+'?path='+encodeURIComponent(path));}
 function attach(path){window.fmAttachPath(path);}
 async function download(path){try{var response=await fetch(linkFor(path,'download'),{headers:{'X-Monitor-Token':monitorToken||''}});if(!response.ok)throw Error((await response.json()).error||'下载失败');downloadBlob(await response.blob(),path.split('/').pop());}catch(e){feedback(e.message);}}
 /* 一行 = 图标/缩略图 + 名称 + 副信息（体积 · 项数 · 修改时间）+ 悬停才亮起的操作 */
 function rowFor(item,editable){
  var kind=kindOf(item),row=node('div',null,'pf-item'+(item.type==='dir'?' is-dir':''));
  row.setAttribute('data-kind',kind);
  if(kind==='image'){
   var thumb=node('img',null,'pf-thumb');thumb.loading='lazy';thumb.alt='';
   /* 学画板抽屉那套（2026-11-20）：先取同名 .thumb.webp，没有才回落原图。
      原来这里直接拿 preview 接口读原图当缩略图 —— 一张 1.2 MB 的海报
      在列表里就是实打实解码 1.2 MB，一个目录十几张能把滚动拖卡。 */
   var full=linkFor(absolute(item.path),'preview');
   thumb.src=(/\.thumb\.webp$/i.test(item.path)?full:full.replace(/\.(png|jpe?g|webp|gif)(?=$|[?#&])/i,'.thumb.webp'));
   thumb.onerror=function(){
     if(this.getAttribute('src')!==full){this.setAttribute('src',full);return;}
     this.replaceWith(ico(kind));
   };
   row.append(thumb);
  }else{
   row.append(ico(kind));
  }
  var main=node('div',null,'pf-main'),open=node('button',displayName(item.name),'pf-name');
  open.type='button';open.title=item.name;
  open.onclick=function(){
   if(item.type==='dir'){navigate(state.root,item.path);return;}
   /* 会话目录里的图：先定位（画板节点 / 对话气泡），定位不到才开预览 */
   var ext=item.name.split('.').pop().toLowerCase(),inSession=/\/sessions\//.test(state.listing?.absolute_path||'');
   if(inSession&&['png','jpg','jpeg','gif','webp','bmp'].includes(ext)&&locateImage(item.name,function(){openFile(item.path);}))return;
   openFile(item.path);
  };
  var meta=node('div',null,'pf-meta'),bits=[];
  if(item.type==='dir'){if(item.count!=null)bits.push(item.count>=1000?'1000+ 项':item.count+' 项');}
  else bits.push(fmtSize(item.bytes));
  if(item.mtime)bits.push(fmtTime(item.mtime));
  bits.forEach(function(text,index){if(index)meta.append(node('span','·','pf-dot'));var piece=node('span',text);if(index===0&&item.type!=='dir')piece.className='pf-meta-size';meta.append(piece);});
  main.append(open,meta);row.append(main);
  var acts=node('div',null,'pf-acts');
  function act(label,glyph,run){var b=iconButton(label,glyph,function(event){event.stopPropagation();run();});b.classList.add('pf-act');acts.append(b);return b;}
  if(item.type==='file'){
   act('预览','<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',()=>openFile(item.path));
   act('下载','<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5L16.5 11"/><path d="M5 20h14"/>',()=>download(absolute(item.path)));
   act('附加到对话','<path d="M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 18a2 2 0 0 1-3-3l7.5-7.5"/>',()=>attach(absolute(item.path)));
   /* 2026-11-23：删掉 @images 那份平行列表后，会话图片的「删除（进回收站）」
      原本只在 imageRow 里有。这里按同样判据补回来 —— 只在会话目录、只对图片、
      且能确定 kind（artifacts/uploads）时才给删除，走 session-images 同一个接口，
      硬链接校验/回收站行为不变。 */
   if(kind==='image'){
    var kindDir=(item.path||'').split('/').filter(function(s){return s==='artifacts'||s==='uploads';}).pop();
    if(inSessionDir()&&kindDir&&activeSession())act('删除（进回收站）','<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/>',()=>deleteImageByName(item,kindDir,activeSession()));
   }
  }
  if(editable)act('归档','<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',()=>archive(item));
  row.append(acts);
  return row;
 }
 /* 当前是否停在「本会话文件」里。旧的 @images 假目录已删（2026-11-23），
    会话模式的判据统一看 root + sessionPath 前缀。 */
 function inSessionDir(){return state.root==='sessions'&&!!sessionPath&&(state.path===sessionPath||state.path.indexOf(sessionPath+'/')===0);}
 /* 按文件名删会话图片：普通列表不带 revision，先向 session-images 要一次真值再删，
    沿用它的乐观锁与硬链接校验，不另开删除通道。 */
 async function deleteImageByName(item,kindDir,sid){
  if(!window.confirm('把「'+item.name+'」移入回收站？'))return;
  try{
   var cur=await imageApi(sid),hit=(cur.images||[]).filter(function(i){return i.name===item.name&&i.kind===kindDir;})[0];
   if(!hit)throw Error('图片已不在列表里，刷新后重试');
   await deleteImage(hit,sid);
  }catch(e){feedback(e.message);}
 }
 function emptyState(text){var box=node('div',null,'pf-empty');box.append(ico('file'),node('p',text));return box;}
 async function load(){if(rootSelect.disabled)return;var request=++sequence;clearListing();feedback('正在读取文件…');
 /* 防卡死：切位置太快时旧请求被新请求顶掉，状态会停在“正在读取”。9 秒还没结果就重来一次。 */
 setTimeout(function(){if(request===sequence&&!state.listing)load();},9000);
 try{
  if(!state.roots.length){var roots=await api('roots');if(request!==sequence)return;state.roots=roots.roots;}
  renderLocations();rootSelect.disabled=false;renderPath();
  var out=await api('',{root:state.root,path:state.path,query:state.query,offset:state.offset});if(request!==sequence)return;state.listing=out;_fmCwd=out.absolute_path;renderPath();up.disabled=!state.path;manage.hidden=!out.editable;
  var rows=sortItems(out.items);list.replaceChildren();var bytes=0;rows.forEach(function(item){if(item.type==='file')bytes+=item.bytes||0;list.append(rowFor(item,out.editable));});
  if(!rows.length)list.append(emptyState(state.query?'没有匹配的文件':'此目录是空的'));
  pages.replaceChildren();
  if(state.offset>0)pages.append(button('上一页',()=>{state.offset=Math.max(0,state.offset-80);load();},'pf-chip'));
  if(out.next!=null)pages.append(button('下一页',()=>{state.offset=out.next;load();},'pf-chip'));
  var parts=[out.total+' 项'];
  if(bytes)parts.push(fmtSize(bytes));
  if(out.next!=null)parts.push('第 '+(Math.floor(state.offset/80)+1)+' 页');
  if(out.skipped)parts.push(out.skipped+' 个链接或特殊文件已跳过');
  feedback(parts.join(' · '));
 }catch(e){if(request===sequence){list.replaceChildren(emptyState(e.message),button('重试',()=>load(),'pf-chip'));feedback(e.message);}}}
 async function openFile(path){closeEditor();var root=state.root;/* 2026-11-23：打开文件不再藏列表。
   主人要求列表留在上面、预览在下面，滚动各走各的：pane 加 has-preview 让列表区封顶 75%，
   editorPane 吃掉剩下的高度自己滚。关闭 editor 时摘掉这个类，列表区放开回整块。 */
 pane.classList.add('has-preview');editorPane.hidden=false;title.textContent=path.split('/').pop();editorFeedback.textContent='正在读取…';editor.hidden=true;/* mdView 挂在 preview 里，清空后要补回来，否则 md 渲染无处可落 */preview.replaceChildren(mdView);mdView.hidden=true;mdToggle.hidden=true;preview.hidden=false;actions.hidden=true;
  var ext=path.split('.').pop().toLowerCase(),urlPath=absolute(path);state.document={root:root,path:path,absolute:urlPath};
  if(['png','jpg','jpeg','gif','webp','svg','bmp','pdf','html','htm','docx','xlsx','pptx','mp3','wav','mp4','webm'].includes(ext)){
   var media=['png','jpg','jpeg','gif','webp','svg','bmp'].includes(ext)?node('img'):['mp3','wav'].includes(ext)?node('audio'):['mp4','webm'].includes(ext)?node('video'):node('iframe');
   /* 2026-11-22：iframe 的 sandbox 只对 html/htm 这类真文档设。空值 sandbox=""
      等于最严格沙箱（唯一源、禁一切），Chrome 内置 PDF 查看器是扩展页面，
      在里面会被直接拒绝，Chrome 弹「此页面已被 Chrome 屏蔽」。PDF 不设 sandbox。 */
   if(media.tagName==='IFRAME' && ['html','htm'].includes(ext))media.setAttribute('sandbox','');
   if(['AUDIO','VIDEO'].includes(media.tagName))media.controls=true;
   media.src=linkFor(urlPath,['docx','xlsx','pptx'].includes(ext)?'preview/office':'preview');media.title=path.split('/').pop();preview.append(media,button('下载原文件',()=>download(urlPath)),button('关闭',closeEditor));editorFeedback.textContent='预览原文件';return;
  }
  var opened=state.document;
  try{var doc=await api('read',{root:root,path:path});if(state.document!==opened)return;var remote=await api('draft',{root:root,path:path});if(state.document!==opened)return;state.document={...doc,absolute:urlPath};state.draftRevision=remote.draft.revision;var saved;try{saved=JSON.parse(localStorage.getItem(key(doc))||'null');}catch(_){}
   editor.value=saved?.root_revision===doc.root_revision?saved.text:remote.draft.base_revision?remote.draft.text:doc.content;editor.hidden=false;preview.hidden=true;actions.hidden=false;save.hidden=!doc.editable;editor.readOnly=!doc.editable;merge.hidden=!doc.editable;downloadDraft.hidden=false;
   editorFeedback.textContent=editor.value===doc.content?'文件已读取':((saved?.base_revision||remote.draft.base_revision)!==doc.revision?'已恢复草稿，原文件有更新，请合并后保存':'已恢复未保存的草稿');if((saved?.base_revision||remote.draft.base_revision)&&editor.value!==doc.content)state.document.revision=saved?.base_revision||remote.draft.base_revision;
   /* Markdown：默认按语法渲染（复用档案页那套 md 模块，见 paintMarkdownPreview），
      想看/改源码就点「编辑源码」，编辑器仍是原来的 textarea，草稿链路不变。 */
   if(ext==='md'){state.mdPreview=true;paintMarkdownPreview();setMdMode(true);mdToggle.hidden=false;editorFeedback.textContent=state.document.editable?'Markdown 已渲染 · 点「编辑源码」可修改':'Markdown 已渲染';}
   else{mdToggle.hidden=true;mdView.hidden=true;}
  }catch(e){editorFeedback.textContent=e.message;preview.replaceChildren(mdView,button('下载原文件',()=>download(urlPath)),button('关闭',closeEditor));}}
 editor.oninput=function(){if(!state.document)return;localDraft(state.document,editor.value);editorFeedback.textContent='草稿保存在此浏览器';clearTimeout(draftTimer);draftTimer=setTimeout(syncDraft,700);/* 源码模式改了内容，切回预览时才能看到最新渲染；这里同步脏一份 */if(state.document.path.split('.').pop().toLowerCase()==='md'){clearTimeout(mdRenderTimer);mdRenderTimer=setTimeout(function(){if(!editor.hidden)return;paintMarkdownPreview();},400);}};
 async function syncDraft(){var doc=state.document;if(!doc?.revision||!doc.editable)return;var text=editor.value;try{var result=await api('draft',{root:doc.root,path:doc.path,revision:state.draftRevision,text:text,base_revision:doc.revision},true);if(state.document===doc){state.draftRevision=result.draft.revision;editorFeedback.textContent='草稿已同步';}}catch(e){if(state.document===doc)editorFeedback.textContent=e.message;}}
 function closeEditor(){clearTimeout(draftTimer);if(state.document?.revision&&state.document.editable)localDraft(state.document,editor.value);state.document=null;state.mdPreview=false;mdView.hidden=true;mdToggle.hidden=true;if(mdToggle)mdToggle.textContent='编辑源码';editorPane.hidden=true;
  /* 摘掉 has-preview，列表区放开回整块（openFile 里加的类） */
  pane.classList.remove('has-preview');}
 async function saveFile(){if(saveBusy||!state.document?.revision)return;saveBusy=true;save.disabled=true;clearTimeout(draftTimer);var doc=state.document,text=editor.value;localDraft(doc,text);var payload={root:doc.root,path:doc.path,root_revision:doc.root_revision,exists:true,revision:doc.revision,content:text};try{var pending=JSON.parse(localStorage.getItem(key(doc)+':pending')||'null');if(pending&&JSON.stringify(pending.payload)===JSON.stringify(payload))payload.request_id=pending.id;}catch(_){}if(!payload.request_id){var requestId=crypto.randomUUID();try{localStorage.setItem(key(doc)+':pending',JSON.stringify({id:requestId,payload:payload}));}catch(_){}payload.request_id=requestId;}editorFeedback.textContent='正在保存并备份旧版本…';try{var out=await api('write',payload,true);try{localStorage.removeItem(key(doc)+':pending');}catch(_){}if(state.document===doc){state.document={...out,absolute:doc.absolute};localDraft(state.document,text);editorFeedback.textContent='已保存，旧版本可在修改记录中恢复';await syncDraft();}await load();if(state.document?.path===doc.path)editorFeedback.textContent=editor.value===out.content?'已保存，旧版本可在修改记录中恢复':'文件已保存，后续输入仍是草稿';}catch(e){editorFeedback.textContent=e.message;}finally{saveBusy=false;save.disabled=false;}}
 async function mergeLatest(){var doc=state.document;if(!doc)return;try{var latest=await api('read',{root:doc.root,path:doc.path}),draft=await api('draft',{root:doc.root,path:doc.path});var dialog=modal('合并文件与草稿');dialog.body.append(node('p','先对照最新文件和其他设备草稿，在下方编辑合并结果。继续后仍需点击保存。'));
  var original=node('textarea'),other=node('textarea'),result=node('textarea');original.readOnly=other.readOnly=true;original.value=latest.content;other.value=draft.draft.text;result.value=editor.value;original.setAttribute('aria-label','磁盘最新文件');other.setAttribute('aria-label','已同步草稿');result.setAttribute('aria-label','合并结果');dialog.body.append(node('h3','磁盘最新文件'),original,node('h3','已同步草稿'),other,node('h3','合并结果'),result,button('使用合并结果',function(){state.document={...latest,absolute:doc.absolute};state.draftRevision=draft.draft.revision;editor.value=result.value;localDraft(state.document,editor.value);syncDraft();dialog.close();}));}catch(e){editorFeedback.textContent=e.message;}}
 function modal(name){
  /* 适配器：唯一实现是 core/ui-kit.js 的 UI.modal，返回 {body,close} 老约定。
     原来这份没有焦点陷阱、关掉也不还原焦点，现在是统一弹窗的那一套。 */
  var m=window.ui.modal({title:name,overlayClass:'modal-overlay',className:'modal pf-modal'});
  return {body:m.bodyEl,close:m.close};
}
 async function create(directory){if(!state.listing?.editable)return;var dialog=modal(directory?'新建目录':'新建文件'),input=node('input'),note=node('p','','pf-status');input.setAttribute('aria-label',directory?'目录名称':'文件名称');dialog.body.append(input,note,button('创建',async function(){var name=input.value.trim();if(!name||name.startsWith('.')||/[\\/]/.test(name)){note.textContent='请输入不含路径分隔符的名称';return;}this.disabled=true;var path=[state.path,name].filter(Boolean).join('/');try{await api(directory?'mkdir':'write',{root:state.root,path:path,root_revision:state.listing.root_revision,exists:false,revision:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',content:'',request_id:crypto.randomUUID()},true);dialog.close();await load();if(!directory)openFile(path);}catch(e){note.textContent=e.message;this.disabled=false;}}));input.focus();}
 async function archive(item){if(!(await ui.confirm('归档“'+item.name+'”？可在归档列表恢复。')))return;try{await api('archive',{root:state.root,path:item.path,root_revision:state.listing.root_revision,entry_revision:item.entry_revision,request_id:crypto.randomUUID()},true);if(state.document?.path===item.path)closeEditor();await load();feedback('已归档，可从归档列表恢复');}catch(e){feedback(e.message);}}
 async function history(archived){var root=state.root,path=state.document?.path;if(!archived&&!path)return;var dialog=modal(archived?'已归档文件':'修改记录'),note=node('p','','pf-status'),rows=node('div'),more=button('加载更多',()=>page(next));var next=0;dialog.body.append(note,rows,more);
  async function page(offset){more.disabled=true;try{var query={root:root,offset:offset};if(archived)query.archived='1';else query.path=path;var out=await api('history',query);if(!out.items.length&&!offset)rows.append(node('p','暂无记录','empty-state'));out.items.forEach(function(record){var row=node('section',null,'pf-history');row.append(node('strong',record.path),node('p',new Date(record.created_at).toLocaleString('zh-CN')));if(record.kind==='archive'){row.append(node('p',record.status==='archived'?'已归档':record.status==='restored'?'已恢复':'归档未完成'));if(record.status==='archived')row.append(button('恢复文件',async function(){this.disabled=true;try{await api('restore',{change_id:record.id},true);await load();row.append(node('p','已恢复'));this.remove();}catch(e){note.textContent=e.message;this.disabled=false;}}));}else{row.append(button('查看旧版本',async function(){try{var out=await api('version',{change_id:record.id}),version=modal('保存前的版本'),text=node('textarea');text.readOnly=true;text.value=out.content;version.body.append(text,button('下载旧版本',()=>downloadBlob(new Blob([out.content]),record.path.split('/').pop())));}catch(e){note.textContent=e.message;}}));if(record.before_exists)row.append(button('撤销这次修改',async function(){this.disabled=true;try{var restored=await api('undo',{change_id:record.id,request_id:crypto.randomUUID()},true);localDraft(restored,restored.content);var currentDraft=await api('draft',{root:root,path:path});await api('draft',{root:root,path:path,revision:currentDraft.draft.revision,text:restored.content,base_revision:restored.revision},true);state.document=null;await openFile(path);await load();note.textContent='已恢复旧版本';}catch(e){note.textContent=e.message;}finally{this.disabled=false;}}));}rows.append(row);});next=out.next;more.hidden=next==null;note.textContent=out.total+' 条记录';}catch(e){note.textContent=e.message;}finally{more.disabled=false;}}
  page(0);
 }
 window.addEventListener('panel-session-changed',()=>{
  if(pane.matches('#workspacePanel.open #ws-files.active'))refreshLocation();
  else {++sequence;contextId=null;sessionPath=null;resetNavigation();clearListing();}
 });
 window.fmRefresh=refreshLocation;window.fmUp=()=>up.click();window.fmNewFile=()=>create(false);window.fmNewDir=()=>create(true);window.fmClosePreview=closeEditor;
 window.fmOpenFile=function(absolutePath){var current=state.listing;if(!current?.absolute_path)return;var base=current.absolute_path.slice(0,current.absolute_path.length-state.path.length);if(absolutePath.startsWith(base))openFile(absolutePath.slice(base.length).replace(/^\//,''));};
})();
