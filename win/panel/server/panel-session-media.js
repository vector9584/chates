import * as fs from 'node:fs';
import {join, extname, relative, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {openStaticFile} from './panel-files.js';
import {atomicWrite, safeId, stateError} from './panel-state.js';

const MIME = {'.gif':'image/gif','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png'};
export function isRasterSticker(fd, mime) {
  const head = Buffer.alloc(12);
  return fs.readSync(fd,head,0,head.length,0) >= 12 && (
    mime === 'image/gif' ? /^GIF8[79]a$/.test(head.toString('ascii',0,6)) :
    mime === 'image/png' ? head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    mime === 'image/jpeg' ? head[0]===255 && head[1]===216 && head[2]===255 :
    mime === 'image/webp' && head.toString('ascii',0,4)==='RIFF' && head.toString('ascii',8,12)==='WEBP');
}
const MAX_STICKER = 24 * 1024 * 1024;
/* 产物子目录白名单（与 panel-workspace.js 的 SESSION_SUBDIRS 同集合）。
   这里本地复制一份而不 import，是为了避开两个模块的循环依赖：
   workspace 引 media 存贴纸，media 再引 workspace 会在 ESM 初始化阶段报
   未定义（2026-11-20 实测 ReferenceError: ARTIFACT_SUBDIRS is not defined）。
   用途只有一处：还原旧格式归档时认「哪一层像会话目录」。 */
const ARTIFACT_SUBDIRS = new Set(['uploads', 'artifacts', 'code', 'stickers']);
/* 2026-11-21：临时预览图（data/tmp）也走同一条归档链。
   面板前端有两道闸把「非会话目录的图」当裂图处理：
     1) markdown 渲染后只给 sessions 目录下的图片改写成稳定地址，
        其它路径若 BASE 有前缀则原样保留 —— 但 /app/hermes-agent/data/tmp/x.png
        在 data 根白名单里能取到，却不在任何「会话产物」目录下，用户端历史消息看起来是裂的；
     2) 归档时只认 assets 贴纸与 tmp/sticker_text。
   统一收进会话 stickers/ 目录后，历史消息与实时消息走同一个可鉴权地址。 */
const STICKER_REF = /(!\[[^\]\n]*\]\(<?)((?:\/app\/hermes-agent)?\/data\/(?:assets\/(?:nekowhale-stickers|whale-stickers|sticker-sent)\/|tmp\/(?:sticker_text|ti_))[^)\s<>]+)(>?(?=\)))/g;

export function stickerSource(data, path) {
  /* 2026-11-21：data/tmp 下的临时预览图（ti_*.png 等）也允许归档，否则历史消息里的临时图每次都要靠 data 根白名单兜，而那条路不在会话目录里，换个归类名就断链。 */
  let match = path.match(/^\/data\/(assets\/(?:nekowhale-stickers\/(?:packs|byhash|renders)|whale-stickers|sticker-sent)|tmp\/(?:sticker_text|ti_))\/(.+)$/);
  if (!match) return null;
  const parts = match[2].split('/').map(decodeURIComponent);
  if (parts.some(p => !p || p.startsWith('.') || /[\/\\\x00-\x1f]/.test(p))) throw stateError('无效表情路径', 400);
  const ext = extname(parts.at(-1)).toLowerCase();
  if (!Object.hasOwn(MIME, ext)) throw stateError('不支持的表情类型', 404);
  const root = join(data, ...match[1].split('/'));
  // Pin to the data tree: no symlink in the configured source subtrees.
  let dir = data;
  for (const part of match[1].split('/')) {
    dir = join(dir, part);
    if (!fs.lstatSync(dir).isDirectory()) throw stateError('无效表情目录', 403);
  }
  return {root, file:join(root,...parts), ext, mime:MIME[ext]};
}

export function preserveSessionStickers(session, data, getWorkdir, report = () => {}, basePath = '') {
  const copied = new Map();
  let changed = false;
  function rewrite(text) {
    if (typeof text !== 'string' || !text.includes('/data/')) return text;
    return text.replace(STICKER_REF, (all, before, url, after) => {
      if (copied.has(url)) return copied.get(url) ? before + copied.get(url) + after : all;
      try {
        const src = stickerSource(data, url.replace(/^\/app\/hermes-agent(?=\/)/,''));
        if (!src) return all;
        const {fd,stat} = openStaticFile(src.root, src.file, {allowHardlinks:true});
        let content;
        try {
          if (stat.size > MAX_STICKER || !isRasterSticker(fd,src.mime)) { copied.set(url,null); return all; }
          content = fs.readFileSync(fd);
        } finally { fs.closeSync(fd); }
        const filename = createHash('sha256').update(content).digest('hex') + src.ext;
        const dir = join(getWorkdir(), 'stickers');
        fs.mkdirSync(dir,{recursive:true});
        if (!fs.lstatSync(dir).isDirectory()) throw stateError('无效会话表情目录', 403);
        const dest = join(dir, filename);
        if (!fs.existsSync(dest)) atomicWrite(dest, content);
        else { const existing = openStaticFile(dir,dest); fs.closeSync(existing.fd); }
        const local = `${basePath}/api/workspace-ui/session-sticker/${safeId(session.id)}/${filename}`;
        copied.set(url, local);
        changed = true;
        return before + local + after;
      } catch (error) {
        copied.set(url, null);
        if (error.code !== 'ENOENT') report(error);
        return all; // Keep the original reference if archival copy fails.
      }
    });
  }
  for (const msg of session.messages || []) {
    if (!msg || msg._streaming) continue;
    if (typeof msg.content === 'string') msg.content = rewrite(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) if (part?.type === 'text') part.text = rewrite(part.text);
    }
  }
  return changed;
}

