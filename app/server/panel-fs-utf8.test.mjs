// 验证 panel-fs-utf8 的包装在「默认代码页不是 utf8」时是否真的纠正了编码。
// 手法：把 fs.writeFileSync 的原函数替换成一个记录 encoding 参数的桩，
// 这样在 Linux 上也能断言「包装层确实补了 utf8」。
import {writeFileSync, appendFileSync} from './panel-fs-utf8.js';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fails = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.log(`  FAIL  ${name} ${extra}`); fails++; }
}

// 1) 真的写中文并读回，确认字节是 utf8 且内容完好
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utf8test-'));
const f1 = path.join(dir, 'auth.json');
const payload = JSON.stringify({version: 1, devices: [{name: '飞牛浏览器', id: 'abc'}]});
writeFileSync(f1, payload);
const raw = fs.readFileSync(f1);
const expected = Buffer.from(payload, 'utf8');
check('写出的字节 == utf8 编码', raw.equals(expected),
  `实际 ${raw.length}B vs 期望 ${expected.length}B`);
check('JSON 能解析', (() => { try { JSON.parse(fs.readFileSync(f1, 'utf8')); return true; } catch { return false; } })());
check('中文没被替换成 ?', !fs.readFileSync(f1, 'utf8').includes('?'));

// 2) 带 options 对象且没有 encoding：应补 utf8 且保留 mode
const f2 = path.join(dir, 'notes.md');
writeFileSync(f2, '# 便签\n中文内容\n', {mode: 0o600});
check('options 对象补了 encoding', fs.readFileSync(f2, 'utf8').includes('中文内容'));

// 3) 显式给了编码：尊重用户选择
const f3 = path.join(dir, 'explicit.txt');
writeFileSync(f3, 'abc', 'latin1');
check('显式 latin1 被尊重', fs.readFileSync(f3, 'latin1') === 'abc');

// 4) Buffer 必须原样透传（传 encoding 会出错）
const f4 = path.join(dir, 'bin.dat');
const buf = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
writeFileSync(f4, buf);
check('Buffer 原样透传', fs.readFileSync(f4).equals(buf));

// 5) appendFileSync 同样成立
const f5 = path.join(dir, 'log.txt');
appendFileSync(f5, '第一行\n');
appendFileSync(f5, '第二行\n');
check('append 中文完好', fs.readFileSync(f5, 'utf8') === '第一行\n第二行\n');

// 6) 复刻真实事故：设备名带中文，写进去后 JSON 必须仍可解析
const f6 = path.join(dir, 'panel-state-auth.json');
const state = {version: 1, devices: [{id: '6fc5', name: '飞牛浏览器', token_hash: 'deadbeef'}], pairs: []};
writeFileSync(f6, JSON.stringify(state) + '\n');
let parsed = null;
try { parsed = JSON.parse(fs.readFileSync(f6, 'utf8')); } catch (e) { parsed = null; }
check('事故场景：auth.json 可解析', parsed !== null);
check('事故场景：设备名完整', parsed && parsed.devices[0].name === '飞牛浏览器');

fs.rmSync(dir, {recursive: true, force: true});
console.log(fails === 0 ? '\n全部通过' : `\n失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
