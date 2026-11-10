import fs from 'node:fs';
import { MARKER, preview, refFor, shouldCapture, store } from './spill.js';

let freezeMessage = (m) => m;
try {
  ({ freezeMessage } = await import('@deepseek-ai/dsh-llm'));
} catch {
  // Standalone tests run without the host bundle; freezing is only a safety net.
}

/**
 * Rewrite over-budget tool results into a preview plus a disk reference.
 *
 * The mechanics copy @deepseek-ai/dsh-compaction-tool-result-pruner, which is
 * bundled in the host: walk session.surface.nodes, price the shadowed node with
 * a compaction/prune event, then append a replacement with
 * surfaceOp:{op:"replace"}. Reusing that shape keeps tokenMeter and any other
 * surface consumer consistent; inventing a second rewrite path would not.
 */
export async function capturePass({ ctx, session, cfg, dir, logger }) {
  const captured = [];
  const failures = [];
  if (!session?.surface?.nodes || typeof session.eventAt !== 'function') {
    logger?.warn?.('dsh-lean-ops: 宿主没有给出 surface 接口，跳过结果外移');
    return { captured, failures, tokensRemoved: 0, skipped: true };
  }

  let tokensRemoved = 0;
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event?.type !== 'tool/result') continue;

    const original = session.deriveEventMessage(event);
    if (!original || !Array.isArray(original.content)) continue;
    if (textOf(original.content).includes(MARKER)) continue;

    const tokens = ctx.tokenMeter?.estimateMessage?.(original) ?? 0;
    if (!shouldCapture(tokens, cfg.captureThresholdTokens)) continue;

    const full = textOf(original.content);
    const ref = refFor(full);
    const kept = preview(full, {
      headChars: cfg.previewHeadChars,
      tailChars: cfg.previewTailChars,
      ref,
      tokens,
      tool: event?.data?.message?.source?.toolName || ''
    });
    const content = replaceText(original.content, kept);
    const message = freezeMessage({ ...original, content });
    const after = ctx.tokenMeter?.estimateMessage?.(message) ?? 0;

    // Only offload when it actually pays: the host pruner asserts the same
    // constraint. Without this gate a long-line result (pwsh, minified JS)
    // gets replaced by a preview that is barely smaller, costing a shadow
    // event and a disk write for nothing.
    if (kept.length >= full.length || after * 2 > tokens) continue;

    let file;
    try {
      file = store(dir, ref, full);
    } catch (err) {
      failures.push({ seq, stage: 'store', error: String(err?.message || err) });
      continue;
    }

    try {
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: tokens
      });
      session.append('tool/result', { ...event.data, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq]
      });
    } catch (err) {
      // The surface refused the rewrite (typically: the result settled after
      // the turn boundary). Drop the orphan file so refs never dangle.
      failures.push({ seq, ref, stage: 'append', error: String(err?.message || err) });
      try {
        fs.rmSync(file);
      } catch {}
      continue;
    }

    tokensRemoved += Math.max(0, tokens - after);
    captured.push({ seq, ref, file, tokensBefore: tokens, tokensAfter: after, charsBefore: full.length, charsAfter: kept.length });
  }

  return { captured, failures, tokensRemoved };
}

function textOf(blocks) {
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
}

/** Keep non-text blocks (images, files) in place; fold all text into one block. */
function replaceText(blocks, kept) {
  const rest = blocks.filter((b) => b?.type !== 'text');
  return [{ type: 'text', text: kept }, ...rest];
}
