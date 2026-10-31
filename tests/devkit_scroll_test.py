import sys, os, random
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import serve
APP=sys.argv[1]; P=random.randint(20000,40000); serve(APP,P)
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':390,'height':600})
    pg.goto(f'http://127.0.0.1:{P}/index.html'); pg.wait_for_function("typeof dkTab==='function'", timeout=60000); pg.wait_for_timeout(1500)
    pg.evaluate("""() => { const panel=document.getElementById('dk-panel'); panel.classList.add('dk-open'); _dk.panelOpen=true; }"""); pg.wait_for_timeout(600)
    r=pg.evaluate("""() => { const panel=document.getElementById('dk-panel'); panel.classList.add('dk-open'); _dk.panelOpen=true;
      if (!_dk.mapLoaded) { dkmInit(); _dk.mapLoaded=true; } dkTab('map');
      const row=DKM_ROWS[0]; DKM.screen=row.form; dkmSelectRow(row.id);
      const pane=document.getElementById('dk-pane-map'), sb=document.getElementById('dkm-scroll-body');
      sb.scrollTop=99999; const pr=document.getElementById('dk-pane-map').getBoundingClientRect();
      const nav=document.getElementById('dkm-detail-nav'); const nr=nav.getBoundingClientRect();
      return { display: getComputedStyle(pane).display, sbH: sb.clientHeight, sbScroll: sb.scrollHeight, top: sb.scrollTop, navBottom: Math.round(nr.bottom), vh: innerHeight, ver: DK_VERSION }; }""")
    print(r)
    ok = r['display']=='flex' and r['top']>0 and r['navBottom']<=r['vh'] and r['sbScroll']>r['sbH']
    print('PASS' if ok else 'FAIL', 'Log Item form scrolls to its Save row')
    b.close()
