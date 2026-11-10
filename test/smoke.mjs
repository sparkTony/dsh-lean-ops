import { apply } from '../index.js';

const registered = [];
const listeners = [];
const fakeCtx = {
  effect: (fn) => { fn(); return () => {}; },
  tools: { register: (t) => { registered.push(t); return () => {}; } },
  on: (name, fn) => { listeners.push([name, fn]); },
  logger: { error: console.error, warn: console.warn },
  tokenMeter: { estimateMessage: (m) => String(m.content?.[0]?.text || '').length }
};

const { cfg } = apply(fakeCtx, {});
console.log('注册工具: ' + registered.map(t => t.name + '(' + Object.keys(t.parameters.properties).join(',') + ')').join(', '));
console.log('监听: ' + listeners.map(l => l[0]).join(', '));
console.log('生效配置: ' + JSON.stringify(cfg));

// edit_many 的 execute 走真实文件（只读临时副本，不动 models.ini）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-ops-smoke-'));
const file = path.join(dir, 'config.ini');
fs.writeFileSync(file, 'ctx-size = 65536\r\ntemp = 0.6\r\nparallel = 1\r\n');

const editMany = registered.find(t => t.name === 'edit_many');
const res = await editMany.execute(
  { path: file, edits: [{ oldText: 'ctx-size = 65536', newText: 'ctx-size = 49152' }, { oldText: 'temp = 0.6', newText: 'temp = 0.2' }] },
  { cwd: dir }
);
console.log('edit_many 结果: ' + JSON.stringify(res));
console.log('文件现在: ' + JSON.stringify(fs.readFileSync(file, 'utf8')));

const dup = path.join(dir, 'dup.ini');
fs.writeFileSync(dup, 'a = 1\na = 1\nb = 2\n');
const before = fs.readFileSync(dup, 'utf8');
const bad = await editMany.execute({ path: dup, edits: [{ oldText: 'a = 1', newText: 'x' }] }, { cwd: dir });
console.log('歧义 oldText 被拒: ' + bad.status + ' / ' + (bad.failures?.[0]?.reason || bad.reason));
console.log('拒绝后文件未改动: ' + (fs.readFileSync(dup, 'utf8') === before));

const resultRead = registered.find(t => t.name === 'result_read');
const missing = await resultRead.execute({ ref: 'r000000000000' }, { agent: { session: { id: 'sess-smoke' } } });
console.log('result_read 未命中: ' + missing.status);
