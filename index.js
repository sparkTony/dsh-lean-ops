import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyToFile, resolvePath } from './lib/edits.js';
import { load, readRange, sessionDir, sweep } from './lib/spill.js';
import { capturePass } from './lib/capture.js';

const DEFAULTS = {
  captureThresholdTokens: 1200,
  previewHeadChars: 2000,
  previewTailChars: 800,
  resultReadLines: 200,
  resultReadMaxChars: 6000,
  maxEditsPerCall: 20,
  spillTtlDays: 7,
  spillRoot: ''
};

// cordis refuses ctx.tools / ctx.tokenMeter unless the module declares them.
export const inject = ['tools', 'tokenMeter'];

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const tools = ctx.tools;
  const spillRoot = cfg.spillRoot || path.join(os.tmpdir(), 'dsh-lean-ops');
  const dirty = new WeakSet();

  // Loading is the only safe moment: no session can be mid-turn yet.
  try {
    sweep(spillRoot, cfg.spillTtlDays * 86400000);
  } catch {
    // Cleanup never blocks the plugin.
  }

  ctx.effect(() => tools.register({
    name: 'edit_many',
    description:
      `对同一个文件一次做 1-${cfg.maxEditsPerCall} 处小改动，整批原子生效。每条 oldText 必须在当前文件里唯一出现，` +
      '任一条找不到或不唯一就整批不写入。改局部内容优先用它；只有新建文件或大段重写才用 write。' +
      '不确定文件现在长什么样就先 read，不要凭记忆写 oldText。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件，绝对路径或相对当前工作目录。' },
        edits: {
          type: 'array',
          description: '按顺序应用的改动，互不重叠。',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: '要在当前文件里唯一出现的原文，多带几行上下文以保证唯一。' },
              newText: { type: 'string', description: '替换后的文本；空字符串表示删除。' }
            },
            required: ['oldText', 'newText']
          }
        }
      },
      required: ['path', 'edits']
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          file: { type: 'string' },
          applied: { type: 'integer' },
          changed: { type: 'boolean' },
          lines: { type: 'integer' },
          bytes: { type: 'integer' },
          newline: { type: 'string' },
          reason: { type: 'string' },
          failures: { type: 'array', items: { type: 'object', additionalProperties: true } },
          hint: { type: 'string' }
        },
        required: ['status', 'file'],
        additionalProperties: false
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'edited'
          ? `已改 ${value.applied} 处 -> ${value.file}（${value.lines} 行 / ${value.bytes} 字节，换行 ${value.newline}）`
          : value.status === 'unchanged'
            ? `oldText 与 newText 相同，文件未改动：${value.file}`
            : `未写入任何改动：${value.reason || '部分 oldText 无法唯一匹配'}` +
              (value.failures ? `\n${value.failures.map(f => `  第 ${f.index + 1} 条 ${f.oldText ? `「${f.oldText}」` : ''}${f.reason}`).join('\n')}` : '') +
              (value.hint ? `\n${value.hint}` : '')
      }],
      presentationMeta: (_args, value) => ({ kind: 'lean-ops-edit', status: value.status, file: value.file, applied: value.applied || 0 })
    },
    execute: async (args, execution) => {
      const file = resolvePath(String(args.path || ''), execution);
      const result = applyToFile(file, args.edits, cfg.maxEditsPerCall);
      if (result.ok) {
        return {
          status: result.changed ? 'edited' : 'unchanged',
          file,
          applied: result.applied,
          changed: result.changed,
          lines: result.lines || 0,
          bytes: result.bytes || 0,
          newline: result.newline || ''
        };
      }
      return {
        status: 'rejected',
        file,
        reason: result.reason || '部分 oldText 无法唯一匹配',
        failures: result.failures || [],
        hint: result.hint || ''
      };
    }
  }));

  ctx.effect(() => tools.register({
    name: 'result_read',
    description:
      '分页读取已被移出上下文的历史工具结果全文。工具结果预览末尾会给 ref，形如 rXXXXXXXXXXXX。' +
      `一次最多返回 ${cfg.resultReadLines} 行，用 offset 继续，不要凭预览推断中间部分。`,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '预览末尾给出的 ref，不带 ref:// 前缀。' },
        offset: { type: 'integer', description: '1-based 起始行，默认 1。' },
        limit: { type: 'integer', description: `返回行数，默认 ${cfg.resultReadLines}，最大 500。` }
      },
      required: ['ref']
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          ref: { type: 'string' },
          text: { type: 'string' },
          start: { type: 'integer' },
          end: { type: 'integer' },
          total: { type: 'integer' },
          nextOffset: { type: 'integer' },
          trimmed: { type: 'boolean' },
          outOfRange: { type: 'boolean' },
          note: { type: 'string' },
          hint: { type: 'string' }
        },
        required: ['status', 'ref'],
        additionalProperties: false
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status !== 'ok'
          ? `读不到 ref ${value.ref}：${value.hint || '不存在'}`
          : value.outOfRange
            ? `[${value.hint}]`
            : `${value.text}\n\n[ref ${value.ref} 第 ${value.start}-${value.end} 行 / 共 ${value.total} 行]${value.note ? ` ${value.note}` : ''}`
      }],
      presentationMeta: (_args, value) => ({ kind: 'lean-ops-result-read', status: value.status, ref: value.ref })
    },
    execute: async (args, execution) => {
      const dir = dirFor(execution, spillRoot);
      const ref = String(args.ref || '').replace(/^r?:?\/\//, '');
      const text = dir ? load(dir, ref) : null;
      if (!text) return { status: 'not_found', ref, hint: 'ref 只在本会话内有效；过期或换会话就重新执行原工具。' };
      const page = readRange(text, args.offset || 1, args.limit || cfg.resultReadLines, cfg.resultReadMaxChars);
      if (page.outOfRange) {
        return {
          status: 'ok',
          ref,
          text: '',
          start: page.start,
          end: page.start - 1,
          total: page.total,
          outOfRange: true,
          hint: `offset=${page.start} 超出范围：这个 ref 里只有 ${page.total} 行（它存的是宿主交给我们的那一份，` +
            '文件更靠后的部分从来没进过这次工具结果）。要找更后面的内容就用官方 read 的 offset 续读，别在 ref 里翻。'
        };
      }
      return {
        status: 'ok',
        ref,
        text: page.text,
        start: page.start,
        end: page.end,
        total: page.total,
        trimmed: page.trimmed,
        ...(page.nextOffset ? { nextOffset: page.nextOffset } : {}),
        note: page.nextOffset
          ? `还有内容，用 offset=${page.nextOffset} 继续${page.trimmed ? '（本页因字符上限被截短）' : ''}`
          : '已到末尾',
        ...(page.trimmed ? { trimmed: true } : {})
      };
    }
  }));

  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent }) => {
      const scope = agent?.ctx;
      if (!scope || typeof scope.on !== 'function') return;

      // pwsh results settle through the job system, often after the turn
      // boundary; rewriting there was refused by the host while the disk write
      // still succeeded. Mark it dirty and do the rewrite where the host's own
      // pruner does it: while building the next request.
      scope.on('tools/result', () => {
        if (agent.session?.surface?.nodes) dirty.add(agent);
      });

      scope.on('agent/pre-step', async (_payload, next) => {
        if (dirty.has(agent)) {
          dirty.delete(agent);
          try {
            const dir = dirFor({ agent }, spillRoot);
            const result = await capturePass({ ctx, session: agent.session, cfg, dir, logger: ctx.logger });
            for (const failure of result.failures) logFailure(spillRoot, agent, failure);
          } catch (err) {
            logFailure(spillRoot, agent, { stage: 'pass', error: String(err?.message || err) });
          }
        }
        return next();
      });
    });
  }

  return { cfg, spillRoot };
}

/** The GUI console is not readable from here, so failures go to disk. */
function logFailure(root, agent, failure) {
  try {
    const session = agent?.session;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      session: sessionDir('', String(session?.id ?? session?.sessionId ?? 'unknown')).split(/[\\/]/).pop(),
      ...failure
    });
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(path.join(root, 'errors.log'), line + '\n');
  } catch {
    // Never let diagnostics break a turn.
  }
}

/** TODO(实机确认): 权威的会话标识来源。现在按 session.id → session.sessionId 依次取。 */
function dirFor(execution, root) {
  const session = execution?.agent?.session;
  const id = session?.id ?? session?.sessionId;
  if (!id) return null;
  return sessionDir(root, id);
}
