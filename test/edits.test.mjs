import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planEdits, applyToFile, writeAtomic } from '../lib/edits.js';

const CRLF_FILE = 'ctx-size = 65536\r\nparallel = 1\r\ntemp = 0.6\r\n';

test('LF 的 oldText 能命中 CRLF 文件，且写回保持 CRLF', () => {
  const plan = planEdits(CRLF_FILE, [{ oldText: 'ctx-size = 65536', newText: 'ctx-size = 49152' }]);
  assert.equal(plan.ok, true);
  assert.equal(plan.newline, 'crlf');
  assert.ok(plan.text.includes('ctx-size = 49152\r\n'));
  assert.ok(!plan.text.includes('49152\n') || plan.text.includes('49152\r\n'));
});

test('多条改动按顺序全部生效', () => {
  const plan = planEdits(CRLF_FILE, [
    { oldText: 'ctx-size = 65536', newText: 'ctx-size = 49152' },
    { oldText: 'temp = 0.6', newText: 'temp = 0.2' },
    { oldText: 'parallel = 1', newText: 'parallel = 1 ; 别删' }
  ]);
  assert.equal(plan.ok, true);
  assert.equal(plan.applied, 3);
  assert.ok(plan.text.includes('49152') && plan.text.includes('0.2') && plan.text.includes('别删'));
});

test('oldText 不唯一就整批拒绝，并指出第几条', () => {
  const plan = planEdits('a\na\na\n', [{ oldText: 'a', newText: 'b' }, { oldText: 'zzz', newText: 'c' }]);
  assert.equal(plan.ok, false);
  assert.equal(plan.failures.length, 2);
  assert.match(plan.failures[0].reason, /命中 3 处/);
  assert.match(plan.failures[1].reason, /找不到/);
  assert.ok(plan.hint.includes('read'));
});

test('区间重叠被拒绝', () => {
  const plan = planEdits('hello world\n', [
    { oldText: 'hello', newText: 'x' },
    { oldText: 'hello world', newText: 'y' }
  ]);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /重叠/);
});

test('空 edits 与超过上限都被拒绝', () => {
  assert.equal(planEdits('x', []).ok, false);
  const many = Array.from({ length: 21 }, (_, i) => ({ oldText: `n${i}`, newText: 'z' }));
  const plan = planEdits('n0 n1', many, 20);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /上限 20/);
});

test('applyToFile 原子写入，不留临时文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-ops-test-'));
  const file = path.join(dir, 'models.ini');
  fs.writeFileSync(file, CRLF_FILE);
  const res = applyToFile(file, [{ oldText: 'temp = 0.6', newText: 'temp = 0.2' }]);
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.equal(res.newline, 'crlf');
  assert.ok(fs.readFileSync(file, 'utf8').includes('temp = 0.2'));
  assert.deepEqual(fs.readdirSync(dir), ['models.ini']);
});

test('applyToFile 对被改坏的文件不误伤：拒绝时不写入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-ops-test-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'keep me\n');
  const res = applyToFile(file, [{ oldText: 'nope', newText: 'x' }]);
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me\n');
});

test('writeAtomic 覆盖已有内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-ops-test-'));
  const file = path.join(dir, 'b.txt');
  fs.writeFileSync(file, 'old');
  writeAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});
