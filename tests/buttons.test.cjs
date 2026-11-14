const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({URL});
vm.runInContext(fs.readFileSync(require.resolve('../src/blocking/buttons.js'), 'utf8'), context);
const {actionKind,installerDestination,reasonFor,create} = context.BlockAdsButtons;

test('button labels recognize bounded actions without treating prose or unrelated controls as commands', () => {
  for (const value of ['Play','Play video','Watch movie','Click to play now','▶️','▶ Play video']) assert.equal(actionKind(value),'play',value);
  for (const value of ['Download','Download for Windows','Download file','Start download','Free download']) assert.equal(actionKind(value),'download',value);
  for (const value of ['',null,42,'Replay','Play settings','How to download safely','Downloadable files','Downloads','Install extension','Play ' + 'x'.repeat(200)] ) assert.equal(actionKind(value),'',String(value));
});

test('installer evidence uses the actual path or declared filename, not misleading queries or archive names', () => {
  const base='https://local.example/video/';
  for (const href of ['../player.EXE?name=movie.mp4','/plugin.xpi#video','/p%2Emsi','/launch.ps1','/phone.apk']) assert.equal(installerDestination(href,base),true,href);
  for (const href of ['/movie.mp4?name=player.exe','/media.webm','/archive.zip','/p.exe/stream','/invalid%xx.exe','javascript:player.exe','https://player.exe/watch','/'+'x'.repeat(4100)+'.exe']) assert.equal(installerDestination(href,base),false,href);
  assert.equal(installerDestination('blob:https://local.example/123',base,'player.exe'),true);
  assert.equal(installerDestination('data:application/octet-stream,local',base,'player.msi'),true);
  assert.equal(installerDestination('javascript:run()',base,'player.exe'),false);
  assert.equal(installerDestination('/movie.mp4',base,'x'.repeat(257)),false);
});

test('strong signals combine conservatively; legitimate software downloads and third-party links alone stay allowed', () => {
  assert.equal(reasonFor({kind:'download',ad:true}),'ad-button');
  assert.equal(reasonFor({kind:'play',installer:true}),'play-installer');
  assert.equal(reasonFor({external:true,overPlayer:true}),'player-overlay');
  for (const input of [{kind:'play'}, {kind:'download',external:true}, {kind:'download',installer:true},
    {ad:true}, {kind:'download',overPlayer:true,external:false}, {kind:'play',external:true}]) assert.equal(reasonFor(input),'');
});

test('disabled, cleared and invalidated documents do not inspect clicks; re-enabling retains capture order', () => {
  const callbacks=new Map(), problems=[];
  let alive=true, inspections=0;
  const guard=create({document:{defaultView:{addEventListener(type,fn,options){assert.equal(options.capture,true);callbacks.set(type,fn);}}},isAlive:()=>alive,onProblem:error=>problems.push(error.message)});
  const click={type:'click',button:0,composedPath(){inspections++;return [];}};
  callbacks.get('click')(click);assert.equal(inspections,0);
  guard.setEnabled(true);callbacks.get('click')(click);assert.equal(inspections,1);
  guard.clear();callbacks.get('click')(click);assert.equal(inspections,1);
  guard.setEnabled(true);callbacks.get('click')(click);assert.equal(inspections,2);
  alive=false;callbacks.get('click')(click);assert.equal(inspections,2);
  alive=true;callbacks.get('click')(click);assert.equal(inspections,2);
  guard.setEnabled(true);
  callbacks.get('keydown')({type:'keydown',key:'Tab',composedPath:()=>{throw Error('unexpected Tab inspection');}});
  callbacks.get('click')({...click,button:2});assert.equal(inspections,2);
  callbacks.get('click')({...click,composedPath(){throw Error('fixture failure');}});
  guard.setEnabled(true);callbacks.get('click')(click);assert.equal(inspections,2);
  assert.deepEqual(problems,['fixture failure']);assert.equal(callbacks.size,11);
});

test('button capture is packaged at document start in all frames with its hostname dependency and no extra permission', () => {
  const manifest=JSON.parse(fs.readFileSync(require.resolve('../manifest.json'),'utf8'));
  const entry=manifest.content_scripts.find(entry=>entry.js.includes('src/blocking/content.js'));
  assert.equal(entry.run_at,'document_start');assert.equal(entry.all_frames,true);
  assert.ok(entry.js.indexOf('src/shared/shared.js')<entry.js.indexOf('src/blocking/buttons.js'));
  assert.ok(entry.js.indexOf('src/blocking/buttons.js')<entry.js.indexOf('src/blocking/content.js'));
  assert.equal(manifest.permissions.includes('downloads'),false);
});
