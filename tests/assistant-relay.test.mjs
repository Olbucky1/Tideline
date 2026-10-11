import fs from 'node:fs';
import assert from 'node:assert/strict';
const code=fs.readFileSync('tools/assistant-relay/worker.js','utf8');
const {default:worker,validAction}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const action={action:'weather',layer:'rain',visible:true,destination:'',scope:'all',message:''};
assert(validAction(action));assert(!validAction({...action,action:'disable_alarms'}));assert(!validAction({...action,layer:'imaginary'}));
const env={OPENAI_API_KEY:'test-private',OPENAI_MODEL:'test',SUPABASE_URL:'https://auth.example',SUPABASE_ANON_KEY:'test',ALLOWED_USER_IDS:'andy',ASSISTANT_LIMITER:{limit:async()=>({success:true})}};
function req(origin='https://olbucky1.github.io',token='session'){return new Request('https://worker.example',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token},body:JSON.stringify({request:'Could you put the rain on the map?',context:{hasGps:true}})})}
let calls=0;
globalThis.fetch=async(url,opts)=>{calls++;if(url.includes('/auth/v1/user'))return Response.json({id:'andy'});const body=JSON.parse(opts.body);assert.equal(body.store,false);assert.equal(body.tools[0].strict,true);assert.equal(body.parallel_tool_calls,false);return Response.json({output:[{type:'function_call',name:'tideline_action',arguments:JSON.stringify(action)}]})};
assert.equal((await worker.fetch(req('https://olbucky1.github.io.attacker.example'),env)).status,403);assert.equal(calls,0);
assert.equal((await worker.fetch(req(),{})).status,503);assert.equal(calls,0);
const response=await worker.fetch(req(),env);assert.equal(response.status,200);assert.deepEqual(await response.json(),action);
assert.equal((await worker.fetch(req(),{...env,ALLOWED_USER_IDS:'someone-else'})).status,403);
assert.equal((await worker.fetch(req(),{...env,ASSISTANT_LIMITER:{limit:async()=>({success:false})}})).status,429);
console.log('PASS: exact-origin protection, backend setup gate, user authorization, rate limit, schema whitelist and mocked function-call response.');
