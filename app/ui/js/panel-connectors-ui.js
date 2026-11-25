(function(){
  'use strict';
  var catalog=[],load;
  async function refresh(){
    if(load)return load;
    /* 2026-11-16：会话里的「本轮连接器」原来只列 /api/connectors 的 9 条预置模板，
       全都 configured:false，等于一个都选不了；而真正在跑的 MCP 服务器
       （config.yaml 的 mcp_servers，「能力 → 外接工具」能看到）这里完全看不见。
       并行拉 /api/panel-mcp 的 action:read，把 enabled 的服务按同一形状并进来。 */
    load=(async function(){
      var pair=await Promise.all([
        fetch(apiUrl('/api/connectors'),{headers:{'X-Monitor-Token':monitorToken||''},cache:'no-store'}),
        fetch(apiUrl('/api/panel-mcp'),{method:'POST',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:JSON.stringify({action:'read'}),cache:'no-store'})
          .then(function(r){return r.ok?r.json():null;}).catch(function(){return null;})
      ]);
      var response=pair[0],data=await response.json();
      if(!response.ok||!data.ok||!Array.isArray(data.connectors))throw Error(data.error||'连接器状态读取失败');
      catalog=data.connectors;
      var mcp=(pair[1]&&pair[1].ok&&Array.isArray(pair[1].servers))?pair[1].servers:[];
      mcp.filter(function(s){return s&&s.enabled!==false;}).forEach(function(s){
        if(catalog.some(function(c){return c.kind==='mcp:'+s.name;}))return;
        var remote=!!(s.url&&/^https?:\/\//i.test(s.url));
        catalog.push({kind:'mcp:'+s.name,name:s.name,icon:'🧩',color:'#7c8cf8',
          description:remote?'远程 MCP 服务':'本地 MCP 服务',auth_kind:'stored',
          mcp_mode:remote?'remote':'local',configured:true,activation:'active',
          source:'mcp',can_undo:false,probe_supported:false,creds_set:{},tools:[]});
      });
      _connState.list=catalog;return catalog;
    })().finally(function(){load=null;});
    return load;
  }
  function node(tag,text){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
  window.panelConnectorContext=async function(kind){var list=await refresh();var connector=list.find(function(item){return item.kind===kind&&item.configured;});if(!connector)throw Error('所选连接器已不可用，请重新选择或清除');return connector;};
  window.panelConnectorRefresh=refresh;
  /* 2026-11-23：外接工具（MCP）并进来的连接器 kind 形如 mcp:<服务名>，
     它们在 /api/connectors 里没有记录 —— 拿去调 openConnectorModal 只会撞上
     服务端路由的 [A-Za-z0-9_-]+ 白名单，回 404（实测点「查看配置」就弹一个错误框）。
     所以这类一律跳「能力 → 外接工具」页，等列表渲染出来点那一行自己的「编辑」。 */
  function clickCard(card,labels){var hit=null;Array.prototype.forEach.call(card.querySelectorAll('button'),function(b){if(!hit&&labels.indexOf(b.textContent)>=0)hit=b;});if(hit){hit.click();return true;}return false;}
  function openMcpServer(name){
    switchPage('connectors');
    var tries=0;
    (function tick(){
      tries++;
      var hit=null;
      Array.prototype.forEach.call(document.querySelectorAll('#mcpServers .mcp-card'),function(card){
        var h=card.querySelector('h3');
        if(!hit&&h&&h.textContent===name)hit=card;
      });
      if(hit&&clickCard(hit,['编辑','管理连接器']))return;   /* 编辑=自定义 MCP；管理连接器=托管回跳 */
      /* 2026-11-24：托管型 MCP（conn-* 以及与预置连接器同名的那批）在下方不再单独建卡，
         统一由上方「预置连接器」配置 —— 找不到 mcp-card 就回退到上方网格，
         conn-baidu-map → baidu-map，tencent-meeting → tencent-meeting。 */
      var preset=document.querySelector('#connectorGrid .connector-card[data-kind="'+name.replace(/^conn-/,'')+'"]');
      if(preset&&clickCard(preset,['管理连接器','配置连接器']))return;
      if(tries<25){setTimeout(tick,120);return;}
      var host=document.getElementById('mcpServers');
      if(host)host.scrollIntoView({block:'start'});
    })();
  }
  function openConnectorConfig(kind){
    var k=String(kind||'');
    if(k.indexOf('mcp:')===0){openMcpServer(k.slice(4));return;}
    openConnectorModal(k);
  }
  window.openConnectorConfig=openConnectorConfig;
  window.renderConnectorChip=function(){
    var comp=document.getElementById('chatComposer');if(!comp)return;
    var box=document.getElementById('connectorChip');if(!box){box=node('div');box.id='connectorChip';box.className='connector-chip';comp.prepend(box);}
    box.replaceChildren();box.hidden=!_selectedConnector;box.style.display=_selectedConnector?'flex':'none';if(!_selectedConnector)return;
    var connector=catalog.find(function(c){return c.kind===_selectedConnector;});
    var ico=node('span','🔌');ico.className='cc-ico';ico.setAttribute('aria-hidden','true');box.append(ico);
    var label=node('span',connector?connector.name:_selectedConnector);label.className='cc-name';label.title='本轮连接器';box.append(label);
    var settings=node('button','查看配置');settings.type='button';settings.className='cc-btn';settings.onclick=function(){openConnectorConfig(_selectedConnector);};box.append(settings);
    var clear=node('button','×');clear.type='button';clear.className='cc-x';clear.setAttribute('aria-label','清除本轮连接器');clear.onclick=window.clearConnectorChip;box.append(clear);
  };
  window.clearConnectorChip=function(){_selectedConnector='';renderConnectorChip();saveDraft(currentSession);};
  window.panelConnectorRestore=function(){renderConnectorChip();if(_selectedConnector)refresh().then(renderConnectorChip).catch(function(){});};
  var current=null,dialog=document.getElementById('connectorModal'),loadSequence=0,editing=false,busy=false,opener;
  document.body.append(dialog);
  async function apiRequest(path,method,body){var response=await fetch(apiUrl('/api/connectors'+path),{method:method||'GET',cache:'no-store',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:body?JSON.stringify(body):undefined});var result=await response.json();if(!response.ok||!result.ok)throw Object.assign(Error(result.error||'连接器操作失败'),{result:result,status:response.status});return result;}
  function stateLabel(c){return !c.configured?'未配置':c.activation==='apply_failed'?'已保存 · 应用失败':c.activation==='pending'?'已保存 · 待应用':c.activation==='pending_restart'?'已保存 · 待重启应用':c.activation==='restart_requested'?'已保存 · 已请求服务重载':'已配置';}
  var filter='all';
  /* 2026-11-24：这个网格只画「预置连接器」。refresh() 会把 config.yaml 里在跑的 MCP
     服务器也并进 catalog（聊天输入框的连接器选择器要用），但页面下方已有专门的
     「MCP 服务器」区，同一台服务在上方再画一张卡就是重复 —— 实测 zotero / notify-hub /
     windows / nekowhale-stickers 等 enabled MCP 全被画了两遍。 */
  window.renderConnectors=async function(){var grid=document.getElementById('connectorGrid');if(!grid)return;grid.replaceChildren(node('p','正在读取连接器…'));try{var list=await refresh();grid.replaceChildren();list.filter(function(c){return c.source!=='mcp'&&(filter==='all'||(filter==='configured'?c.configured:!c.configured));}).forEach(function(c){var card=node('article');card.className='connector-card';card.dataset.kind=c.kind;card.append(node('h3',c.name),node('p',c.description),node('p',stateLabel(c)));var button=node('button',c.configured?'管理连接器':'配置连接器');button.className='btn';button.onclick=function(){openConnectorConfig(c.kind);};card.append(button);grid.append(card);});if(!grid.children.length)grid.append(node('p','此分类没有预置连接器。'));}catch(error){grid.replaceChildren(node('p',error.message));var retry=node('button','重新读取');retry.className='btn';retry.onclick=renderConnectors;grid.append(retry);}};
  window.setConnFilter=function(button,value){filter=value;document.querySelectorAll('#page-connectors .ch-filter').forEach(function(item){item.classList.toggle('active',item===button);});renderConnectors();};
  function status(message){document.getElementById('connectorActionStatus').textContent=message;}
  function lock(value){busy=value;dialog.querySelectorAll('button,input,textarea,select').forEach(function(control){control.disabled=value;});}
  function field(label,name,secret,value){var wrapper=node('label');wrapper.className='connector-field';wrapper.append(node('span',label));var input=node('input');input.name=name;input.type=secret?'password':'text';input.value='';input.autocomplete='off';input.placeholder=value||'';wrapper.append(input);return wrapper;}
  function credentials(){var body={revision:current.revision};dialog.querySelectorAll('[data-credential]').forEach(function(input){body[input.name]=input.value;});return body;}
  function renderDetail(c){current=c;editing=false;var body=document.getElementById('connModalBody'),foot=document.getElementById('connModalFoot');body.replaceChildren();foot.replaceChildren();document.getElementById('connModalTitle').textContent=c.name;body.append(node('p',c.description),node('p',c.auth_hint));
    if(/^https:\/\//.test(c.doc_url||'')){var link=node('a','获取凭证与官方文档');link.href=c.doc_url;link.target='_blank';link.rel='noopener noreferrer';body.append(link);}
    (c.fields||[]).forEach(function(item){var f=field(item.label,item.key,item.secret,c.creds_set[item.key]?'已设置，留空保留原值':item.placeholder||'');var input=f.querySelector('input');input.dataset.credential='1';input.oninput=function(){editing=true;};body.append(f);});
    var message=node('p',stateLabel(c));message.id='connectorActionStatus';message.setAttribute('role','status');body.append(message);
    function action(label,fn){var button=node('button',label);button.type='button';button.className='btn';button.onclick=fn;foot.append(button);}
    if(c.probe_supported)action('测试连接',function(){operate('probe');});
    action('保存配置',function(){operate('save');});
    if(['apply_failed','pending'].includes(c.activation))action('重试应用',function(){operate('activate');});
    if(c.can_undo)action('撤销上次修改',async function(){if(await ui.confirm('恢复此连接器的上一个配置版本？'))operate('restore');});
    if(c.configured)action('停用连接器',async function(){if(await ui.confirm('停用此连接器？可以撤销恢复，已保存的消息不受影响。'))operate('disable');});
    if(c.configured&&c.mcp_mode==='gateway'&&(c.tools||[]).length){var details=node('details');details.className='connector-tools';details.append(node('summary','手动调用工具'));var select=node('select');select.setAttribute('aria-label','选择连接器工具');c.tools.forEach(function(tool,i){var option=node('option',tool.name+' · '+(tool.description||''));option.value=i;select.append(option);});var args=node('div'),result=node('pre');result.className='conn-result';result.hidden=true;var run=node('button','调用工具');run.type='button';run.className='btn';details.append(select,args,run,result);body.append(details);
      function fields(){args.replaceChildren();var tool=c.tools[Number(select.value)],schema=tool.inputSchema||{};Object.entries(schema.properties||{}).forEach(function(pair){var required=(schema.required||[]).includes(pair[0]);var f=field((pair[1].description||pair[0])+(required?' *':''),pair[0],false);var input=f.querySelector('input');input.required=required;input.dataset.type=pair[1].type||'string';if(['integer','number'].includes(pair[1].type)){input.type='number';input.step=pair[1].type==='integer'?'1':'any';}args.append(f);});}select.onchange=fields;fields();
      run.onclick=async function(){var values={};for(var input of args.querySelectorAll('input')){if(!input.reportValidity())return;if(input.value.trim())values[input.name]=['integer','number'].includes(input.dataset.type)?Number(input.value):input.value.trim();}lock(true);result.hidden=false;result.textContent='正在调用…';try{var response=await apiRequest('/'+encodeURIComponent(c.kind)+'/call','POST',{tool:c.tools[Number(select.value)].name,args:values});result.textContent=typeof response.result==='string'?response.result:JSON.stringify(response.result,null,2);}catch(error){result.textContent=error.message;}finally{lock(false);}};
    }
  }
  async function operate(action){if(busy||!current)return;var kind=current.kind,body=credentials(),path='/'+encodeURIComponent(kind),method='POST';if(action==='probe')path+='/probe';if(['restore','activate'].includes(action)){path+='/'+action;body={revision:current.revision};}if(action==='disable'){method='DELETE';body={revision:current.revision};}lock(true);status(action==='probe'?'正在测试连接…':'正在保存并应用…');try{var response=await apiRequest(path,method,body);if(action==='probe')status(response.message);else{renderDetail(response);status(response.message);refresh().then(function(){renderConnectorChip();renderConnectors();}).catch(function(){});}}catch(error){
    if(error.result?.saved){current={...current,...error.result};renderDetail(current);status(error.message);}else{status(error.message);if(error.status===409){var reload=node('button','保留输入并读取最新版本');reload.className='btn';reload.onclick=async function(){var values=credentials();try{var updated=await apiRequest('/'+encodeURIComponent(kind));renderDetail(updated);dialog.querySelectorAll('[data-credential]').forEach(function(input){input.value=values[input.name]||'';});editing=true;status('已读取最新版本；本次输入保留，请核对后再次保存。');}catch(error){status(error.message);}};document.getElementById('connModalBody').append(reload);}}
  }finally{lock(false);}}
  window.openConnectorModal=async function(kind){if(busy)return;if(dialog.open&&!closeConnectorModal())return;opener=document.activeElement;var ticket=++loadSequence;current=null;editing=false;document.getElementById('connModalTitle').textContent='连接器配置';document.getElementById('connModalBody').replaceChildren(node('p','正在读取配置…'));document.getElementById('connModalFoot').replaceChildren();dialog.showModal();try{var data=await apiRequest('/'+encodeURIComponent(kind));if(ticket!==loadSequence||!dialog.open)return;renderDetail(data);}catch(error){if(ticket!==loadSequence)return;var b=document.getElementById('connModalBody');b.replaceChildren(node('p',error.message));var retry=node('button','重试');retry.className='btn';retry.onclick=function(){openConnectorModal(kind);};b.append(retry);}};
  window.closeConnectorModal=function(){if(busy)return false;if(editing&&!confirm('凭证修改尚未保存，确定关闭？'))return false;loadSequence++;dialog.close();return true;};
  dialog.addEventListener('cancel',function(event){event.preventDefault();closeConnectorModal();});dialog.addEventListener('close',function(){current=null;editing=false;if(opener?.isConnected)opener.focus();});dialog.querySelector('.modal-close').onclick=closeConnectorModal;
  /* 2026-11-22：原来这里把 openMini 劫持成 choose() —— 先 closeMini 再弹一个独立 <dialog>，
     于是模型/思考/能力/技能/专家/快捷指令六个按钮全是贴着图标的小浮层，只有连接器是全屏蒙版。
     现在拆掉劫持，连接器直接走 index.html 的 openMini(this,'connector')（锚定弹层），
     点选由下面 pickConnector 处理：写 _selectedConnector + 落草稿 + 重画 chip。 */
  window.pickConnector=function(button){
    var kind=button&&button.getAttribute('data-kind');
    if(!kind)return;
    _selectedConnector=kind;
    renderConnectorChip();
    if(typeof saveDraft==='function')saveDraft(currentSession);
    if(typeof closeMini==='function')closeMini();
  };
  // The previous shortcut invoked the first tool with empty arguments and fabricated a chat fallback.
  window.invokeSelectedConnector=function(){if(_selectedConnector)openConnectorModal(_selectedConnector);};
}());
