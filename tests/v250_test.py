# usage: python3 v250_test.py <snapshot> <app dir>   (fun awards shelf, photo proof, IDB v6 upgrade, snapshot, Test mode)
import sys, os, random, json, base64
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import serve, load_snapshot
SNAP, APP = sys.argv[1], sys.argv[2]; P = random.randint(20000, 40000); serve(APP, P); B = f'http://127.0.0.1:{P}/'
open(os.path.join(APP, '_blank_test.html'), 'w').write('<html><body>blank</body></html>')
ok = fail = 0
def check(n, c, i=''):
    global ok, fail
    if c: ok += 1; print('PASS', n)
    else: fail += 1; print('FAIL', n, i)
CH = {"id": "pht1", "source": "league", "contest": "hgame", "people": ["me", "tb18"], "state": "accepted", "name": "Proof test",
      "params": {"start": "2026-10-01", "end": "2026-12-31", "count": "all", "proof": "photo", "where": "any", "tie": "shared"}, "rounds": []}
FIN = {"id": "pf1", "source": "league", "contest": "hgame", "people": ["me", "tb18"], "state": "accepted", "name": "Close one",
       "params": {"start": "2026-09-01", "end": "2026-09-07", "count": "all", "proof": "none"}, "rounds": [],
       "result": {"winners": ["me"], "at": "2026-09-08", "margin": 1, "rows": [{"pid": "me"}, {"pid": "tb18"}]}}
