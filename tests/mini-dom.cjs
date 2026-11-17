/* Minimal offline DOM for unit tests of isolated-world page logic. It supports
 * compound selectors and selector lists (no combinators), tree walking, inline
 * styles over per-element "stylesheet" values, and rectangles. Browser suites
 * remain the authority for layout and cascade behavior. */
'use strict';
const camel = property => property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
function parseCompound(text) {
  const parts = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let match = /^([a-zA-Z][\w-]*|\*)?/.exec(text);
  if (match[1] && match[1] !== '*') parts.tag = match[1].toLowerCase();
  let rest = text.slice(match[0].length);
  while (rest) {
    if ((match = /^#([\w-]+)/.exec(rest))) parts.id = match[1];
    else if ((match = /^\.([\w-]+)/.exec(rest))) parts.classes.push(match[1]);
    else if ((match = /^\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]/.exec(rest))) parts.attrs.push({ name: match[1], op: match[2], value: match[3] });
    else if ((match = /^:([\w-]+)/.exec(rest))) parts.pseudos.push(match[1]);
    else throw new Error('mini-dom selector unsupported: ' + text);
    rest = rest.slice(match[0].length);
  }
  return parts;
}
function matchesCompound(element, parts) {
  if (parts.tag && element.localName !== parts.tag) return false;
  if (parts.id && element.getAttribute('id') !== parts.id) return false;
  for (const name of parts.classes) if (!element.classList.contains(name)) return false;
  for (const { name, op, value } of parts.attrs) {
    if (!element.hasAttribute(name)) return false;
    const actual = element.getAttribute(name);
    if (op === '=' && actual !== value || op === '*=' && !actual.includes(value) || op === '^=' && !actual.startsWith(value)) return false;
  }
  for (const pseudo of parts.pseudos) {
    if (!['modal', 'popover-open'].includes(pseudo)) throw new Error('mini-dom pseudo-class unsupported: ' + pseudo);
    if (!element['_' + pseudo]) return false;
  }
  return true;
}
const compiled = new Map();
function compile(selector) {
  if (!compiled.has(selector)) compiled.set(selector, selector.split(',').map(item => item.trim()).map(item => {
    if (/[\s>+~]/.test(item)) throw new Error('mini-dom combinators unsupported: ' + item);
    return parseCompound(item);
  }));
  return compiled.get(selector);
}
class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { return this.getRootNode() === this.ownerDocument; }
  getRootNode() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
  contains(other) { for (let node = other; node; node = node.parentNode) if (node === this) return true; return false; }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.childNodes = []; if (value) this.append(String(value)); }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === 'string') node = this.ownerDocument.createTextNode(node);
      node.remove(); node.parentNode = this; this.childNodes.push(node);
    }
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  *descendants() { for (const child of this.childNodes) { yield child; yield* child.descendants(); } }
  querySelectorAll(selector) { const parts = compile(selector); return [...this.descendants()].filter(node => node.nodeType === 1 && parts.some(part => matchesCompound(node, part))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = data; }
  get textContent() { return this.data; }
}
class Style {
  constructor() { this.map = new Map(); }
  getPropertyValue(property) { return this.map.get(property)?.value || ''; }
  getPropertyPriority(property) { return this.map.get(property)?.priority || ''; }
  setProperty(property, value, priority = '') { this.map.set(property, { value, priority }); }
  removeProperty(property) { this.map.delete(property); }
}
class Element extends Node {
  constructor(doc, tag) {
    super(doc); this.nodeType = 1; this.localName = tag; this.attributes = new Map(); this.style = new Style();
    this.rect = { x: 0, y: 0, width: 100, height: 30 }; this.stylesheet = {}; this.shadowRoot = null;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  get id() { return this.getAttribute('id') || ''; }
  attachShadow() { return this.shadowRoot = { append() {} }; }
  get classList() { const list = (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); return { contains: name => list.includes(name) }; }
  matches(selector) { return compile(selector).some(part => matchesCompound(this, part)); }
  closest(selector) { for (let node = this; node?.nodeType === 1; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  get value() { return this.getAttribute('value') || ''; }
  getBoundingClientRect() { const { x, y, width, height } = this.rect; return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }; }
  getClientRects() { return this.rect.width || this.rect.height ? [this.rect] : []; }
  get previousElementSibling() { const siblings = this.parentNode?.children || []; return siblings[siblings.indexOf(this) - 1] || null; }
  get nextElementSibling() { const siblings = this.parentNode?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
  get open() { return this.hasAttribute('open'); }
}
class Document extends Node {
  constructor() {
    super(null); this.ownerDocument = this; this.nodeType = 9;
    this.documentElement = this.createElement('html'); this.append(this.documentElement);
    this.head = this.createElement('head'); this.body = this.createElement('body');
    this.documentElement.append(this.head, this.body);
    this.location = { hostname: 'page.example', href: 'https://page.example/' }; this.baseURI = this.location.href;
    this.hits = []; // elementsFromPoint result, topmost first
    this.defaultView = {
      innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0, scrollTo() {}, setTimeout: () => 0, clearTimeout() {},
      // Listeners by type, for tests that dispatch synthetic events themselves.
      listeners: new Map(), addEventListener(type, listener) { this.listeners.set(type, [...this.listeners.get(type) || [], listener]); },
      // An element's own sheet values, overridden by its inline style, as in the cascade.
      getComputedStyle: element => {
        const values = { display: 'block', visibility: 'visible', position: 'static', pointerEvents: 'auto', touchAction: 'auto',
          overflowX: 'visible', overflowY: 'visible', top: 'auto', ...element.stylesheet };
        for (const [property, { value }] of element.style.map) values[camel(property)] = value;
        return { ...values, getPropertyValue: property => values[camel(property)] ?? '' };
      }
    };
  }
  get isConnected() { return true; }
  createElement(tag) { return new Element(this, tag); }
  elementsFromPoint() { return this.hits; }
  createTextNode(data) { return new Text(this, data); }
  createTreeWalker(root, filter) {
    // NodeFilter.SHOW_ELEMENT (1) and SHOW_TEXT (4).
    const nodes = [...root.descendants()].filter(node => filter & 1 && node.nodeType === 1 || filter & 4 && node.nodeType === 3);
    let index = 0; return { nextNode: () => nodes[index++] || null };
  }
}
function h(doc, tag, options = {}, ...children) {
  const element = doc.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'rect' || key === 'stylesheet') element[key] = value;
    else element.setAttribute(key, value);
  }
  element.append(...children); return element;
}
module.exports = { Document, h };
