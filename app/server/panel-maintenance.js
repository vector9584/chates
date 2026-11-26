import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';

const frozen = /^\/api\/(?:hermes\/update(?:\/|$)|app\/(?:update(?:\/|$)|auto-update$|hot-patch$))/;
export function createMaintenanceHandler({repositories, checkToken, run = execFile, releases = {}}) {
  const reply = (body, status = 200) => new Response(JSON.stringify(body), {status,
    headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  /* 版本来源：Gitea 全量仓（内网，可能不可达）+ GitHub 发布仓（外网，人人可见）。
     两边都查，前端自己决定显示哪几张。node fetch 在 TUN 下会被 RST，所以一律走 curl 子进程。 */
  function curlJson(url, timeout = 8000) {
    return new Promise(resolve => run('curl', ['-sS','-L','--max-time',String(Math.round(timeout/1000)),
      '-H','Accept: application/vnd.github+json','-H','User-Agent: chates-panel', url],
      {timeout: timeout + 2000, maxBuffer: 4*1024*1024, env: {...process.env, CURL_SSL_NO_REVOKE:'1'}},
      (error, stdout) => {
        if (error) return resolve({ok:false, error: error.killed ? '读取超时' : '无法连接'});
        try { resolve({ok:true, data: JSON.parse(stdout)}); }
        catch (_) { resolve({ok:false, error:'返回内容无法解析'}); }
      }));
  }
  /* ls-remote 需要仓库凭据，monitor 进程没有；退回 Gitea HTTP API 读分支 head。
     两条都失败时不谎报 synced=true：remoteHead 留空、synced 记 null，前端显示"未确认"。 */
  /* monitor 进程环境里不一定有 GITEA_TOKEN（启动方式不同）；从 DATA_DIR/.env 兜底读。
     只认 GITEA_TOKEN / GITEA_URL 两行，别的一概不碰。 */
  function readDotEnv(file) {
    if (!file) return {};
    const out = {};
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*(GITEA_TOKEN|GITEA_URL)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    } catch (_) {}
    return out;
  }
  function giteaBranchHead(cfg) {
    if (!cfg.owner || !cfg.repo) return Promise.resolve('');
    const env = readDotEnv(cfg.envFile);
    const api = String(cfg.api || env.GITEA_URL || '').replace(/\/+$/, '');
    const token = String(cfg.token || env.GITEA_TOKEN || '');
    if (!api) return Promise.resolve('');
    const url = `${api}/repos/${cfg.owner}/${cfg.repo}/branches/${cfg.branch || 'main'}`;
    const args = ['-sS','-L','--max-time','6','-H','Accept: application/json',
      '-H','User-Agent: chates-panel'];
    if (token) args.push('-H', `Authorization: token ${token}`);
    args.push(url);
    return new Promise(resolve => run('curl', args, {timeout:8000, maxBuffer:1024*1024}, (error, stdout) => {
      if (error) return resolve('');
      try {
        const d = JSON.parse(stdout);
        resolve(String((d && d.commit && d.commit.id) || ''));
      } catch (_) { resolve(''); }
    }));
  }
  async function giteaRelease() {
    const cfg = releases.gitea;
    if (!cfg || !cfg.path) return {available:false, error:'未配置全量仓'};
    try {
      /* cfg.path 是 Gitea 的裸仓库实体：HEAD 就是它的 main，没有"远端"可查。
         拿不到 git 目录里的 ref 时（比如只给了工作副本）再退回 API。 */
      const [head, date, lsRemote, file, apiHead] = await Promise.all([
        git({path:cfg.path}, ['rev-parse','--verify','HEAD']).catch(() => ''),
        git({path:cfg.path}, ['log','-1','--no-show-signature','--format=%aI']).catch(() => ''),
        git({path:cfg.path}, ['rev-parse','--verify','refs/heads/main']).catch(() => ''),
        Promise.resolve(cfg.versionFile || ''),
        giteaBranchHead(cfg),
      ]);
      if (!head.trim()) return {available:false, error:'全量仓无法读取'};
      let version = '', built = '';
      if (file) {
        try {
          const raw = JSON.parse(readFileSync(file, 'utf8'));
          version = raw.version || ''; built = raw.built || '';
        } catch (_) {}
      }
      /* 没有工作副本时（releases.gitea.path 是裸仓库）从仓库里取版本文件。
         和 head 同一条链路，不额外依赖任何磁盘路径。 */
      if (!version && cfg.versionRef) {
        try {
          const shown = await git({path:cfg.path}, ['show', cfg.versionRef]);
          const raw = JSON.parse(shown);
          version = raw.version || ''; built = raw.built || '';
        } catch (_) {}
      }
      const localShort = head.trim();
      const remoteHead = ((lsRemote.trim().split('\t')[0] || '') || String(apiHead || '').trim());
      const synced = remoteHead ? remoteHead === localShort : null;
      /* 拼绝对地址只走 .env 的 GITEA_URL；拿不到就留空，前端自然不给链接。 */
      const envForUrl = readDotEnv(cfg.envFile);
      const base = String(cfg.api || envForUrl.GITEA_URL || '').replace(/\/+$/, '');
      const url = base && cfg.webUrlPath ? base + cfg.webUrlPath : '';
      /* Gitea 没有"版本号"这种东西，只有提交。仓库里的 win/version.json 是
         代码文件、属于 GitHub 发布版的号，搬到 Gitea 卡上就成了编造。
         版本号只在 GitHub 那张卡和顶栏显示；这张卡只讲提交。
         注：versionRef 仍要读，因为后面要跟着发版号走，只是不往外返回。 */
      void version; void built;
      return {available:true, kind:'gitea', head:localShort,
        date: date.trim(), remoteHead: remoteHead.slice(0,12), synced, url};
    } catch (error) { return {available:false, error:error.message}; }
  }
  async function githubRelease() {
    const cfg = releases.github;
    if (!cfg || !cfg.owner) return {available:false, error:'未配置发布仓'};
    const api = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/latest`;
    const got = await curlJson(api);
    if (!got.ok) return {available:false, error:got.error};
    const d = got.data || {};
    const assets = (d.assets || []).map(a => ({name:a.name, size:a.size,
      url:a.browser_download_url, downloads:a.download_count}));
    return {available:true, kind:'github', tag:d.tag_name || '', name:d.name || '',
      published:d.published_at || '', prerelease: !!d.prerelease,
      url:d.html_url || `https://github.com/${cfg.owner}/${cfg.repo}/releases/latest`, assets};
  }
  /* GitHub 侧的提交历史：面板要能在同一块内容区切到 GitHub。
     GitHub 没有本地仓库可 git log，只能走 REST。只读公开仓库，不需要 token。 */
  async function githubCommits(span) {
    const cfg = releases.github;
    if (!cfg || !cfg.owner) return {ok:false, error:'未配置发布仓'};
    const repo = cfg.repo || 'chates';
    const since = new Date(Date.now() - span * 86400000).toISOString();
    const per = 100;
    let page = 1, all = [];
    /* 最多拉 5 页（500 条），够画一年热力图；再多就慢且没必要。 */
    while (page <= 5) {
      const url = `https://api.github.com/repos/${cfg.owner}/${repo}/commits`
        + `?since=${encodeURIComponent(since)}&per_page=${per}&page=${page}`;
      const got = await curlJson(url, 12000);
      if (!got.ok) {
        if (page === 1) return {ok:false, error:got.error};
        break;
      }
      const batch = Array.isArray(got.data) ? got.data : [];
      all = all.concat(batch);
      if (batch.length < per) break;
      page++;
    }
    return {ok:true, commits: all};
  }
  function git(repo, args) {
    return new Promise((resolve, reject) => run('git', ['-c', 'safe.directory=*', '-C', repo.path, ...args],
      {timeout:10000, maxBuffer:2*1024*1024, env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}},
      (error, stdout) => error ? reject(new Error(error.killed?'读取版本记录超时，请重试':'仓库暂时读不到')) : resolve(stdout)));
  }
  return async function maintenance(req, path) {
    if (!path.startsWith('/api/maintenance/') && !frozen.test(path)) return null;
    if (!checkToken(req)) return reply({ok:false,error:'请重新登录后查看维护记录'},401);
    if (frozen.test(path)) return reply({ok:false,error:'此应用已采用本地维护，在线升级接口已停用'},410);
    if (req.method !== 'GET') return reply({ok:false,error:'版本记录仅支持读取'},405);
    if (path === '/api/maintenance/repositories') {
      /* 只列有工作区的仓库。Gitea 那个是裸仓库、且上面已经有版本卡，
         列在这里会变成"同一个仓库上下各一张卡"，纯重复。 */
      const visible = repositories.filter(repo => repo.showInList !== false);
      const items = await Promise.all(visible.map(async repo => {
        try {
          const head = await git(repo,['rev-parse','--verify','HEAD']);
          /* 裸仓库（Gitea 实体）没有工作区，status 必失败；此时只报 head，
             changes 记 null 表示"不适用"，不要把它算成读不到。 */
          let changes = null;
          try {
            const status = await git(repo,['status','--porcelain=v1','-z','--untracked-files=normal']);
            const entries=status.split('\0').filter(Boolean);changes=0;
            for(let i=0;i<entries.length;i++){changes++;if(/^[RC]|^.[RC]/.test(entries[i]))i++;}
          } catch (_) {}
          return {id:repo.id,name:repo.name,head:head.trim(),changes,available:true};
        } catch(error) {return {id:repo.id,name:repo.name,available:false,error:error.message};}
      }));
      return reply({ok:true,repositories:items});
    }
    if (path === '/api/maintenance/releases') {
      const [gitea, github] = await Promise.all([giteaRelease(), githubRelease()]);
      /* localVersion = 这台机器上跑的包自己的版本号，从本地仓库 win/version.json 读。
         它不属于 Gitea（Gitea 只有提交），所以放在顶层、不进 gitea 卡。 */
      let localVersion = '';
      try {
        if (releases.gitea && releases.gitea.versionRef) {
          const shown = await git({path: releases.gitea.path}, ['show', releases.gitea.versionRef]);
          const raw = JSON.parse(shown);
          localVersion = String(raw.version || '');
        }
      } catch (_) {}
      return reply({ok:true, gitea, github, localVersion});
    }
    if (path === '/api/maintenance/activity') {
      const aurl = new URL(req.url);
      const span = Math.min(1095, Math.max(30, Number(aurl.searchParams.get('days')||365) || 365));
      /* GitHub 源：同一块热力图，数据从 GitHub REST 拉，形状与本地 git log 那条保持一致。 */
      if (aurl.searchParams.get('source') === 'github') {
        const gh = await githubCommits(span);
        if (!gh.ok) return reply({ok:false,error:gh.error},503);
        const daily = new Map(), types = new Map(), commits = [];
        for (const item of gh.commits) {
          const c = (item && item.commit) || {};
          const day = new Date(((c.author && c.author.date) || (c.committer && c.committer.date) || '')).toLocaleDateString('sv-SE');
          const hash = (item && item.sha || '').slice(0, 7);
          const subject = (c.message || '').split('\n')[0];
          if (!day || day === 'Invalid Date' || !hash) continue;
          daily.set(day, (daily.get(day)||0) + 1);
          commits.push([day, hash, subject]);
          const matched = /^([A-Za-z][\w-]*)(?:\([^)]*\))?!?:/.exec(subject);
          const key = matched ? matched[1].toLowerCase() : '其他';
          types.set(key, (types.get(key)||0) + 1);
        }
        const keys = [...daily.keys()].sort(), stamp = day => Date.parse(day+'T00:00:00');
        let longest = 0, run = 0, prev = 0;
        for (const day of keys) {
          const at = stamp(day);
          run = prev && at - prev === 86400000 ? run + 1 : 1;
          prev = at; if (run > longest) longest = run;
        }
        const today = new Date().toLocaleDateString('sv-SE');
        const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
        let current = 0, cursor = daily.has(today) ? today : (daily.has(yesterday) ? yesterday : null);
        while (cursor && daily.has(cursor)) { current++; cursor = new Date(stamp(cursor) - 86400000).toLocaleDateString('sv-SE'); }
        const typeList = [...types.entries()].sort((a,b) => b[1]-a[1]).slice(0,8).map(([key,count]) => ({key,count}));
        return reply({ok:true, repository:'github', ref:'', days:span, today, total:commits.length,
          longest, current, daily:Object.fromEntries(daily), types:typeList,
          last: commits.length ? {day:commits[0][0], hash:commits[0][1], subject:commits[0][2]} : null,
          commits});
      }
      const arepo = repositories.find(item => item.id === aurl.searchParams.get('repo'));
      if (!arepo) return reply({ok:false,error:'请选择已有代码仓库'},400);
      try {
        const head = (await git(arepo, ['rev-parse','--verify','HEAD'])).trim();
        const out = await git(arepo, ['log', head, '--no-show-signature', '--since='+span+' days ago',
          '--date=format:%Y-%m-%d', '--format=%ad%x00%h%x00%s', '--']);
        const daily = new Map(), types = new Map(), commits = [];
        for (const line of out.split('\n')) {
          if (!line) continue;
          const [day, hash, subject] = line.split('\0');
          if (!day || !hash) continue;
          daily.set(day, (daily.get(day)||0) + 1);
          commits.push([day, hash, subject||'']);
          const matched = /^([A-Za-z][\w-]*)(?:\([^)]*\))?!?:/.exec(subject||'');
          const key = matched ? matched[1].toLowerCase() : '其他';
          types.set(key, (types.get(key)||0) + 1);
        }
        const keys = [...daily.keys()].sort(), stamp = day => Date.parse(day+'T00:00:00');
        let longest = 0, run = 0, prev = 0;
        for (const day of keys) {
          const at = stamp(day);
          run = prev && at - prev === 86400000 ? run + 1 : 1;
          prev = at; if (run > longest) longest = run;
        }
        const today = new Date().toLocaleDateString('sv-SE');
        const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
        let current = 0, cursor = daily.has(today) ? today : (daily.has(yesterday) ? yesterday : null);
        while (cursor && daily.has(cursor)) { current++; cursor = new Date(stamp(cursor) - 86400000).toLocaleDateString('sv-SE'); }
        const typeList = [...types.entries()].sort((a,b) => b[1]-a[1]).slice(0,8).map(([key,count]) => ({key,count}));
        return reply({ok:true, repository:arepo.id, ref:head, days:span, today, total:commits.length,
          longest, current, daily:Object.fromEntries(daily), types:typeList,
          last: commits.length ? {day:commits[0][0], hash:commits[0][1], subject:commits[0][2]} : null,
          commits});
      } catch (error) { return reply({ok:false,error:error.message},503); }
    }
    if (path !== '/api/maintenance/history') return reply({ok:false,error:'维护记录接口不存在'},404);
    const url=new URL(req.url);
    /* GitHub 源：下面「加载更早的提交」也走这里，靠 skip 参数翻页。 */
    if (url.searchParams.get('source') === 'github') {
      const skip = Math.max(0, Math.min(500, Number(url.searchParams.get('offset')||0) || 0));
      const gh = await githubCommits(365 * 3);
      if (!gh.ok) return reply({ok:false,error:gh.error},503);
      const slice = gh.commits.slice(skip, skip + 30).map(item => {
        const c = (item && item.commit) || {};
        return {hash: (item && item.sha) || '',
          date: ((c.author && c.author.date) || (c.committer && c.committer.date) || ''),
          author: ((c.author && c.author.name) || (c.committer && c.committer.name) || ''),
          subject: (c.message || '').split('\n')[0],
          body: (c.message || '').split('\n').slice(1).join('\n').trim()};
      }).filter(x => x.hash);
      const nextOffset = skip + 30 < gh.commits.length ? String(skip + 30) : null;
      return reply({ok:true, repository:'github', ref:'github:main', commits:slice, next:nextOffset});
    }
    const repo=repositories.find(item=>item.id===url.searchParams.get('repo'));
    if (!repo) return reply({ok:false,error:'请选择已有代码仓库'},400);
    const offset=Number(url.searchParams.get('offset')||0), requested=url.searchParams.get('ref');
    if (!Number.isSafeInteger(offset)||offset<0||offset>100000||requested&&!/^[0-9a-f]{40}$/.test(requested)) return reply({ok:false,error:'版本分页参数不正确'},400);
    try {
      const head=requested||(await git(repo,['rev-parse','--verify','HEAD'])).trim();
      const output=await git(repo,['log',head,'--no-show-signature','-z','--format=%H%x00%aI%x00%an%x00%s%x00%b','--max-count=31','--skip='+offset,'--']);
      const fields=output.split('\0');if(fields.at(-1)==='')fields.pop();
      if(fields.length%5)throw new Error('Git 记录格式无法解析');
      const commits=[];
      for(let i=0;i<fields.length;i+=5)commits.push({hash:fields[i],date:fields[i+1],author:fields[i+2],subject:fields[i+3],body:fields[i+4]});
      return reply({ok:true,repository:repo.id,ref:head,commits:commits.slice(0,30),next:commits.length>30?offset+30:null});
    } catch(error){return reply({ok:false,error:error.message},503);}
  };
}