export function sessionSticker(data, workdir, name) {
  if (!/^[a-f0-9]{64}\.(gif|webp|jpe?g|png)$/.test(name)) throw stateError('无效表情文件名',400);
  const root = join(data,'sessions');
  return {root, file:join(workdir,'stickers',name), mime:MIME[extname(name)]};
}

// Session directories can predate the current group slug. Discover by exact ID,
// not by title, and park each group under the existing archive tree.
function dirExists(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  if (!st.isDirectory()) throw stateError('会话文件路径不是普通目录',409);
  return true;
}
/* 归类是多层树（NAS管理/文件处理），磁盘上也要多层：
   以前只扫 sessions/<一级>/<id>，父级被压平，NAS管理/文件处理 与 文件处理 撞同一目录。 */
function groupDirs(root,id) {
  const out=[];
  const walk=(dir,chain,depth)=>{
    if(depth>6||!dirExists(dir))return;
    let ents=[];try{ents=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
    for(const d of ents){
      if(!d.isDirectory()||d.name.startsWith('.'))continue;
      if(d.name===id&&chain.length){out.push({group:chain.join('/'),path:join(dir,d.name)});continue;}
      walk(join(dir,d.name),[...chain,d.name],depth+1);
    }
  };
  walk(root,[],0);
  return out;
}
export function existingSessionWorkdir(data,id,preferredRel) {
  safeId(id);
  const preferred = join(data,preferredRel);
  const found = groupDirs(join(data,'sessions'),id);
  const exact = found.find(x=>x.path===preferred);
  if (exact) return exact.path;
  if (found.length===1) return found[0].path;
  // 归到别的组的同名目录不算；优先同一条归类链（避免改一次归类就认错家、附件失联）
  const want = relative(join(data,'sessions'), dirname(preferred));
  return found.find(x=>x.group===want)?.path || preferred;
}
export function ensureDirectory(parent, ...parts) {
  for (const part of parts) {
    parent = join(parent, part);
    /* recursive: 归档根（VAR/chat/archived-sessions）在从未归档过的机器上不存在，
       非递归 mkdir 会直接 ENOENT（2026-11-20 隔离实测首次归档即崩）。 */
    if (!dirExists(parent)) fs.mkdirSync(parent, {recursive: true});
  }
  return parent;
}
function moveAndCommit(moves, commit) {
  const moved = [];
  for (const [,to] of moves) {
    if (!dirExists(join(to,'..')) || dirExists(to)) throw stateError('会话文件目录已存在，未覆盖',409);
  }
  try {
    for (const [from,to] of moves) { fs.renameSync(from,to); moved.push([from,to]); }
    commit();
  } catch (error) {
    for (const [from,to] of moved.reverse()) fs.renameSync(to,from);
    throw error;
  }
}
export function moveSessionWorkdir(data, archive, id, mode, preferredRel, commit) {
  safeId(id);
  const parked = join(archive,'workspaces',id);
  const workspaceRoot = join(data,'sessions');
  if (mode === 'archive') {
    const moves = groupDirs(workspaceRoot,id).map(({group,path})=>[path,join(parked,group,id)]);
    if (moves.length) {
      ensureDirectory(archive,'workspaces',id);
      for (const [,to] of moves) fs.mkdirSync(dirname(to),{recursive:true});
    }
    moveAndCommit(moves,commit);
  } else if (mode === 'restore') {
    const found = dirExists(parked) ? groupDirs(parked,id) : [];
    /* 旧格式兼容（2026-11-20 之前归档的会话）：那时把会话目录直接 rename 成 group 末级，
       归档里没有 <id> 这一层，restore 按名字找必然空手 —— 会话回来了、附件留在归档里，
       用户看到的就是「还原后附件全没了」。这里改成按「哪一层有 uploads/产物子目录」认。 */
    let src = found;
    if (!src.length && dirExists(parked)) {
      const hits = [];
      const walk = (dir, chain, depth) => {
        if (depth > 8) return;
        let ents = [];
        try { ents = fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
        const subs = ents.filter(e=>e.isDirectory() && ARTIFACT_SUBDIRS.has(e.name));
        if (subs.length && chain.length) hits.push({group:chain.join('/'),path:dir});
        for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) walk(join(dir,e.name),[...chain,e.name],depth+1);
      };
      walk(parked,[],0);
      if (hits.length) { hits.sort((a,b)=>a.group.split('/').length-b.group.split('/').length); src=[hits[0]]; }
    }
    const moves = src.map(({group,path})=>[path, src.length===1?join(data,preferredRel):join(workspaceRoot,group,id)]);
    for (const [,to] of moves) fs.mkdirSync(dirname(to),{recursive:true});
    moveAndCommit(moves,commit);
    try { fs.rmdirSync(parked); } catch {}
  } else if (mode === 'purge') {
    // Older archives can still have their workspaces in the live tree.
    for (const {path} of groupDirs(workspaceRoot,id)) fs.rmSync(path,{recursive:true});
    if (dirExists(join(archive,'workspaces')) && dirExists(parked)) fs.rmSync(parked,{recursive:true});
    commit();
  } else throw new Error('Unknown workspace operation');
}
