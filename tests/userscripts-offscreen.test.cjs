const { test } = require('node:test'), assert = require('node:assert/strict');
require('../src/userscripts/userscripts-offscreen.js');
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), fire: value => { for(const fn of listeners) fn(value); } }; };
function fixture() {
  const state={open:false,creates:0,closes:0,connects:0,granted:true,ports:[]};
  const api={permissions:{contains:async()=>state.granted},runtime:{getURL:p=>'chrome-extension://owned/'+p,getContexts:async()=>state.open?[{}]:[],
    connect:()=>{state.connects++;const port={onMessage:event(),onDisconnect:event(),postMessage:details=>{port.details=details;},disconnect:()=>{port.onDisconnect.fire();}};state.ports.push(port);return port;}},
    offscreen:{createDocument:async()=>{if(state.failure)throw Error('creation failed');state.creates++;state.open=true;},closeDocument:async()=>{state.closes++;state.open=false;}}};
  return {state,host:BlockAdsOffscreen.create(api),api};
}
test('clipboard and uploads share one document until the last lease ends',async()=>{
  const {state,host,api}=fixture();assert.equal(BlockAdsOffscreen.create(api),host);
  const [clipboard,upload]=await Promise.all([host.acquire(),host.acquire()]);
  assert.equal(state.creates,1);await clipboard();assert.equal(state.open,true);await clipboard();assert.equal(state.closes,0);
  await upload();assert.equal(state.open,false);assert.equal(state.closes,1);
  const later=await host.acquire();assert.equal(state.creates,2);await later();
});
test('failed helper creation and permission denial preserve capacity for retry',async()=>{
  const {state,host}=fixture();state.failure=true;await assert.rejects(host.acquire(),/creation failed/);
  state.failure=false;state.granted=false;await assert.rejects(host.acquire(),/helper access/);
  state.granted=true;const release=await host.acquire();await release();assert.equal(state.creates,1);assert.equal(state.closes,1);
});
test('helper connection loss and cancellation settle once without replaying accepted uploads',async()=>{
  const {state,host}=fixture();const controller=new AbortController(),events=[];
  const promise=host.xhr({url:'http://127.0.0.1/owned'},controller.signal,e=>events.push(e));
  for(let i=0;i<10&&!state.ports.length;i++)await new Promise(r=>setImmediate(r));
  state.ports[0].onMessage.fire({event:'progress',upload:true,loaded:1});controller.abort();
  await assert.rejects(promise);assert.equal(events.length,1);assert.equal(state.connects,1);assert.equal(state.open,false);
  const next=host.xhr({},new AbortController().signal,()=>{});
  for(let i=0;i<10&&state.ports.length<2;i++)await new Promise(r=>setImmediate(r));
  state.ports[1].onDisconnect.fire();await assert.rejects(next,/not retried/);assert.equal(state.connects,2);assert.equal(state.open,false);
});
