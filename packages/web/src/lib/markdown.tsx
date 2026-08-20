import type { ReactNode } from 'react';

/**
 * A small Markdown renderer for chat messages.
 *
 * It produces React elements and never HTML. That is the whole security story:
 * message bodies are written by people and by models, and anything that turned
 * them into markup would need a sanitiser and would eventually be wrong about
 * something. Here there is no path from a message to an HTML tag at all.
 *
 * The supported subset is what actually appears in a development conversation:
 * fenced code, inline code, headings, lists, block quotes, rules, emphasis,
 * links and mentions. Anything else is shown as the text it is, which is the
 * correct outcome for a chat window - never an error, never a blank.
 */

type InlineOptions = { onMention?: (handle: string) => void };

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const WINDOWS_FILE = /^[a-zA-Z]:[\\/]/;

export function localFileHref(path: string): string | null {
  if (WINDOWS_FILE.test(path)) return `vscode://file/${path.replaceAll('\\', '/')}`;
  if (path.startsWith('/')) return `vscode://file${path}`;
  return null;
}

export function renderMarkdown(source: string, options: InlineOptions = {}): ReactNode {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];

  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Fenced code. Everything inside is verbatim, including characters that
    // would otherwise be emphasis or a mention.
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const language = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // closing fence
      blocks.push(
        <pre key={key++} className="md-code">
          {language && <span className="md-code-lang">{language}</span>}
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // A horizontal rule: three or more of the same marker, spaces allowed.
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]?.length ?? 1, 6);
      const Tag = `h${level + 2 > 6 ? 6 : level + 2}` as 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={key++} className={`md-heading md-h${level}`}>
          {renderInline(heading[2] ?? '', options)}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {renderMarkdown(quoted.join('\n'), options)}
        </blockquote>,
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line) && !bullet.test(line);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (index < lines.length && marker.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(marker, ''));
        index += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key++} className="md-list">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, options)}</li>
          ))}
        </List>,
      );
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other block.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim() === '' ||
        /^\s*```/.test(current) ||
        /^(#{1,6})\s+/.test(current) ||
        /^\s*>\s?/.test(current) ||
        bullet.test(current) ||
        numbered.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {renderInline(paragraph.join('\n'), options)}
      </p>,
    );
  }

  return blocks;
}

/**
 * Inline formatting. Code spans are taken first and never re-parsed, so
 * `**not bold**` inside backticks stays literal.
 */
function renderInline(text: string, options: InlineOptions): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)|((?:^|\s)@[a-zA-Z0-9][a-zA-Z0-9._-]*)/g;

  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];

    if (token.startsWith('`')) {
      nodes.push(
        <code key={key++} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key++}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link?.[2] ?? '';
      const fileHref = localFileHref(href);
      nodes.push(
        SAFE_LINK.test(href) || fileHref ? (
          <a
            key={key++}
            href={fileHref ?? href}
            className={fileHref ? 'md-file-link' : undefined}
            target="_blank"
            rel="noreferrer noopener"
          >
            {link?.[1]}
          </a>
        ) : (
          // A link that is not plainly http(s) or mailto is shown as text:
          // javascript: and data: URLs have no business in a chat message.
          <span key={key++}>{token}</span>
        ),
      );
    } else if (token.startsWith('http')) {
      nodes.push(
        <a key={key++} href={token} target="_blank" rel="noreferrer noopener">
          {token}
        </a>,
      );
    } else {
      const leading = /^\s/.test(token) ? token[0] : '';
      const handle = token.trim().slice(1);
      if (leading) nodes.push(leading);
      nodes.push(
        <button
          key={key++}
          type="button"
          className="md-mention"
          onClick={() => options.onMention?.(handle)}
          title={`Mention @${handle}`}
        >
          @{handle}
        </button>,
      );
    }
    cursor = start + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
