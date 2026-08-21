/**
 * Minimal Markdown renderer for model output.
 *
 * Deliberately not a full Markdown library, and deliberately never `dangerouslySetInnerHTML`.
 * Model output is untrusted input: it is text that an attacker can influence through a
 * prompt-injected file or web page the agent read. Everything here produces React elements
 * from parsed text, so there is no HTML string for an injection to ride in on.
 *
 * Supported: fenced code, inline code, headings, bullet and numbered lists, bold, italic,
 * and links restricted to http(s). That covers what the models actually emit here.
 */

import { memo, type ReactNode } from 'react';

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;

  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > index) nodes.push(text.slice(index, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[0.85em] text-neutral-200">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-neutral-100">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      if (linkMatch) {
        const [, label, href] = linkMatch;
        // Only http(s). This is what stops a javascript: or data: URL from becoming a
        // clickable payload in rendered model output.
        const safe = /^https?:\/\//i.test(href);
        nodes.push(
          safe ? (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-sky-400 underline underline-offset-2 hover:text-sky-300"
            >
              {label}
            </a>
          ) : (
            <span key={key}>{label}</span>
          ),
        );
      } else {
        nodes.push(token);
      }
    }
    index = match.index + token.length;
  }

  if (index < text.length) nodes.push(text.slice(index));
  return nodes;
}

interface Block {
  kind: 'code' | 'heading' | 'list' | 'ordered' | 'paragraph';
  content: string[];
  language?: string;
  level?: number;
}

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const content: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        content.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({ kind: 'code', content, language });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', content: [heading[2]], level: heading[1].length });
      i += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const content: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        content.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'list', content });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const content: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        content.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ordered', content });
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const content: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !/^#{1,4}\s/.test(lines[i])) {
      content.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', content });
  }

  return blocks;
}

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source);

  return (
    <div className="space-y-3 text-[13.5px] leading-relaxed text-neutral-300">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        if (block.kind === 'code') {
          return (
            <pre
              key={key}
              className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs leading-relaxed text-neutral-300"
            >
              <code>{block.content.join('\n')}</code>
            </pre>
          );
        }
        if (block.kind === 'heading') {
          const size = block.level === 1 ? 'text-base' : block.level === 2 ? 'text-[15px]' : 'text-sm';
          return (
            <h3 key={key} className={`${size} font-semibold text-neutral-100`}>
              {renderInline(block.content[0], key)}
            </h3>
          );
        }
        if (block.kind === 'list' || block.kind === 'ordered') {
          const List = block.kind === 'list' ? 'ul' : 'ol';
          return (
            <List
              key={key}
              className={`ml-4 space-y-1 ${block.kind === 'list' ? 'list-disc' : 'list-decimal'} marker:text-neutral-600`}
            >
              {block.content.map((item, j) => (
                <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>
              ))}
            </List>
          );
        }
        return <p key={key}>{renderInline(block.content.join(' '), key)}</p>;
      })}
    </div>
  );
});
