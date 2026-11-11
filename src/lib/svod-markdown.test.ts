import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SvodMarkdown from "../components/SvodMarkdown";
import { MARKDOWN_HELP_EXAMPLES } from "./svod-markdown";

const render = (body: string) => renderToStaticMarkup(h(SvodMarkdown, { body }));

test("exact XSS payload is inert: handler stripped, no img executes", () => {
  const payload = '<img src=x onerror="globalThis.svodMdProbe=1;void \'<x>\'">';
  const html = render(payload);
  // No live element and no live handler: raw HTML is escaped text, not a tag.
  assert.doesNotMatch(html, /<\s*img/i);
  assert.doesNotMatch(html, /<[^>]*\sonerror\s*=/i);
  assert.match(html, /&lt;img/);
});

test("headings, lists, tables, links, inline and fenced code render", () => {
  const html = render(
    `# Title\n\n- one\n- two\n\n[Docs](https://example.com/x)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nInline \`code\` here.\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n`,
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul>[\s\S]*<li>one<\/li>/);
  assert.match(html, /<table>[\s\S]*<th>A<\/th>/);
  assert.match(html, /<a href="https:\/\/example\.com\/x"[^>]*>Docs<\/a>/);
  assert.match(html, /<code>code<\/code>/);
});

test("fenced blocks carry real highlight markup", () => {
  const html = render("```csharp\nvar btn = new Button();\n```\n");
  assert.match(html, /language-csharp/);
  assert.match(html, /hljs/);
  assert.match(html, /hljs-keyword|hljs-type|hljs-title/);
});

test("unsafe links neutralise to text: javascript: and data: never survive", () => {
  const html = render(
    `[click](javascript:alert(1))\n\n[img](data:text/html,<script>alert(1)</script>)\n\n[ok](https://example.com)`,
  );
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /data:text\/html/i);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test("relative file links preserved, unsafe schemes blocked", () => {
  const html = render(
    `[guide](guide.md)\n\n[part](../guide.md#part)\n\n[evil](vbscript:msgbox(1))\n`,
  );
  assert.match(html, /href="guide\.md"/);
  assert.match(html, /href="\.\.\/guide\.md#part"/);
  assert.doesNotMatch(html, /vbscript:/i);
  // Blocked links render as text, not anchors.
  assert.doesNotMatch(html, /<a[^>]*>evil<\/a>/);
});

test("remote images never load: inert label instead of img", () => {
  const html = render(`![evil](https://evil.test/x.png)`);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /evil\.test\/x\.png/);
});

test("full body readable: no silent truncation of long notes", () => {
  const tail = "TAIL-MARKER-9f8c2e";
  const body = `${"# T\n\n"}${"lorem ipsum dolor sit amet ".repeat(9000)}\n\n${tail}\n`;
  assert.ok(body.length > 210_000);
  const html = render(body);
  assert.match(html, new RegExp(tail));
});

test("syntax help keeps the 5 spec examples", () => {
  const titles = MARKDOWN_HELP_EXAMPLES.map((e) => e.title);
  for (const want of ["Heading", "List", "Link", "Table", "Code"]) {
    assert.ok(titles.includes(want), `missing ${want}`);
  }
});
