const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const src=fs.readFileSync('app.js','utf8');let message='',weather=null,tab=null;
const result={innerHTML:''};
const c={FM:{view:1},S:{fleet:{active:1},fix:{lat:39,lon:-76},lastFixAt:Date.now(),sog:6,cog:0,spots:[]},ais:new Map(),$:id=>id==='firstMateResults'?result:null,Date,Math,Number,esc:String,firstMateMessage:x=>message=x,setTab:x=>tab=x,setWxL:(k,on)=>weather=[k,on],toast(){},WX:{},RT:{pts:[]},renderWxBar(){},openAisList(){},suggestPlaces:async()=>[{name:'Baltimore Harbor',sub:'Maryland',lat:39.28,lon:-76.6,d:20}],searchCenter:()=>({lat:39,lon:-76}),distNm:()=>1,bearing:()=>0,fmtDist:()=> '1 nm'};
vm.createContext(c);
vm.runInContext(src.slice(src.indexOf('function firstMateAheadTargets()'),src.indexOf('async function askFirstMate()')),c);
(async()=>{
await c.firstMateExecute({action:'weather',layer:'rain',visible:true});assert.deepEqual(weather,['rain',true]);assert.equal(tab,'chart');
await assert.rejects(()=>c.firstMateExecute({action:'disable_alarms'}));
await c.firstMateExecute({action:'navigate',destination:'Baltimore'});assert(result.innerHTML.includes('Baltimore Harbor'));assert.equal(c.S.goto,undefined);assert(message.includes('has not started'));
c.S.sog=0;assert.equal(c.firstMateAheadTargets(),null);c.S.sog=6;
c.ais.set('old',{id:'old',seen:Date.now()-200000});c.ais.set('fresh',{id:'fresh',seen:Date.now(),len:150});assert.equal(c.firstMateAheadTargets().length,1);
assert.equal(c.firstMateSpotDistance({lat:39.5,lon:-76},{lat:39,lon:-76},{lat:40,lon:-76}),0);
assert(c.firstMateSpotDistance({lat:39.5,lon:-75},{lat:39,lon:-76},{lat:40,lon:-76})>1);
await c.firstMateExecute({action:'fishing',scope:'along_route'});assert(message.includes('Plan or select a route first'));
console.log('PASS: weather action, rejected alarm operation, navigation preview without activation, stale/stationary AIS handling and route corridor geometry.');
})().catch(e=>{console.error(e);process.exitCode=1});
