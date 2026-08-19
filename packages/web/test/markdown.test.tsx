import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from '../src/lib/markdown.js';

const render = (source: string): string => renderToStaticMarkup(<>{renderMarkdown(source)}</>);

describe('markdown rendering', () => {
  it('renders fenced code with its language', () => {
    const html = render('```ts\nconst x = 1;\n```');
    assert.match(html, /<pre class="md-code">/);
    assert.match(html, /md-code-lang">ts</);
    assert.match(html, /const x = 1;/);
  });

  it('does not format inside code', () => {
    // A model explaining markdown must not have its example eaten by it.
    const html = render('```\n**not bold** and @not-a-mention\n```');
    assert.match(html, /\*\*not bold\*\*/);
    assert.doesNotMatch(html, /<strong>/);
    assert.doesNotMatch(html, /md-mention/);
  });

  it('renders headings, lists and quotes', () => {
    assert.match(render('# Title'), /md-h1/);
    assert.match(render('- one\n- two'), /<ul class="md-list"><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(render('1. first\n2. second'), /<ol class="md-list">/);
    assert.match(render('> quoted'), /<blockquote class="md-quote">/);
    assert.match(render('---'), /md-hr/);
  });

  it('renders emphasis and inline code', () => {
    assert.match(render('**bold**'), /<strong>bold<\/strong>/);
    assert.match(render('*italic*'), /<em>italic<\/em>/);
    assert.match(render('~~gone~~'), /<del>gone<\/del>/);
    assert.match(render('use `npm test`'), /md-inline-code">npm test</);
  });

  it('links only to schemes that belong in a chat message', () => {
    assert.match(render('[docs](https://example.com/x)'), /<a href="https:\/\/example\.com\/x"/);
    // Anything else is shown as text rather than made clickable.
    assert.doesNotMatch(render('[click](javascript:alert(1))'), /<a /);
    assert.doesNotMatch(render('[click](data:text/html;base64,PHNjcmlwdD4=)'), /<a /);
  });

  it('never emits markup that came from the message', () => {
    // The renderer produces React elements, so there is no path from message
    // text to a tag - this asserts that property directly.
    const html = render('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<script/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('marks mentions so they stand out and can be clicked', () => {
    const html = render('@gpt take a look');
    assert.match(html, /md-mention/);
    assert.match(html, />@gpt</);
  });

  it('keeps plain text plain', () => {
    assert.match(render('just a sentence'), /<p class="md-p">just a sentence<\/p>/);
  });
});
