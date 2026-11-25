import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs';
import {join} from 'node:path';

// Exact argv ownership checks. Substrings such as "hermes-agent-copy" or a
// mention of our path in another program's argument never establish ownership.
export function isApplicationService(argv,{hermesBin,venvBin}){
 // Windows 上解释器和启动器都带 .exe，且 vm 版没有 join(venvBin,'python') 这种无扩展名文件。
 // 所以两个平台都要试：'python' / 'python.exe' / 'python3' / 'python3.exe'。
 const pyCandidates=['python','python.exe','python3','python3.exe'].map(n=>join(venvBin,n));
 const isPy=p=>pyCandidates.includes(p);
 const index=argv.indexOf(hermesBin);
 if(index>=0&&(index===0||(index===1&&isPy(argv[0]))))return argv[index+1]==='dashboard'||(argv[index+1]==='gateway'&&argv[index+2]==='run');
 return isPy(argv[0])&&argv[1]==='-m'&&argv[2]==='hermes_cli.main'&&(argv[3]==='dashboard'||argv[3]==='gateway'&&argv[4]==='run');
}

// Windows 版端口归属探测（2026-11-25 加）。
//
// 原实现只走 Linux 路径：`ss -H -ltnp` + 读 /proc/<pid>/cmdline。
// 在 Windows 上这两样都不存在 —— ss 命令没有、/proc 没有 ——
// run('ss') 直接抛错，函数返回 [{reason:'inspection_failed'}]，
// 上层 foreignHermesPortConflicts() 把「探测失败」当成「端口被占」，
// 于是 gateway/dashboard 永远不启动，日志一句「应用端口被其他进程占用」，
// 而实际上端口全空。这是个会卡死整条启动链的假冲突。
//
// Windows 用 netstat -ano 拿 LISTENING 行的 PID，再用 PowerShell CIM 读命令行。
function inspectWindows({ports,hermesBin,venvBin,run}) {
  let result;
  try {
    result = run('netstat', ['-ano'], {encoding:'utf8', timeout:5000, maxBuffer:4*1024*1024});
  } catch { return ports.map(port=>({port,reason:'inspection_failed'})); }
  if (result.error || !result.stdout) return ports.map(port=>({port,reason:'inspection_failed'}));

  const conflicts = [];
  const seen = new Set();
  for (const line of String(result.stdout).split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    if (!ports.includes(port) || seen.has(port)) continue;
    seen.add(port);
    if (!pid) { conflicts.push({port, reason:'owner_unavailable'}); continue; }

    // 取这个 pid 的命令行。拿不到就当成「不是我们的」——保守，但不会误杀。
    let cmdline = '';
    try {
      const q = run('powershell', ['-NoProfile','-NonInteractive','-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        {encoding:'utf8', timeout:6000});
      cmdline = String(q.stdout || '').trim();
    } catch {}

    const argv = cmdline ? cmdline.split(/\s+/).filter(Boolean) : [];
    let ours = false;
    try { ours = isApplicationService(argv, {hermesBin, venvBin}); } catch {}
    if (!ours) conflicts.push({port, pid, reason:'foreign_listener'});
  }
  return conflicts;
}

export function inspectServicePortConflicts({ports,hermesBin,venvBin,run=spawnSync,io=fs,proc='/proc'}){
 if (process.platform === 'win32') return inspectWindows({ports,hermesBin,venvBin,run});

 let result;try{result=run('ss',['-H','-ltnp'],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024});}catch{return ports.map(port=>({port,reason:'inspection_failed'}));}
 if(result.error||result.status!==0)return ports.map(port=>({port,reason:'inspection_failed'}));
 const conflicts=[];
 for(const line of String(result.stdout||'').split('\n')){
  const address=line.trim().split(/\s+/)[3],port=Number(address?.match(/:(\d+)$/)?.[1]);if(!ports.includes(port))continue;
  const ids=[...line.matchAll(/pid=(\d+)/g)].map(m=>Number(m[1]));
  if(!ids.length){conflicts.push({port,reason:'owner_unavailable'});continue;}
  for(const pid of ids){let ours=false;try{ours=isApplicationService(io.readFileSync(join(proc,String(pid),'cmdline'),'utf8').split('\0').filter(Boolean),{hermesBin,venvBin});}catch{}
   if(!ours)conflicts.push({port,pid,reason:'foreign_listener'});
  }
 }
 return conflicts;
}
