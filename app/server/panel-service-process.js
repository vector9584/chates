import * as fs from 'node:fs';
import {join} from 'node:path';
import {isApplicationService} from './panel-process-guard.js';

// Windows 独立桌面版没有 /proc：cmdline/stat/readdir 全不可用。这里用一个显式开关
// （electron 壳 spawn monitor 时已设 HERMES_PANEL_TRUST_LOOPBACK=1）切到 pid-only 实现，
// fpk/生产环境不设该变量，仍走完整的 /proc 归属与 starttime 校验。
const PID_ONLY = process.platform === 'win32' && process.env.HERMES_PANEL_TRUST_LOOPBACK === '1';

export function createServiceProcesses({hermesBin,venvBin,pidFiles,io=fs,proc='/proc',signal=(pid,name)=>process.kill(pid,name),delay=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 function identity(pid,kind){
  if(!Number.isSafeInteger(pid)||pid<=0)return null;
  if(PID_ONLY){
   // 没有 cmdline 可读，无法校验「这个 pid 确实是 gateway」；也没有 starttime。
   // 独立版只 bind 127.0.0.1、pid 文件在用户私有目录，故以存活为判据，
   // start 由 pid 派生以保证两次调用可比（ServiceHealth 用 start 做 same() 比对）。
   try{process.kill(pid,0);}catch{return null;}
   return {pid,kind,start:'w'+pid};
  }
  try{
   const argv=io.readFileSync(join(proc,String(pid),'cmdline'),'utf8').split('\0').filter(Boolean);
   if(!isApplicationService(argv,{hermesBin,venvBin}))return null;
   const index=argv.indexOf(hermesBin),command=index>=0?argv[index+1]:argv[3];
   if(command!==kind)return null;
   const raw=io.readFileSync(join(proc,String(pid),'stat'),'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
   if(['Z','X'].includes(fields[0])||!/^\d+$/.test(fields[19]))return null;
   return {pid,kind,start:fields[19]};
  }catch{return null;}
 }
 function matches(saved){const current=identity(saved.pid,saved.kind);return !!current&&current.start===saved.start;}
 function read(kind){try{return identity(Number(io.readFileSync(pidFiles[kind],'utf8').trim()),kind);}catch{return null;}}
 function find(kind){try{for(const name of io.readdirSync(proc)){if(!/^\d+$/.test(name))continue;const found=identity(Number(name),kind);if(found)return found;}}catch{}return null;}
 function forget(kind,pid){try{const recorded=Number(io.readFileSync(pidFiles[kind],'utf8').trim());if(recorded===pid||!identity(recorded,kind))io.unlinkSync(pidFiles[kind]);}catch{}}
 async function stop(kind){
  const saved=read(kind)||find(kind);if(!saved)return {ok:true,stopped:false};
  // Every signal rechecks exact command ownership and the PID incarnation.
  try{if(matches(saved))signal(saved.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')return {ok:false,error:'无法停止应用服务，请检查运行用户权限'};}
  const deadline=now()+5000;
  while(matches(saved)&&now()<deadline)await delay(100);
  if(matches(saved)){try{signal(saved.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')return {ok:false,error:'应用服务仍在运行，未完成停止'};}await delay(200);}
  if(matches(saved))return {ok:false,error:'应用服务尚未退出，请稍后核对'};
  if(!identity(saved.pid,kind))forget(kind,saved.pid);return {ok:true,stopped:true};
 }
 return {identity,read,find,stop,matches};
}
