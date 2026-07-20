#!/usr/bin/env node
/**
 * Generates the Markdown twin of every static page in site/.
 *
 * Why: agents increasingly ask for `Accept: text/markdown` (Cloudflare's
 * "Markdown for Agents"), and handing a model 22 KB of HTML chrome to extract
 * 6 KB of prose wastes its context and ours. nginx serves `index.md` next to
 * `index.html` when the request asks for it — see the vhost's `$md_suffix`.
 *
 * The output is committed, not built on the server: the site deploy stays a
 * `git pull` with no build step and no restart, which is the property that
 * makes it hard to break. Run this whenever a page changes:
 *
 *   node scripts/generate-site-markdown.mjs        # write
 *   node scripts/generate-site-markdown.mjs --check  # CI: fail if stale
 *
 * Only `<main>` is converted. Nav, header and footer are chrome that repeats
 * on every page — exactly the noise an agent asked for markdown to avoid.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import TurndownService from 'turndown';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const CHECK = process.argv.includes('--check');

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});

// Tables are the one construct turndown drops by default, and the comparison
// pages are mostly tables — losing them would gut the pages worth citing.
turndown.addRule('table', {
  filter: 'table',
  replacement: (_content, node) => {
    // getElementsByTagName, not querySelectorAll: turndown parses with domino
    // and the node handed to a rule does not carry the selector API.
    const rows = Array.from(node.getElementsByTagName('tr'));
    if (rows.length === 0) return '';
    const cells = (tr) =>
      Array.from(tr.childNodes)
        .filter((n) => n.nodeName === 'TD' || n.nodeName === 'TH')
        .map((td) => turndown.turndown(td.innerHTML).replace(/\n+/g, ' ').trim());
    const [head, ...body] = rows;
    const header = cells(head);
    return [
      `\n| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...body.map((tr) => `| ${cells(tr).join(' | ')} |`),
      '\n',
    ].join('\n');
  },
});

// Breadcrumbs are navigation, not content.
turndown.addRule('crumbs', {
  filter: (node) => node.nodeName === 'P' && node.className === 'crumbs',
  replacement: () => '',
});

async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(path)));
    else if (entry.name.endsWith('.html')) out.push(path);
  }
  return out;
}

function extractMain(html) {
  const start = html.indexOf('<main');
  if (start === -1) return null;
  const open = html.indexOf('>', start) + 1;
  const end = html.lastIndexOf('</main>');
  return end > open ? html.slice(open, end) : null;
}

function canonicalOf(html) {
  return html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)?.[1] ?? null;
}

const files = await htmlFiles(SITE);
let written = 0;
const stale = [];

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const main = extractMain(html);
  if (!main) {
    console.warn(`skip (no <main>): ${relative(ROOT, file)}`);
    continue;
  }

  const canonical = canonicalOf(html);
  const body = turndown.turndown(main).replace(/\n{3,}/g, '\n\n').trim();
  // The canonical URL is the one piece of the <head> an agent still needs:
  // it is what it cites once the chrome is gone.
  const markdown = `${canonical ? `<!-- ${canonical} -->\n\n` : ''}${body}\n`;

  const target = file.replace(/\.html$/, '.md');
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current === markdown) continue;

  if (CHECK) stale.push(relative(ROOT, target));
  else {
    writeFileSync(target, markdown);
    written++;
  }
}

if (CHECK) {
  if (stale.length) {
    console.error(`Markdown twins are stale:\n${stale.map((f) => `  ${f}`).join('\n')}`);
    console.error('\nRun: node scripts/generate-site-markdown.mjs');
    process.exit(1);
  }
  console.log(`${files.length} pages checked, all markdown twins up to date.`);
} else {
  console.log(`${files.length} pages scanned, ${written} markdown twin(s) written.`);
}