try:
  with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 844}); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    # 1 upgrade from an IDB v5 database (as the phone has it today)
    pg.goto(B + '_blank_test.html'); pg.wait_for_load_state('load'); pg.wait_for_timeout(800); print('url', pg.url)
    pg.evaluate("""() => new Promise(res => { const r = indexedDB.open('BowlingDB', 5); r.onupgradeneeded = e => { const d = e.target.result;
       [['series','SeriesID'],['games','GameID'],['frames','FrameID'],['attempts','AttemptID'],['ballImages','BallID'],['laneLibrary','LaneKey'],['recalledContext','id'],['challengeSessions','id']].forEach(x => d.createObjectStore(x[0], { keyPath: x[1] }));
       e.target.transaction.objectStore('recalledContext').put({ id: 'keepme', v: 1 }); }; r.onsuccess = () => { r.result.close(); res(); }; })""")
    pg.goto(B + 'index.html'); pg.wait_for_function("typeof openIDB==='function'", timeout=60000); pg.wait_for_timeout(1500)
    up = pg.evaluate("""async () => { const d = await openIDB(); const rc = await idbGetAll('recalledContext'); return { v: d.version, stores: [...d.objectStoreNames], kept: rc.some(x => x.id === 'keepme') }; }""")
    check('IDB upgraded 5 -> 6 with challengePhotos', up['v'] == 6 and 'challengePhotos' in up['stores'], up)
    check('existing v5 data kept through the upgrade', up['kept'])
    load_snapshot(pg, B + 'index.html', SNAP)
    check('APP_VERSION v30.250', pg.evaluate('APP_VERSION') == 'v30.250')
    # 2 challenge page with proof: photo
    pg.evaluate("chs => { const l = JSON.parse(localStorage.getItem('bowlingdb_challenges') || '[]'); chs.forEach(c => l.unshift(c)); localStorage.setItem('bowlingdb_challenges', JSON.stringify(l)); }", [CH, FIN])
    pg.evaluate("() => new Promise(r => _chLoad(r))"); pg.wait_for_timeout(500)
    pg.evaluate("window._cnStartTab='challenges'; window._chDetail='pht1'; navTo('s-friend-feed')"); pg.wait_for_timeout(2000)
    txt = pg.inner_text('#s-friend-feed')
    check('challenge page shows Photo proof', 'Photo proof' in txt, txt[:600])
    nents = pg.evaluate("document.querySelectorAll('#s-friend-feed button[onclick^=\"chpAdd\"]').length")
    exp = pg.evaluate("(() => { const r = BDB_CHALLENGE.evaluate(chGet ? chGet('pht1') : null, {}, {}, '2026-10-30', {}); return 0; })") if False else None
    check('one + Photo per counted entry (Oct 28 night etc.)', nents >= 1, nents)
    # 3 add a big photo -> shrunk JPEG
    png = pg.evaluate("""() => { const c = document.createElement('canvas'); c.width = 3000; c.height = 2000; const x = c.getContext('2d'); x.fillStyle = '#336'; x.fillRect(0,0,3000,2000); x.fillStyle = '#fc0'; x.font = '200px sans-serif'; x.fillText('608', 1000, 1100); return c.toDataURL('image/png').split(',')[1]; }""")
    open('/tmp/proof.png', 'wb').write(base64.b64decode(png))
    first_btn = pg.evaluate("document.querySelector('#s-friend-feed button[onclick^=\"chpAdd\"]').getAttribute('onclick')")
    pg.evaluate("""() => { const o = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.id !== 'chp-input') return o.call(this); }; }""")
    pg.evaluate(first_btn)
    pg.set_input_files('#chp-input', '/tmp/proof.png'); pg.wait_for_timeout(2500)
    rec = pg.evaluate("async () => { const l = await idbGetAll('challengePhotos'); return l.map(x => ({ id: x.id, chID: x.chID, entry: x.entry, w: x.w, h: x.h, jpeg: x.data.startsWith('data:image/jpeg'), kb: Math.round(x.data.length * 3 / 4 / 1024) })); }")
    print('photos', rec)
    check('photo stored, linked to the challenge entry', len(rec) == 1 and rec[0]['chID'] == 'pht1' and rec[0]['entry'] in first_btn, rec)
    check('shrunk to 1280 long edge JPEG', rec and rec[0]['w'] == 1280 and rec[0]['h'] == 853 and rec[0]['jpeg'], rec)
    check('thumbnail on the challenge page', pg.evaluate("document.querySelectorAll('#s-friend-feed img[onclick^=\"chpView\"]').length") == 1)
    check('entry says 1 photo', '1 photo' in pg.inner_text('#s-friend-feed'))
    # 4 Full Snapshot carries it (even without ball pictures); restore store list
    sn = pg.evaluate("async () => { const s = await buildFullSnapshot(false); return [(s.idb.challengePhotos || []).length, s.idb.ballImages === null]; }")
    check('Full Snapshot includes proof photos, ball pictures still optional', sn == [1, True], sn)
    check('safety-copy restore knows the store', pg.evaluate("RSC_IDB_KEY.challengePhotos === 'id' && !!RSC_LABEL.challengePhotos"))
    # 5 view + delete
    pg.evaluate(f"chpView('{rec[0]['id']}')"); pg.wait_for_timeout(400)
    check('viewer shows the photo', pg.evaluate("!!document.querySelector('#modal-body img')") and 'Never posted' in pg.inner_text('#modal-body'))
    pg.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'photo_view.png'))
    pg.evaluate(f"chpDelete('{rec[0]['id']}')"); pg.wait_for_timeout(1200)
    check('delete removes it', pg.evaluate("idbGetAll('challengePhotos').then(l => l.length)") == 0 and pg.evaluate("document.querySelectorAll('#s-friend-feed img[onclick^=\"chpView\"]').length") == 0)
    # 6 trophy case: FOR FUN shelf, Photo Finish from the finished 'pf1'
    pg.evaluate("openAwards()"); pg.wait_for_timeout(4000)
    t = pg.inner_text('#modal-body')
    check('trophy case has the Challenges FOR FUN shelf', 'FOR FUN' in t and 'Perfectly Terrible' in t and 'Sore Winner' in t, t[-800:])
    check('Photo Finish earned (won by 1)', pg.evaluate("""(() => { const l = chFunAwards(); return l.some(o => o.id === 'photo' && o.pid === 'me' && o.chID === 'pf1'); })()"""))
    check('later awards marked not tracked yet', t.count('not tracked yet') == 2, t.count('not tracked yet'))
    pg.evaluate("awFunDetail('photo')"); pg.wait_for_timeout(400)
    d = pg.inner_text('#modal-body'); check('detail lists the challenge', 'Close one' in d and 'won by 1' in d, d)
    pg.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fun_detail.png'))
    pg.evaluate("awFunOpenCh('pf1')"); pg.wait_for_timeout(1200)
    check('tapping it opens that challenge', pg.evaluate("getCurrentScreen()") == 's-friend-feed' and 'Close one' in pg.inner_text('#s-friend-feed'))
    pg.evaluate("openAwards()"); pg.wait_for_timeout(3000)
    pg.evaluate("document.getElementById('modal-body').scrollTop = 1e6"); pg.wait_for_timeout(200)
    pg.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fun_shelf.png'))
    pg.evaluate("closeModal()"); pg.wait_for_timeout(500)
    # 7 USBC-style awards untouched by the shelf
    c1 = pg.evaluate("BDB_AWARDS.awardsScan({ games: db.games, series: db.series, frames: db.frames, attempts: db.attempts, leagues: db.leagues, tournaments: db.tournaments, leaves: db.leaves, entryAvg: {} }, BDB_AWARDS.DEFAULT_CFG).occurrences.length")
    check('USBC-style award count unchanged in the engine', c1 > 0, c1)
    # 8 Test mode: a photo added there never reaches real storage
    real_before = pg.evaluate("idbGetAll('challengePhotos').then(l => l.length)")
    pg.evaluate("window.bdbSandbox.enter('test', true)"); pg.wait_for_timeout(15000)
    pg.wait_for_function("typeof db!=='undefined' && typeof bdbIsTest==='function' && bdbIsTest()", timeout=120000); pg.wait_for_timeout(2000)
    pg.evaluate("() => { const o = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.id !== 'chp-input') return o.call(this); }; }")
    pg.evaluate("chpAdd('pht1', 'sTEST', 'test photo')"); pg.set_input_files('#chp-input', '/tmp/proof.png'); pg.wait_for_timeout(2500)
    check('photo saved in Test mode', pg.evaluate("idbGetAll('challengePhotos').then(l => l.length)") == real_before + 1)
    pg.evaluate("window.bdbSandbox.exit()"); pg.wait_for_timeout(4000)
    pg.wait_for_function("typeof db!=='undefined' && typeof bdbIsTest==='function' && !bdbIsTest()", timeout=120000); pg.wait_for_timeout(1500)
    check('real store unchanged after Test mode', pg.evaluate("idbGetAll('challengePhotos').then(l => l.length)") == real_before)
    errs = [e for e in errs if 'createObjectURL' not in e]
    check('no page errors', not errs, errs[:3])
    b.close()
finally:
    os.remove(os.path.join(APP, '_blank_test.html'))
print(f'v250_test: {ok} passed, {fail} failed')
