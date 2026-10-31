import sys, os, json
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import serve, load_snapshot
APP = sys.argv[2] if len(sys.argv) > 2 else '.'; SNAP = sys.argv[1]
import random; PORT = random.randint(20000, 40000); srv = serve(APP, PORT); ok = 0; fail = 0
def check(name, cond, info=''):
    global ok, fail
    if cond: ok += 1; print('PASS', name)
    else: fail += 1; print('FAIL', name, info)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 844})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    load_snapshot(pg, f'http://127.0.0.1:{PORT}/index.html', SNAP)
    check('version', pg.evaluate('APP_VERSION') >= 'v30.248')
    # 1 parity: ldScan vs buildFreshRackScan ledger (converted != null)
    r = pg.evaluate("""() => {
      const ids = standardGamePool().map(g=>g.GameID);
      const L = buildFreshRackScan(ids).ledger.filter(e=>e.converted!==null);
      const D = ldScan();
      const A = {}; db.attempts.forEach(a=>A[a.AttemptID]=a);
      const key = e => e.attemptID;
      const m = {}; D.events.forEach(e=>{});
      // rebuild attemptID per event isn't stored; compare counts per leave key and conversions
      const lib = {}; L.forEach(e => { const lv = ldFindLeave(new Set(e.pins), e.leaveID); const k=lv.LeaveID; lib[k]=lib[k]||[0,0]; lib[k][0]++; if(e.converted) lib[k][1]++; });
      const mine = {}; D.events.forEach(e => { mine[e.key]=mine[e.key]||[0,0]; mine[e.key][0]++; if(e.conv) mine[e.key][1]++; });
      const diffs = Object.keys(Object.assign({},lib,mine)).filter(k => JSON.stringify(lib[k])!==JSON.stringify(mine[k]));
      return { libN: L.length, mineN: D.events.length, diffs: diffs.slice(0,5), nKeys: Object.keys(mine).length };
    }""")
    check('parity: ledger size', r['libN'] == r['mineN'], r)
    check('parity: per-leave opps/conv identical', not r['diffs'], r)
    # 2 the Library rows equal detail totals (All filter) for the 10-pin
    pg.evaluate("navTo('s-leaves')"); pg.wait_for_timeout(1500)
    pg.evaluate("_leavesFilter='all'; _leavesSort='freq'; renderLeavesScreen()"); pg.wait_for_timeout(800)
    top = pg.evaluate("""() => { const t=document.querySelector('#leaves-content').innerText; return t.slice(0,600); }""")
    check('library shows Details link', 'Details' in top, top[:200])
    idx10 = pg.evaluate("_leavesAlignMap.findIndex(id => { const lv=db.leaves.find(l=>l.LeaveID===id); return lv && lv.DisplayName==='10'; })")
    check('10-pin row found', idx10 >= 0, idx10)
    pg.evaluate(f"openLeaveDetail({idx10})"); pg.wait_for_timeout(1500)
    check('detail screen active', pg.evaluate("getCurrentScreen()") == 's-leave-detail')
    txt = pg.inner_text('#leave-detail-content')
    print(txt[:1500])
    for s in ['Conversion: recent vs career'.upper(), 'CONVERSION STREAKS', 'SHOW ALL', 'RECENT FORM', 'HOW OFTEN IT IS LEFT', 'BY LEAGUE', 'SPARE BALL', 'LATEST TRIES']:
        check('section ' + s, s.lower() in txt.lower(), '')
    exp = pg.evaluate("""() => { const e=ldScan().events.filter(x=>x.key===_ldKey); return [e.length, e.filter(x=>x.conv).length]; }""")
    check('header counts', f'Converted {exp[1]} of {exp[0]}' in txt, exp)
    # streak definitions vs independent python-free check in JS
    s = pg.evaluate("""() => { const e=ldScan().events.filter(x=>x.key===_ldKey); const out={};
      ['night','league','all'].forEach(sc=>{ const r=ldStreaks(e,sc); out[sc]=[r.best?r.best.n:0, r.avg, r.runs, r.conv]; }); return out; }""")
    print('streaks', s)
    check('default scope league', pg.evaluate("ldScope()") == 'league')
    check('league best >= night best', s['league'][0] >= s['night'][0], s)
    check('avg = floor(conv/runs,1)', all(abs(v[1] - int(v[3]/v[2]*10)/10) < 1e-9 for v in s.values()), s)
    pg.evaluate("ldSetScope('night')"); pg.wait_for_timeout(300)
    t2 = pg.inner_text('#leave-detail-content')
    check('scope switch rerenders', 'end of the night' in t2)
    pg.evaluate("ldSetScope('league')")
    pg.screenshot(path='ld_top.png'); pg.evaluate("document.querySelector('#s-leave-detail').scrollTop=700; window.scrollTo(0,700); document.scrollingElement.scrollTop=700"); pg.wait_for_timeout(200); pg.screenshot(path='ld_mid.png')
    check('svg trend drawn', pg.evaluate("!!document.querySelector('#leave-detail-content svg polyline')"))
    # back returns to library
    pg.evaluate("navBack()"); pg.wait_for_timeout(800)
    check('back to library', pg.evaluate("getCurrentScreen()") == 's-leaves')
    # every leave key renders without error
    bad = pg.evaluate("""() => { const keys=Object.keys(ldScan().leaves); let bad=[]; keys.forEach(k=>{ _ldKey = isNaN(+k)?k:+k; try{ renderLeaveDetail(); }catch(e){ bad.push(k+':'+e.message);} }); return [keys.length,bad.slice(0,3)]; }""")
    check('all leaves render', not bad[1], bad)
    # live data: adding a frame invalidates the cache
    n0 = pg.evaluate("ldScan().events.length")
    pg.evaluate("""() => { const f=db.frames.find(x=>x.FrameNumber===3); const c=JSON.parse(JSON.stringify(f)); c.FrameID=999999; db.frames.push(c);
       db.attempts.filter(a=>a.FrameID===f.FrameID).forEach(a=>{ const b=JSON.parse(JSON.stringify(a)); b.AttemptID=b.AttemptID+900000; b.FrameID=999999; db.attempts.push(b); }); }""")
    n1 = pg.evaluate("ldScan().events.length")
    check('cache refreshes on push', n1 >= n0 and pg.evaluate("_ldCache.nF===db.frames.length"), (n0, n1))
    errs=[e for e in errs if 'createObjectURL' not in e]  # headless picture store, pre-existing in v30.247
    check('no page errors', not errs, errs[:3])
    pg.screenshot(path='ld_shot.png', full_page=False)
    b.close()
print(f'{ok}/{ok+fail}')
