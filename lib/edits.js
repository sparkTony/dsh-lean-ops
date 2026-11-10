import fs from 'node:fs';
import path from 'node:path';

const toLF = (text) => text.replace(/\r\n/g, '\n');
const hasCRLF = (text) => text.includes('\r\n');
const restore = (text, crlf) => (crlf ? text.replace(/\n/g, '\r\n') : text);

/**
 * Match and apply edits against the original bytes without writing.
 *
 * Matching happens in LF space while the file keeps its own newline convention:
 * a model that was shown CRLF text usually emits LF in oldText, and a plain
 * indexOf would then report "not found" for text that is really there.
 */
export function planEdits(original, edits, maxEdits = 20) {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, reason: 'edits 必须是非空数组' };
  if (edits.length > maxEdits) return { ok: false, reason: `edits 超过上限 ${maxEdits} 条，拆成多次调用` };

  const crlf = hasCRLF(original);
  const hay = toLF(original);
  const spans = [];
  const failures = [];

  edits.forEach((edit, index) => {
    const oldText = toLF(String(edit?.oldText ?? ''));
    const newText = toLF(String(edit?.newText ?? ''));
    if (!oldText) {
      failures.push({ index, reason: 'oldText 为空' });
      return;
    }
    const hits = [];
    for (let at = hay.indexOf(oldText); at >= 0; at = hay.indexOf(oldText, at + 1)) hits.push(at);
    if (hits.length === 0) {
      failures.push({ index, oldText: head(oldText), reason: '在当前文件里找不到' });
    } else if (hits.length > 1) {
      failures.push({ index, oldText: head(oldText), reason: `命中 ${hits.length} 处，要求唯一；把 oldText 连同行一起多带几行上下文` });
    } else {
      spans.push({ index, start: hits[0], end: hits[0] + oldText.length, newText });
    }
  });

  if (failures.length) return { ok: false, failures, hint: '先 read 这个文件拿到真实文本，再改；不要凭记忆写 oldText' };

  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      return { ok: false, reason: 'edits 区间重叠', failures: [{ index: spans[i].index, reason: '与上一条重叠' }] };
    }
  }

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += hay.slice(cursor, span.start) + span.newText;
    cursor = span.end;
  }
  out += hay.slice(cursor);

  return { ok: true, text: restore(out, crlf), applied: spans.length, newline: crlf ? 'crlf' : 'lf' };
}

export function applyToFile(file, edits, maxEdits = 20) {
  let original;
  try {
    original = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? '文件不存在，新建文件请用 write' : `读取失败：${err.message}` };
  }
  const plan = planEdits(original, edits, maxEdits);
  if (!plan.ok) return plan;
  if (plan.text === original) return { ok: true, applied: plan.applied, changed: false, file };
  writeAtomic(file, plan.text);
  const lines = plan.text.split(/\r?\n/);
  return {
    ok: true,
    applied: plan.applied,
    changed: true,
    file,
    lines: lines.length,
    bytes: Buffer.byteLength(plan.text),
    newline: plan.newline
  };
}

/** Same-directory temp file then rename, so a crash cannot leave a half-written target. */
export function writeAtomic(file, text) {
  const tmp = `${file}.lean-ops-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function resolvePath(asked, execution) {
  const base = execution?.cwd || process.cwd();
  return path.isAbsolute(asked) ? asked : path.resolve(base, asked);
}

function head(text) {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
