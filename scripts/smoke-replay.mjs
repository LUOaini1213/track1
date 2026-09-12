#!/usr/bin/env node
// Exercise the shipped replay entrypoint through HTTP, without model credentials.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROTECTED_FIXTURE_SECRET} from '../apps/server/dist/policy.js';
const cwd=fileURLToPath(new URL('../apps/server',import.meta.url));
const base=path.resolve(tmpdir());
const root=await mkdtemp(path.join(base,'launchpad-http-replay-'));
const port=3988;
const child=spawn(process.execPath,['dist/replay-dev.js'],{cwd,env:{...process.env,
  HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production',LOG_LEVEL:'silent',
  APP_DATA_DIR:path.join(root,'data'),AGENT_WORKSPACE_ROOT:path.join(root,'workspaces'),
  CODEX_HOME:path.join(root,'codex'),APP_AUTH_TOKEN:'',ARK_API_KEY:'',ARK_MODEL:'',REPLAY_SPEED:'1000'},
  stdio:['ignore','pipe','pipe']});
let log=''; child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(endpoint,body){
  const response=await fetch(`http://127.0.0.1:${port}${endpoint}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json();
  assert(response.ok,JSON.stringify(value));return value;
}
try{
  let healthy=false;
  for(let i=0;i<100;i++){
    assert.equal(child.exitCode,null,'server exited before startup');
    try{healthy=(await request('/api/health')).ok}catch{}
    if(healthy)break;await wait(100);
  }
  assert(healthy,'replay server did not start');
  const {agent}=await request('/api/agents',{name:'Replay verification'});
  await request(`/api/agents/${agent.id}/start`,{});
  for(const [content,expected] of [['Build a hello CLI','completed'],['Fix the failing test','failed'],['Inspect configuration files','failed']]){
    const started=await request(`/api/agents/${agent.id}/messages`,{content});
    let run=started.run;
    for(let i=0;i<200&&['queued','running'].includes(run.status);i++){
      await wait(50);run=(await request(`/api/runs/${run.id}`)).run;
    }
    assert.equal(run.status,expected,`${content}: ${JSON.stringify(run)}`);
    const trace=await request(`/api/runs/${run.id}/trace`);
    assert(trace.spans.length>0,'no trace spans');
    assert(!JSON.stringify(trace).includes(PROTECTED_FIXTURE_SECRET),'fixture secret leaked');
    console.log(`replay HTTP: ${expected}, ${trace.spans.length} spans, ${content}`);
  }
}catch(error){
  console.error(log.trim().split('\n').slice(-10).join('\n'));
  throw error;
}finally{
  if(child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
  const relative=path.relative(base,path.resolve(root));
  assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'unsafe cleanup target');
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
