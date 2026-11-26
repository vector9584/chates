(function(){
  'use strict';
  var selected='',ref='',next=null,busy=false,generation=0,activity=null,pickedDay='',actSeq=0;
  var TYPE_LABEL={feat:'新功能',fix:'修问题',refactor:'重构',docs:'文档',test:'测试',audit:'审计',chore:'杂务',style:'样式',perf:'性能',build:'构建',ci:'流水线',revert:'回滚','其他':'其他'};
  function el(tag,text,cls){var node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  function pad(n){return n<10?'0'+n:''+n;}
  function ymd(date){return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate());}
  function addDays(date,offset){return new Date(date.getFullYear(),date.getMonth(),date.getDate()+offset);}
  async function request(path){var response=await fetch(apiUrl(path),{headers:{'X-Monitor-Token':monitorToken||''}});var body=await response.json();if(!response.ok||!body.ok)throw Error(body.error||'读取版本记录失败');return body;}
  function feedback(message){document.getElementById('maintenanceFeedback').textContent=message;}
  function controls(){document.getElementById('maintenanceRefresh').disabled=busy;document.getElementById('maintenanceMore').disabled=busy;}
  async function history(append){
    if(busy)return;busy=true;controls();var ticket=++generation;
    var list=document.getElementById('maintenanceHistory'),more=document.getElementById('maintenanceMore');
    if(!append){list.replaceChildren();ref='';next=null;more.hidden=true;}feedback('正在读取提交记录…');
    try{
      var data=await request('/api/maintenance/history?repo='+encodeURIComponent(selected)+(append?'&ref='+ref+'&offset='+next:''));
      if(ticket!==generation)return;ref=data.ref;next=data.next;
      data.commits.forEach(function(commit){
        var item=el('article',undefined,'maintenance-commit');item.append(el('h2',commit.subject));
        var meta=el('div',undefined,'maintenance-meta');meta.append(el('code',commit.hash.slice(0,12)),el('span',commit.author),el('time',new Date(commit.date).toLocaleString()));item.append(meta);
        if(commit.body){var details=el('details');details.append(el('summary','查看提交说明'),el('pre',commit.body));item.append(details);}list.append(item);
      });
      if(!list.children.length)list.append(el('p','此仓库没有提交记录。'));
      more.hidden=next===null;feedback('已显示 '+list.children.length+' 条提交 · 快照 '+ref.slice(0,12));
    }catch(error){feedback(error.message);}
    finally{busy=false;controls();}
  }

  /* ── 提交活跃度：GitHub 式热力图 + 统计条 + 类型分布 + 点日期看当天提交 ── */
  function chip(label,value,warn){
    var node=el('span','',('maint-chip')+(warn?' is-warn':''));
    node.append(el('b',value),el('em',label));return node;
  }
  function sinceText(day){
    var at=Date.parse(day+'T00:00:00');if(!at)return day;
    var days=Math.round((Date.now()-at)/86400000);
    if(days<=0)return '今天';if(days===1)return '昨天';return days+' 天前';
  }
  function quantiles(values){
    var sorted=values.slice().sort(function(a,b){return a-b;});
    if(!sorted.length)return [1,2,3];
    var pick=function(p){return sorted[Math.min(sorted.length-1,Math.max(0,Math.floor(p*sorted.length)))];};
    return [pick(0.25),pick(0.5),pick(0.75)];
  }
  function level(count,cut){
    if(!count)return 0;
    if(count<=cut[0])return 1;if(count<=cut[1])return 2;if(count<=cut[2])return 3;return 4;
  }
  function renderSummary(){
    var box=document.getElementById('maintActivitySummary');if(!box)return;
    var daily=activity.daily||{},today=activity.today||ymd(new Date());
    var weekStart=addDays(new Date(today+'T00:00:00'),-new Date(today+'T00:00:00').getDay());
    var week=0;for(var i=0;i<7;i++){week+=daily[ymd(addDays(weekStart,i))]||0;}
    box.replaceChildren(
      chip('近一年提交',activity.total),
      chip('今日',daily[today]||0),
      chip('本周',week),
      chip('当前连续',activity.current+' 天',activity.current===0),
      chip('最长连续',activity.longest+' 天'),
      chip('最后提交',activity.last?sinceText(activity.last.day):'无'));
  }
  function renderHeat(){
    var grid=document.getElementById('maintHeatmap'),months=document.getElementById('maintMonths');
    if(!grid)return;
    var wrapEl=grid.parentElement,keepLeft=wrapEl?wrapEl.scrollLeft:0;
    var daily=activity.daily||{};
    var counts=Object.keys(daily).map(function(key){return daily[key];});
    var cut=quantiles(counts);
    var today=new Date();today.setHours(0,0,0,0);
    /* 轴以今天为中点，向前一年、向后一年——不是「从今天往前两年」。
       起点和终点各按一年取，不足一年的一方也补满，空白周照画，
       这样桌面鼠标滚轮、按住拖都有余量（用户原话：知道记录没那么多，能多滚就行）。
       注意方向：future 段必须留出来，否则首屏永远贴着最右边、看着像时间到头了。 */
    var BACK_DAYS=365,FOR_DAYS=365;
    /* 起点落在整周开头（周日），终点落在整周末尾（周六），
       不然首尾两列是半截周，格子和月份标签会对不齐。 */
    var start=addDays(today,-BACK_DAYS);
    start=addDays(start,-start.getDay());
    var end=addDays(today,FOR_DAYS);
    end=addDays(end,6-end.getDay());
    var spanDays=Math.round((end-start)/86400000)+1;
    var weeks=Math.ceil(spanDays/7);
    /* 只补到本周结束，不整列补空：多补一列会凭空多出一个「11月」标签，
       看着像时间轴绕回去了。 */
    var days=spanDays;
    grid.style.setProperty('--weeks',weeks);
    grid.replaceChildren();
    var frag=document.createDocumentFragment(),labelFrag=document.createDocumentFragment();
    var monthRuns=[],yearRuns=[],lastKey='',lastYear='';
    for(var w=0;w<weeks;w++){
      var first=addDays(start,w*7),year=first.getFullYear(),key=year+'-'+first.getMonth();
      if(String(year)!==lastYear){yearRuns.push({label:year+'年',span:0,at:w});lastYear=String(year);}
      yearRuns[yearRuns.length-1].span++;
      if(key!==lastKey){monthRuns.push({label:(first.getMonth()+1)+'月',span:0,at:w});lastKey=key;}
      monthRuns[monthRuns.length-1].span++;
    }
    /* 年份单独一行：跨年点看得见，首尾同名月份就不会被读成时间倒流。
       两行必须写死起止列，只给 span 会出事：容器是 grid-auto-flow:column，
       年份那串先占掉整行 105 列，月份那串就接着从第 106 列往下排，
       结果月份行被撑到两倍宽、越往后越偏右，末尾几个月的标签直接飘到格子外面。
       2026-11-20 实测：年份 span 合计 105、月份 105、容器却长出 164 列。 */
    function putLabel(run,cls){
      var label=el('span',run.label,cls);
      label.style.gridColumn=(run.at+1)+' / span '+run.span;
      labelFrag.append(label);
    }
    yearRuns.forEach(function(run){putLabel(run,'maint-year');});
    monthRuns.forEach(function(run){putLabel(run,'maint-month');});
    for(var w=0;w<weeks;w++){
      for(var d=0;d<7;d++){
        var date=addDays(start,w*7+d),day=ymd(date),count=daily[day]||0;
        /* 未来那一年不特殊处理：同一天一个格子，daily 里没它，count 自然是 0，
           走 lv0，hover 出日期、点击选中——和过去任何一个空白天完全一样。
           唯一标记：dataset.future，供后续统计区分，不影响任何样式与交互。 */
        var cell=el('i',undefined,'maint-cell');
        if(day===ymd(today))cell.dataset.today='1';
        if(date>today)cell.dataset.future='1';
        cell.dataset.day=day;cell.dataset.count=String(count);
        cell.className+=' lv'+level(count,cut)+(day===pickedDay?' is-picked':'');
        cell.setAttribute('role','button');cell.tabIndex=count||day===pickedDay?0:-1;
        cell.setAttribute('aria-label',day+' '+count+' 次提交');
        frag.append(cell);
      }
    }
    grid.append(frag);
    if(months){months.replaceChildren(labelFrag);months.style.setProperty('--weeks',weeks);}
    bindHeatDrag(wrapEl);
    if(wrapEl&&keepLeft)wrapEl.scrollLeft=keepLeft;
    else alignHeatToToday(wrapEl,grid);
  }

  /* 首屏对齐「今天所在列」，不是贴最右边。
     轴里现在有未来一年，贴右边就停在一年后的空白区，打开面板一片空。
     必须放在渲染之后单独调：早先塞在 bindHeatDrag 里，那函数第一句就
     `if(wrap.dataset.dragBound)return`，第二次渲染起直接返回，对齐永不执行。 */
  function alignHeatToToday(wrap,grid){
    if(!wrap||!grid)return;
    /* 不能用 offsetLeft：grid 子项的 offsetLeft 相对最近定位祖先，不等于
       「在滚动内容里的偏移」，实测恒为 0。用 rect 差值算。 */
    var mid=grid.querySelector('.maint-cell[data-today="1"]');
    if(!mid)return;
    var mr=mid.getBoundingClientRect(),wr=wrap.getBoundingClientRect();
    var target=wrap.scrollLeft+(mr.left-wr.left)-(wrap.clientWidth/2)+mr.width/2;
    wrap.scrollLeft=Math.max(0,Math.min(target,wrap.scrollWidth-wrap.clientWidth));
  }

  /* 横向平移：桌面按住拖（窗口窄到 53 列放不下时才有得拖），触摸交给浏览器原生。
     首次进来直接停在今天这一头 —— 否则 303px 的容器停在 8 个月前的空白上，
     看着就像这张图根本没画出来。 */
  function bindHeatDrag(wrap){
    if(!wrap||wrap.dataset.dragBound)return;
    wrap.dataset.dragBound='1';
    var down=false,sx=0,sl=0,moved=false;
    function syncCursor(){wrap.classList.toggle('is-scrollable',wrap.scrollWidth>wrap.clientWidth+1);}
    syncCursor();
    window.addEventListener('resize',syncCursor);
    /* 鼠标只有竖直滚轮。不接管的话在热力图上滚就是整页上下跳，图一格都不动，
       看着就是「电脑没法滚动」。只在真溢出时接管，且把竖直增量转成横向。 */
    /* 判断放在事件里面、每次现算：绑定时若布局还没出（或面板还没显示，
       scrollWidth===clientWidth），绑一次就 return 会让滚轮永久失效。 */
    wrap.addEventListener('wheel',function(e){
      if(wrap.scrollWidth<=wrap.clientWidth+1)return;
      if(Math.abs(e.deltaY)<=Math.abs(e.deltaX))return;
      wrap.scrollLeft+=e.deltaY;
      e.preventDefault();
    },{passive:false});
    wrap.addEventListener('pointerdown',function(e){
      if(e.pointerType!=='mouse'||e.button!==0)return;
      if(wrap.scrollWidth<=wrap.clientWidth+1)return;
      down=true;moved=false;sx=e.clientX;sl=wrap.scrollLeft;wrap.classList.add('is-dragging');
    });
    wrap.addEventListener('pointermove',function(e){
      if(!down)return;
      var dx=e.clientX-sx;
      if(Math.abs(dx)>3)moved=true;
      wrap.scrollLeft=sl-dx;
      e.preventDefault();
    });
    function end(){if(!down)return;down=false;wrap.classList.remove('is-dragging');}
    wrap.addEventListener('pointerup',end);
    wrap.addEventListener('pointercancel',end);
    wrap.addEventListener('pointerleave',end);
    wrap.addEventListener('click',function(e){
      if(moved){moved=false;e.stopPropagation();e.preventDefault();}
    },true);
  }
  function renderTypes(){
    var box=document.getElementById('maintTypeBars');if(!box)return;
    var types=activity.types||[];
    box.replaceChildren();
    if(!types.length){box.append(el('p','暂无提交类型数据。','pw-hint'));return;}
    var max=types.reduce(function(top,item){return Math.max(top,item.count);},1);
    types.forEach(function(item){
      var row=el('div',undefined,'maint-type');
      var bar=el('span',undefined,'maint-type-bar');bar.style.width=Math.max(2,Math.round(item.count/max*100))+'%';
      var track=el('span',undefined,'maint-type-track');track.append(bar);
      row.append(el('b',TYPE_LABEL[item.key]||item.key),track,el('em',String(item.count)));
      box.append(row);
    });
  }
  function renderDayList(){
    var box=document.getElementById('maintDayList');if(!box)return;
    if(!pickedDay){box.hidden=true;box.replaceChildren();return;}
    var rows=(activity.commits||[]).filter(function(item){return item[0]===pickedDay;});
    box.hidden=false;box.replaceChildren();
    var head=el('div',undefined,'maint-day-head');
    head.append(el('strong',pickedDay+' · '+rows.length+' 次提交'));
    var clear=el('button','清除','btn');clear.type='button';
    clear.onclick=function(){pickedDay='';renderDayList();renderHeat();};
    head.append(clear);box.append(head);
    if(!rows.length){box.append(el('p','这一天没有提交。','pw-hint'));return;}
    var list=el('div',undefined,'maint-day-list');
    rows.slice(0,40).forEach(function(item){
      var row=el('div',undefined,'maint-day-row');row.append(el('code',item[1]),el('span',item[2]));list.append(row);
    });
    if(rows.length>40)list.append(el('p','仅显示前 40 条。','pw-hint'));
    box.append(list);
  }
  /* 热力图的格子只说明「哪天忙」，看不出忙什么 —— 想知道内容得一个个悬停。
     把最新 12 条直接摊在下面，扫一眼就有工作内容，不用点也不用猜。 */
  function renderRecent(){
    var box=document.getElementById('maintRecent');if(!box)return;
    var rows=(activity.commits||[]).slice(0,12);
    box.replaceChildren();
    if(!rows.length)return;
    var head=el('div',undefined,'maint-recent-head');
    head.append(el('strong','最近提交'),el('em','最新 12 条；上方热力图按天看密度，点某天看当天全部'));
    box.append(head);
    var grid=el('div',undefined,'maint-recent-grid');
    rows.forEach(function(item){
      var row=el('div',undefined,'maint-recent-row');
      row.append(el('code',String(item[0]||'').slice(5)),el('span',String(item[2]||'')));
      grid.append(row);
    });
    box.append(grid);
  }
  function renderActivity(){
    var root=document.getElementById('maintenanceActivity');
    if(!root)return;
    if(!activity){root.hidden=true;return;}
    root.hidden=false;renderSummary();renderHeat();renderTypes();renderRecent();renderDayList();
  }
  async function loadActivity(){
    if(!selected)return;
    var ticket=++actSeq,root=document.getElementById('maintenanceActivity');
    try{
      /* days 放到后端上限 1095：仓库历史多长就画多长，别让前端卡一年。 */
      var data=await request('/api/maintenance/activity?days=1095&repo='+encodeURIComponent(selected));
      if(ticket!==actSeq)return;
      activity=data;pickedDay='';renderActivity();
    }catch(error){
      if(ticket!==actSeq)return;
      activity=null;if(root){root.hidden=false;document.getElementById('maintHeatmap').replaceChildren();
        document.getElementById('maintActivitySummary').replaceChildren();
        document.getElementById('maintTypeBars').replaceChildren(el('p',error.message,'pw-hint'));}
    }
  }
  /* 气泡：桌面悬停 + 手机点按都要出。2026-11-15 用户报「手机上点上去没反应」，
     原因就是原来只绑了 mouseover/mouseout——触摸设备根本不派发这两个事件。 */
  var tipTimer=0,lastPointer='mouse';
  function tipNode(){
    var node=document.getElementById('maintHeatTip');
    if(!node){node=el('div',undefined,'maint-tip');node.id='maintHeatTip';node.hidden=true;document.body.append(node);}
    return node;
  }
  function fillTip(cell){
    var box=tipNode(),day=cell.dataset.day,count=Number(cell.dataset.count)||0;
    var today=activity&&activity.today;
    box.replaceChildren(el('strong',day+(today===day?' · 今天':'')),el('span',count?count+' 次提交':'没有提交'));
    if(count){
      var rows=((activity&&activity.commits)||[]).filter(function(item){return item[0]===day;}).slice(0,5);
      rows.forEach(function(item){box.append(el('em',item[1]+' '+item[2]));});
      if(count>rows.length)box.append(el('em','还有 '+(count-rows.length)+' 条…'));
    }
    return box;
  }
  function placeTip(cell){
    if(!cell)return;
    var box=fillTip(cell),rect=cell.getBoundingClientRect();
    box.hidden=false;
    var width=box.offsetWidth,height=box.offsetHeight;
    var left=Math.min(window.innerWidth-width-12,Math.max(12,rect.left+rect.width/2-width/2));
    var above=rect.top-height-10;
    /* 格子贴着屏幕下沿时（手机热力图常这样）翻到下面，别把气泡顶出视口 */
    var top=above>=12?above:Math.min(window.innerHeight-height-12,rect.bottom+10);
    box.style.left=left+'px';
    box.style.top=Math.max(12,top)+'px';
  }
  function hideTip(){tipNode().hidden=true;clearTimeout(tipTimer);tipTimer=0;}
  function showTip(cell,hold){
    if(!cell||!cell.dataset.day)return;
    placeTip(cell);
    clearTimeout(tipTimer);tipTimer=0;
    if(hold)tipTimer=setTimeout(hideTip,2600);
  }
  function bindHeat(){
    var grid=document.getElementById('maintHeatmap');
    if(!grid||grid.dataset.bound)return;
    grid.dataset.bound='1';
    grid.addEventListener('pointerover',function(event){
      lastPointer=event.pointerType||'mouse';
      if(lastPointer!=='mouse')return;
      showTip(event.target.closest('.maint-cell'));
    });
    grid.addEventListener('pointerout',function(event){
      if((event.pointerType||'mouse')!=='mouse')return;
      if(!event.target.closest('.maint-cell'))return;
      hideTip();
    });
    /* 触摸/笔：按下即出气泡——手机上唯一能看到气泡的路径 */
    grid.addEventListener('pointerdown',function(event){
      lastPointer=event.pointerType||'mouse';
      if(lastPointer==='mouse'){hideTip();return;}
      showTip(event.target.closest('.maint-cell'),true);
    });
    document.addEventListener('pointerdown',function(event){
      if(event.target.closest&&event.target.closest('.maint-cell'))return;
      hideTip();
    },true);
    window.addEventListener('scroll',hideTip,true);
    window.addEventListener('resize',hideTip);
    grid.addEventListener('click',function(event){
      var cell=event.target.closest('.maint-cell');if(!cell||!cell.dataset.day)return;
      var day=cell.dataset.day;
      pickedDay=pickedDay===day?'':day;
      renderDayList();renderHeat();
      /* renderHeat 重建了格子，气泡节点挂在 body 上没被带走；点按后按新格子重贴一次 */
      if(lastPointer!=='mouse')requestAnimationFrame(function(){
        showTip(document.querySelector('.maint-cell[data-day="'+day+'"]'),true);
      });
    });
    grid.addEventListener('keydown',function(event){
      if(event.key!=='Enter'&&event.key!==' ')return;
      var cell=event.target.closest('.maint-cell');if(!cell||!cell.dataset.day)return;
      event.preventDefault();cell.click();
    });
  }

  /* ── 双版本并列：Gitea 全量仓（内网）+ GitHub 发布版（外网） ──
     内网拿不到全量仓时 gitea.available=false，这里就不渲染那张卡，
     只剩 GitHub 一张——外部用户看到的就是发布情况。 */
  function bytes(n){
    if(!n)return '0 B';
    var u=['B','KB','MB','GB'],i=0;var v=Number(n)||0;
    while(v>=1024&&i<u.length-1){v/=1024;i++;}
    return (i?v.toFixed(1):v)+' '+u[i];
  }
  function dayText(iso){
    if(!iso)return '';
    var d=new Date(iso);
    if(isNaN(d.getTime()))return String(iso).slice(0,10);
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
  }
  function releaseCard(data){
    var isGitea=data.kind==='gitea';
    var card=el('article',undefined,'maintenance-release'+(isGitea?' is-gitea':' is-github'));
    var head=el('div',undefined,'maintenance-release-head');
    head.append(el('span',isGitea?'Gitea 全量仓':'GitHub 发布版','maintenance-release-kind'));
    if(data.url){
      var link=el('a','打开','maintenance-release-link');
      link.href=data.url;link.target='_blank';link.rel='noopener';
      head.append(link);
    }
    card.append(head);
    var body=el('div',undefined,'maintenance-release-body');
    if(isGitea){
      body.append(el('strong',data.version||'未标记版本','maintenance-release-version'));
      var meta=el('div',undefined,'maintenance-release-meta');
      if(data.head)meta.append(el('code',String(data.head).slice(0,12)));
      if(data.date)meta.append(el('span',dayText(data.date)+' 提交'));
      if(data.head)meta.append(el('em',data.synced?'已同步到 Gitea':'本地领先于 Gitea',
        'maintenance-release-sync'+(data.synced?' is-ok':' is-warn')));
      body.append(meta);
    }else{
      body.append(el('strong',data.tag||'暂无发布','maintenance-release-version'));
      var meta2=el('div',undefined,'maintenance-release-meta');
      if(data.published)meta2.append(el('span',dayText(data.published)+' 发布'));
      if(data.assets&&data.assets.length)meta2.append(el('span',data.assets.length+' 个下载'));
      if(data.prerelease)meta2.append(el('em','预发布','maintenance-release-sync is-warn'));
      body.append(meta2);
      if(data.assets&&data.assets.length){
        var list=el('ul',undefined,'maintenance-release-assets');
        data.assets.slice(0,6).forEach(function(asset){
          var li=el('li');
          var link2=el('a',asset.name);
          link2.href=asset.url;link2.target='_blank';link2.rel='noopener';
          li.append(link2,el('span',bytes(asset.size)));
          list.append(li);
        });
        body.append(list);
      }
    }
    card.append(body);
    return card;
  }
  async function renderReleases(){
    var box=document.getElementById('maintenanceReleases');
    if(!box)return;
    try{
      var data=await request('/api/maintenance/releases'),cards=[];
      if(data.gitea&&data.gitea.available)cards.push(releaseCard(data.gitea));
      if(data.github&&data.github.available)cards.push(releaseCard(data.github));
      box.replaceChildren();
      cards.forEach(function(card){box.append(card);});
      box.hidden=!cards.length;
    }catch(_){box.hidden=true;}
  }

  window.renderMaintenancePage=async function(){
    renderReleases();
    if(busy)return;busy=true;controls();feedback('正在读取本地仓库状态…');
    try{
      var data=await request('/api/maintenance/repositories'),tabs=document.getElementById('maintenanceRepositories');tabs.replaceChildren();
      if(!data.repositories.some(function(repo){return repo.id===selected&&repo.available;}))selected=(data.repositories.find(function(repo){return repo.available;})||{}).id||'';
      data.repositories.forEach(function(repo){
        var card=el('button',undefined,'maintenance-repository');card.type='button';card.disabled=!repo.available;card.setAttribute('aria-pressed',String(repo.id===selected));
        card.append(el('strong',repo.name),el('span',repo.available?(repo.changes?repo.changes+' 项未提交变更':'工作区无未提交变更'):repo.error));
        if(repo.available)card.append(el('code',repo.head.slice(0,12)));
        card.onclick=function(){if(busy)return;selected=repo.id;try{localStorage.setItem('panel-maintenance-repository',selected);}catch(_){}tabs.querySelectorAll('button').forEach(function(button){button.setAttribute('aria-pressed',String(button===card));});history(false);loadActivity();};tabs.append(card);
      });
      if(!selected){document.getElementById('maintenanceHistory').replaceChildren();document.getElementById('maintenanceMore').hidden=true;feedback('未能读取代码仓库，请检查上方状态后重试。');}
    }catch(error){feedback(error.message);selected='';}
    finally{busy=false;controls();}
    if(selected){await history(false);await loadActivity();}
  };
  try{selected=localStorage.getItem('panel-maintenance-repository')||'';}catch(_){}
  document.getElementById('maintenanceRefresh').onclick=window.renderMaintenancePage;
  document.getElementById('maintenanceMore').onclick=function(){history(true);};
  bindHeat();
}());
