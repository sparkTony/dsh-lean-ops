import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capturePass } from '../lib/capture.js';
import { MARKER, load, refFor, sessionDir } from '../lib/spill.js';

const BIG = Array.from({ length: 4000 }, (_, i) => `line ${i}: const x = compute(i, "payload")`).join('\n');
const SMALL = 'ctx-size = 65536\ntemp = 0.6\n';
// 复刻线上那次 pwsh：5,040 字符 / 42 行长行，估算约 1,362 token，超阈值但省不到一半
const LONG_LINES = Array.from({ length: 42 }, () => 'p'.repeat(110)).join('\n');

const CFG = {
  captureThresholdTokens: 1200,
  previewHeadChars: 2000,
  previewTailChars: 800
};

function makeSession(events) {
  const appended = [];
  let nextSeq = 100;
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return {
    id: 'sess-fake-1',
    surface: { nodes: events.map((e) => e.seq) },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => (event.type === 'tool/result' ? event.data.message : undefined),
    append: (type, data, opts) => {
      const seq = nextSeq++;
      appended.push({ type, data, opts });
      return { seq };
    },
    appended
  };
}

const toolResult = (seq, content, name = 'read') => ({
  seq,
  type: 'tool/result',
  data: { message: { role: 'tool', source: { kind: 'tool', toolName: name, callId: `c${seq}` }, content } }
});

const ctxStub = () => ({ tokenMeter: { estimateMessage: (m) => Math.round(String(m.content?.map?.((b) => b.text || '').join('') || '').length / 3.7) } });
const dirs = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lean-ops-capture-'));

test('超预算的 read 结果被换成预览+ref，并留下影子计价事件', async () => {
  const session = makeSession([toolResult(1, [{ type: 'text', text: BIG }])]);
  const dir = sessionDir(dirs(), session.id);
  const { captured, tokensRemoved } = await capturePass({ ctx: ctxStub(), session, cfg: CFG, dir });

  assert.equal(captured.length, 1);
  assert.ok(tokensRemoved > 1000, `应省下上千 token，实际 ${tokensRemoved}`);

  const prune = session.appended.find((a) => a.type === 'compaction/prune');
  assert.ok(prune, '必须先写 compaction/prune 影子事件');
  assert.deepEqual(prune.data.shadowedRange, { start: 1, end: 1 });
  assert.ok(prune.data.shadowedTokenCount > 0);

  const rep = session.appended.find((a) => a.type === 'tool/result');
  assert.deepEqual(rep.opts.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 });
  assert.deepEqual(rep.opts.sourceEventSeqs, [1]);

  const text = rep.data.message.content[0].text;
  assert.ok(text.includes(MARKER));
  assert.ok(text.includes(`ref://${captured[0].ref}`));
  assert.ok(text.length < BIG.length / 4, '预览必须显著短于原文');
});

test('落盘全文可以按 ref 完整取回（可恢复，不是破坏性截断）', async () => {
  const session = makeSession([toolResult(7, [{ type: 'text', text: BIG }])]);
  const dir = sessionDir(dirs(), session.id);
  const { captured } = await capturePass({ ctx: ctxStub(), session, cfg: CFG, dir });
  assert.equal(load(dir, captured[0].ref), BIG);
  assert.ok(fs.existsSync(captured[0].file));
});

test('省不到一半就不外移：长行 pwsh 结果保持原样（线上踩过的坑）', async () => {
  const session = makeSession([toolResult(1, [{ type: 'text', text: LONG_LINES }], 'pwsh')]);
  const dir = sessionDir(dirs(), 'sess-fake-1');
  const { captured, tokensRemoved } = await capturePass({ ctx: ctxStub(), session, cfg: CFG, dir });
  assert.equal(captured.length, 0, '预览收益不足时必须放弃外移');
  assert.equal(tokensRemoved, 0);
  assert.equal(session.appended.length, 0, '不该留下影子事件或替换');
  assert.equal(fs.existsSync(dir), false, '不该写盘');
});

test('未超预算的结果一律不动', async () => {
  const session = makeSession([toolResult(1, [{ type: 'text', text: SMALL }])]);
  const { captured, tokensRemoved } = await capturePass({ ctx: ctxStub(), session, cfg: CFG, dir: sessionDir(dirs(), 's') });
  assert.equal(captured.length, 0);
  assert.equal(tokensRemoved, 0);
  assert.equal(session.appended.length, 0);
});

test('已经是预览的结果不会被二次外移（防自替换循环）', async () => {
  const already = `头部\n${MARKER}\n尾部\n[完整内容 4000 行 / 约 3000 token已存 ref://rdeadbeefdead]`;
  const session = makeSession([toolResult(1, [{ type: 'text', text: already }])]);
  const { captured } = await capturePass({
    ctx: ctxStub(),
    session,
    cfg: { ...CFG, captureThresholdTokens: 10, previewHeadChars: 10, previewTailChars: 10 },
    dir: sessionDir(dirs(), 's')
  });
  assert.equal(captured.length, 0, '阈值再低也不该重抓自己的预览');
});

test('非文本块（图片等）保持原位，只折叠文本块', async () => {
  const blocks = [
    { type: 'image', url: 'data:...' },
    { type: 'text', text: BIG.slice(0, 20000) },
    { type: 'text', text: BIG.slice(20000) }
  ];
  const session = makeSession([toolResult(1, blocks)]);
  const dir = sessionDir(dirs(), 'sess-fake-1');
  const { captured } = await capturePass({ ctx: ctxStub(), session, cfg: CFG, dir });
  assert.equal(captured.length, 1);
  const content = session.appended.find((a) => a.type === 'tool/result').data.message.content;
  assert.equal(content.length, 2, '折叠成 1 个文本块 + 1 个图片块');
  assert.equal(content[1].type, 'image');
  assert.equal(load(dir, captured[0].ref), blocks[1].text + '\n' + blocks[2].text);
});

test('没有 surface 接口时保守跳过，不抛错也不写盘', async () => {
  const dir = dirs();
  const { skipped, captured } = await capturePass({
    ctx: ctxStub(),
    session: {},
    cfg: { ...CFG, captureThresholdTokens: 1, previewHeadChars: 1, previewTailChars: 1 },
    dir
  });
  assert.equal(skipped, true);
  assert.equal(captured.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'lean-ops')), false);
});

test('refFor 与 capture 用的是同一个 id', async () => {
  const session = makeSession([toolResult(1, [{ type: 'text', text: BIG }])]);
  const dir = sessionDir(dirs(), 'sess-fake-1');
  const { captured } = await capturePass({ ctx: ctxStub(), session, cfg: CFG, dir });
  assert.equal(captured[0].ref, refFor(BIG));
});
