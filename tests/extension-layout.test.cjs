/* Verify the packaged filesystem, not a second hand-maintained path list. */
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const acorn = require('../vendor/acorn/acorn.js');
const { files } = require('../scripts/extension-files.cjs');
const root = path.resolve(__dirname, '..'), packaged = new Set(files);
const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
function resource(value, from = 'manifest.json') {
  if (!value || /^(?:[a-z]+:|#)/i.test(value)) return;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from),value.split(/[?#]/)[0]));
  assert.ok(!relative.startsWith('../') && !path.posix.isAbsolute(relative), from+' escapes package: '+value);
  assert.ok(packaged.has(relative), from+' references missing package file: '+value);
}
test('the shared inventory includes runtime files and excludes local tooling and transient files', () => {
  assert.equal(packaged.size,files.length);
  assert.ok(files.length>50);
  for(const file of files){assert.ok(fs.statSync(path.join(root,file)).isFile());assert.ok(!/^(tests|development|mcp|\.artifacts)\//.test(file));assert.ok(!/(^|\/)\./.test(file));}
  assert.deepEqual(fs.readdirSync(root).filter(name=>/\.(js|html|css)$/.test(name)),[]);
});
test('all manifest entry points and bundled rules resolve inside the package', () => {
  resource(manifest.background.service_worker);manifest.background.scripts.forEach(file=>resource(file));
  resource(manifest.action.default_popup);resource(manifest.options_ui.page);
  for(const icon of Object.values(manifest.icons))resource(icon);
  for(const entry of manifest.content_scripts)for(const file of [...entry.js,...(entry.css||[])])resource(file);
  for(const rule of manifest.declarative_net_request.rule_resources)resource(rule.path);
});
test('HTML scripts, styles, icons and navigation links resolve relative to their own page', () => {
  for(const file of files.filter(file=>file.endsWith('.html'))){const text=fs.readFileSync(path.join(root,file),'utf8');
    for(const match of text.matchAll(/\b(?:src|href)=(['"])(.*?)\1/g))resource(match[2],file);
  }
});
test('static worker imports, extension URLs, offscreen documents and injected scripts resolve correctly', () => {
  let loaders=0;
  for(const file of files.filter(file=>file.startsWith('src/')&&file.endsWith('.js'))){const ast=acorn.parse(fs.readFileSync(path.join(root,file),'utf8'),{ecmaVersion:'latest'});
    function walk(node){if(!node||typeof node!=='object')return;
      if((node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='importScripts')||(node.type==='NewExpression'&&node.callee.name==='Worker')){
        for(const arg of node.arguments)if(arg.type==='Literal'){resource(arg.value,file);loaders++;}
      }
      if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&node.callee.property.name==='getURL'&&typeof node.arguments[0]?.value==='string')resource(node.arguments[0].value);
      if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&['createDocument','executeScript'].includes(node.callee.property.name)){
        const options=node.arguments[0];for(const property of options?.properties||[]){const key=property.key.name||property.key.value;
          if(key==='url'&&typeof property.value.value==='string')resource(property.value.value);
          if(key==='files'&&property.value.type==='ArrayExpression')for(const item of property.value.elements)resource(item.value);
        }
      }
      for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}
    }walk(ast);
  }
  assert.ok(loaders>=20);
});
