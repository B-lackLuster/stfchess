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

test('undo is ignored while browsing the middle of the game',()=>{
  const {run,node} = app();
  run(`S.history=[{uci:'e2e4',color:'w'},{uci:'e7e5',color:'b'},{uci:'g1f3',color:'w'}]; S.cursor=1; bindEvents()`);
  node('#btn-undo').onclick();
  assert.equal(run('S.history.length'),3);
});

test('a forced engine move in play mode lets the engine answer for its own side',async()=>{
  const {ctx,run} = app();
  ctx.replies=[
    {san:'e4',uci:'e2e4',fen_after:'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',color:'w'},
    {san:'e5',uci:'e7e5',fen_after:'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',color:'b'}];
  run(`S.vsEngine=true; S.engineSide='b'; api = async () => replies.shift()`);
  await run('maybeEngineMove(true)');
  assert.equal(run('S.history.map(m=>m.san).join()'),'e4,e5');
});

test('threefold repetition is detected from the move history',()=>{
  const {run} = app();
  const start='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const cycle=['rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1','rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2',
    'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 3 2','rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 3'];
  run(`S.initialFen=${JSON.stringify(start)}; S.history=${JSON.stringify([...cycle,...cycle].map(f=>({fenAfter:f})))}`);
  run('S.cursor=4'); assert.equal(run('isThreefold()'),false);
  run('S.cursor=8'); assert.equal(run('isThreefold()'),true);
});

test('move badge does not report stalemate before legal moves have loaded',async()=>{
  const {ctx,run} = app();
  ctx.badges=[];
  ctx.fetch=async()=>({ok:true,json:async()=>({lines:[{cp_pov:-30,depth:12,pv_uci:['e7e5']}]})});
  run(`S.badgeOn=true; S.legal=[]; showMoveBadge=(sq,cls,text)=>badges.push(sq+' '+cls+(text?' '+text:''));
    S.evalCache.set('prev|12',[{cp_pov:40,pv_uci:['e2e4']}]); scheduleMoveBadge('prev','e2e4',12)`);
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(ctx.badges,['e4 best']);
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
