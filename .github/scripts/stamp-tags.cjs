#!/usr/bin/env node
// Stamps the assembled site's cache tags from the files' contents, so that a
// deploy needs no hand-bumped tag: assemble-site.sh runs it on _site/. The
// source's tags stay as they are, so a local preview needs the browser cache
// off.
//
// Every tag becomes the first 8 hex digits of a sha256:
//   ?v= in index.html (src, href, data-worker): the file's own sha256. The
//       employee model's two scripts share one tag, over its glue, .wasm and
//       loader (`sha256sum` of the three, hashed again): js/employee-model.js
//       passes its tag on to the .wasm, and the page passes it to the planner
//       worker as model=.
//   ?w= on a worker's URL in js/: the worker and the scripts its
//       importScripts calls name, hashed like the model's. The worker loads
//       them with its own query.
// The ?w= tags go first, so the tag of the script that holds them covers
// the stamped text. A ?v= or ?w= tag this can't stamp stops it.
//
// Usage: node .github/scripts/stamp-tags.cjs <site directory>
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODEL = ['js/wasm/employee_model.js', 'js/wasm/employee_model_bg.wasm', 'js/employee-model.js'];
const SHARED = { 'js/wasm/employee_model.js': MODEL, 'js/employee-model.js': MODEL };

function fail(message) {
  console.error(`stamp-tags: ${message}`);
  process.exit(1);
}

const [site, ...extra] = process.argv.slice(2);
if (!site || extra.length) fail('takes one argument, the site directory.');

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function read(rel, from) {
  const file = path.join(site, rel);
  if (!fs.existsSync(file)) fail(`${from} names ${rel}, which isn't in ${site}.`);
  return fs.readFileSync(file);
}
// One file: its sha256. Several: the sha256 of their `sha256sum` lines.
function tagOf(files, from) {
  const digest = files.length === 1 ? sha256(read(files[0], from))
    : sha256(files.map(f => `${sha256(read(f, from))}  ${f}\n`).join(''));
  return digest.slice(0, 8);
}

// Replaces every match of `url` (flags dg, the tag's text in the group
// `tag`) by stamp(its groups), and stops at a tag that no match covers:
// `any` matches where every tag starts.
function stampAll(text, rel, url, any, where, stamp) {
  const covered = new Set();
  for (const m of text.matchAll(url)) covered.add(m.indices.groups.tag[0]);
  for (const m of text.matchAll(any)) {
    if (!covered.has(m.index)) fail(`${rel}:${text.slice(0, m.index).split('\n').length} has a tag outside ${where}.`);
  }
  return { text: text.replace(url, (...args) => stamp(args.at(-1))), count: covered.size };
}

// The scripts named in a worker's importScripts calls, as quoted strings.
function importsOf(worker, from) {
  const text = read(worker, from).toString('utf8');
  const names = [];
  for (const m of text.matchAll(/\bimportScripts\(/g)) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    for (const s of text.slice(m.index, i).matchAll(/(['"])([\w./-]+\.js)\1/g)) names.push(s[2]);
  }
  if (!names.length) fail(`${worker}, loaded with ?w= in ${from}, names no script in an importScripts call.`);
  return names.map(n => path.posix.join(path.posix.dirname(worker), n));
}

// --- ?w= worker tags in js/ ---
let workerTags = 0;
for (const name of fs.readdirSync(path.join(site, 'js')).filter(f => f.endsWith('.js')).sort()) {
  const rel = `js/${name}`, file = path.join(site, rel);
  const { text, count } = stampAll(fs.readFileSync(file, 'utf8'), rel,
    /(?<q>['"`])(?<worker>js\/[\w./-]+\.js)\?w=(?<tag>[\w.-]*)\k<q>/dg, /(?<=\?w=)[\w.-]/g, "a quoted 'js/….js?w=…' URL",
    ({ q, worker }) => `${q}${worker}?w=${tagOf([worker, ...importsOf(worker, rel)], rel)}${q}`);
  if (count) fs.writeFileSync(file, text);
  workerTags += count;
}

// --- ?v= tags in index.html ---
const page = path.join(site, 'index.html');
const { text, count: pageTags } = stampAll(fs.readFileSync(page, 'utf8'), 'index.html',
  /\b(?<attr>src|href|data-worker)="(?<url>[^"?#]+)\?v=(?<tag>[\w.-]*)"/dg, /(?<=\?v=)/g, 'src="…?v=…", href or data-worker',
  ({ attr, url }) => `${attr}="${url}?v=${tagOf(SHARED[url] || [url], 'index.html')}"`);
fs.writeFileSync(page, text);

console.log(`stamp-tags: ${pageTags} ?v= tags in index.html, ${workerTags} ?w= worker tags in js/`);
