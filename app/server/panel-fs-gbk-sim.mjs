// 反向验证：在「默认代码页不是 utf8」时，旧写法真的会写坏 JSON 吗？
// 用 iconv 把 utf8 文本按 GBK 编码再写盘，等价于 Windows CP936 的行为，
// 然后看 JSON.parse 会不会失败 —— 如果会，就确证了事故根因。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbksim-'));
const f = path.join(dir, 'auth.json');
const good = JSON.stringify({version: 1, devices: [{id: '6fc5', name: '飞牛浏览器'}]}) + '\n';

// 模拟 Windows：把字符串按 GBK 编成字节再写盘（'器' 在 GBK 里能编，但 '浏' 也能；
// 真正的杀手是某些字符 + 后续引号被一起吃掉，用 //TRANSLIT 复刻替换行为）
try {
  execFileSync('bash', ['-c',
    `printf '%s' ${JSON.stringify(good)} | iconv -f utf-8 -t GBK > ${JSON.stringify(f)} 2>/dev/null || true`]);
} catch (e) { console.log('iconv 不可用，跳过：', e.message); process.exit(0); }

const bytes = fs.readFileSync(f);
console.log('GBK 写出的字节数:', bytes.length, ' utf8 期望:', Buffer.from(good, 'utf8').length);

// 用 utf8 读回来（这正是 panel-state.js 的 read() 干的事）
let parsed = null, err = null;
try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { err = e.message; }

if (err) {
  console.log('读端 utf8 解析失败 —— 复现事故:', err.slice(0, 90));
  console.log('原因：GBK 字节流用 utf8 解码得到替换字符，字符串失去闭合。');
} else {
  console.log('本例未复现（该字符集下 GBK 恰好可逆）:', JSON.stringify(parsed).slice(0, 80));
}
fs.rmSync(dir, {recursive: true, force: true});
