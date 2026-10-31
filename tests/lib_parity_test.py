import sys, os, random, re
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from common import serve, load_snapshot
SNAP=sys.argv[1]; out={}
with sync_playwright() as p:
    for name,d in [('old',sys.argv[2]),('new',sys.argv[3])]:
        P=random.randint(20000,40000); serve(d,P)
        b=p.chromium.launch(); pg=b.new_page()
        load_snapshot(pg,f'http://127.0.0.1:{P}/index.html',SNAP)
        res={}
        for f in ['all','100','50','30']:
            pg.evaluate(f"navTo('s-leaves'); _leavesFilter='{f}'; _leavesSort='freq'; renderLeavesScreen()"); pg.wait_for_timeout(500)
            t=pg.inner_text('#leaves-content')
            res[f]=re.sub(r'\s*(Details\s*\u203a|[\u25b4\u25be] best)','',t)
        res['map']=pg.evaluate("JSON.stringify(_leavesAlignMap)")
        out[name]=res; b.close()
ok=all(out['old'][k]==out['new'][k] for k in out['old'])
for k in out['old']:
    print('PASS' if out['old'][k]==out['new'][k] else 'FAIL', 'Leave Library identical:', k, len(out['old'][k]))
