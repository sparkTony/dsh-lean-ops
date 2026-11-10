import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MARKER = '[... 工具结果过大，已移出上下文 ...]';

export function sessionDir(root, sessionId) {
  const hash = crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
  return path.join(root, 'lean-ops', hash);
}

export function refFor(text) {
  return `r${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

export function shouldCapture(tokens, threshold) {
  return Number.isFinite(tokens) && tokens > threshold;
}

export function spillPath(dir, ref) {
  if (!/^r[0-9a-f]{12}$/.test(ref)) return null;
  return path.join(dir, `${ref}.txt`);
}

export function store(dir, ref, text) {
  fs.mkdirSync(dir, { recursive: true });
  const file = spillPath(dir, ref);
  if (!file) throw new Error(`非法 ref: ${ref}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text);
  return file;
}

export function load(dir, ref) {
  const file = spillPath(dir, ref);
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

/**
 * The replacement text the model actually sees.
 *
 * Budgets are in characters, not lines: pwsh and minified bundles produce
 * single lines tens of thousands of characters long, so a line-count cap can
 * emit a "preview" barely smaller than the original. Cutting at line
 * boundaries keeps the preview readable; a line longer than the budget is cut
 * mid-line rather than dropped.
 */
export function preview(text, { headChars = 2000, tailChars = 800, ref, tokens = 0, tool = '' } = {}) {
  if (text.length <= headChars + tailChars) return text;
  const head = sliceAtLine(text, 0, headChars);
  const tail = sliceTailAtLine(text, tailChars);
  const lines = linesOf(text).length;
  const note = HOST_CAP.test(text)
    ? `[注意：这 ${lines} 行只是宿主已经截断后交给我们的部分，文件更靠后的内容不在 ref 里——要它就用官方 read 的 offset 续读]`
    : `[需要别处就用 result_read(ref="${ref}", offset=<行号>, limit=<行数>)，不要凭这段预览推断中间部分]`;
  return [
    head,
    '',
    MARKER,
    '',
    tail,
    '',
    `[ref://${ref} 存了这次结果的 ${lines} 行 / ${text.length} 字符 / 约 ${tokens} token${tool ? `，来自 ${tool}` : ''}]`,
    note
  ].join('\n');
}

const HOST_CAP = /Output capped\.|Use offset=\d+ to continue\./;

function linesOf(text) {
  return text.split(/\r?\n/);
}

function sliceAtLine(text, from, budget) {
  const cut = Math.min(text.length, from + budget);
  const nl = text.lastIndexOf('\n', cut);
  return text.slice(from, nl > from ? nl : cut);
}

function sliceTailAtLine(text, budget) {
  const start = Math.max(0, text.length - budget);
  const nl = text.indexOf('\n', start);
  return text.slice(nl >= 0 && nl < text.length - 1 ? nl + 1 : start);
}

export function readRange(text, offset = 1, limit = 200, maxChars = 6000) {
  const lines = linesOf(text);
  const start = Math.max(1, Math.floor(offset));
  const take = Math.max(1, Math.min(500, Math.floor(limit)));
  let body = lines.slice(start - 1, start - 1 + take);
  let joined = body.join('\n');
  let trimmed = false;
  while (joined.length > maxChars && body.length > 1) {
    body = body.slice(0, -1);
    joined = body.join('\n');
    trimmed = true;
  }
  if (joined.length > maxChars) {
    joined = joined.slice(0, maxChars);
    trimmed = true;
  }
  const returned = body.length;
  const end = start - 1 + returned;
  return {
    text: joined,
    start,
    end,
    total: lines.length,
    trimmed,
    outOfRange: start > lines.length,
    nextOffset: end < lines.length ? end + 1 : null
  };
}

/**
 * Delete spilled files older than maxAgeMs and any session dir left empty.
 *
 * A spilled ref is only reachable from a live session event, so once the
 * session is gone the file can never be read again. Nothing else cleans them:
 * the host does not know about this directory.
 */
export function sweep(root, maxAgeMs) {
  const base = path.join(root, 'lean-ops');
  let dirs;
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { files: 0, dirs: 0 };
  }
  const cutoff = Date.now() - maxAgeMs;
  let files = 0;
  let emptied = 0;
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
          files++;
        }
      } catch {}
    }
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        emptied++;
      }
    } catch {}
  }
  return { files, dirs: emptied };
}
