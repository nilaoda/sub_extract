import {chromium} from 'playwright';import {pathToFileURL} from 'node:url';import{resolve}from'node:path';import assert from'node:assert/strict';import{writeFile}from'node:fs/promises';
const b=await chromium.launch({channel:'chrome',headless:true});const c=await b.newContext();const p=await c.newPage();
const errors=[],requests=[];p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(/^http/.test(r.url()))requests.push(r.url());});p.on('console',m=>{if(m.type()==='error'&&!m.text().includes('[W:'))console.log('CONSOLE',m.text().slice(0,1000));});
try{
await p.goto(pathToFileURL(resolve('dist/sub-extract.html')).href);await p.locator('#backend').selectOption('wasm');await p.locator('#load-online').click();
let timer=setInterval(async()=>{try{console.log(await p.locator('#model-status').textContent());}catch{}},5000);
try{await p.waitForFunction(()=>document.querySelector('#cancel')?.hidden===true,null,{timeout:150000});}finally{clearInterval(timer);}
let status=await p.locator('#model-status').textContent();console.log('ONLINE',status);assert.match(status,/模型已就绪/);assert(requests.some(u=>u.includes('huggingface.co')));assert.equal(await p.locator('#load-online').textContent(),'模型已就绪');assert(await p.locator('#load-online').isDisabled());
await p.locator('#video-file').setInputFiles(process.env.TEST_VIDEO || '.local-test/sample-603-645.mp4');await p.waitForFunction(()=>document.querySelector('video')?.duration>1);
await p.locator('video').evaluate(async v=>{v.currentTime=3;await new Promise(r=>v.addEventListener('seeked',r,{once:true}));});await p.locator('#test-frame').click();await p.waitForFunction(()=>document.querySelector('#test-frame')?.disabled===false,null,{timeout:30000});assert.match(await p.locator('#frame-text').textContent(),/律令直解/);
const frame=await p.locator('#frame-result').textContent();
await c.setOffline(true);requests.length=0;await p.reload();await p.waitForFunction(()=>document.querySelector('#load-online')?.textContent==='模型已就绪',null,{timeout:60000});status=await p.locator('#model-status').textContent();console.log('CACHED OFFLINE',status);assert.match(status,/模型已就绪/);assert.equal(requests.length,0);assert.equal(errors.length,0);assert.equal(await p.locator('#load-online').textContent(),'模型已就绪');await p.locator('#clear-cache').click();await p.waitForFunction(()=>document.querySelector('#toast')?.textContent==='在线模型缓存已清除。');assert.equal(await p.locator('#load-online').textContent(),'模型已就绪');await p.locator('#backend').selectOption('auto');assert.equal(await p.locator('#load-online').textContent(),'下载并加载模型');
await writeFile('.local-test/online-report.json',JSON.stringify({online:true,cachedOffline:true,backend:'wasm',frame,status},null,2));
}finally{await b.close();}
