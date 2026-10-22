const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function app() {
  const nodes = new Map();
  const handlers = {};
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {style:{},hidden:true,value:'12',textContent:'',innerHTML:'',remove(){},
      classList:{toggle(){},add(){},remove(){}},addEventListener(){},querySelector:()=>node('child'),
      querySelectorAll:()=>[],selectedOptions:[{text:'业余'}]});
    return nodes.get(id);
  };
  const ctx = vm.createContext({
    console, AbortController, Map, localStorage:{getItem:()=>null}, window:{addEventListener(){}},
    document:{querySelector:selector=>selector==='.modal:not([hidden])' ? null : node(selector),querySelectorAll:()=>[],
      addEventListener:(event,handler)=>{handlers[event]=handler;}},
    setTimeout:(fn)=>setImmediate(fn),clearTimeout:clearImmediate,
  });
  vm.runInContext(fs.readFileSync('static/app.js','utf8').replace(/init\(\);\s*$/, ''), ctx);
  vm.runInContext(`
    renderAll = renderWorkspace = renderBoard = renderStatus = cancelDrag = clearHint = () => {};
    refreshLegal = async () => true; scheduleAnalyze = () => {};
    selectPanel = () => {}; S.badgeOn = false;
  `, ctx);
  return {ctx, run:code=>vm.runInContext(code,ctx),node,handlers};
}

test('late user and engine moves cannot modify a replacement game',async()=>{
  for (const operation of ['doUserMove("e2","e4")','maybeEngineMove(true)']) {
    const {ctx,run} = app();
    const pending = deferred(); ctx.response = pending.promise;
    run('api = () => response');
    const action = run(operation);
    await run('afterPositionChange()');
    pending.resolve({san:'e4',uci:'e2e4',fen_after:'old position',color:'w'});
    await action;
    assert.equal(run('S.history.length'),0);
    assert.equal(run('S.busy'),false);
  }
});

test('position analysis is discarded even if reset returns to identical FEN',async()=>{
  const {ctx,run} = app();
  const pending = deferred(); ctx.fetch=()=>pending.promise; ctx.rendered=[];
  run('renderLines = lines => rendered.push(lines); S.legal = [{}]');
  const action = run('runPositionAnalyze()');
  await run('afterPositionChange()');
  pending.resolve({ok:true,json:async()=>({fen:run('curFen()'),lines:[{cp_white:900}]})});
  await action;
  assert.equal(ctx.rendered.length,0);
});

test('single-PV badge requests do not poison the three-PV analysis cache',async()=>{
  const {ctx,run} = app();
  ctx.fetch=async()=>({ok:true,json:async()=>({lines:[{cp_pov:20}]})});
  run('S.badgeOn=true; S.legal=[{}]; scheduleMoveBadge("previous", "e2e4", 12)');
  await new Promise(setImmediate);
  assert.equal(run('S.evalCache.has(curFen()+"|12")'),false);
});

test('cancelled startup cancels the server job once its ID arrives',async()=>{
  const {ctx,run} = app();
  const pending = deferred(); ctx.response=pending.promise; ctx.cancelled=[];
  run(`S.history=[{uci:'e2e4'}];
    api = path => path.endsWith('analyze-job') ? response : (cancelled.push(path), Promise.resolve({}));`);
  const action = run('startGameAnalysis()');
  run('invalidateJob()');
  pending.resolve({job_id:'late',total:2});
  await action;
  assert.equal(run('S.job'),null);
  assert.deepEqual(ctx.cancelled,['/api/jobs/late/cancel']);
});

test('cancelled polling cannot merge an old report into a new game',async()=>{
  const {ctx,run} = app();
  const pending = deferred(); ctx.response=pending.promise; ctx.merged=[];
  run(`S.job={id:'old',gen:1,depth:12}; S.jobGen=1;
    api = path => path.endsWith('/cancel') ? Promise.resolve({}) : response;
    mergeAnalysis = result => merged.push(result);`);
  const action = run('pollJob("old",1)');
  await new Promise(setImmediate);
  run('invalidateJob()');
  pending.resolve({status:'done',result:{moves:[]},total:1,done:1});
  await action;
  assert.equal(ctx.merged.length,0);
});

test('arrow shortcuts still work after focusing a navigation button',()=>{
  const {ctx,run,handlers} = app();
  ctx.cursors=[];
  run('setCursor = cursor => cursors.push(cursor); S.cursor=2; bindEvents()');
  let prevented=false;
  handlers.keydown({key:'ArrowLeft',target:{tagName:'BUTTON'},preventDefault(){prevented=true;}});
  assert.deepEqual(ctx.cursors,[1]);
  assert.equal(prevented,true);
  handlers.keydown({key:'ArrowLeft',target:{tagName:'SELECT'},preventDefault(){}});
  assert.deepEqual(ctx.cursors,[1]);
});
