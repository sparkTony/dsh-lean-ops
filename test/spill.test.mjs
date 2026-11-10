import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKER, preview, readRange, refFor, sessionDir, shouldCapture, spillPath, store, sweep, load } from '../lib/spill.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lean-ops-spill-'));

test('ref 稳定且只接受自己的格式', () => {
  const a = refFor('payload');
  assert.match(a, /^r[0-9a-f]{12}$/);
  assert.equal(a, refFor('payload'));
  assert.notEqual(a, refFor('payload2'));
  assert.equal(spillPath('/tmp/x', '../../etc/passwd'), null);
  assert.equal(spillPath('/tmp/x', a), path.join('/tmp/x', `${a}.txt`));
});

test('会话目录按 id 隔离，两个会话不互相引用', () => {
  const one = sessionDir('/root', 'session-1');
  const two = sessionDir('/root', 'session-2');
  assert.notEqual(one, two);
  assert.ok(one.startsWith(path.join('/root', 'lean-ops')));
});

test('store/load 往返，重复写不破坏原文', () => {
  const d = dir();
  const text = 'line1\nline2\n';
  const ref = refFor(text);
  store(d, ref, text);
  store(d, ref, '不该覆盖');
  assert.equal(load(d, ref), text);
  assert.equal(load(d, 'r000000000000'), null);
});

test('shouldCapture 用严格大于，边界不外移', () => {
  assert.equal(shouldCapture(1200, 1200), false);
  assert.equal(shouldCapture(1201, 1200), true);
  assert.equal(shouldCapture(NaN, 1200), false);
});

test('预览按字符封顶：短文本原样返回', () => {
  const short = 'a\nb\nc\n';
  assert.equal(preview(short, { headChars: 2000, tailChars: 800, ref: 'rdeadbeefdead' }), short);
});

test('预览按字符封顶：长行文件也不会漏出大预览', () => {
  const oneLine = 'x'.repeat(50000);
  const out = preview(oneLine, { headChars: 2000, tailChars: 800, ref: 'rdeadbeefdead', tokens: 13000, tool: 'pwsh' });
  assert.ok(out.length < 3500, `预览应被字符预算钉住，实际 ${out.length}`);
  assert.ok(out.includes(MARKER));
  assert.ok(out.includes('ref://rdeadbeefdead'));
  assert.ok(out.includes('50000 字符'));
});

test('预览在行边界裁切，不切碎正常代码行', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i} = value`).join('\n');
  const out = preview(text, { headChars: 500, tailChars: 100, ref: 'rdeadbeefdead' });
  const headBlock = out.split('\n').slice(0, 20);
  assert.ok(headBlock.every((l) => l.startsWith('line ') || l === ''), '头部每行都完整');
  assert.ok(out.includes('line 1999 = value'), '尾部保留最后几行');
});

test('readRange 翻页游标连续，limit 有上限', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `L${i + 1}`).join('\n');
  const first = readRange(text, 1, 200);
  assert.equal(first.start, 1);
  assert.equal(first.end, 200);
  assert.equal(first.nextOffset, 201);
  assert.equal(first.total, 1000);
  assert.equal(first.trimmed, false);

  const second = readRange(text, first.nextOffset, 200);
  assert.equal(second.text.split('\n')[0], 'L201');

  const clamped = readRange(text, 1, 99999);
  assert.equal(clamped.end, 500);

  const tail = readRange(text, 950, 200);
  assert.equal(tail.nextOffset, null);
  assert.equal(tail.end, 1000);

  const underflow = readRange(text, 0, 10);
  assert.equal(underflow.start, 1);
});

test('readRange 的字符上限会截短整页并回报 trimmed', () => {
  const text = Array.from({ length: 300 }, () => 'y'.repeat(100)).join('\n');
  const page = readRange(text, 1, 200, 6000);
  assert.ok(page.text.length <= 6000, `不该超过字符上限，实际 ${page.text.length}`);
  assert.equal(page.trimmed, true);
  assert.ok(page.end < 200, '被截短后 end 要如实反映返回的行数');
  assert.equal(page.nextOffset, page.end + 1, '下一页游标要接得上');

  const single = readRange('z'.repeat(20000), 1, 200, 6000);
  assert.equal(single.text.length, 6000);
  assert.equal(single.trimmed, true);
});

test('sweep 只删过期文件，空目录跟着收', () => {
  const root = dir();
  const a = sessionDir(root, 'session-a');
  const b = sessionDir(root, 'session-b');
  const old = store(a, refFor('old payload'), 'old');
  const fresh = store(b, refFor('fresh payload'), 'fresh');
  const past = new Date(Date.now() - 8 * 86400000);
  fs.utimesSync(old, past, past);

  const removed = sweep(root, 7 * 86400000);
  assert.equal(removed.files, 1);
  assert.ok(!fs.existsSync(old), '过期的外移文件要删掉');
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'fresh', '未过期的不能动');
  assert.ok(!fs.existsSync(a), '文件删空的会话目录要一起收掉');
  assert.ok(fs.existsSync(b), '还有新文件的目录要留着');
  assert.equal(removed.dirs, 1);

  assert.deepEqual(sweep(path.join(root, 'nope'), 7 * 86400000), { files: 0, dirs: 0 });
});

test('offset 越过末尾时如实报越界，而不是"第 1240-1239 行"', () => {
  const text = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n');
  const page = readRange(text, 1240, 5);
  assert.equal(page.outOfRange, true);
  assert.equal(page.text, '');
  assert.equal(page.total, 10);
  assert.equal(readRange(text, 10, 5).outOfRange, false, '最后一行本身不算越界');
});

test('宿主已经截断过的结果，预览要改成指向 read 续读而不是 ref', () => {
  const capped = [
    '<content>',
    ...Array.from({ length: 400 }, (_, i) => `${i + 1}: line ${i + 1}`).map((s) => `${s} ${'x'.repeat(40)}`),
    '',
    '(Output capped. Showing lines 1-400. Use offset=401 to continue.)',
    '</content>'
  ].join('\n');
  const out = preview(capped, { headChars: 200, tailChars: 80, ref: 'r'.repeat(13) });
  assert.match(out, /只是宿主已经截断后交给我们的部分/);
  assert.ok(!out.includes('不要凭这段预览推断中间部分'), '截断过的结果不该再引导它去 ref 里翻');

  const plain = preview('a'.repeat(4000), { headChars: 200, tailChars: 80, ref: 'r'.repeat(13) });
  assert.match(plain, /不要凭这段预览推断中间部分/);
  assert.doesNotMatch(plain, /宿主已经截断/);
});
