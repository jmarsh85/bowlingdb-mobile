




(function(){
var s=document.createElement('style');
s.id='dk-style';
s.textContent=`/* ── DEVKIT ─────────────────────────────────────────────────
Isolated developer overlay. All classes/IDs prefixed dk-.
z-indexes sit above every app layer (modal=100, grp-full=900).
*/
#dk-version {
position:fixed; top:calc(var(--safe-t) + 6px); right:10px;
font-size:10px; font-weight:800; letter-spacing:0.04em;
color:var(--teal); background:rgba(0,217,217,0.08);
border:1px solid rgba(0,217,217,0.22);
border-radius:6px; padding:3px 7px;
z-index:1001; display:none; pointer-events:none;
font-family:monospace;
}
/* Live screen-name overlay — shows dkmScreenKey()'s current mapped area
whenever DevKit devMode is on (independent of whether the full panel is
open). Sits just below the version badge, same translucent-pill language,
slightly more subdued since it's supplementary rather than primary. */
#dk-screen-label {
position:fixed; top:calc(var(--safe-t) + 30px); right:10px;
font-size:9px; font-weight:700; letter-spacing:0.06em;
color:var(--t2); background:rgba(157,78,221,0.08);
border:1px solid rgba(157,78,221,0.22);
border-radius:6px; padding:3px 7px;
z-index:1001; display:none; pointer-events:none;
font-family:monospace;
}
#dk-toggle {
position:fixed; bottom:calc(var(--safe-b) + 72px); left:14px;
width:42px; height:42px; border-radius:21px;
background:var(--bg2); border:1.5px solid rgba(0,217,217,0.35);
display:none; align-items:center; justify-content:center;
font-size:20px; cursor:pointer; z-index:1001;
box-shadow:0 4px 16px rgba(0,0,0,0.5);
transition:transform 0.15s ease, box-shadow 0.15s ease;
}
#dk-toggle:active { transform:scale(0.92); }
#dk-panel {
position:fixed; inset:0; z-index:1002;
background:var(--bg0,#0d0f14);
display:flex; flex-direction:column;
transform:translateY(100%);
transition:transform 0.28s cubic-bezier(0.32,0.72,0,1);
overflow:hidden;
}
#dk-panel.dk-open { transform:translateY(0); }
#dk-header {
display:flex; align-items:center; gap:0;
padding:calc(var(--safe-t) + 10px) 0 10px;
background:var(--bg2,#191c25);
border-bottom:1px solid var(--border1);
flex-shrink:0; overflow:hidden;
}
#dk-header-title {
font-size:15px; font-weight:800; color:var(--teal);
letter-spacing:-0.2px; flex-shrink:0;
padding:0 10px 0 14px;
}
#dk-header-screen {
font-size:10px; color:var(--t3); font-family:monospace;
background:var(--bg3,#1f2330); border-radius:4px; padding:2px 6px;
flex-shrink:0; margin-right:6px;
}
#dk-header-btns {
display:flex; align-items:center; gap:6px;
flex:1; overflow-x:auto; padding:0 14px 0 0;
-webkit-overflow-scrolling:touch; scrollbar-width:none;
}
#dk-header-btns::-webkit-scrollbar { display:none; }
.dk-hdr-btn {
height:30px; padding:0 10px; border-radius:8px; border:none;
background:var(--bg3,#1f2330); color:var(--t2); font-size:12px;
font-weight:600; cursor:pointer; white-space:nowrap; flex-shrink:0;
transition:background var(--transition);
}
.dk-hdr-btn:active { background:var(--bg4,#27292d); }
.dk-hdr-btn.dk-export { color:var(--teal); }
.dk-hdr-btn.dk-close  { color:var(--t3); }
#dk-tabs {
display:flex; gap:0; background:var(--bg1);
border-bottom:1px solid var(--border1); flex-shrink:0;
}
.dk-tab {
flex:1; padding:10px 0; text-align:center;
font-size:12px; font-weight:700; color:var(--t3);
cursor:pointer; border-bottom:2px solid transparent;
transition:color var(--transition), border-color var(--transition);
}
.dk-tab.dk-active { color:var(--teal); border-bottom-color:var(--teal); }
/* ── Tools tab (v30.132, A3) ──────────────────────────────────────
Uniform rows replacing the per-button inline background colours the
dry-run stack accumulated. Default = read-only; .write and .danger
are the only tools that touch data, which the old colours did not
distinguish — several destructive buttons were milder-looking than
read-only ones sitting next to them. */
.dk-tool-group {
font-size:10px; font-weight:800; color:var(--t3);
text-transform:uppercase; letter-spacing:0.8px;
margin:14px 0 4px; padding-bottom:4px;
border-bottom:1px solid var(--border1);
}
.dk-tool-group:first-child { margin-top:2px; }
.dk-tool-btn {
display:block; width:100%; margin-top:6px;
padding:9px 10px; text-align:left;
border-radius:8px; border:1px solid var(--border1); background:var(--bg3);
color:var(--t2); font-size:12px; font-weight:600; cursor:pointer;
-webkit-tap-highlight-color:transparent;
transition:background var(--transition), border-color var(--transition);
}
.dk-tool-btn:active { background:var(--bg4,#27292d); }
.dk-tool-btn.write  { color:var(--gold);   border-color:rgba(255,215,0,0.28); }
.dk-tool-btn.danger { color:var(--sedona); border-color:rgba(232,93,76,0.32); }
#dk-body { flex:1; overflow-y:auto; padding:14px; }
/* ── Log tab ── */
.dk-cat-row { display:flex; gap:6px; margin-bottom:10px; }
.dk-cat-btn {
flex:1; padding:7px 0; border-radius:8px; border:none;
font-size:11px; font-weight:700; cursor:pointer;
background:var(--bg3,#1f2330); color:var(--t3);
transition:background var(--transition), color var(--transition);
}
.dk-cat-btn.dk-sel-bug  { background:rgba(232,93,76,0.18);  color:var(--red);    border:1px solid rgba(232,93,76,0.35); }
.dk-cat-btn.dk-sel-ui   { background:rgba(157,78,221,0.18); color:var(--purple); border:1px solid rgba(157,78,221,0.35); }
.dk-cat-btn.dk-sel-feat { background:rgba(0,217,217,0.15);  color:var(--teal);   border:1px solid rgba(0,217,217,0.3); }
.dk-cat-btn.dk-sel-note { background:rgba(255,215,0,0.12);  color:var(--gold);   border:1px solid rgba(255,215,0,0.28); }
#dk-ref-chip {
display:none; align-items:center; gap:6px;
background:rgba(0,217,217,0.08); border:1px solid rgba(0,217,217,0.25);
border-radius:7px; padding:5px 9px; margin-bottom:8px; font-size:11px;
}
#dk-ref-chip-text { color:var(--teal); font-family:monospace; flex:1; }
#dk-ref-chip-clear { color:var(--t3); cursor:pointer; font-size:14px; line-height:1; }
#dk-msg {
width:100%; box-sizing:border-box;
background:var(--bg3,#1f2330); border:1px solid var(--border2);
border-radius:10px; color:var(--t1); font-size:13px;
padding:10px 12px; resize:none; height:80px;
font-family:inherit; outline:none;
transition:border-color var(--transition);
}
#dk-msg:focus { border-color:rgba(0,217,217,0.45); }
#dk-submit {
width:100%; margin-top:8px; padding:11px;
border-radius:10px; border:none; cursor:pointer;
background:rgba(0,217,217,0.15); color:var(--teal);
font-size:13px; font-weight:700;
transition:background var(--transition);
}
#dk-submit:active { background:rgba(0,217,217,0.25); }
.dk-recent-hdr {
font-size:10px; font-weight:700; color:var(--t3);
letter-spacing:0.06em; text-transform:uppercase;
margin:14px 0 8px;
}
/* ── Entry cards ── */
.dk-entry {
background:var(--bg2,#191c25); border-radius:10px;
padding:10px 11px; margin-bottom:8px;
border-left:3px solid var(--border2);
}
.dk-entry[data-cat=bug]  { border-left-color:var(--red); }
.dk-entry[data-cat=ui]   { border-left-color:var(--purple); }
.dk-entry[data-cat=feat] { border-left-color:var(--teal); }
.dk-entry[data-cat=note] { border-left-color:var(--gold); }
.dk-entry-head {
display:flex; align-items:center; gap:6px; margin-bottom:5px;
}
.dk-badge {
font-size:9px; font-weight:800; letter-spacing:0.06em;
text-transform:uppercase; border-radius:4px; padding:2px 5px;
}
.dk-badge-bug  { background:rgba(232,93,76,0.18);  color:var(--red); }
.dk-badge-ui   { background:rgba(157,78,221,0.18); color:var(--purple); }
.dk-badge-feat { background:rgba(0,217,217,0.15);  color:var(--teal); }
.dk-badge-note { background:rgba(255,215,0,0.12);  color:var(--gold); }
.dk-entry-ts   { font-size:10px; color:var(--t3); flex:1; }
.dk-entry-del  { font-size:16px; color:var(--t3); cursor:pointer; line-height:1; padding:0 2px; }
.dk-entry-msg  { font-size:12px; color:var(--t1); line-height:1.45; user-select:text; -webkit-user-select:text; }
.dk-entry-ref  { font-size:10px; color:var(--teal); font-family:monospace; margin-top:3px; user-select:text; -webkit-user-select:text; }
.dk-entry-scr  { font-size:10px; color:var(--t3); margin-top:2px; user-select:text; -webkit-user-select:text; }
/* ── State tab ── */
#dk-state {
font-family:monospace; font-size:11px; color:var(--t2);
line-height:1.6; white-space:pre-wrap; word-break:break-all;
}
/* ── Inspect overlay ── */
#dk-inspect-overlay {
position:fixed; inset:0; z-index:1003;
background:transparent;
display:none; pointer-events:none;
}
#dk-inspect-overlay.dk-inspecting {
display:block; pointer-events:auto;
}
#dk-inspect-banner {
position:fixed; inset:0;
border:3px solid rgba(0,217,217,0.7);
border-radius:0; z-index:1004;
display:none; pointer-events:none;
animation:none;
}
#dk-inspect-banner.dk-inspecting {
display:block;
animation:dk-border-pulse 1.2s ease-in-out infinite;
}
@keyframes dk-border-pulse {
0%,100% { border-color:rgba(0,217,217,0.5); box-shadow:inset 0 0 0 1px rgba(0,217,217,0.15); }
50%      { border-color:rgba(0,217,217,0.95); box-shadow:inset 0 0 0 1px rgba(0,217,217,0.3); }
}
/* ── Inspect highlight flash ── */
.dk-inspect-highlight {
outline:2px solid var(--teal)!important;
outline-offset:2px!important;
background:rgba(0,217,217,0.07)!important;
}
/* ── Tag-confirm bubble ── */
#dk-tag-bubble {
display:none; position:fixed; z-index:1005;
background:var(--bg1); border:1.5px solid var(--teal);
border-radius:12px; padding:10px 14px;
box-shadow:0 8px 32px rgba(0,0,0,0.6);
min-width:200px; max-width:270px;
}
#dk-tag-bubble-name { font-size:13px; font-weight:600; color:var(--t1); margin-bottom:2px; line-height:1.3; }
#dk-tag-bubble-ctx  { font-size:11px; color:var(--t3); margin-bottom:10px; line-height:1.4; }
#dk-tag-bubble-hdr  { font-size:11px; font-weight:700; color:var(--teal); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.4px; }
.dk-bbl-cat {
flex:1; padding:5px 4px; border-radius:8px; font-size:11px; font-weight:700;
cursor:pointer; border:1px solid var(--border1);
background:var(--bg3); color:var(--t3);
}
.dk-bbl-sel-bug  { background:rgba(232,93,76,0.18);  color:var(--red);    border-color:rgba(232,93,76,0.35); }
.dk-bbl-sel-ui   { background:rgba(157,78,221,0.18); color:var(--purple); border-color:rgba(157,78,221,0.35); }
.dk-bbl-sel-feat { background:rgba(0,217,217,0.15);  color:var(--teal);   border-color:rgba(0,217,217,0.3); }
.dk-bbl-sel-note { background:rgba(255,215,0,0.12);  color:var(--gold);   border-color:rgba(255,215,0,0.28); }
/* ── Entry status on Log/Entries tabs ── */
.dk-status-row { display:flex; gap:5px; margin-top:6px; }
.dk-status-btn {
padding:3px 9px; border-radius:8px; font-size:10px; font-weight:700;
border:1px solid var(--border2); background:var(--bg3); color:var(--t3); cursor:pointer;
}
.dk-status-btn.sel-open    { background:rgba(93,168,255,0.15); border-color:rgba(93,168,255,0.4); color:#5da8ff; }
.dk-status-btn.sel-fixed   { background:rgba(61,220,132,0.15); border-color:rgba(61,220,132,0.4); color:#3ddc84; }
.dk-status-btn.sel-wontfix { background:rgba(85,91,110,0.2);   border-color:rgba(85,91,110,0.4);  color:var(--t2); }
/* ── Filter chips (Entries tab) ── */
.dk-filter-chip {
padding:4px 12px; border-radius:20px; font-size:11px; font-weight:700;
border:1.5px solid var(--border2); background:var(--bg3); color:var(--t3);
cursor:pointer; white-space:nowrap; flex-shrink:0;
}
.dk-filter-chip.sel { background:rgba(0,217,217,0.12); border-color:var(--teal); color:var(--teal); }
/* ── Inspect btn active state ── */
.dk-hdr-btn.dk-active { background:rgba(232,93,76,0.15); border-color:rgba(232,93,76,0.4); color:var(--red); }
/* ── Map pane ── */
#dkm-breadcrumb {
padding:8px 12px; border-bottom:1px solid var(--border1);
font-size:11px; display:flex; align-items:center; gap:5px;
background:var(--bg2); flex-shrink:0;
}
#dkm-screen-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:0 10px 8px; }
#dkm-type-row {
display:flex; gap:5px; padding:6px 10px 4px;
overflow-x:auto; scrollbar-width:none;
}
#dkm-type-row::-webkit-scrollbar { display:none; }
#dkm-obj-list { padding:4px 0 8px; }
#dkm-search {
width:100%; background:var(--bg2); border:1px solid var(--border1);
color:var(--t1); font-size:12px; padding:7px 10px; border-radius:8px;
outline:none; font-family:inherit; box-sizing:border-box;
}
#dk-pane-map { display:flex; flex-direction:column; height:100%; overflow:hidden; }
#dk-pane-idb { display:flex; flex-direction:column; height:100%; overflow:hidden; }
#dkm-scroll-body { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; }
.dk-idb-row { border-bottom:1px solid var(--border1); padding:7px 0; cursor:pointer; }
.dk-idb-row:active { background:var(--bg3); }
.dk-idb-row-head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
.dk-idb-badge { font-size:9px; font-weight:700; padding:1px 6px; border-radius:6px; white-space:nowrap; }
.dk-idb-badge-auto     { background:rgba(102,102,102,0.2); color:var(--t3); }
.dk-idb-badge-prompted { background:rgba(245,166,35,0.15);  color:var(--gold); }
.dk-idb-badge-user     { background:rgba(0,217,217,0.15);   color:var(--teal); }
.dk-idb-badge-null     { background:rgba(50,50,80,0.4);     color:var(--t3); }
.dk-idb-expand { font-size:10px; color:var(--t2); margin-top:5px; background:var(--bg2); border-radius:6px; padding:6px 8px; line-height:1.7; white-space:pre-wrap; word-break:break-all; display:none; }
.dk-idb-expand.open { display:block; }
`;
document.head.appendChild(s);
var host=document.getElementById('app')||document.body;
host.insertAdjacentHTML('beforeend',`<!-- ── DEVKIT OVERLAY ─────────────────────────────────────── -->
  <div id="dk-version">DEV v22</div>
  <div id="dk-screen-label"></div>
  <div id="dk-toggle" onclick="dkTogglePanel()" title="DevKit"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="ball-grad" cx="38%" cy="35%" r="60%">
      <stop offset="0%" stop-color="#9D4EDD"/>
      <stop offset="100%" stop-color="#3a1060"/>
    </radialGradient>
    <radialGradient id="ball-sheen" cx="35%" cy="30%" r="45%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.22)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
  </defs>
  <circle cx="11" cy="11" r="10" fill="url(#ball-grad)"/>
  <circle cx="11" cy="11" r="10" fill="url(#ball-sheen)"/>
  <!-- finger holes -->
  <circle cx="8.5" cy="8" r="1.35" fill="rgba(0,0,0,0.45)"/>
  <circle cx="12" cy="7" r="1.35" fill="rgba(0,0,0,0.45)"/>
  <circle cx="13.5" cy="10.5" r="1.35" fill="rgba(0,0,0,0.45)"/>
</svg></div>
  <div id="dk-inspect-overlay"></div>
  <div id="dk-inspect-banner"></div>

  <!-- Tag-confirm bubble — appears near tapped element -->
  <div id="dk-tag-bubble">
    <div id="dk-tag-bubble-hdr">🔍 Element Tagged</div>
    <div id="dk-tag-bubble-name"></div>
    <div id="dk-tag-bubble-ctx"></div>
    <!-- Category selector -->
    <div id="dk-bubble-cat-row" style="display:flex;gap:5px;margin-bottom:10px">
      <button class="dk-bbl-cat dk-bbl-sel-bug"  onclick="dkBubbleCat('bug')"  id="dkbbl-bug" >🔴 Bug</button>
      <button class="dk-bbl-cat"                  onclick="dkBubbleCat('ui')"   id="dkbbl-ui"  >🟣 UI</button>
      <button class="dk-bbl-cat"                  onclick="dkBubbleCat('feat')" id="dkbbl-feat">🔵 Feat</button>
      <button class="dk-bbl-cat"                  onclick="dkBubbleCat('note')" id="dkbbl-note">🟡 Note</button>
    </div>
    <!-- Actions -->
    <div style="display:flex;gap:6px">
      <button onclick="dkBubbleLogAndLink()" style="flex:1;padding:8px;border-radius:8px;background:rgba(0,217,217,0.12);border:1px solid rgba(0,217,217,0.35);color:var(--teal);font-size:12px;font-weight:700;cursor:pointer">Log &amp; Link ›</button>
      <button onclick="dkmTagConfirm()" style="padding:8px 10px;border-radius:8px;background:rgba(157,78,221,0.12);border:1px solid rgba(157,78,221,0.3);color:var(--purple);font-size:12px;font-weight:700;cursor:pointer">Map ›</button>
      <button onclick="dkmTagDismiss(true)" style="padding:8px 10px;border-radius:8px;background:var(--bg3);border:1px solid var(--border1);color:var(--t2);font-size:12px;font-weight:700;cursor:pointer">✕</button>
    </div>
  </div>

  <div id="dk-panel">
    <!-- Header -->
    <div id="dk-header">
      <div id="dk-header-title">🐛 DevKit</div>
      <div id="dk-header-screen"></div>
      <div id="dk-header-btns">
        <button class="dk-hdr-btn" id="dk-inspect-btn" onclick="dkToggleInspect()">🔍 Inspect</button>
        <button class="dk-hdr-btn" onclick="dkSessionBrief()">📋 Brief</button>
        <!-- v30.132 (A3): Baker Purge / F10 Flags / Stale Games moved to the
             Tools tab. They were the last three items in a hidden-scrollbar
             row, so they sat off-screen by default with nothing to indicate
             they existed. The header now holds only what fits unscrolled. -->
        <button class="dk-hdr-btn dk-export" onclick="dkExport()">⬆ Export</button>
        <button class="dk-hdr-btn dk-close" onclick="dkTogglePanel()">✕</button>
      </div>
    </div>
    <!-- Tabs -->
    <div id="dk-tabs">
      <div class="dk-tab dk-active" onclick="dkTab('entries')">Entries</div>
      <div class="dk-tab" onclick="dkTab('map');if(!_dk.mapLoaded){dkmInit();_dk.mapLoaded=true;}dkmStep('quicklog');">Log Item</div>
      <div class="dk-tab" onclick="dkTab('state')">State</div>
      <div class="dk-tab" onclick="dkTab('idb')">Data</div>
      <div class="dk-tab" onclick="dkTab('tools')">Tools</div>
    </div>
    <!-- Body -->
    <div id="dk-body">
      <!-- LOG TAB -->
      <!-- ENTRIES TAB (default) -->
      <div id="dk-pane-entries">
        <div id="dk-filter-row" style="display:flex;gap:6px;padding:10px 14px 6px;border-bottom:1px solid var(--border1);overflow-x:auto;scrollbar-width:none">
          <div class="dk-filter-chip sel" data-filter="all" onclick="dkSetFilter('all')">All</div>
          <div class="dk-filter-chip" data-filter="open" onclick="dkSetFilter('open')">🔓 Open</div>
          <div class="dk-filter-chip" data-filter="fixed" onclick="dkSetFilter('fixed')">✅ Fixed</div>
          <div class="dk-filter-chip" data-filter="wontfix" onclick="dkSetFilter('wontfix')">🚫 Won't Fix</div>
          <div class="dk-filter-chip" style="color:var(--teal);border-color:rgba(0,217,217,0.3)" onclick="dkReviewAndExport()">🤖 Review &amp; Export</div>
          <div class="dk-filter-chip" style="color:var(--red);border-color:rgba(232,93,76,0.3)" onclick="dkClearResolved()">🗑 Clear Resolved</div>
        </div>
        <div id="dk-entries-list" style="padding:8px 0"></div>
      </div>
      <!-- MAP TAB -->
      <div id="dk-pane-map" style="display:none">
        <div id="dkm-breadcrumb"></div>
        <div id="dkm-scroll-body">
          <!-- Step 1: Screen picker -->
          <div id="dkm-step-screen" style="padding:8px 0">
            <div style="padding:4px 12px 6px;font-size:11px;color:var(--t3)">Select a screen to explore its interactions:</div>
            <div id="dkm-screen-grid"></div>
          </div>
          <!-- Step 2: Object list -->
          <div id="dkm-step-object" style="display:none">
            <div style="padding:6px 10px 0">
              <input id="dkm-search" placeholder="🔍 Filter…" oninput="dkmRenderObjects()">
            </div>
            <div id="dkm-type-row"></div>
            <div id="dkm-obj-list"></div>
          </div>
          <!-- Step 3: Detail + form -->
          <div id="dkm-step-detail" style="display:none;padding:8px 10px 12px">
            <div id="dkm-detail-card" style="background:var(--bg2);border:1px solid var(--border1);border-radius:10px;margin-bottom:10px;overflow:hidden"></div>
            <div id="dkm-form-card" style="background:var(--bg2);border:1px solid var(--border1);border-radius:10px;overflow:hidden">
              <div style="padding:10px 12px;border-bottom:1px solid var(--border1)">
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:6px">Type</div>
                <div style="display:flex;gap:5px;margin-bottom:10px" id="dkm-cat-row"></div>
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:5px">Description / Issue</div>
                <textarea id="dkm-desc" rows="2" style="width:100%;background:var(--bg3);border:1px solid var(--border1);color:var(--t1);font-size:13px;padding:8px;border-radius:7px;font-family:inherit;resize:none;line-height:1.5;outline:none;box-sizing:border-box" placeholder="Describe the bug, feature, or note…"></textarea>
                <div id="dkm-ref-display" style="display:none;margin-top:6px;font-size:10px;color:var(--teal);font-family:monospace;background:rgba(0,217,217,0.06);border:1px solid rgba(0,217,217,0.2);border-radius:6px;padding:4px 8px;line-height:1.5"></div>
              </div>
              <div style="padding:10px 12px;border-bottom:1px solid var(--border1)">
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:6px">Desired Outcome</div>
                <textarea id="dkm-desired" rows="4" style="width:100%;background:var(--bg3);border:1px solid var(--border1);color:var(--t1);font-size:13px;padding:8px;border-radius:7px;font-family:inherit;resize:none;line-height:1.5;outline:none;box-sizing:border-box" placeholder="What should happen? Describe the exact UI behavior…"></textarea>
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin:8px 0 4px">Notes / Edge Cases</div>
                <textarea id="dkm-notes" rows="2" style="width:100%;background:var(--bg3);border:1px solid var(--border1);color:var(--t1);font-size:12px;padding:7px 8px;border-radius:7px;font-family:inherit;resize:none;line-height:1.5;outline:none;box-sizing:border-box" placeholder="Edge cases, related row IDs, implementation context…"></textarea>
              </div>
              <div style="padding:8px 12px;border-bottom:1px solid var(--border1)">
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:6px">Status</div>
                <div style="display:flex;gap:5px" id="dkm-status-row"></div>
              </div>
              <div style="padding:8px 12px">
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:6px">Priority</div>
                <div style="display:flex;gap:5px" id="dkm-pri-row"></div>
              </div>
            </div>
            <div style="display:flex;gap:6px;margin-top:8px" id="dkm-detail-nav"></div>
            <button onclick="dkmSaveDetail()" style="width:100%;margin-top:8px;padding:11px;border-radius:10px;background:var(--teal);color:#000;font-size:14px;font-weight:700;border:none;cursor:pointer">Save Changes</button>
          </div>
          <!-- Step 4: New object form -->
          <div id="dkm-step-quicklog" style="display:none"></div>
          <div id="dkm-step-new" style="display:none;padding:8px 10px 12px">
            <div style="font-size:12px;color:var(--t2);margin-bottom:10px;line-height:1.5" id="dkm-new-ctx"></div>
            <div style="background:var(--bg2);border:1px solid var(--border1);border-radius:10px;overflow:hidden">
              <div style="padding:10px 12px;border-bottom:1px solid var(--border1)">
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:5px">Object Name</div>
                <input id="dkm-new-obj" style="width:100%;background:var(--bg3);border:1px solid var(--border1);color:var(--t1);font-size:13px;padding:7px 9px;border-radius:7px;font-family:inherit;outline:none;box-sizing:border-box">
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin:8px 0 5px">Screen</div>
                <select id="dkm-new-form" style="width:100%;background:var(--bg3);border:1px solid var(--border1);color:var(--t1);font-size:13px;padding:7px 9px;border-radius:7px;font-family:inherit;outline:none;box-sizing:border-box">
                  <option value="HOME">Home</option>
                  <option value="LEAGUES">Leagues</option>
                  <option value="SERIES">Series</option>
                  <option value="SCORING">Scoring</option>
                  <option value="TEAMBOWL">Team Bowl</option>
                  <option value="STATS">Statistics</option>
                  <option value="BALLS">Balls</option>
                  <option value="OPEN">Open Bowling</option>
                  <option value="MODALS">Modals</option>
                </select>
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin:8px 0 5px">Current Behavior</div>
                <textarea id="dkm-new-current" rows="2" style="width:100%;background:var(--bg3);border:1px solid var(--border1);color:var(--t1);font-size:12px;padding:7px 8px;border-radius:7px;font-family:inherit;resize:none;outline:none;box-sizing:border-box" placeholder="What does it do now?"></textarea>
                <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin:8px 0 5px">Desired Outcome</div>
                <textarea id="dkm-new-desired" rows="3" style="width:100%;background:var(--bg3);border:1px solid var(--border1);color:var(--t1);font-size:13px;padding:8px;border-radius:7px;font-family:inherit;resize:none;line-height:1.5;outline:none;box-sizing:border-box" placeholder="What should happen instead?"></textarea>
              </div>
              <div style="padding:8px 12px;display:flex;gap:5px" id="dkm-new-status-row"></div>
            </div>
            <button onclick="dkmSaveNew()" style="width:100%;margin-top:8px;padding:11px;border-radius:10px;background:var(--teal);color:#000;font-size:14px;font-weight:700;border:none;cursor:pointer">Add to Map</button>
          </div>
        </div>
      </div>
      <!-- STATE TAB -->
      <!-- DATA INSPECTOR PANE -->
      <div id="dk-pane-idb" style="display:none;flex-direction:column;height:100%">
        <!-- Row 1: Table selector + scope + refresh -->
        <div style="display:flex;gap:6px;padding:8px 14px 6px;border-bottom:1px solid var(--border1);flex-shrink:0;align-items:center">
          <select id="dk-idb-table" onchange="dkIdbRender()"
            style="flex:2;padding:5px 6px;background:var(--bg3);color:var(--t1);border:1px solid var(--border2);border-radius:8px;font-size:11px">
            <optgroup label="── Reference (localStorage) ──">
              <option value="ls:balls">balls</option>
              <option value="ls:bowlers">bowlers</option>
              <option value="ls:leagues">leagues</option>
              <option value="ls:centers">centers</option>
              <option value="ls:patterns">patterns</option>
              <option value="ls:leaves">leaves</option>
              <option value="ls:surfaces">surfaces</option>
              <option value="ls:surfaceDetails">surfaceDetails</option>
              <option value="ls:seasons">seasons</option>
              <option value="ls:lineages">lineages</option>
            </optgroup>
            <optgroup label="── Scoring (IDB) ──">
              <option value="idb:attempts">attempts</option>
              <option value="idb:frames">frames</option>
              <option value="idb:games">games</option>
              <option value="idb:series">series</option>
            </optgroup>
            <optgroup label="── App State ──">
              <option value="ls:openSessions">openSessions</option>
              <option value="ls:tournaments">tournaments</option>
              <option value="ls:customPins">customPins</option>
              <option value="ls:spare_alignments">spare_alignments</option>
              <option value="ls:prefs">prefs</option>
              <option value="ls:handicap">handicap</option>
              <option value="ls:lane_ref">lane_ref</option>
              <option value="ls:coaching_profile">coaching_profile</option>
            </optgroup>
            <optgroup label="── Assets ──">
              <option value="idb:ballImages">ballImages (count only)</option>
            </optgroup>
          </select>
          <select id="dk-idb-scope" onchange="dkIdbRender()"
            style="flex:1;padding:5px 6px;background:var(--bg3);color:var(--t1);border:1px solid var(--border2);border-radius:8px;font-size:11px">
            <option value="current">Current</option>
            <option value="all">All</option>
          </select>
          <button onclick="dkIdbRender()" style="padding:5px 9px;background:var(--bg3);color:var(--teal);border:1px solid rgba(0,217,217,0.3);border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">↻</button>
          <button onclick="dkIdbExport()" style="padding:5px 9px;background:var(--bg3);color:var(--purple);border:1px solid rgba(157,78,221,0.3);border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">⬇</button>
        </div>
        <!-- Row 2: Pinned field chips (attempts only) -->
        <div id="dk-idb-field-row" style="display:none;gap:4px;padding:5px 14px;border-bottom:1px solid var(--border1);overflow-x:auto;scrollbar-width:none;flex-shrink:0;align-items:center">
          <span style="font-size:10px;color:var(--t3);white-space:nowrap">Pin:</span>
          <div class="dk-filter-chip sel" id="dk-idb-pin-pocket" onclick="dkIdbTogglePin('pocket')" style="font-size:10px;padding:2px 7px">Entry</div>
          <div class="dk-filter-chip sel" id="dk-idb-pin-pesrc"  onclick="dkIdbTogglePin('pesrc')"  style="font-size:10px;padding:2px 7px">PE Src</div>
          <div class="dk-filter-chip sel" id="dk-idb-pin-broll"  onclick="dkIdbTogglePin('broll')"  style="font-size:10px;padding:2px 7px">BallRoll</div>
          <div class="dk-filter-chip sel" id="dk-idb-pin-brsrc"  onclick="dkIdbTogglePin('brsrc')"  style="font-size:10px;padding:2px 7px">BR Src</div>
          <div class="dk-filter-chip sel" id="dk-idb-pin-leave"  onclick="dkIdbTogglePin('leave')"  style="font-size:10px;padding:2px 7px">Leave</div>
        </div>
        <!-- Results body -->
        <div id="dk-idb-body" style="flex:1;overflow-y:auto;padding:8px 14px 14px;font-family:monospace;font-size:11px">
          <div style="color:var(--t3);text-align:center;padding:20px">Tap ↻ to load</div>
        </div>
      </div>
      <div id="dk-pane-state" style="display:none">
        <pre id="dk-state"></pre>
      </div>
      <!-- TOOLS TAB (v30.132, A3) — every DevKit data tool in one place.
           Previously split across two homes: three buttons buried at the far
           right of the header's hidden-scrollbar scroller, and a 23-deep
           undifferentiated stack of dry-run buttons inside the State tab
           (which is otherwise a state dump). Same handlers, same behaviour;
           grouped, labelled, and reachable without horizontal scrolling.
           Read-only is the default styling — .write and .danger mark the
           tools that actually touch data, which the old rainbow of inline
           background colours did not encode. -->
      <div id="dk-pane-tools" style="display:none">
        <div id="dk-purge-panel" style="padding:4px 4px 4px">

          <div class="dk-tool-group">Maintenance — writes data</div>
          <button class="dk-tool-btn write" onclick="dkBackfillF10Flags()" title="Populate Strike/Spare flags on historical frame-10 rows (dry run first)">🔟 F10 Flags — backfill frame-10 Strike/Spare</button>
          <button class="dk-tool-btn write" onclick="dkReviewStaleGames()" title="Review and purge empty game shells that count as zeros">🧹 Stale Games — review &amp; purge empty shells</button>
          <button class="dk-tool-btn write" onclick="dkBakerPurgeShells()" title="Remove empty db.games shells created in Baker rounds by the pre-v30.126 routing bug">🎳 Baker Purge — remove Baker game shells</button>
          <button class="dk-tool-btn write" onclick="dkUpdateGamesSincePrompt()">Update Games-Since-Prompt</button>
          <button class="dk-tool-btn write" onclick="dkEnsureLineagesRun()">Ensure Lineages</button>
          <button class="dk-tool-btn danger" onclick="dkPurgeOrphans()">Purge Orphan IDB Records</button>
          <button class="dk-tool-btn danger" onclick="dkNukeOpenPhantoms()">NUCLEAR: Clear Phantom Open Bowling</button>

          <div class="dk-tool-group">Seasons &amp; lineages</div>
          <button class="dk-tool-btn" onclick="dkSeasonDryRun()">Season Dry Run</button>
          <button class="dk-tool-btn" onclick="dkLineageDryRun()">Lineage Dry Run</button>

          <div class="dk-tool-group">Streaks</div>
          <button class="dk-tool-btn" onclick="dkStreakDryRun()">Streak Dry Run</button>
          <button class="dk-tool-btn" onclick="dkStreakDryRunDetail()">Streak Detail — League 129</button>
          <button class="dk-tool-btn" onclick="dkStreakRollingDryRun()">Rolling Avg Streak — League 129</button>
          <button class="dk-tool-btn" onclick="dkStreakRollingDryRun('lineage', 1)">Rolling Avg Streak — Lineage 1</button>
          <button class="dk-tool-btn" onclick="dkStreakRollingDryRun('global')">Rolling Avg Streak — Global</button>
          <button class="dk-tool-btn" onclick="dkBestSeriesStreakDryRun('lineage', 1)">Best Streak — Lineage 1</button>
          <button class="dk-tool-btn" onclick="dkBestSeriesStreakDryRun('calendar')">Best Streak — Calendar/Global</button>
          <button class="dk-tool-btn" onclick="dkPreviewCompareStreaks()">Preview: Compare Streaks Tab</button>

          <div class="dk-tool-group">Leaves &amp; lane condition</div>
          <button class="dk-tool-btn" onclick="dkLeaveDiagnosisDiffRun()">Leave Diagnosis Diff — old vs new</button>
          <button class="dk-tool-btn" onclick="dkLeaveSideClusteringDryRun()">Leave-Side Clustering Dry Run</button>
          <button class="dk-tool-btn" onclick="dkLaneHookRatingDryRun()">Lane Hook Rating Dry Run</button>
          <button class="dk-tool-btn" onclick="dkSbtbComparisonDryRun()">SB/TB Comparison Dry Run</button>
          <button class="dk-tool-btn" onclick="dkLanePrepBriefPreview()">Lane Prep Brief Preview — no AI call</button>

          <div class="dk-tool-group">Ball change &amp; motion</div>
          <button class="dk-tool-btn" onclick="dkBallChangeRetrospectiveDryRun()">Ball-Change Retrospective</button>
          <button class="dk-tool-btn" onclick="dkBallChangeStep2DryRun()">Ball-Change Step 2 Join</button>
          <button class="dk-tool-btn" onclick="dkBallMotionProfileInspector()">Ball Motion Profile Inspector</button>

          <div class="dk-tool-group">Diagnostics</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <button class="dk-tool-btn" style="margin-top:0" onclick="dkIDBDump()">Dump IDB</button>
            <button class="dk-tool-btn" style="margin-top:0" onclick="dkAIAnalyze()">AI Analyze</button>
            <button class="dk-tool-btn write" style="margin-top:0" onclick="dkApplyAIFix()">Apply AI Fix</button>
            <button class="dk-tool-btn" style="margin-top:0" onclick="dkCopyResult()">Copy Result</button>
          </div>

          <div id="dk-purge-result" style="font-size:11px;color:var(--t2);margin-top:8px;font-family:monospace;white-space:pre-wrap;max-height:280px;overflow-y:auto;border:1px solid #333;border-radius:6px;padding:6px;background:#0a0a0a"></div>
        </div>
      </div>
    </div>
  </div>
  <!-- ── /DEVKIT ─────────────────────────────────────────────── -->`);
})();
async function dkPreviewCompareStreaks() {
try {
await loadScoringData();
var _pOpts = _perfPickOptions();
if (_pOpts.length < 2) throw new Error('Need at least 2 comparable leagues/lineages in _perfPickOptions() to preview.');
var sc = { cmpSlots: [
{ type: _pOpts[0].type, id: _pOpts[0].id },
{ type: _pOpts[1].type, id: _pOpts[1].id },
null
] };
window._dkStreaksPreviewSc = sc;
openModal('<div class="modal-title">Compare Streaks — Preview ('+ _pOpts[0].name + ' vs '+ _pOpts[1].name + ')</div>'+
'<div id="dk-streaks-preview">'+ _perfRenderCompareStreaks(sc, _dkStreaksPreview.mode, 'dkSetStreakPreviewMode') + '</div>'+
'<button class="btn" style="width:100%;margin-top:10px" onclick="closeModal()">Close</button>');
} catch(e) {
openModal('<div class="modal-title">Compare Streaks — Preview failed</div>'+
'<pre style="white-space:pre-wrap;font-size:11px;color:var(--red)">'+
(e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '') + '</pre>'+
'<button class="btn" style="width:100%;margin-top:10px" onclick="closeModal()">Close</button>');
}
}function dkSetStreakPreviewMode(m) {
_dkStreaksPreview.mode = m;
var el = document.getElementById('dk-streaks-preview');
if (el && window._dkStreaksPreviewSc) el.innerHTML = _perfRenderCompareStreaks(window._dkStreaksPreviewSc, m, 'dkSetStreakPreviewMode');
}







/*
   STALE / EMPTY GAME REVIEW (v30.131)
   Surfaced by the Compare score-block table, which showed a 0-9 band for
   League 8: six games carrying FinalScore 0 with no frames and no attempts
   at all. These are shells, not bad games — they drag league averages down
   and produce the "0 / -201 vs avg" Game Complete state.

   Review first, purge second, and never in one blind step: the list is
   rendered with a row per affected series, each row opening the real series
   game list (s-game-select) so the data can be inspected in the normal form
   view before anything is deleted. Deletion follows the Baker Purge
   contract — idbDeleteKeys() before the in-memory splice, because idbPutAll
   is upsert-only and a removed row would otherwise resurrect on the next
   loadScoringData().
   */
function _dkStaleGameScan() {
const out = [];
db.games.forEach(g => {
const frames = db.frames.filter(f => f.GameID === g.GameID);
const fids   = new Set(frames.map(f => f.FrameID));
const pinned = db.attempts.filter(a => fids.has(a.FrameID) && a.Pinfall !== null).length;
const score  = g.FinalScore;



const scoreOnly = pinned === 0 && score != null && score > 0;
if (pinned === 0 && !scoreOnly && (score === 0 || score == null)) {
out.push({ game: g, frames: frames.length, attempts: pinned });
}
});
return out;
}function dkReviewStaleGames() {
const stale = _dkStaleGameScan();
if (!stale.length) {
openModal('<div class="modal-title">Stale Games</div>'+
'<div style="color:var(--t3);font-size:13px;padding:8px 0">No empty game shells found. Nothing to review.</div>'+
'<button class="btn btn-secondary" style="margin-top:14px;width:100%" onclick="closeModal()">Close</button>');
return;
}

const bySeries = {};
stale.forEach(e => {
const sid = e.game.SeriesID;
if (!bySeries[sid]) bySeries[sid] = [];
bySeries[sid].push(e);
});
const rows = Object.keys(bySeries).map(sid => {
const sidN = Number(sid);
const ser = db.series.find(x => x.SeriesID === sidN);
const lg  = ser ? db.leagues.find(l => l.LeagueID === ser.LeagueID) : null;
const ct  = ser ? db.centers.find(c => c.CenterID === ser.CenterID) : null;
const list = bySeries[sid];
const allGames = db.games.filter(g => g.SeriesID === sidN);
const liveGames = allGames.length - list.length;
const date = ser?.DateBowled
? new Date(ser.DateBowled + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit'})
: '—';
return `
      <div style="padding:9px 0;border-bottom:1px solid var(--border1)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <div style="min-width:0;flex:1">
            <div style="font-size:13px;font-weight:700;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${lg?.LeagueName || 'Series '+ sidN}
            </div>
            <div style="font-size:11px;color:var(--t3);margin-top:1px">
              ${date}${ct ? ' · '+ ct.CenterName : ''} · Series ${sidN}
            </div>
            <div style="font-size:11px;color:var(--gold);margin-top:3px">
              ${list.length} empty game${list.length !== 1 ? 's': ''}
              (${list.map(e => 'G'+ (e.game.GameNumber ?? '?')).join(', ')})${liveGames > 0 ? ' · '+ liveGames + ' with data': ' · whole series is empty'}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" style="flex:0 0 auto;padding:0 10px;font-size:11px"
            onclick="dkOpenStaleSeries(${sidN})">View</button>
        </div>
      </div>`;
}).join('');
openModal(
'<div class="modal-title">Stale Games</div>'+
'<div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:10px">'+
stale.length + ' game shell'+ (stale.length !== 1 ? 's': '') + ' with no frames and no recorded pinfall, across '+
Object.keys(bySeries).length + ' series. These count toward league averages as zeros.'+
'</div>'+
'<div style="font-size:11px;color:var(--t3);margin-bottom:10px">'+
'Tap View to open a series in the normal game list and inspect it before deciding.'+
'</div>'+
'<div style="max-height:44vh;overflow-y:auto;overflow-x:clip">'+ rows + '</div>'+
'<button class="btn btn-primary" style="margin-top:14px;width:100%" onclick="dkPurgeStaleGames()">Purge all '+ stale.length + ' shell'+ (stale.length !== 1 ? 's': '') + '…</button>'+
'<button class="btn btn-secondary" style="margin-top:8px;width:100%" onclick="closeModal()">Close</button>'
);
}

function dkOpenStaleSeries(seriesID) {
const ser = db.series.find(x => x.SeriesID === seriesID);
if (!ser) { toast('Series not found'); return; }
const games = db.games.filter(g => g.SeriesID === seriesID)
.sort((a, b) => (a.GameNumber || 0) - (b.GameNumber || 0));
closeModal();
try { if (document.getElementById('dk-panel')?.style.display !== 'none') dkTogglePanel(); } catch(e) {}
G.leagueID = ser.LeagueID;
G.seriesID = seriesID;
const first = games[0];
if (first) {
G.gameID = first.GameID;
G.gameNum = first.GameNumber || 1;
G.scoreOnlyGame = db.frames.filter(f => f.GameID === first.GameID).length === 0;
}
navTo('s-game-select');
}async function dkPurgeStaleGames() {
const stale = _dkStaleGameScan();
if (!stale.length) { toast('Nothing to purge'); return; }
const gameIDs  = stale.map(e => e.game.GameID);
const frameIDs = db.frames.filter(f => gameIDs.indexOf(f.GameID) >= 0).map(f => f.FrameID);
const attIDs   = db.attempts.filter(a => frameIDs.indexOf(a.FrameID) >= 0).map(a => a.AttemptID);

const affectedSeries = [...new Set(stale.map(e => e.game.SeriesID))];
const emptiedSeries = affectedSeries.filter(sid =>
db.games.filter(g => g.SeriesID === sid && gameIDs.indexOf(g.GameID) < 0).length === 0);
const msg = 'Delete '+ gameIDs.length + ' empty game shell(s)?\n\n'+
'  '+ frameIDs.length + ' frame row(s)\n'+
'  '+ attIDs.length + ' attempt row(s)\n'+
(emptiedSeries.length
? '\n'+ emptiedSeries.length + ' series will be left with no games at all: '+
emptiedSeries.join(', ') + '.\nThose series records are LEFT IN PLACE — delete them yourself from the series list if you want them gone.\n'
: '') +
'\nThis cannot be undone. Export a backup first if unsure.';
if (!confirm(msg)) return;
db.attempts = db.attempts.filter(a => frameIDs.indexOf(a.FrameID) < 0);
db.frames   = db.frames.filter(f => gameIDs.indexOf(f.GameID) < 0);
db.games    = db.games.filter(g => gameIDs.indexOf(g.GameID) < 0);

if (attIDs.length)   await idbDeleteKeys('attempts', attIDs);
if (frameIDs.length) await idbDeleteKeys('frames',   frameIDs);
await idbDeleteKeys('games', gameIDs);
await saveAll();
gameIDs.forEach(gid => { try { localStorage.removeItem('debrief_'+ gid); } catch(e) {} });
closeModal();
toast('Purged '+ gameIDs.length + ' empty game shell(s)');
}




async function dkBackfillF10Flags() {
var f10 = db.frames.filter(function(f){ return f.FrameNumber === 10; });
if (!f10.length) { toast('No frame-10 rows found'); return; }
var attsByFrame = {};
db.attempts.forEach(function(a){
(attsByFrame[a.FrameID] = attsByFrame[a.FrameID] || []).push(a);
});
var noTapByGame = {};
db.games.forEach(function(g){ noTapByGame[g.GameID] = !!g.NoTap; });
var changed = [], noData = 0, alreadyOK = 0;
var cats = {};
f10.forEach(function(fr){
var atts = attsByFrame[fr.FrameID] || [];
var flags = deriveFrameFlags(fr, atts, noTapByGame[fr.GameID]);
if (!flags) { noData++; return; }
if (!!fr.Strike === flags.Strike && !!fr.Spare === flags.Spare) { alreadyOK++; return; }
var before = fr.Strike ? 'X': fr.Spare ? '/': 'open';
var after  = flags.Strike ? 'X': flags.Spare ? '/': 'open';
var key = before + ' \u2192 '+ after;
if (!cats[key]) cats[key] = { key: key, n: 0, samples: [] };
cats[key].n++;
if (cats[key].samples.length < 3) {
var seq = atts.slice().sort(function(a,b){ return a.Attempt - b.Attempt; })
.map(function(a){ return a.Pinfall === null || a.Pinfall === undefined ? '_': a.Pinfall; }).join(',');
cats[key].samples.push('G'+ fr.GameID + (noTapByGame[fr.GameID] ? ' NoTap': '') + ' ['+ seq + ']');
}
changed.push({ fr: fr, flags: flags });
});



var cleanBefore = db.frames.filter(function(f){ return f.Strike || f.Spare; }).length;
var cleanAfter  = cleanBefore + changed.filter(function(c){ return c.flags.Strike || c.flags.Spare; }).length
- changed.filter(function(c){ return c.fr.Strike || c.fr.Spare; }).length;
var framesWithData = db.frames.filter(function(f){
return (attsByFrame[f.FrameID] || []).some(function(a){ return a.Attempt === 1 && a.Pinfall !== null; });
}).length;
var pctB = framesWithData ? Math.round(cleanBefore / framesWithData * 100) : 0;
var pctA = framesWithData ? Math.round(cleanAfter  / framesWithData * 100) : 0;
var catRows = Object.keys(cats).sort(function(a,b){ return cats[b].n - cats[a].n; }).map(function(k){
var c = cats[k];
return '<div style="padding:7px 0;border-bottom:1px solid var(--border1)">'+
'<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">'+
'<span style="font-size:13px;font-weight:700;color:var(--t1)">'+ c.key + '</span>'+
'<span style="font-size:13px;font-weight:800;color:var(--teal)">'+ c.n + '</span>'+
'</div>'+
'<div style="font-size:10px;color:var(--t3);margin-top:2px;word-break:break-word">'+
c.samples.join(' \u00b7 ') + '</div>'+
'</div>';
}).join('');
var summary =
'<div class="modal-title">Frame 10 Flags</div>'+
'<div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:10px">'+
'Frame 10 never had its Strike/Spare flags written, so historical 10th frames read as opens '+
'no matter what was thrown. These flags are not shown anywhere directly \u2014 they feed Clean %, '+
'the game-card mark counts, and streak brackets.'+
'</div>'+
'<div style="display:flex;gap:8px;margin-bottom:12px">'+
'<div style="flex:1;background:var(--bg3);border-radius:8px;padding:8px;text-align:center">'+
'<div style="font-size:10px;color:var(--t3)">SCANNED</div>'+
'<div style="font-size:18px;font-weight:800;color:var(--t1)">'+ f10.length + '</div></div>'+
'<div style="flex:1;background:var(--bg3);border-radius:8px;padding:8px;text-align:center">'+
'<div style="font-size:10px;color:var(--t3)">CORRECT</div>'+
'<div style="font-size:18px;font-weight:800;color:var(--t3)">'+ alreadyOK + '</div></div>'+
'<div style="flex:1;background:var(--bg3);border-radius:8px;padding:8px;text-align:center">'+
'<div style="font-size:10px;color:var(--t3)">TO FIX</div>'+
'<div style="font-size:18px;font-weight:800;color:var(--teal)">'+ changed.length + '</div></div>'+
'</div>';
if (!changed.length) {
openModal(summary +
'<div style="color:var(--t3);font-size:13px;padding:6px 0">Every frame-10 row already carries the correct flags. Nothing to do.</div>'+
(noData ? '<div style="font-size:11px;color:var(--t3)">'+ noData + ' skipped (no first-ball pinfall).</div>': '') +
'<button class="btn btn-secondary" style="margin-top:14px;width:100%" onclick="closeModal()">Close</button>');
return;
}
openModal(summary +
'<div style="font-size:11px;font-weight:700;color:var(--t3);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:2px">Changes by transition</div>'+
'<div style="max-height:34vh;overflow-y:auto;overflow-x:clip">'+ catRows + '</div>'+
'<div style="background:var(--bg3);border-radius:8px;padding:9px;margin-top:12px">'+
'<div style="font-size:10px;color:var(--t3);letter-spacing:0.5px">EFFECT ON CLEAN %</div>'+
'<div style="font-size:15px;font-weight:800;color:var(--t1);margin-top:2px">'+
pctB + '% \u2192 <span style="color:var(--teal)">'+ pctA + '%</span>'+
'</div>'+
'<div style="font-size:10px;color:var(--t3);margin-top:2px">'+ cleanBefore + ' \u2192 '+ cleanAfter + ' clean frames of '+ framesWithData + '</div>'+
'</div>'+
(noData ? '<div style="font-size:11px;color:var(--t3);margin-top:8px">'+ noData + ' skipped (no first-ball pinfall).</div>': '') +
'<div style="font-size:11px;color:var(--t3);margin-top:10px;line-height:1.45">'+
'First-rack semantics: Strike = first ball struck; Spare = it did not and the first two made ten. '+
'Marks earned on fill balls are not represented in the flags.'+
'</div>'+
'<button class="btn btn-primary" style="margin-top:12px;width:100%" onclick="dkApplyF10Flags()">Apply '+ changed.length + ' fix'+ (changed.length !== 1 ? 'es': '') + '</button>'+
'<button class="btn btn-secondary" style="margin-top:8px;width:100%" onclick="closeModal()">Cancel</button>');
window._dkF10Pending = changed;
}async function dkApplyF10Flags() {
var changed = window._dkF10Pending || [];
if (!changed.length) { toast('Nothing to apply'); return; }
changed.forEach(function(c){ c.fr.Strike = c.flags.Strike; c.fr.Spare = c.flags.Spare; });
await saveAll();
window._dkF10Pending = null;
closeModal();
toast('Updated '+ changed.length + ' frame-10 row(s)');
}async function dkBakerPurgeShells() {
var strays = db.games.filter(function(g){ return bakerSeriesIsBaker(g.SeriesID); });
if (!strays.length) { alert('No db.games rows exist in any Baker-format round. Nothing to purge.'); return; }
var empty = [], dirty = [];
strays.forEach(function(g){
var fids = db.frames.filter(function(f){ return f.GameID===g.GameID; }).map(function(f){ return f.FrameID; });
var hasPins = db.attempts.some(function(a){ return fids.indexOf(a.FrameID)>=0 && a.Pinfall!=null; });
(hasPins ? dirty : empty).push(g);
});
var msg = 'Baker rounds contain '+ strays.length + ' personal game row(s):\n'+
'  '+ empty.length + ' empty shell(s) → will be deleted: '+ empty.map(function(g){return 'GameID '+g.GameID+' (Series '+g.SeriesID+' G'+g.GameNumber+')';}).join(', ') + '\n'+
(dirty.length ? '  '+ dirty.length + ' with real pinfall → LEFT ALONE, review manually: '+ dirty.map(function(g){return 'GameID '+g.GameID;}).join(', ') + '\n': '') +
'\nDelete the empty shell(s) now?';
if (!empty.length) { alert(msg.replace('\nDelete the empty shell(s) now?','')); return; }
if (!confirm(msg)) return;
var gameIDs  = empty.map(function(g){ return g.GameID; });
var frameIDs = db.frames.filter(function(f){ return gameIDs.indexOf(f.GameID)>=0; }).map(function(f){ return f.FrameID; });
var attIDs   = db.attempts.filter(function(a){ return frameIDs.indexOf(a.FrameID)>=0; }).map(function(a){ return a.AttemptID; });
db.attempts = db.attempts.filter(function(a){ return frameIDs.indexOf(a.FrameID)<0; });
db.frames   = db.frames.filter(function(f){ return gameIDs.indexOf(f.GameID)<0; });
db.games    = db.games.filter(function(g){ return gameIDs.indexOf(g.GameID)<0; });
await idbDeleteKeys('attempts', attIDs);
await idbDeleteKeys('frames',   frameIDs);
await idbDeleteKeys('games',    gameIDs);
await saveAll();
alert('Purged '+ gameIDs.length + ' shell game(s), '+ frameIDs.length + ' frames, '+ attIDs.length + ' attempts. Close DevKit and re-open the tournament.');
try { bakerRefreshAfterMigration(); } catch(e) {}
}



async function dkBallChangeRetrospectiveDryRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
var beforeMutCheck = JSON.stringify({ games: (db.games || []).length, frames: (db.frames || []).length, attempts: (db.attempts || []).length });
var r = ballChangeRetrospective();
var out = [];
out.push('BALL-CHANGE RETROSPECTIVE DRY RUN — read-only');
out.push('Lane-side-aware true-change detection (frame parity), Step 1 outcome grading only.');
out.push('');
out.push('Complete (10-frame) games considered: '+ r.gamesConsidered);
out.push('Games with >=1 true change event: '+ r.gamesWithChange +
' ('+ (r.gamesConsidered ? Math.floor(r.gamesWithChange / r.gamesConsidered * 1000) / 10 : 0) + '%)');
out.push('Total true-change events: '+ r.totalEvents);
out.push('');
out.push('Step 1 outcome grading (2+ strikes/3 same-side frames = positive, 0 = negative, 1 = neutral):');
out.push('  Positive: '+ r.counts.positive + ' ('+ r.pct.positive + '%)');
out.push('  Neutral:  '+ r.counts.neutral  + ' ('+ r.pct.neutral  + '%)');
out.push('  Negative: '+ r.counts.negative + ' ('+ r.pct.negative + '%)');
out.push('');
out.push('Design-doc reference target: ~771 events / 338 games / 30.7% / 41.5% / 27.8%.');
var afterMutCheck = JSON.stringify({ games: (db.games || []).length, frames: (db.frames || []).length, attempts: (db.attempts || []).length });
out.push('');
out.push('MUTATION CHECK: '+ (beforeMutCheck === afterMutCheck ? 'PASS - no writes': 'FAIL - dry run mutated scoring data'));
if (result) result.textContent = out.join('\n');
toast('Ball-Change Retrospective complete');
} catch (e) {
if (result) result.textContent = 'Ball-Change Retrospective failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}


async function dkBallChangeStep2DryRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
var beforeMutCheck = JSON.stringify({ games: (db.games || []).length, frames: (db.frames || []).length, attempts: (db.attempts || []).length });
var cells = ballChangeStep2Join();
var pad = function(s, n) { s = (s == null ? '—': String(s)); return s.length > n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
var out = [];
out.push('BALL-CHANGE RETROSPECTIVE — STEP 2 JOIN DRY RUN — read-only');
out.push('Bucket: deltaDir (Layer 2 totalHook direction) x triggerLeaveSide (Layer 1 axis 3)');
out.push('Interpretive lens only — never mixed back into Step 1 grading.');
out.push('');
out.push(pad('deltaDir', 10) + pad('side', 8) + pad('n', 6) + pad('pos%', 7) + pad('neu%', 7) + pad('neg%', 7) + 'gate');
cells.forEach(function(c) {
out.push(pad(c.deltaDir, 10) + pad(c.triggerLeaveSide, 8) + pad(c.n, 6) +
pad(c.pct.positive, 7) + pad(c.pct.neutral, 7) + pad(c.pct.negative, 7) +
(c.gated ? 'OK (n>=15)': 'below gate'));
});
out.push('');
out.push('Cells clearing n>=15 gate: '+ cells.filter(function(c){ return c.gated; }).length + ' of '+ cells.length);
var afterMutCheck = JSON.stringify({ games: (db.games || []).length, frames: (db.frames || []).length, attempts: (db.attempts || []).length });
out.push('');
out.push('MUTATION CHECK: '+ (beforeMutCheck === afterMutCheck ? 'PASS - no writes': 'FAIL - dry run mutated scoring data'));
if (result) result.textContent = out.join('\n');
toast('Step 2 join dry run complete');
} catch (e) {
if (result) result.textContent = 'Step 2 join dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}



async function dkBallMotionProfileInspector() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Computing ball motion profiles...';
try {
var pad = function(s, n) { s = (s == null ? '—': String(s)); return s.length > n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
var out = [];
out.push('BALL MOTION PROFILE INSPECTOR — read-only, review/approve only');
out.push('Layer 2: pure function of current specs + latest logged surface prep (never box specs alone).');
out.push('Flags a disagreement when |derived total hook - rated HookRating| >= '+ BMP_DISAGREEMENT_THRESHOLD + ' (0-10 scale).');
out.push('');
out.push(pad('Ball', 20) + pad('Rated', 7) + pad('Derived', 9) + pad('Δ', 6) + pad('Surface', 20) + 'Flag');
var flaggedCount = 0, missingSpecCount = 0;
(db.balls || []).forEach(function(b) {
var profile = ballMotionProfile(b);
if (!profile || profile.totalHookDerived == null) {
missingSpecCount++;
out.push(pad(b.BallName, 20) + pad(b.HookRating, 7) + pad('—', 9) + pad('—', 6) + pad('insufficient specs', 20) + '');
return;
}
var rated = b.HookRating;
var derived = Math.floor(profile.totalHookDerived * 10) / 10;
var delta = (rated != null) ? Math.floor(Math.abs(derived - rated) * 10) / 10 : null;
var flagged = (delta != null && delta >= BMP_DISAGREEMENT_THRESHOLD);
if (flagged) flaggedCount++;
out.push(pad(b.BallName, 20) + pad(rated, 7) + pad(derived, 9) + pad(delta, 6) + pad(profile.surfaceSource, 20) + (flagged ? '⚠ FLAG': ''));
});
out.push('');
out.push('Total balls: '+ (db.balls || []).length + ' | Flagged disagreements: '+ flaggedCount + ' | Insufficient specs: '+ missingSpecCount);
if (result) result.textContent = out.join('\n');
toast('Ball Motion Profile Inspector complete');
} catch (e) {
if (result) result.textContent = 'Ball Motion Profile Inspector failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}async function dkExportFullSnapshot() {
let withImages = false;
try { withImages = confirm('Include ball images?\n\nThey are base64 encoded and can add several MB. Choose Cancel for a smaller file — images re-download from GitHub on the new device.'); }
catch(e) {}
toast('Building snapshot…');
const snap = await buildFullSnapshot(withImages);
const json = JSON.stringify(snap);
const lsCount = Object.keys(snap.localStorage).length;
const idbCount = SNAPSHOT_IDB_STORES.reduce((n, k) => n + ((snap.idb[k] || []).length), 0);
const blob = new Blob([json], { type: 'application/json'});
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'BowlingDB_Snapshot_'+ new Date().toISOString().slice(0, 10) + '.json';
document.body.appendChild(a); a.click(); a.remove();
setTimeout(() => URL.revokeObjectURL(url), 4000);
openModal(
'<div class="modal-title">Full Snapshot</div>'+
'<div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:10px">'+
'Complete device replication \u2014 scoring data, reference tables, every preference, '+
'the lane library, recalled context, and cached debriefs.'+
'</div>'+
'<div style="display:flex;gap:8px;margin-bottom:10px">'+
'<div style="flex:1;background:var(--bg3);border-radius:8px;padding:8px;text-align:center">'+
'<div style="font-size:10px;color:var(--t3)">SIZE</div>'+
'<div style="font-size:16px;font-weight:800;color:var(--t1)">'+ (json.length / 1048576).toFixed(1) + ' MB</div></div>'+
'<div style="flex:1;background:var(--bg3);border-radius:8px;padding:8px;text-align:center">'+
'<div style="font-size:10px;color:var(--t3)">SETTINGS</div>'+
'<div style="font-size:16px;font-weight:800;color:var(--t1)">'+ lsCount + '</div></div>'+
'<div style="flex:1;background:var(--bg3);border-radius:8px;padding:8px;text-align:center">'+
'<div style="font-size:10px;color:var(--t3)">IDB ROWS</div>'+
'<div style="font-size:16px;font-weight:800;color:var(--t1)">'+ idbCount + '</div></div>'+
'</div>'+
'<div style="font-size:11px;color:var(--t3);line-height:1.45">'+
'Ball images '+ (withImages ? 'included': 'excluded') + '. Your API key is never written to the file \u2014 re-enter it on the new device.'+
'</div>'+
'<button class="btn btn-secondary" style="margin-top:14px;width:100%" onclick="closeModal()">Close</button>'
);
} 
function dkIsEnabled() {
try { return !!(JSON.parse(localStorage.getItem(DK_CFG_KEY)||'{}').enabled); }
catch(e) { return false; }
}function dkSetDevMode(on) {
try {
var cfg = JSON.parse(localStorage.getItem(DK_CFG_KEY)||'{}');
cfg.enabled = !!on;
localStorage.setItem(DK_CFG_KEY, JSON.stringify(cfg));
} catch(e) {}
if (!on) { dkSetVisible(false); if (_dk.panelOpen) dkTogglePanel(); }
openSettingsModal();
}function dkClearLog() {
if (!confirm('Clear all DevKit log entries?')) return;
localStorage.removeItem(DK_KEY);
openSettingsModal();
toast('DevLog cleared');
} 
function dkLoadLog() {
try { return JSON.parse(localStorage.getItem(DK_KEY)||'[]'); } catch(e) { return []; }
}function dkSaveLog(log) {
try { localStorage.setItem(DK_KEY, JSON.stringify(log)); } catch(e) {}
}function dkGetApiKey() {
return localStorage.getItem('bowlingdb_ai_key') || '';
} 
function dkHeaderTap() {
if (!dkIsEnabled()) return;
_dk.tapCount++;
clearTimeout(_dk.tapTimer);
_dk.tapTimer = setTimeout(function(){ _dk.tapCount = 0; }, 600);
if (_dk.tapCount >= 3) {
_dk.tapCount = 0;
clearTimeout(_dk.tapTimer);
dkSetVisible(!_dk.visible);
}
} 
function dkSetVisible(on) {
_dk.visible = on;
var btn   = document.getElementById('dk-toggle');
var badge = document.getElementById('dk-version');
var scLbl = document.getElementById('dk-screen-label');
if (btn)   btn.style.display   = on ? 'flex': 'none';
if (badge) badge.style.display = on ? 'block': 'none';
if (scLbl) scLbl.style.display = on ? 'block': 'none';
if (on) dkUpdateScreenLabel(); 
if (!on && _dk.panelOpen) dkTogglePanel();
}

function dkUpdateScreenLabel() {
if (!_dk.visible) return;
var el = document.getElementById('dk-screen-label');
if (el) el.textContent = dkmScreenKey();
} 
function dkTogglePanel() {
_dk.panelOpen = !_dk.panelOpen;
var panel = document.getElementById('dk-panel');
if (!panel) return;
if (_dk.panelOpen) {
panel.classList.add('dk-open');
dkRegenerateCodeMap();
if (!_dk.mapLoaded) { dkmInit(); _dk.mapLoaded = true; }
dkRenderTab(_dk.tab);
var scEl = document.getElementById('dk-header-screen');
if (scEl) scEl.textContent = getCurrentScreen();
} else {
panel.classList.remove('dk-open');
if (_dk.inspecting) dkToggleInspect();
toastDismiss(); 
}
} 
function dkTab(name) {
_dk.tab = name;
['entries','map','state','tools'].forEach(function(t) {
var pane = document.getElementById('dk-pane-'+t);
if (pane) pane.style.display = (t === name) ? (t === 'map'? 'flex': 'block') : 'none';
});




document.querySelectorAll('.dk-tab').forEach(function(tab) {
var fn = tab.getAttribute('onclick') || '';
tab.classList.toggle('dk-active', fn.indexOf("dkTab('"+ name + "')") >= 0);
});
if (name === 'map') {
if (!_dk.mapLoaded) { dkmInit(); _dk.mapLoaded = true; }
dkmRenderBreadcrumb();
}
dkRenderTab(name);
}function dkRenderTab(name) {
['entries','map','state','idb','tools'].forEach(function(t) {
var pane = document.getElementById('dk-pane-'+t);
if (pane) pane.style.display = (t === name) ? (t==='idb'?'flex':'block') : 'none';
});
if (name === 'entries') dkRenderEntries();
if (name === 'state')   dkRenderState();
if (name === 'idb')     dkIdbRender();




}function dkIdbGetRecords(tableName) {

if (['series','games','frames','attempts'].indexOf(tableName) !== -1) {
return Promise.resolve({ type:'idb', records: db[tableName] ? db[tableName].slice() : [] });
}

if (tableName === 'ballImages') {
return idbCount('ballImages').then(function(n){ return { type:'count', count:n }; })
.catch(function(){ return { type:'count', count:'?'}; });
}

var def = DK_LS_TABLES[tableName];
if (!def) return Promise.resolve({ type:'ls', records: [] });
var records;
if (def.src === 'db') {
records = db[tableName] ? db[tableName].slice() : [];
} else {
try { records = JSON.parse(localStorage.getItem(def.key) || 'null') || []; }
catch(e) { records = []; }

if (!Array.isArray(records)) records = [records];
}
return Promise.resolve({ type:'ls', records: records });
}function dkIdbTogglePin(key) {
_dkIdb.pins[key] = !_dkIdb.pins[key];
var el = document.getElementById('dk-idb-pin-'+ key);
if (el) el.classList.toggle('sel', _dkIdb.pins[key]);
dkIdbRender();
}function dkIdbRender() {
var tableEl  = document.getElementById('dk-idb-table');
var scopeEl  = document.getElementById('dk-idb-scope');
var bodyEl   = document.getElementById('dk-idb-body');
var fieldRow = document.getElementById('dk-idb-field-row');
if (!bodyEl) return;
var tableVal  = tableEl ? tableEl.value : 'idb:attempts';
var scope     = scopeEl ? scopeEl.value : 'all';
var parts     = tableVal.split(':');
var tableName = parts[1] || parts[0];

if (fieldRow) fieldRow.style.display = (tableName === 'attempts') ? 'flex': 'none';
bodyEl.innerHTML = '<div style="color:var(--t3);text-align:center;padding:20px">Loading\u2026</div>';
dkIdbGetRecords(tableName).then(function(result) {

if (result.type === 'count') {
bodyEl.innerHTML = '<div style="text-align:center;padding:24px">'+
'<div style="font-size:32px;color:var(--teal);font-weight:700">'+ result.count + '</div>'+
'<div style="color:var(--t3);margin-top:4px">ball image records</div>'+
'<div style="font-size:10px;color:var(--t3);margin-top:8px">Binary data — not shown inline</div></div>';
return;
}
var records = result.records;

if (scope === 'current'&& G.gameID) {
if (tableName === 'attempts') {
var fids = new Set((db.frames||[]).filter(function(f){ return f.GameID===G.gameID; }).map(function(f){ return f.FrameID; }));
records = records.filter(function(a){ return fids.has(a.FrameID); });
} else if (tableName === 'frames') {
records = records.filter(function(f){ return f.GameID===G.gameID; });
} else if (tableName === 'games') {
records = records.filter(function(g){ return g.GameID===G.gameID; });
}
}

if (tableName === 'attempts') {
records = records.slice().sort(function(a,b){
if (a.FrameNumber!==b.FrameNumber) return (a.FrameNumber||0)-(b.FrameNumber||0);
return (a.Attempt||0)-(b.Attempt||0);
});
} else if (tableName === 'frames') {
records = records.slice().sort(function(a,b){ return (a.FrameNumber||0)-(b.FrameNumber||0); });
}
if (!records.length) {
bodyEl.innerHTML = '<div style="color:var(--t3);text-align:center;padding:20px">No records</div>';
return;
}
var pins = _dkIdb.pins;
function srcBadge(src) {
if (!src) return '<span class="dk-idb-badge dk-idb-badge-null">null</span>';
var cls = {'auto':'dk-idb-badge-auto','prompted':'dk-idb-badge-prompted','user':'dk-idb-badge-user'}[src] || 'dk-idb-badge-null';
return '<span class="dk-idb-badge '+ cls + '">'+ src + '</span>';
}
function valSpan(val) {
if (val === null || val === undefined) return '<span style="color:var(--t3)">null</span>';
return '<span style="color:var(--teal)">'+ _escHtml(String(val)) + '</span>';
}
function buildChildHTML(rec) {
var children = [], childLabel = '';
if (tableName === 'frames') {
children = (db.attempts||[]).filter(function(a){ return a.FrameID===rec.FrameID; })
.sort(function(a,b){ return (a.Attempt||0)-(b.Attempt||0); });
childLabel = 'Attempts';
} else if (tableName === 'games') {
children = (db.frames||[]).filter(function(f){ return f.GameID===rec.GameID; })
.sort(function(a,b){ return (a.FrameNumber||0)-(b.FrameNumber||0); });
childLabel = 'Frames';
} else if (tableName === 'series') {
children = (db.games||[]).filter(function(g){ return g.SeriesID===rec.SeriesID; });
childLabel = 'Games';
} else if (tableName === 'balls') {
children = (db.surfaces||[]).filter(function(s){ return s.BallID===rec.BallID; });
childLabel = 'Surface Records';
} else if (tableName === 'leagues') {
children = (db.series||[]).filter(function(s){ return s.LeagueID===rec.LeagueID; });
childLabel = 'Series';
}
if (!children.length) return '';
var rows = children.map(function(c) {
var keys = Object.keys(c);
var title = '';
if (tableName==='frames')  title = 'Att '+ (c.Attempt||'?') + ' · pf:'+ (c.Pinfall!==null&&c.Pinfall!==undefined?c.Pinfall:'—') + (c.PocketEntry?' · '+c.PocketEntry:'') + (c.PocketEntrySource?' ['+c.PocketEntrySource+']':'') + (c.BallRoll?' · roll:'+c.BallRoll:'');
else if (tableName==='games')   title = 'F'+(c.FrameNumber||'?')+' · '+(c.Score!==null&&c.Score!==undefined?c.Score:'—')+(c.IsStrike?' ✕':c.IsSpare?' /':'');
else if (tableName==='series')  title = 'G'+(c.GameNumber||'?')+(c.FinalScore!==null&&c.FinalScore!==undefined?' · '+c.FinalScore:'');
else if (tableName==='balls')   title = (c.PrepDate||c.Date||'') + ' · '+ (c.Grit||'') + (c.Polished?' Polished':'');
else if (tableName==='leagues') title = 'S'+(c.SeriesID||'?')+' · '+(c.Date||'');
else { title = _escHtml(String(c[keys[0]]||'')); }
return '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:10px;color:var(--t2)">'+ _escHtml(title) + '</div>';
}).join('');
return '<div style="margin-top:8px;background:rgba(0,0,0,0.3);border-radius:6px;padding:6px 8px">'+
'<div style="font-size:9px;color:var(--t3);font-weight:700;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">'+
childLabel + ' ('+ children.length + ')</div>'+ rows + '</div>';
}
function rowSummary(rec) {
var head = [], badges = [];
if (tableName === 'attempts') {
head.push('<span style="color:var(--purple);font-weight:700">F'+(rec.FrameNumber||'?')+' A'+(rec.Attempt||'?')+'</span>');
head.push('<span style="color:var(--t2);margin-left:6px">pf:'+(rec.Pinfall!==null?rec.Pinfall:'—')+'</span>');
if (pins.leave)  badges.push('<span style="color:var(--t3)">leave:</span>'+valSpan(rec.LeaveID));
if (pins.pocket) badges.push('<span style="color:var(--t3)">entry:</span>'+valSpan(rec.PocketEntry));
if (pins.pesrc)  badges.push(srcBadge(rec.PocketEntrySource));
if (pins.broll)  badges.push('<span style="color:var(--t3)">roll:</span>'+valSpan(rec.BallRoll));
if (pins.brsrc)  badges.push(srcBadge(rec.BallRollSource));
} else if (tableName === 'frames') {
head.push('<span style="color:var(--purple);font-weight:700">F'+(rec.FrameNumber||'?')+'</span>');
head.push('<span style="color:var(--t2);margin-left:6px">score:'+(rec.Score!==null&&rec.Score!==undefined?rec.Score:'—')+'</span>');
if (rec.IsStrike) badges.push('<span class="dk-idb-badge dk-idb-badge-user">Strike</span>');
else if (rec.IsSpare) badges.push('<span class="dk-idb-badge dk-idb-badge-prompted">Spare</span>');
badges.push('<span style="color:var(--t3)">rt:</span>'+valSpan(rec.RunningTotal));
} else if (tableName === 'games') {
head.push('<span style="color:var(--purple);font-weight:700">G'+(rec.GameNumber||'?')+'</span>');
head.push('<span style="color:var(--t2);margin-left:6px">'+(rec.FinalScore!==null&&rec.FinalScore!==undefined?rec.FinalScore:'in progress')+'</span>');
badges.push('<span style="color:var(--t3)">ID:</span>'+valSpan(rec.GameID));
} else if (tableName === 'series') {
head.push('<span style="color:var(--purple);font-weight:700">S'+(rec.SeriesID||'?')+'</span>');
head.push('<span style="color:var(--t2);margin-left:6px">'+_escHtml(String(rec.Date||rec.SeriesDate||''))+'</span>');
badges.push('<span style="color:var(--t3)">league:</span>'+valSpan(rec.LeagueID));
} else if (tableName === 'balls') {
head.push('<span style="color:var(--purple);font-weight:700">'+_escHtml(String(rec.BallName||rec.Name||rec.BallID||'?'))+'</span>');
badges.push('<span style="color:var(--t3)">ID:</span>'+valSpan(rec.BallID));
badges.push(valSpan(rec.Brand));
} else if (tableName === 'bowlers') {
head.push('<span style="color:var(--purple);font-weight:700">'+_escHtml(String(rec.Name||rec.BowlerName||'?'))+'</span>');
if (rec.IsMe) badges.push('<span class="dk-idb-badge dk-idb-badge-user">ME</span>');
badges.push('<span style="color:var(--t3)">avg:</span>'+valSpan(rec.Average||rec.Avg));
} else if (tableName === 'leagues') {
head.push('<span style="color:var(--purple);font-weight:700">'+_escHtml(String(rec.LeagueName||rec.Name||'?'))+'</span>');
badges.push('<span style="color:var(--t3)">center:</span>'+valSpan(rec.CenterID));
badges.push('<span style="color:var(--t3)">hdcp:</span>'+valSpan(rec.Handicap));
} else if (tableName === 'centers') {
head.push('<span style="color:var(--purple);font-weight:700">'+_escHtml(String(rec.CenterName||rec.Name||'?'))+'</span>');
badges.push(valSpan(rec.City));
} else if (tableName === 'leaves') {
head.push('<span style="color:var(--purple);font-weight:700">'+_escHtml(String(rec.DisplayName||rec.LeaveID||'?'))+'</span>');
badges.push('<span style="color:var(--t3)">ID:</span>'+valSpan(rec.LeaveID));
badges.push(valSpan(rec.PinCount));
} else if (tableName === 'patterns') {
head.push('<span style="color:var(--purple);font-weight:700">'+_escHtml(String(rec.PatternName||rec.Name||'?'))+'</span>');
badges.push('<span style="color:var(--t3)">length:</span>'+valSpan(rec.Length));
} else if (tableName === 'spare_alignments') {
var _saLeaf = (db.leaves||[]).find(function(l){return l.LeaveID===rec.leaveID;});
head.push('<span style="color:var(--purple);font-weight:700">'+_escHtml(String((_saLeaf&&_saLeaf.DisplayName)||rec.leaveID||'?'))+'</span>');
badges.push('<span style="color:var(--t3)">ID:</span>'+valSpan(rec.leaveID));
badges.push('<span style="color:var(--t3)">sb:</span>'+valSpan(rec.sb));
badges.push('<span style="color:var(--t3)">tb:</span>'+valSpan(rec.tb));
} else {

var keys = Object.keys(rec);
head.push('<span style="color:var(--purple);font-weight:700">'+_escHtml(String(rec[keys[0]]||''))+'</span>');
keys.slice(1,4).forEach(function(k){ badges.push('<span style="color:var(--t3)">'+_escHtml(k)+':</span>'+valSpan(rec[k])); });
}
return { head:head, badges:badges };
}
var html = '';
records.forEach(function(rec, idx) {
var s = rowSummary(rec);
var expandID = 'dk-idb-exp-'+ idx;
var childHTML = buildChildHTML(rec);
var fullJSON = JSON.stringify(rec, null, 2);
html += '<div class="dk-idb-row" onclick="dkIdbToggleExpand(\''+ expandID + '\')">'+
'<div class="dk-idb-row-head">'+ s.head.join('') + '</div>'+
(s.badges.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:3px">'+ s.badges.join('') + '</div>': '') +
'<div class="dk-idb-expand" id="'+ expandID + '">'+
childHTML +
'<div style="margin-top:8px;font-size:9px;color:var(--t3);font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Full Record</div>'+
'<div style="margin-top:4px;background:rgba(0,0,0,0.3);border-radius:6px;padding:6px 8px;white-space:pre-wrap;word-break:break-all">'+ _escHtml(fullJSON) + '</div>'+
'<div style="margin-top:6px">'+
'<span onclick="event.stopPropagation();dkIdbCopyRecord(\''+ expandID + '\')" '+
'style="color:var(--teal);cursor:pointer;font-size:10px;margin-right:12px">⧉ Copy JSON</span>'+
'</div>'+
'</div>'+
'</div>';
});
html += '<div style="color:var(--t3);font-size:10px;text-align:center;padding:10px">'+
records.length + ' record'+ (records.length===1?'':'s') + '</div>';
bodyEl.innerHTML = html;
});
}function dkIdbToggleExpand(id) {
var el = document.getElementById(id);
if (el) el.classList.toggle('open');
}function dkIdbCopyRecord(expandID) {
var el = document.getElementById(expandID);
if (!el) return;

var pre = el.querySelector('div[style*="pre-wrap"]');
var text = pre ? pre.textContent : el.textContent.replace('\u29C7 Copy JSON','').trim();
if (navigator.clipboard) {
navigator.clipboard.writeText(text).then(function(){ toast('Copied'); });
} else {
var ta = document.createElement('textarea');
ta.value = text; document.body.appendChild(ta); ta.select();
document.execCommand('copy'); document.body.removeChild(ta);
toast('Copied');
}
}function dkIdbExport() {
var tableEl = document.getElementById('dk-idb-table');
var scopeEl = document.getElementById('dk-idb-scope');
var tableVal  = tableEl ? tableEl.value : 'idb:attempts';
var parts     = tableVal.split(':');
var tableName = parts[1] || parts[0];
var scope     = scopeEl ? scopeEl.value : 'all';
dkIdbGetRecords(tableName).then(function(result) {
if (result.type === 'count') { toast('ballImages: binary data, export not supported'); return; }
var records = result.records;

if (scope === 'current'&& G.gameID) {
if (tableName === 'attempts') {
var fids = new Set((db.frames||[]).filter(function(f){ return f.GameID===G.gameID; }).map(function(f){ return f.FrameID; }));
records = records.filter(function(a){ return fids.has(a.FrameID); });
} else if (tableName === 'frames') {
records = records.filter(function(f){ return f.GameID===G.gameID; });
} else if (tableName === 'games') {
records = records.filter(function(g){ return g.GameID===G.gameID; });
}
}
if (!records.length) { toast('No records to export'); return; }
var ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
var filename = 'bowlingdb_'+ tableName + '_'+ scope + '_'+ ts + '.json';
var blob = new Blob([JSON.stringify(records, null, 2)], { type:'application/json'});
var url = URL.createObjectURL(blob);
var a = document.createElement('a');
a.href = url; a.download = filename;
document.body.appendChild(a); a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);
toast('Exported '+ records.length + ' records → '+ filename);
});
}/* Bug fix (v30.127): dkRenderEntries() previously had no error handling at
   all — a single malformed/legacy entry (old field shape from an earlier
   app version, still sitting in localStorage under DK_KEY) throwing inside
   _entryHTML() would abort this ENTIRE function. Since dkmSaveQuickLog()
   and dkSubmit() both call this synchronously and only clear the
   textarea/show the "saved" feedback on the lines AFTER it, that throw
   silently ate the confirmation — the entry actually saved to localStorage,
   but the form looked stuck (no toast, text still in the box) and the
   uncaught exception was left as unhandled console noise. Two layers of
   defense: (1) a bad individual entry is skipped rather than killing the
   whole render, (2) the function overall never throws, so it can never
   again block whatever called it. */
function dkRenderEntries() {
try {
var filter = _dk.activeFilter || 'all';

var dkmEntries = (typeof DKM_ROWS !== 'undefined'? DKM_ROWS : [])
.filter(function(r){ return r.desc || r.desired || r.notes || r.ref; })
.map(function(r){

var entryStatus = (r.status==='ok'||r.status==='working') ? 'fixed'
: r.status==='wontfix'? 'wontfix'
: 'open';
return {
id:       r.id,
ts:       r._ts || new Date(r.id).toISOString(),
cat:      r.cat || 'note',
msg:      r.desc || r.object || '',
screen:   r.form || '',
ref:      r.ref  || null,
mapRowId: r.id,
status:   entryStatus,
snap:     null,
_dkmRow:  true
};
});

var standalone = dkLoadLog().filter(function(e){ return !e.mapRowId; })
.sort(function(a,b){ return b.id - a.id; });
var all = standalone.concat(dkmEntries.sort(function(a,b){ return b.id - a.id; }));

var filtered = filter === 'all'? all : all.filter(function(e){
return (e.status||'open') === filter;
});
var html = filtered.length
? filtered.map(function(e){


try { return _entryHTML(e); }
catch(rowErr) { console.warn('dkRenderEntries: skipped unrenderable entry', e && e.id, rowErr); return ''; }
}).join('')
: '<div style="padding:32px 16px;text-align:center;color:var(--t3);font-size:13px">No '+(filter==='all'?'logged items':filter+' entries')+'.</div>';
var el = document.getElementById('dk-entries-list');
if (el) el.innerHTML = html;
} catch(err) {
console.error('dkRenderEntries failed:', err);
var elErr = document.getElementById('dk-entries-list');
if (elErr) elErr.innerHTML = '<div style="padding:16px;color:var(--red);font-size:12px">Entries list failed to render — see console.</div>';
}
} 
function dkSubmit() {
var msgEl = document.getElementById('dk-msg');
var msg   = (msgEl ? msgEl.value : '').trim();
if (!msg) { toast('Add a description first'); return; }
var snap = null;
try {
snap = {
screen:    getCurrentScreen(),
leagueID:  G.leagueID || null,
seriesID:  G.seriesID || null,
gameID:    G.gameID   || null,
frameNum:  G.frameNum || null,
mode:      G.mode     || null,
modalOpen: !!(document.getElementById('modal-bg') && document.getElementById('modal-bg').classList.contains('open'))
};
} catch(ex) { snap = {error: ex.message}; }
var entry = {
id:       Date.now(),
ts:       new Date().toISOString(),
cat:      _dk.cat,
msg:      msg,
screen:   getCurrentScreen(),
ref:      _dk.pendingRef    || null,
mapRowId: _dk.pendingMapRowId || null,
status:   'open',
snap:     snap
};
var log = dkLoadLog();
log.unshift(entry);
dkSaveLog(log);
_dk.pendingRef = null;
_dk.pendingMapRowId = null;
if (msgEl) msgEl.value = '';
dkClearRef();
dkClearMapLink();
dkRenderEntries();
var btn = document.getElementById('dk-submit');
if (btn) { var orig=btn.textContent; btn.textContent='✓ Saved'; setTimeout(function(){ btn.textContent=orig; },1200); }
} 
function dkSetStatus(id, status) {

var log = dkLoadLog();
var e = log.find(function(x){ return x.id===id; });
if (e) { e.status = status; dkSaveLog(log); dkRenderEntries(); return; }

var row = (typeof DKM_ROWS !== 'undefined') ? DKM_ROWS.find(function(r){ return r.id===id; }) : null;
if (row) {
row.status = (status==='fixed') ? 'ok': (status==='wontfix') ? 'wontfix': 'tbd';
dkmSaveEdits();
dkRenderEntries();
}
}function dkSetFilter(filter) {
_dk.activeFilter = filter;
document.querySelectorAll('.dk-filter-chip').forEach(function(el){
el.classList.toggle('sel', el.dataset.filter === filter);
});
dkRenderEntries();
}function dkDeleteEntry(id) {

var log = dkLoadLog();
var inLog = log.some(function(e){ return e.id===id; });
if (inLog) {
dkSaveLog(log.filter(function(e){ return e.id!==id; }));
dkRenderEntries();
toast('Entry deleted');
return;
}

var row = (typeof DKM_ROWS !== 'undefined') ? DKM_ROWS.find(function(r){ return r.id===id; }) : null;
if (!row) { toast('Entry not found'); return; }
if (row._dynamic) {
var idx = DKM_ROWS.indexOf(row);
if (idx > -1) DKM_ROWS.splice(idx, 1);
} else {

row.desc=''; row.ref=''; row.cat='note';
row.desired=''; row.notes=''; row.status='tbd';
}
dkmSaveEdits();
dkRenderEntries();
toast('Entry deleted');
}function dkClearResolved() {

var log = dkLoadLog();
var legacyResolved = log.filter(function(e){ return e.status==='fixed'||e.status==='wontfix'; });
var dkmResolved = (typeof DKM_ROWS !== 'undefined')
? DKM_ROWS.filter(function(r){ return (r.desc||r.desired||r.notes||r.ref) && (r.status==='ok'||r.status==='wontfix'); })
: [];
var total = legacyResolved.length + dkmResolved.length;
if (!total) { toast('No resolved entries to clear'); return; }

if (!_dk._clearPending) {
_dk._clearPending = true;
toast('Tap Clear Resolved again to confirm ('+total+' item'+(total===1?'':'s')+')');
setTimeout(function(){ _dk._clearPending = false; }, 4000);
return;
}
_dk._clearPending = false;

dkSaveLog(log.filter(function(e){ return e.status!=='fixed'&&e.status!=='wontfix'; }));

dkmResolved.forEach(function(r) {
if (r._dynamic) {
var idx = DKM_ROWS.indexOf(r);
if (idx > -1) DKM_ROWS.splice(idx, 1);
} else {
r.desc=''; r.ref=''; r.cat='note';
r.desired=''; r.notes=''; r.status='tbd';
}
});
if (dkmResolved.length) dkmSaveEdits();
dkRenderEntries();
toast('Cleared '+total+' resolved entr'+(total===1?'y':'ies'));
} 
function dkEditEntry(id) {
var log = dkLoadLog();
var e   = log.find(function(x){ return x.id===id; });
if (e) {
var newMsg = prompt('Edit entry:', e.msg);
if (newMsg === null) return;
e.msg = newMsg.trim() || e.msg;
dkSaveLog(log);
dkRenderEntries();
toast('Entry updated');
return;
}

var row = (typeof DKM_ROWS !== 'undefined') ? DKM_ROWS.find(function(r){ return r.id===id; }) : null;
if (!row) { toast('Entry not found'); return; }
var newDesc = prompt('Edit entry:', row.desc || row.object || '');
if (newDesc === null) return;
row.desc = newDesc.trim() || row.desc;
dkmSaveEdits();
dkRenderEntries();
toast('Entry updated');
} 
function _dkBuildAIPrompt(e, catLabel) {
var codeMap = (typeof window._DK_CODE_MAP_LIVE !== 'undefined') ? window._DK_CODE_MAP_LIVE : null;
var fnList  = codeMap ? codeMap.functions.slice(0,80).map(function(f){ return f.fn+'('+f.params+') L'+f.line; }).join(', ') : '(regenerate to get function list)';
var snapStr = e.snap ? JSON.stringify(e.snap, null, 2) : 'no snapshot';
return 'You are a senior developer reviewing a bug report for BowlingDB PWA v22, a bowling score tracking app.\n\n'+
'ISSUE CATEGORY: '+catLabel+'\n'+
'MESSAGE: '+e.msg+'\n'+
'SCREEN: '+(e.screen||'unknown')+'\n'+
'ELEMENT REF: '+(e.ref||'none')+'\n'+
'APP STATE AT LOG TIME:\n'+snapStr+'\n\n'+
'FUNCTION INDEX (first 80): '+fnList+'\n\n'+
'Provide: (1) likely root cause, (2) specific functions to investigate, (3) suggested fix approach. Be concise and technical.';
}




function dkCopyAIText() {
var text = window._dkLastAIText || '';
if (!text) { toast('Nothing to copy'); return; }
if (navigator.clipboard && navigator.clipboard.writeText) {
navigator.clipboard.writeText(text)
.then(function(){ toast('Copied ✓'); })
.catch(function(){ _dkCopyFallback(text); });
} else {
_dkCopyFallback(text);
}
}function _dkCopyFallback(text) {
var ta = document.createElement('textarea');
ta.value = text;
ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.left = '-9999px';
document.body.appendChild(ta);
ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
try { document.execCommand('copy'); toast('Copied ✓'); }
catch(e) { toast('Copy failed — long-press the text to copy manually'); }
document.body.removeChild(ta);
}function dkAskAI(entryId) {
var log   = dkLoadLog();
var entry = log.find(function(e){ return e.id===entryId; });
if (!entry) return;
var key = dkGetApiKey();
if (!key) { toast('No API key — add one in Settings → AI Integration'); return; }
var catLabels = {bug:'Bug',ui:'UI Issue',feat:'Feature Request',note:'Note'};
var prompt    = _dkBuildAIPrompt(entry, catLabels[entry.cat]||entry.cat);

var entryEls = document.querySelectorAll('.dk-entry');
var target   = null;
entryEls.forEach(function(el){
if (el.querySelector('[onclick*="'+entryId+'"]')) target = el;
});
toast('Asking AI…');
fetch('https://api.anthropic.com/v1/messages', {
method:'POST',
headers:{ 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01', 'anthropic-dangerous-direct-browser-access':'true'},
body: JSON.stringify({ model:getAIModelFast(), max_tokens:600,
messages:[{role:'user', content:prompt}] })
}).then(function(r){ return r.json(); }).then(function(data){
var text = (data.content||[]).map(function(c){ return c.text||''; }).join('');
if (!text && data.error) { toast('AI error: '+data.error.message); return; }
entry.aiAnalysis = text;
entry.aiTs       = new Date().toISOString();
dkSaveLog(log);

window._dkLastAIText = text;
openModal('<div class="modal-title">🤖 AI Analysis</div>'+
'<div style="font-size:12px;color:var(--t2);margin-bottom:10px;font-style:italic">'+_escHtml(entry.msg)+'</div>'+
'<div style="font-size:13px;color:var(--t1);line-height:1.6;white-space:pre-wrap">'+_escHtml(text)+'</div>'+
'<button class="btn btn-primary" onclick="dkCopyAIText()" style="margin-top:12px;width:100%">📋 Copy</button>'+
'<button class="btn btn-secondary" onclick="closeModal()" style="margin-top:8px;width:100%">Close</button>');
}).catch(function(err){ toast('AI request failed: '+err.message); });
} 
function dkReviewAndExport() {
var key  = dkGetApiKey();
var log  = dkLoadLog();
var open = log.filter(function(e){ return (e.status||'open')==='open'; });
if (!open.length) { toast('No open items to review'); return; }
if (!key) { toast('No API key — add one in Settings → AI Integration'); return; }
var catLabels = {bug:'Bug',ui:'UI Issue',feat:'Feature Request',note:'Note'};
var summary   = open.map(function(e,i){
return (i+1)+'. ['+( catLabels[e.cat]||e.cat)+'] '+e.msg+' {screen:'+e.screen+'}';
}).join('\n');
var prompt = 'You are reviewing open issues for BowlingDB PWA v22, a bowling score-tracking iPhone app.\n\n'+
'OPEN ITEMS ('+open.length+'):\n'+summary+'\n\n'+
'Provide a brief prioritized analysis: which items are most critical, any patterns you notice, and suggested implementation order. Format as a numbered list by priority.';
toast('Generating batch review…');
fetch('https://api.anthropic.com/v1/messages', {
method:'POST',
headers:{ 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01', 'anthropic-dangerous-direct-browser-access':'true'},
body: JSON.stringify({ model:getAIModelFast(), max_tokens:1000,
messages:[{role:'user', content:prompt}] })
}).then(function(r){ return r.json(); }).then(function(data){
var text = (data.content||[]).map(function(c){ return c.text||''; }).join('');
if (!text && data.error) { toast('AI error: '+data.error.message); return; }
var full = '=== BowlingDB DevKit Review ===\n'+new Date().toLocaleDateString()+'\n'+open.length+' open items\n\n'+text;
window._dkLastAIText = full; 
openModal('<div class="modal-title">🤖 Review &amp; Export</div>'+
'<div style="font-size:12px;color:var(--t1);line-height:1.6;white-space:pre-wrap;margin-bottom:12px">'+_escHtml(text)+'</div>'+
'<button class="btn btn-primary" onclick="dkCopyAIText()">📋 Copy Full Report</button>'+
'<button class="btn btn-secondary" onclick="closeModal()" style="margin-top:8px;width:100%">Close</button>');
}).catch(function(err){ toast('AI request failed: '+err.message); });
} 
function dkSessionBrief() {
if (typeof DKM_ROWS === 'undefined') { toast('Open Log Item tab first'); return; }
var catHeaders = {bug:'BUGS', ui:'UI ISSUES', feat:'FEATURES / REQUESTS', note:'NOTES'};
var catOrder   = ['bug','ui','feat','note'];

var bycat = {};
DKM_ROWS.forEach(function(r) {
if (!r.desc && !r.desired && !r.notes) return;
var c = r.cat || 'note';
if (!bycat[c]) bycat[c] = [];
bycat[c].push(r);
});

var legacyLog = dkLoadLog().filter(function(e){ return !e.mapRowId && (e.status||'open')==='open'; });
legacyLog.forEach(function(e) {
var c = e.cat || 'note';
if (!bycat[c]) bycat[c] = [];
bycat[c].push({ object: e.msg, form: e.screen||'', desc: '', ref: e.ref||'', _legacy: true });
});
var total = Object.values(bycat).reduce(function(s,a){ return s+a.length; }, 0);
if (!total) { toast('Nothing logged yet'); return; }
var d = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
var lines = ['BowlingDB PWA v30 — Session Brief ['+ d + ']', 'Items: '+ total, ''];
catOrder.forEach(function(cat) {
var items = bycat[cat];
if (!items || !items.length) return;
lines.push((catHeaders[cat]||cat.toUpperCase()) + ' ('+ items.length + '):');
items.forEach(function(r) {
var sm  = (typeof DKM_SCREENS !== 'undefined'&& DKM_SCREENS[r.form]) ? DKM_SCREENS[r.form].name : (r.form||'');
var obj = r.object || r.desc || '';
var dsc = (!r._legacy && r.desc) ? ' — '+ r.desc : '';
var ref = r.ref   ? ' ['+ r.ref + ']': '';
var scr = sm      ? ' {'+ sm + '}': '';
var st  = (!r._legacy && r.status && r.status !== 'tbd') ? ' ('+ r.status + ')': '';
lines.push('• '+ obj + dsc + ref + scr + st);
});
lines.push('');
});
lines.push('---');
lines.push('Paste this with the HTML file attached to continue the session.');
var brief = lines.join('\n');

var panel = document.getElementById('dk-panel');
if (panel) { panel.classList.remove('dk-open'); _dk.panelOpen = false; }
setTimeout(function() {
if (navigator.share) {
navigator.share({title:'BowlingDB Session Brief', text:brief}).catch(function(){
navigator.clipboard && navigator.clipboard.writeText(brief)
.then(function(){ toast('Brief copied'); });
});
} else {
navigator.clipboard && navigator.clipboard.writeText(brief)
.then(function(){ toast('Brief copied'); })
.catch(function(){ toast('Copy failed'); });
}
}, 200);
} 
 
function dkRenderRefChip() {
var old = document.getElementById('dk-ref-chip');
if (!old) return;
if (!_dk.pendingRef) { old.innerHTML=''; old.style.display='none'; return; }
old.style.cssText = 'display:flex;align-items:center;gap:4px;background:rgba(0,217,217,0.1);border:1px solid rgba(0,217,217,0.3);border-radius:8px;padding:6px 10px;color:var(--teal)';
old.innerHTML =
'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">📌 '+_escHtml(_dk.pendingRef)+'</span>'+
'<span onclick="dkClearRef()" style="color:var(--red);font-size:13px;padding-left:8px;cursor:pointer;flex-shrink:0">✕</span>';
}function dkClearRef() {
_dk.pendingRef = null;
var chip = document.getElementById('dk-ref-chip');
if (chip) { chip.innerHTML=''; chip.style.display='none'; }
} 
function dkSetMapLink(rowId) {
_dk.pendingMapRowId = rowId;
var inp = document.getElementById('dk-maplink-search');
if (inp) inp.value = '';
var dd = document.getElementById('dk-maplink-dd');
if (dd) dd.style.display = 'none';
dkRenderMapLinkChip();
}function dkClearMapLink() {
_dk.pendingMapRowId = null;
dkRenderMapLinkChip();
}function dkRenderMapLinkChip() {
var wrap = document.getElementById('dk-maplink-chip');
if (!wrap) return;
if (!_dk.pendingMapRowId) {
wrap.innerHTML = '';
wrap.style.display = 'none';
return;
}
var row = (typeof DKM_ROWS !== 'undefined') ? DKM_ROWS.find(function(r){ return r.id===_dk.pendingMapRowId; }) : null;
var label = row ? (row.form + ' › '+ row.object) : ('#'+ _dk.pendingMapRowId);
wrap.style.cssText = 'display:flex;align-items:center;gap:4px;background:rgba(157,78,221,0.12);border:1px solid rgba(157,78,221,0.3);border-radius:8px;padding:6px 10px;color:var(--purple)';
wrap.innerHTML =
'<span style="font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🗺 '+_escHtml(label)+'</span>'+
'<span onclick="dkClearMapLink()" style="color:var(--red);font-size:13px;padding-left:8px;cursor:pointer;flex-shrink:0">✕</span>';
}function dkJumpToMapRow(rowId) {
if (!_dk.panelOpen) dkTogglePanel();
if (!_dk.mapLoaded) { dkmInit(); _dk.mapLoaded=true; }
dkTab('map');
var row = (typeof DKM_ROWS !== 'undefined') ? DKM_ROWS.find(function(r){ return r.id===rowId; }) : null;
if (row) {
setTimeout(function() {
DKM.screen = row.form;
dkmSelectRow(row.id);
}, 80);
}
} 
function dkRenderState() {
var el = document.getElementById('dk-state');
if (!el) return;
var screen    = getCurrentScreen();
var modalOpen = !!(document.getElementById('modal-bg')&&document.getElementById('modal-bg').classList.contains('open'));
var grpOpen   = document.getElementById('grp-full-card')&&document.getElementById('grp-full-card').style.display!=='none';
var gLines='';
try {
gLines =
'LeagueID: '+(G.leagueID||'—')+'  SeriesID: '+(G.seriesID||'—')+'\n'+
'GameID: '+(G.gameID  ||'—')+'  FrameID: '+(G.frameID ||'—')+'\n'+
'Frame: '+(G.frameNum||'—')+' · Att: '+(G.attNum||'—')+' · Mode: '+(G.mode||'—')+'\n';
} catch(x) { gLines='(G unavailable)\n'; }
var hist='';
try { hist=((G.screenHistory||[]).slice(-5).join(' → ')||'')+(G.screenHistory&&G.screenHistory.length?' → ':'')+screen; }
catch(x){ hist=screen; }
var dc   = (typeof db!=='undefined'&&db._scoringCounts)||{};
var aiKey= localStorage.getItem('bowlingdb_ai_key')||'';
var navLogLines = _dk.navLog.length ? _dk.navLog.join('\n') : '(no events yet)';
el.textContent =
'── SCREEN ──\n'+screen+(modalOpen?' [modal: open]':'')+(grpOpen?' [grp-overlay]':'')+'\n\n'+
'── SESSION ──\n'+gLines+'\n'+
'── HISTORY ──\n'+hist+'\n\n'+
'── DATA ──\n'+
'Centers: '+((typeof db!=='undefined'&&db.centers)||[]).length+'  Leagues: '+((typeof db!=='undefined'&&db.leagues)||[]).length+'\n'+
'Balls: '+((typeof db!=='undefined'&&db.balls)  ||[]).length+'  Patterns: '+((typeof db!=='undefined'&&db.patterns)||[]).length+'\n'+
'Series: '+(dc.series  !=null?dc.series  :((typeof db!=='undefined'&&db.series  )||[]).length)+'\n'+
'Games: '+(dc.games   !=null?dc.games   :((typeof db!=='undefined'&&db.games   )||[]).length)+'\n'+
'Attempts: '+(dc.attempts!=null?dc.attempts:((typeof db!=='undefined'&&db.attempts)||[]).length)+'\n\n'+
'── AI ──\n'+
'Key: '+(aiKey?aiKey.slice(0,8)+'…'+aiKey.slice(-4):'not set')+'\n\n'+
'── NAV LOG (last 8) ──\n'+navLogLines+'\n\n'+
'── DEVKIT ──\n'+
'Log entries: '+dkLoadLog().length+'\n'+
'Map rows: '+(typeof DKM_ROWS!=='undefined'?DKM_ROWS.length:0)+'\n';
} 
/* ═════════════════════════════════════════════════════════════
   SEASON DRY RUN (v30.38) — READ-ONLY
   Validates the season engine against real IDB data before any
   consumer is wired to it. Calls deriveLeagueSeason() (pure) and
   NEVER getLeagueSeason() (which assigns + persists). A mutation
   guard at the end proves nothing was written.

   The offline preseed harness could only test 23/27 leagues: it has
   reference tables but no series, so chain step 3 (observed span)
   never fired. That is the gap this closes.

   The real test is the last column: the span-derived season vs the
   season the ACTUAL SERIES DATES vote for. If those two ever
   disagree, the span logic is wrong and the engine is not trusted.
   ═══════════════════════════════════════════════════════════ */
async function dkSeasonDryRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();   

var before = {
seasons: (db.seasons||[]).length,
nextID:  db.ids.season,
tags:    JSON.stringify((db.leagues||[]).map(function(l){
return [l.LeagueID, l.SeasonID, l.SeasonSource]; }))
};
var out = [];
out.push('SEASON DRY RUN - read-only, no writes');
out.push('Leagues: '+ (db.leagues||[]).length +
'   Series loaded: '+ (db.series||[]).length);
out.push('Rule: majority of calendar days wins. Sanctioned is not an input.');
out.push('');
var pad = function(s,n){ s = (s==null?'':String(s)); return s.length>n ? s.slice(0,n) : s+' '.repeat(n-s.length); };
out.push(pad('ID',4)+pad('League',24)+pad('Method',11)+pad('Derived',16)+
pad('Shr',5)+pad('Src',9)+pad('SeriesVote',20)+'Agree');
out.push('-'.repeat(94));
var nAuto=0, nPrompt=0, nObserved=0, nThin=0, nDisagree=0, nThinDisagree=0, nNoSeries=0, nNamed=0;
var disagreements = [], thinDisagreements = [];
(db.leagues||[]).filter(function(l){ return !l._virtual && l.LeagueID > 0; })
.sort(function(a,b){ return String(a.StartDate||'zz').localeCompare(String(b.StartDate||'zz')); })
.forEach(function(l) {
var d = deriveLeagueSeason(l);
if (!d) return;
if (d.source==='auto') nAuto++; else nPrompt++;
if (d.span && d.span.method==='observed') nObserved++;
if (d.sharePct != null && d.sharePct < 60) nThin++;
if (d.reason && d.reason.indexOf('name') !== -1) nNamed++;








var sDates = (db.series||[])
.filter(function(s){ return s.LeagueID === l.LeagueID && s.DateBowled; })
.map(function(s){ return s.DateBowled; });
var vote = '(no series)', agree = '-';
if (!sDates.length) { nNoSeries++; }
else {
var expected = l.Weeks > 0 ? l.Weeks : null;
var thinSample = expected ? (sDates.length < expected * 0.5) : (sDates.length < 8);
var b = {};
sDates.forEach(function(ds){
var k = seasonBucketOf(ds);
if (k) b[k] = (b[k]||0)+1;
});
var ks = Object.keys(b).sort(function(x,y){ return b[y]-b[x]; });
if (ks.length) {
var parts = ks[0].split('|');
vote = seasonLabel(parts[1], parts[0]) + ' ('+ b[ks[0]] + '/'+ sDates.length +
(expected ? ' of '+ expected + 'wk': '') + ')';
var match = (d.label === seasonLabel(parts[1], parts[0]));
agree = match ? 'yes': (thinSample ? 'thin': 'NO');
if (!match) {
var detail = '  L'+ l.LeagueID + ' '+ l.LeagueName +
'\n    span says : '+ d.label + '  ('+ d.reason + ')'+
'\n    series say: '+ vote +
'\n    span used : '+ (d.span ? d.span.start+' -> '+d.span.end+' ['+d.span.method+']': 'none');
if (thinSample) {
nThinDisagree++;
thinDisagreements.push(detail +
'\n    -> only '+ sDates.length + ' series recorded'+
(expected ? ' of '+ expected + ' expected weeks': '') +
' - too small a sample to trust over the span. Informational only.');
} else {
nDisagree++;
disagreements.push(detail);
}
}
}
}
out.push(pad(l.LeagueID,4) + pad(l.LeagueName,24) +
pad(d.span?d.span.method:'-',11) +
pad(d.label||'(unassigned)',16) +
pad(d.sharePct!=null?d.sharePct+'%':'-',5) +
pad(d.source,9) + pad(vote,20) + agree);
});
out.push('-'.repeat(94));
out.push('');
out.push('SUMMARY');
out.push('  auto: '+ nAuto + '   prompted: '+ nPrompt + '   (name-signal involved: '+ nNamed + ')');
out.push('  resolved via observed-series span: '+ nObserved);
out.push('  thin margin <60%: '+ nThin);
out.push('  no series yet: '+ nNoSeries);
out.push('  span-vs-series DISAGREEMENTS (full-sample): '+ nDisagree +
(nDisagree ? '   <-- ENGINE NOT TRUSTED': '   <-- engine agrees with reality on every full sample'));
out.push('  span-vs-series disagreements (thin sample, informational): '+ nThinDisagree);
if (disagreements.length) {
out.push('');
out.push('DISAGREEMENT DETAIL (full sample - takes these seriously)');
disagreements.forEach(function(x){ out.push(x); });
}
if (thinDisagreements.length) {
out.push('');
out.push('THIN-SAMPLE DETAIL (informational - not a trust failure)');
thinDisagreements.forEach(function(x){ out.push(x); });
}

var after = {
seasons: (db.seasons||[]).length,
nextID:  db.ids.season,
tags:    JSON.stringify((db.leagues||[]).map(function(l){
return [l.LeagueID, l.SeasonID, l.SeasonSource]; }))
};
var clean = (before.seasons===after.seasons && before.nextID===after.nextID &&
before.tags===after.tags);
out.push('');
out.push('MUTATION CHECK  (dry run must write nothing)');
out.push('  db.seasons:    '+ before.seasons + ' -> '+ after.seasons);
out.push('  ids.season:    '+ before.nextID  + ' -> '+ after.nextID);
out.push('  league tags:   '+ (before.tags===after.tags ? 'unchanged': 'CHANGED'));
out.push('  '+ (clean ? 'PASS - no writes': 'FAIL - dry run mutated state'));
if (result) result.textContent = out.join('\n');
toast('Season dry run complete'+ (nDisagree ? ' - '+ nDisagree + ' disagreement(s)': ' - clean'));
} catch(e) {
if (result) result.textContent = 'Season dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
} 
async function dkEnsureLineagesRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Running...';
try {
await loadScoringData();
var r = ensureLineages();
saveDB();
var msg = [];
msg.push('ENSURE LINEAGES - writes applied');
msg.push('');
msg.push('  lineage groups written: '+ r.groupsWritten);
msg.push('  leagues touched (assigned/cleared): '+ r.leaguesTouched);
msg.push('  display names corrected (year-free rename): '+ r.displayNamesFixed);
msg.push('  slot match candidates still needing a manual pick: '+ r.slotCandidates);
msg.push('');
msg.push('Run the read-only Lineage Dry Run to review the result, or check');
msg.push('individual League forms - each shows its current Lineage assignment.');
if (result) result.textContent = msg.join('\n');
toast('Lineages updated - '+ r.leaguesTouched + ' league(s) touched');
} catch(e) {
if (result) result.textContent = 'Ensure Lineages failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}





async function dkLineageDryRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
var snap = function() {
return JSON.stringify({
seasons: (db.seasons || []).length,
nextID:  db.ids.season,
tags:    (db.leagues || []).map(function(l) {
return [l.LeagueID, l.SeasonID, l.SeasonSource, l.LineageID, l.LineageSource]; })
});
};
var before = snap();
var leagues = (db.leagues || []).filter(function(l) {
return !l._virtual && l.LeagueID > 0;
});
var g = computeLineageGroups(leagues);
var out = [];
out.push('LINEAGE DRY RUN - read-only, no writes  (v30.46: reads persisted state)');
out.push('Leagues: '+ leagues.length + '   Name keys: '+ g.keys.length +
'   Proposed lineages (2+ members): '+ g.multi.length +
'   Singletons: '+ g.single.length +
'   User-locked: '+ g.userLocked.length);
out.push('Tier 1: exact name-key match. Tier 2a: prefix + Center/Day corroboration (auto-promoted).');
out.push('Tier 2b: Center/Day + shared word, no key/prefix relation (human review only). Season words always separate sessions.');
out.push('');
var seasonOf = function(l) {
var d = deriveLeagueSeason(l);
return d && d.label ? d.label : '(unassigned)';
};
var nSameSeason = 0;
out.push('PROPOSED LINEAGES (grouped, 2+ members)');
out.push('-'.repeat(70));
if (!g.multi.length) out.push('  (none)');
g.multi.forEach(function(k) {



var promo = g.promoted.filter(function(p) {
return g.finalGroups[k].indexOf(p.hit.a) !== -1 || g.finalGroups[k].indexOf(p.hit.b) !== -1;
});
var already = db.lineages.find(function(x) { return x.LineageKey === g.label[k]; });
out.push('"'+ g.label[k] + '"'+ (promo.length ? '   [merged via prefix + slot match]': '') +
(already ? '   [persisted: LineageID '+ already.LineageID + ']': '   [not yet persisted]'));
var seen = {};
g.finalGroups[k].sort(function(a, b) { return a.LeagueID - b.LeagueID; }).forEach(function(l) {
var s = seasonOf(l);
var dup = seen[s] ? '   << SAME SEASON as L'+ seen[s] + ' - check!': '';
if (seen[s]) nSameSeason++;
seen[s] = seen[s] || l.LeagueID;
var tag = l.LineageSource ? ('   ['+ l.LineageSource + ']') : '';
out.push('   L'+ l.LeagueID + '  '+ l.LeagueName + '   ['+ s + ']'+ tag + dup);
});
promo.forEach(function(p) {
out.push('   -> promoted: "'+ p.pair[0] + '" + "'+ p.pair[1] + '" share Center '+
p.hit.slot.split('|')[0] + ' / '+ p.hit.slot.split('|')[1] +
' (L'+ p.hit.a.LeagueID + ', L'+ p.hit.b.LeagueID + ')');
});
out.push('');
});
out.push('SLOT MATCH CANDIDATES (Center + Day + shared word, name key/prefix did not link these - human review)');
out.push('-'.repeat(70));
if (!g.slotCandidates.length) out.push('  (none)');
g.slotCandidates.forEach(function(c) {
out.push('  L'+ c.l1.LeagueID + ' "'+ c.l1.LeagueName + '"   ~   L'+ c.l2.LeagueID +
' "'+ c.l2.LeagueName + '"   [Center '+ c.slot.split('|')[0] + ' / '+
c.slot.split('|')[1] + ', shared word: '+ c.shared.join(', ') + ']'+
'   -> resolve on the League form if these should merge');
});
out.push('');
out.push('REVIEW CANDIDATES (prefix match, no Center/Day corroboration - possible same lineage)');
out.push('-'.repeat(70));
if (!g.stillReview.length) out.push('  (none)');
g.stillReview.forEach(function(p) {
var ids = function(k) { return g.groups[k].map(function(l) { return 'L'+ l.LeagueID; }).join(','); };
out.push('  "'+ p[0] + '" ('+ ids(p[0]) + ')   ~   "'+ p[1] + '" ('+ ids(p[1]) + ')');
});
out.push('');
out.push('USER-LOCKED (manual override on the League form - unaffected by auto-grouping)');
out.push('-'.repeat(70));
if (!g.userLocked.length) out.push('  (none)');
g.userLocked.forEach(function(l) {
var ln = db.lineages.find(function(x) { return x.LineageID === l.LineageID; });
out.push('  L'+ l.LeagueID + '  '+ l.LeagueName + '   -> '+
(ln ? '"'+ ln.DisplayName + '" (LineageID '+ ln.LineageID + ')': 'standalone (explicitly no lineage)'));
});
out.push('');
out.push('SINGLETONS (no grouping proposed)');
out.push('-'.repeat(70));
g.single.forEach(function(k) {
var l = g.finalGroups[k][0];
out.push('  L'+ l.LeagueID + '  '+ l.LeagueName + '   ->  "'+ k + '"');
});
out.push('');
out.push('SUMMARY');
out.push('  proposed lineages: '+ g.multi.length +
'   leagues covered by them: '+ g.multi.reduce(function(s, k) { return s + g.finalGroups[k].length; }, 0) +
'   (of which promoted via prefix+slot: '+ g.promoted.length + ')');
out.push('  slot match candidates (human review): '+ g.slotCandidates.length);
out.push('  singletons: '+ g.single.length);
out.push('  user-locked leagues: '+ g.userLocked.length);
out.push('  prefix review candidates (no slot corroboration): '+ g.stillReview.length);
out.push('  same-season collisions inside a group: '+ nSameSeason +
(nSameSeason ? '   <-- inspect: over-merge or true duplicate leagues': ''));
var after = snap();
out.push('');
out.push('MUTATION CHECK  (dry run must write nothing)');
out.push('  '+ (before === after ? 'PASS - no writes': 'FAIL - dry run mutated state'));
if (result) result.textContent = out.join('\n');
toast('Lineage dry run complete - '+ g.multi.length + ' lineage(s), '+ g.slotCandidates.length + ' slot candidate(s)');
} catch(e) {
if (result) result.textContent = 'Lineage dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}/* ── Streak Dry Run (read-only) ──────────────────────────────
   Validates computeFloorStreaks()/computeBucketStreak() (Section 3
   of the July 2026 Performance handoff) against real per-series
   average data before either tier is ever wired into a screen.
   Per-league AND global, computed in parallel — never a toggle,
   matching the spec. Floors are derived from the observed avg
   range (not hardcoded) so this validates correctly against any
   bowler's real data. Shows ALL floors unfiltered — the "only
   show brackets at or above current avg" relevance rule is a
   presentation-layer concern for the eventual UI, not something
   the dry run should hide while you're checking correctness. */
async function dkStreakDryRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
var before = JSON.stringify({
series: (db.series || []).length,
games:  (db.games  || []).length
});
var out = [];
out.push('STREAK DRY RUN - read-only, no writes');
out.push('One generic engine (comparator + target-getter), Tier 1 = bucket, Tier 2 = floor.');
out.push('Count columns mirror the standard stats periods (10W/Season/ATL), scoped');
out.push('the same way at every tier below.');
out.push('');
out.push('Two comparison columns, not one — they answer different questions:');
out.push('  Global Max  = best run in your FULL cross-league timeline, interleaved by');
out.push('                date. An off night in an unrelated league can break this even');
out.push('                if it never touched the scope being reported.');
out.push('  BestLg Max  = the best any SINGLE league has ever done at this floor, on');
out.push('                its own nights only. A lineage or league CAN legitimately beat');
out.push('                Global Max (no other-league interruptions in its own run) but');
out.push('                can never beat BestLg Max by more than tying it.');
out.push('');
var pad = function(s,n){ s = (s==null?'':String(s)); return s.length>n ? s.slice(0,n) : s+' '.repeat(n-s.length); };


var last10SeriesIDs = new Set(getCanonicalLast10WksGames().map(function(g){ return g.SeriesID; }));
function floorsFor(avgs) {
if (!avgs.length) return [];
var lo = Math.floor(Math.min.apply(null, avgs.map(function(a){return a.avg;})) / 10) * 10;
var hi = Math.floor(Math.max.apply(null, avgs.map(function(a){return a.avg;})) / 10) * 10;
var floors = [];
for (var f = lo; f <= hi; f += 10) floors.push(f);
return floors;
}



function floorCount(avgs, floor) {
return avgs.filter(function(a){ return a >= floor; }).length;
}

var globalFloorStreaks = null;
var leagueMaxByFloor = null;
function report(label, avgs, compareMode) {
out.push(label + '  ('+ avgs.length + ' series)');
if (!avgs.length) { out.push('  no series with scored games in this scope'); out.push(''); return; }
var bucket = computeBucketStreak(avgs.map(function(a){return a.avg;}));
out.push('  Tier 1 (exact bucket '+ _streakBucketOf(avgs[avgs.length-1].avg) + 's): current '+
bucket.current + '   max '+ bucket.max);
var floors = floorsFor(avgs);
var rawAvgs = avgs.map(function(a){return a.avg;});
var floorStreaks = computeFloorStreaks(rawAvgs, floors);





var mostRecentSeries = db.series.find(function(s){ return s.SeriesID === avgs[avgs.length-1].seriesID; });
var currentSeasonID = mostRecentSeries ? getSeriesSeasonID(mostRecentSeries) : null;
var seasonRec = (db.seasons || []).find(function(s){ return s.SeasonID === currentSeasonID; });
var seasonLabel = seasonRec ? seasonRec.Label : '?';
var seasonSeriesIDs = new Set(
db.series.filter(function(s){ return currentSeasonID != null && getSeriesSeasonID(s) === currentSeasonID; })
.map(function(s){ return s.SeriesID; })
);
var tenWkVals  = avgs.filter(function(a){ return last10SeriesIDs.has(a.seriesID); }).map(function(a){ return a.avg; });
var seasonVals = avgs.filter(function(a){ return seasonSeriesIDs.has(a.seriesID); }).map(function(a){ return a.avg; });
out.push('  Tier 2 (per-floor, all observed floors — relevance filter applied only in UI):');
out.push('  Count columns: 10W = last 10 wks, Season = '+ (seasonLabel || '?') + ', ATL = all-time');
var hdr = '  '+ pad('Floor',7) + pad('Current',9) + pad('Max',6) + pad('10W',5) + pad('Season',8) + pad('ATL',6);
if (compareMode) hdr += pad('GlobalMx',10) + 'BestLgMx';
out.push(hdr);
floors.slice().reverse().forEach(function(f) {
var st = floorStreaks[f];
var line = '  '+ pad(f + 's', 7) + pad(st.current, 9) + pad(st.max, 6) +
pad(floorCount(tenWkVals, f), 5) + pad(floorCount(seasonVals, f), 8) + pad(floorCount(rawAvgs, f), 6);
if (compareMode) {
var g = globalFloorStreaks ? globalFloorStreaks[f] : null;
var bl = leagueMaxByFloor ? leagueMaxByFloor[f] : null;
var beatsGlobal = g && st.max >= g.max;
var beatsBestLg = bl != null && st.max >= bl;
line += pad(g ? g.max : '?', 10) + (bl != null ? bl : '?');
if (beatsGlobal || beatsBestLg) {
var tags = [];
if (beatsGlobal) tags.push('global');
if (beatsBestLg) tags.push('league');
line += '  <- PB ('+ tags.join('+') + ')';
}
}
out.push(line);
});
out.push('');
}

var allSeries = (db.series || []).filter(function(s){ return !s._virtual; });
var globalAvgs = _streakSeriesAvgs(allSeries);
report('GLOBAL', globalAvgs);
var globalFloors = floorsFor(globalAvgs);
globalFloorStreaks = computeFloorStreaks(globalAvgs.map(function(a){return a.avg;}), globalFloors);



leagueMaxByFloor = {};
(db.leagues || []).filter(function(l){ return !l._virtual && l.LeagueID > 0; }).forEach(function(l) {
var leagueSeries = (db.series || []).filter(function(s){ return s.LeagueID === l.LeagueID; });
if (!leagueSeries.length) return;
var lAvgObjs = _streakSeriesAvgs(leagueSeries);
if (!lAvgObjs.length) return;
var lFloors = floorsFor(lAvgObjs);
var lStreaks = computeFloorStreaks(lAvgObjs.map(function(a){return a.avg;}), lFloors);
lFloors.forEach(function(f) {
var m = lStreaks[f].max;
if (leagueMaxByFloor[f] == null || m > leagueMaxByFloor[f]) leagueMaxByFloor[f] = m;
});
});









ensureLineages();
var lineageGroups = {}; 
(db.leagues || []).filter(function(l){ return !l._virtual && l.LeagueID > 0 && l.LineageID != null; }).forEach(function(l) {
if (!lineageGroups[l.LineageID]) lineageGroups[l.LineageID] = [];
lineageGroups[l.LineageID].push(l);
});
var lineageIDs = Object.keys(lineageGroups).map(Number).sort(function(a,b){return a-b;});
if (lineageIDs.length) {
out.push('=== LINEAGES (persisted LineageID via ensureLineages() — same engine as the Lineage Dry Run) ===');
out.push('');
lineageIDs.forEach(function(lid) {
var leagues = lineageGroups[lid];
var leagueIDSet = new Set(leagues.map(function(l){ return l.LeagueID; }));
var lineageSeries = (db.series || []).filter(function(s){ return leagueIDSet.has(s.LeagueID); });
if (!lineageSeries.length) return;
var rec = (db.lineages || []).find(function(x){ return x.LineageID === lid; });
var displayName = rec ? rec.DisplayName : ('LineageID '+ lid);
var names = leagues.map(function(l){ return l.LeagueID; }).sort(function(a,b){return a-b;}).join(', ');
report('LINEAGE "'+ displayName + '"  (leagues: '+ names + ')', _streakSeriesAvgs(lineageSeries), true);
});
}

out.push('=== INDIVIDUAL LEAGUES ===');
out.push('');
(db.leagues || []).filter(function(l){ return !l._virtual && l.LeagueID > 0; })
.sort(function(a,b){ return (a.LeagueName||'').localeCompare(b.LeagueName||''); })
.forEach(function(l) {
var leagueSeries = (db.series || []).filter(function(s){ return s.LeagueID === l.LeagueID; });
if (!leagueSeries.length) return;
report('LEAGUE '+ l.LeagueID + ' - '+ l.LeagueName, _streakSeriesAvgs(leagueSeries), true);
});
var after = JSON.stringify({
series: (db.series || []).length,
games:  (db.games  || []).length
});
out.push('MUTATION CHECK  (series/games — the actual scoring data — must be untouched)');
out.push('  '+ (before === after ? 'PASS - no writes to series/games': 'FAIL - dry run mutated scoring data'));
out.push('  Note: getSeriesSeasonID() and ensureLineages() may lazily tag');
out.push('  league.SeasonID / league.LineageID on first call, same idempotent');
out.push('  behavior the Performance screen and Lineage Dry Run already rely on —');
out.push('  not tracked above since it is expected, not scoring-data corruption.');
if (result) result.textContent = out.join('\n');
toast('Streak dry run complete');
} catch(e) {
if (result) result.textContent = 'Streak dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}/* ── Leave Diagnosis Classification Diff (read-only) ──────────
   Design doc §7: "old POCKET_ANGLE_TABLE vs new Layer 1 across all
   historical att1 leaves — every changed classification listed for
   review (expected: 3-6-10 flips, 3-6 gains coverage, 9 flips to high)."
   Scans every non-strike, pocket-hit att1 in the real IDB data (frames
   1-10, att1 only — F10 att2 is a different attempt slot and out of
   scope per the literal "att1 leaves" wording), classifies each leave
   both ways, and tallies per-leave-key old vs new so every changed,
   newly-covered, and still-uncovered entry can be reviewed before any
   pipeline switchover. Pure read-only — no writes. */
async function dkLeaveDiagnosisDiffRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
var hand = getPrefs().handedness || 'right';


var angleMap = { high:'high', low:'light', flat:'flush'};




function getLeaveSet(a1) {
var standing = new Set();
for (var p = 1; p <= 10; p++) {
if (a1['PinStart'+ p] === 1 && a1['PinDelta'+ p] !== 1) standing.add(p);
}
if (standing.size > 0) return standing;
if (a1.LeaveID && db.leaves && db.leaves.length) {
var lv = db.leaves.find(function(l){ return l.LeaveID === a1.LeaveID; });
if (lv) { for (var p2 = 1; p2 <= 10; p2++) { if (lv['Pin'+ p2]) standing.add(p2); } }
if (standing.size > 0) return standing;
}
var anyKnocked = [1,2,3,4,5,6,7,8,9,10].some(function(p3){ return a1['Pin'+ p3] === true; });
if (anyKnocked) { for (var p4 = 1; p4 <= 10; p4++) { if (!a1['Pin'+ p4]) standing.add(p4); } }
return standing;
}
var tally = {}; 
var totalAtt1 = 0, changedCount = 0;
var beforeMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length });
db.frames.filter(function(f){ return f.FrameNumber >= 1 && f.FrameNumber <= 10; }).forEach(function(f) {
var a1 = db.attempts.find(function(a){ return a.FrameID === f.FrameID && a.Attempt === 1; });
if (!a1 || a1.Pinfall === null || a1.Pinfall === 10 || a1.Pinfall === 0) return;
var leave = getLeaveSet(a1);
if (leave.size === 0 || leave.has(1)) return; 
totalAtt1++;
var key = Array.from(leave).sort(function(a,b){ return a-b; }).join('-');
var geom = classifyPocketEntry(leave, hand);
var oldAngle = (geom && geom.angle && geom.angle !== 'unknown') ? (angleMap[geom.angle] || geom.angle) : null;
var diag = getLeaveDiagnosis(key, hand, a1);
var newAngle = diag ? diag.angle : null;
if (!tally[key]) tally[key] = { label: resolveLeaveDisplayName(leave, null), oldAngle:null, newAngle:null, count:0, changed:0 };
tally[key].count++;
tally[key].oldAngle = oldAngle;
tally[key].newAngle = newAngle;
if (oldAngle && newAngle && oldAngle !== newAngle) { tally[key].changed++; changedCount++; }
});
var pad = function(s,n){ s = (s==null?'—':String(s)); return s.length>n ? s.slice(0,n) : s+' '.repeat(n-s.length); };
var out = [];
out.push('LEAVE DIAGNOSIS CLASSIFICATION DIFF — read-only');
out.push('old POCKET_ANGLE_TABLE vs new LEAVE_DIAGNOSIS (Layer 1, seed v'+ LEAVE_DIAGNOSIS_SEED_VERSION + ')');
out.push('Handedness: '+ hand + '   Scope: att1 only, frames 1-10, non-strike pocket hits');
out.push('Total att1 leaves scanned: '+ totalAtt1);
out.push('');
out.push(pad('Leave',10) + pad('Label',18) + pad('Old',8) + pad('New',8) + pad('Count',7) + 'Status');
var changedRows = [], newCoverageRows = [], unchangedRows = [], oldOnlyRows = [];
Object.entries(tally).sort(function(a,b){ return b[1].count - a[1].count; }).forEach(function(entry) {
var key = entry[0], v = entry[1];
var status;
if (v.oldAngle && v.newAngle && v.oldAngle !== v.newAngle) status = 'CHANGED';
else if (!v.oldAngle && v.newAngle) status = 'NEW COVERAGE';
else if (v.oldAngle && !v.newAngle) status = 'old-only (not in Layer 1 yet)';
else if (v.oldAngle && v.newAngle) status = 'unchanged';
else status = 'unresolved (neither table)';
var row = pad(key,10) + pad(v.label,18) + pad(v.oldAngle,8) + pad(v.newAngle,8) + pad(v.count,7) + status;
if (status === 'CHANGED') changedRows.push(row);
else if (status === 'NEW COVERAGE') newCoverageRows.push(row);
else if (status === 'unchanged') unchangedRows.push(row);
else oldOnlyRows.push(row);
});
out.push('');
out.push('=== CHANGED ('+ changedRows.length + ') — expected: 3-6-10, 9 ===');
out = out.concat(changedRows.length ? changedRows : ['  none']);
out.push('');
out.push('=== NEW COVERAGE ('+ newCoverageRows.length + ') — expected: 3-6 ===');
out = out.concat(newCoverageRows.length ? newCoverageRows : ['  none']);
out.push('');
out.push('=== UNCHANGED, both tables agree ('+ unchangedRows.length + ') ===');
out = out.concat(unchangedRows.length ? unchangedRows : ['  none']);
out.push('');
out.push('=== NOT YET IN LAYER 1 — still old-table-only ('+ oldOnlyRows.length + ') ===');
out = out.concat(oldOnlyRows.length ? oldOnlyRows : ['  none']);
out.push('');
out.push('Historical occurrences whose classification would change: '+ changedCount + ' of '+ totalAtt1);
var afterMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length });
out.push('MUTATION CHECK (attempts/frames counts): '+ (beforeMutCheck === afterMutCheck ? 'PASS - no writes': 'FAIL - dry run mutated scoring data'));
if (result) result.textContent = out.join('\n');
toast('Leave diagnosis diff complete');
} catch(e) {
if (result) result.textContent = 'Leave diagnosis diff failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}



async function dkLeaveSideClusteringDryRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
var beforeMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length });
function getLeaveSet(a1) {
var standing = new Set();
for (var p = 1; p <= 10; p++) { if (a1['PinStart'+ p] === 1 && a1['PinDelta'+ p] !== 1) standing.add(p); }
if (standing.size > 0) return standing;
if (a1.LeaveID && db.leaves && db.leaves.length) {
var lv = db.leaves.find(function(l){ return l.LeaveID === a1.LeaveID; });
if (lv) { for (var p2 = 1; p2 <= 10; p2++) { if (lv['Pin'+ p2]) standing.add(p2); } }
if (standing.size > 0) return standing;
}
var anyKnocked = [1,2,3,4,5,6,7,8,9,10].some(function(p3){ return a1['Pin'+ p3] === true; });
if (anyKnocked) { for (var p4 = 1; p4 <= 10; p4++) { if (!a1['Pin'+ p4]) standing.add(p4); } }
return standing;
}
var dist = { left:0, right:0, mixed:0, center:0 };
var n = 0;
db.frames.filter(function(f){ return f.FrameNumber >= 1 && f.FrameNumber <= 10; }).forEach(function(f) {
var a1 = db.attempts.find(function(a){ return a.FrameID === f.FrameID && a.Attempt === 1; });
if (!a1 || a1.Pinfall === null || a1.Pinfall === 10 || a1.Pinfall === 0) return;
var leave = getLeaveSet(a1);
if (leave.size === 0 || leave.has(1)) return;
n++;
dist[classifyLeaveSide(leave)]++;
});
var out = [];
out.push('LEAVE-SIDE CLUSTERING DRY RUN — read-only');
out.push('Third Layer 1 axis: left={2,4,7,8} right={3,6,9,10} mixed=both center=remainder');
out.push('Scope: att1 only, frames 1-10, non-strike pocket hits (pin1 knocked)');
out.push('');
out.push('Total leaves classified: '+ n);
out.push('  Right:  '+ dist.right  + ' ('+ (n ? Math.floor(dist.right/n*1000)/10 : 0)  + '%)');
out.push('  Left:   '+ dist.left   + ' ('+ (n ? Math.floor(dist.left/n*1000)/10 : 0)   + '%)');
out.push('  Mixed:  '+ dist.mixed  + ' ('+ (n ? Math.floor(dist.mixed/n*1000)/10 : 0)  + '%)');
out.push('  Center: '+ dist.center + ' ('+ (n ? Math.floor(dist.center/n*1000)/10 : 0) + '%)');
out.push('');
out.push('Design-doc reference target: right ~48-51%, left ~34-36%, mixed ~13-15%, center ~2%.');
var afterMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length });
out.push('');
out.push('MUTATION CHECK: '+ (beforeMutCheck === afterMutCheck ? 'PASS - no writes': 'FAIL - dry run mutated scoring data'));
if (result) result.textContent = out.join('\n');
toast('Leave-side clustering dry run complete');
} catch(e) {
if (result) result.textContent = 'Leave-side clustering dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}




async function dkLaneHookRatingDryRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
if (!_llCache) await llLoadAll();
await llSyncFromHistory();
var beforeMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length, laneLibrary:(_llCache||[]).length });
var pad = function(s, n) { s = (s == null ? '—': String(s)); return s.length > n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
var out = [];
out.push('LANE HOOK RATING DRY RUN — read-only');
out.push('TENTATIVE sign convention: rating > 0 = "reading hot" (more high-angle');
out.push('leaves than the thrown balls specs predict); < 0 = "playing loose".');
out.push('Not yet reviewed against enough on-lane sessions — treat as first-pass.');
out.push('');
out.push(pad('Lane', 10) + pad('n', 5) + pad('Actual', 8) + pad('Expected', 10) + pad('Rating', 8) + 'Label');
var rows = [];
(_llCache || []).forEach(function(rec) {
var r = laneHookRating([rec.LaneKey]);
if (!r || r.rating == null) return;
rows.push({ key: rec.LaneKey, n: r.n,
actual: Math.floor(r.actualScore * 100) / 100,
expected: Math.floor(r.expectedScore * 100) / 100,
rating: Math.floor(r.rating * 100) / 100,
label: r.label });
});
rows.sort(function(a, b){ return b.rating - a.rating; });
rows.forEach(function(row) {
out.push(pad(row.key, 10) + pad(row.n, 5) + pad(row.actual, 8) + pad(row.expected, 10) + pad(row.rating, 8) + row.label);
});
out.push('');
out.push('Gate-qualifying lanes rated: '+ rows.length);
var afterMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length, laneLibrary:(_llCache||[]).length });
out.push('');
out.push('MUTATION CHECK: '+ (beforeMutCheck === afterMutCheck ? 'PASS - no writes': 'FAIL - dry run mutated data'));
if (result) result.textContent = out.join('\n');
toast('Lane Hook Rating dry run complete');
} catch(e) {
if (result) result.textContent = 'Lane Hook Rating dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}





async function dkSbtbComparisonDryRun() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
if (!_llCache) await llLoadAll();
await llSyncFromHistory();
var beforeMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length });
var out = [];
out.push('SB/TB COMPARISON DRY RUN — read-only');
out.push('Gated = StartingBoardSource/TargetBoardSource === "user" only (production mode).');
out.push('Ungated = structural mechanics check only, ignores source tier.');
out.push('');
var recs = (_llCache || []);
out.push('=== att1 STRIKE LINE (lane behavior vs personal baseline) ===');
var anyGatedStrike = false;
recs.forEach(function(rec) {
var gated = sbtbStrikeLineComparison([rec.LaneKey], true);
var ungated = sbtbStrikeLineComparison([rec.LaneKey], false);
if (gated.laneN.sb + gated.laneN.tb > 0) anyGatedStrike = true;
if (ungated.laneN.sb + ungated.laneN.tb === 0) return; 
out.push(rec.LaneKey + ':');
out.push('  gated:   n(sb/tb)='+ gated.laneN.sb + '/'+ gated.laneN.tb + '  delta(sb/tb)='+ gated.delta.sb + '/'+ gated.delta.tb);
out.push('  ungated: n(sb/tb)='+ ungated.laneN.sb + '/'+ ungated.laneN.tb + '  delta(sb/tb)='+ ungated.delta.sb + '/'+ ungated.delta.tb);
});
if (!anyGatedStrike) out.push('(no user-tier att1 SB/TB records yet — expected, backup predates v30.112 source tiers)');
out.push('');
out.push('=== att2 SPARE EXECUTION (vs saved Spare Alignment) ===');
var anyGatedSpare = false;
recs.forEach(function(rec) {
var gated = sbtbSpareExecutionComparison([rec.LaneKey], true);
var ungated = sbtbSpareExecutionComparison([rec.LaneKey], false);
if (gated.some(function(r){ return r.n.sb + r.n.tb > 0; })) anyGatedSpare = true;
if (!ungated.length) return;
out.push(rec.LaneKey + ':');
ungated.forEach(function(r) {
var g = gated.find(function(x){ return x.leaveID === r.leaveID; });
out.push('  leave '+ r.leaveID + ': ungated n='+ (r.n.sb + r.n.tb) +
' delta(sb/tb)='+ r.delta.sb + '/'+ r.delta.tb +
' | gated n='+ (g ? (g.n.sb + g.n.tb) : 0));
});
});
if (!anyGatedSpare) out.push('(no user-tier att2 SB/TB records yet — expected, backup predates v30.112 source tiers)');
out.push('');
out.push('Spare Alignment records available: '+ (db.spareAlignments || []).length);
var afterMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length });
out.push('');
out.push('MUTATION CHECK: '+ (beforeMutCheck === afterMutCheck ? 'PASS - no writes': 'FAIL - dry run mutated scoring data'));
if (result) result.textContent = out.join('\n');
toast('SB/TB comparison dry run complete');
} catch(e) {
if (result) result.textContent = 'SB/TB comparison dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}/* ── DevKit: Lane Prep Brief — Context Preview (no AI call) ───
   Assembles the same context object + prompt llGeneratePrepBrief
   would send, WITHOUT actually calling the API — validates the
   data-assembly mechanics for every gate-qualifying lane without
   spending API quota. Read-only against scoring data; does NOT
   touch gamesSincePrompt/snooze/paused state (that is a separate,
   intentionally-mutating tool below). */
async function dkLanePrepBriefPreview() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
if (!_llCache) await llLoadAll();
await llSyncFromHistory();
var beforeMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length, laneLibrary:(_llCache||[]).length });
var recs = (_llCache || []).slice(0, 3); 
var out = [];
out.push('LANE PREP BRIEF — CONTEXT PREVIEW (no AI call, read-only)');
out.push('Shows the assembled context + prompt for the first 3 lanes, to check the');
out.push('data-assembly mechanics without spending API quota.');
out.push('');
recs.forEach(function(rec) {
var ctx = llBuildPrepBriefContext(rec.LaneKey);
var prompt = llBuildPrepBriefPrompt(ctx);
var due = llBriefDue(rec);
out.push('=== '+ rec.LaneKey + ' (due for brief: '+ due + ', gamesSincePrompt='+ (rec.gamesSincePrompt||0) + '/'+ (rec.snoozeThreshold != null ? rec.snoozeThreshold : (rec.cooldownGames||9)) + ', paused='+ !!rec.paused + ') ===');
out.push(prompt);
out.push('');
});
var afterMutCheck = JSON.stringify({ attempts:(db.attempts||[]).length, frames:(db.frames||[]).length, laneLibrary:(_llCache||[]).length });
out.push('MUTATION CHECK: '+ (beforeMutCheck === afterMutCheck ? 'PASS - no writes': 'FAIL - preview mutated data'));
if (result) result.textContent = out.join('\n');
toast('Lane Prep Brief preview complete');
} catch(e) {
if (result) result.textContent = 'Lane Prep Brief preview failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}




async function dkUpdateGamesSincePrompt() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Updating games-since-prompt counters...';
try {
await loadScoringData();
if (!_llCache) await llLoadAll();
await llSyncFromHistory();
var updated = await llUpdateGamesSincePrompt();
var out = [];
out.push('GAMES-SINCE-PROMPT UPDATE — real state write, not a dry run');
out.push('Lane records updated: '+ updated);
out.push('');
(_llCache || []).forEach(function(rec) {
var due = llBriefDue(rec);
out.push(rec.LaneKey + ': gamesSincePrompt='+ (rec.gamesSincePrompt||0) +
' threshold='+ (rec.snoozeThreshold != null ? rec.snoozeThreshold : (rec.cooldownGames||9)) +
' paused='+ !!rec.paused + ' due='+ due);
});
if (result) result.textContent = out.join('\n');
toast('Games-since-prompt updated for '+ updated + ' lanes');
} catch(e) {
if (result) result.textContent = 'Games-since-prompt update failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}/* ── Streak Dry Run Detail (read-only) ───────────────────────
   Per-series trace for one league — shows the actual game scores,
   series total/avg, bucket, and the running streak count at EACH
   point in the timeline (not just the final current/max), so the
   summary numbers from the main dry run can be checked step by
   step against real series instead of taken on faith. Defaults to
   league 129 (Foxes and Hounds Summer Trios 2026, current league)
   per request; pass a different LeagueID to check another league. */
async function dkStreakDryRunDetail(leagueID) {
leagueID = leagueID || 129;
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
var l = (db.leagues || []).find(function(x){ return x.LeagueID === leagueID; });
var out = [];
out.push('STREAK DRY RUN DETAIL - League '+ leagueID + (l ? ' - '+ l.LeagueName : ' (not found)'));
out.push('Per-series trace: game scores, series total/avg, bucket, running streak per floor.');
out.push('');
var leagueSeries = (db.series || []).filter(function(s){ return s.LeagueID === leagueID; });
var avgs = _streakSeriesAvgs(leagueSeries);
if (!avgs.length) {
out.push('No series with scored games in this league.');
if (result) result.textContent = out.join('\n');
return;
}
var lo = Math.floor(Math.min.apply(null, avgs.map(function(a){return a.avg;})) / 10) * 10;
var hi = Math.floor(Math.max.apply(null, avgs.map(function(a){return a.avg;})) / 10) * 10;
var floors = [];
for (var f = lo; f <= hi; f += 10) floors.push(f);



var floorCurrent = {}, floorMax = {}; floors.forEach(function(fl){ floorCurrent[fl] = 0; floorMax[fl] = 0; });
var bucketCurrent = 0, bucketMax = 0, bucketTarget = null;
avgs.forEach(function(a, i) {
var games = db.games.filter(function(g){ return g.SeriesID === a.seriesID && !g.IsTeammate && g.FinalScore != null; })
.sort(function(x,y){ return (x.GameNumber||0) - (y.GameNumber||0); });
var scores = games.map(function(g){ return g.FinalScore; });
var total  = scores.reduce(function(x,y){ return x+y; }, 0);
var bucket = _streakBucketOf(a.avg);
if (bucketTarget !== null && bucket === bucketTarget) { bucketCurrent++; }
else { bucketCurrent = 1; bucketTarget = bucket; }
if (bucketCurrent > bucketMax) bucketMax = bucketCurrent;
var floorLines = [];
floors.forEach(function(fl) {
if (a.avg >= fl) {
floorCurrent[fl]++;
if (floorCurrent[fl] > floorMax[fl]) floorMax[fl] = floorCurrent[fl];
floorLines.push(fl + 's:'+ floorCurrent[fl]);
} else {
floorCurrent[fl] = 0;
}
});
out.push('#'+ (i+1) + '  '+ (a.date || '?') + '  SeriesID '+ a.seriesID);
out.push('   Games: ['+ scores.join(', ') + ']   Total: '+ total + '   Avg: '+ a.avg.toFixed(2));
out.push('   Bucket: '+ bucket + 's   Tier 1 streak now: '+ bucketCurrent);
out.push('   Active Tier 2 streaks: '+ (floorLines.length ? floorLines.join('   ') : '(none — below lowest floor)'));
out.push('');
});
var last10SeriesIDs = new Set(getCanonicalLast10WksGames().map(function(g){ return g.SeriesID; }));
var mostRecentSeries = db.series.find(function(s){ return s.SeriesID === avgs[avgs.length-1].seriesID; });
var currentSeasonID = mostRecentSeries ? getSeriesSeasonID(mostRecentSeries) : null;
var seasonRec = (db.seasons || []).find(function(s){ return s.SeasonID === currentSeasonID; });
var seasonLabel = seasonRec ? seasonRec.Label : '?';
var seasonSeriesIDs = new Set(
db.series.filter(function(s){ return currentSeasonID != null && getSeriesSeasonID(s) === currentSeasonID; })
.map(function(s){ return s.SeriesID; })
);
out.push('FINAL — Tier 1: current '+ bucketCurrent + '   max '+ bucketMax);
out.push('FINAL — Tier 2 max / count per floor (count columns: 10W = last 10 wks, Season = '+
(seasonLabel || '?') + ', ATL = all-time):');
out.push('  '+ floors.slice().reverse().map(function(fl){
var tenWk  = avgs.filter(function(a){ return last10SeriesIDs.has(a.seriesID) && a.avg >= fl; }).length;
var season = avgs.filter(function(a){ return seasonSeriesIDs.has(a.seriesID) && a.avg >= fl; }).length;
var atl    = avgs.filter(function(a){ return a.avg >= fl; }).length;
return fl + 's: max '+ floorMax[fl] + ', 10W '+ tenWk + ', Season '+ season + ', ATL '+ atl;
}).join('\n  '));
out.push('');
out.push('Cross-check these against the summary numbers from the main Streak Dry Run for this league.');
if (result) result.textContent = out.join('\n');
toast('Streak detail dry run complete — league '+ leagueID);
} catch(e) {
if (result) result.textContent = 'Streak detail dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}/* ── Rolling Average Streak Dry Run (read-only) ──────────────
   Validates _streakRollingScopeAvgs() feeding the SAME streak engine —
   "how many series running does my cumulative average stay above
   200/210/220 before crossing", not the per-series-average streaks above.
   Per-series trace shows both numbers side by side (that series' own
   average vs the resulting cumulative average) so a jump/drop in the
   cumulative number can be sanity-checked against the actual game that
   caused it.

   scope: 'league' (default) | 'lineage' | 'global'. id: LeagueID or
   LineageID depending on scope (ignored for global). Rolling average is
   CONTINUOUS across the scope — no reset at league/season boundaries
   within a lineage, no reset ever within global — same philosophy as the
   existing LINEAGE/GLOBAL tiers for per-series streaks. */
async function dkStreakRollingDryRun(scope, id) {
scope = scope || 'league';
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
await loadScoringData();
var label, seriesList;
if (scope === 'global') {
label = 'GLOBAL';
seriesList = (db.series || []).filter(function(s){ return !s._virtual; });
} else if (scope === 'lineage') {
ensureLineages();
id = id || 1;
var lrec = (db.lineages || []).find(function(x){ return x.LineageID === id; });
var memberIDs = new Set((db.leagues || []).filter(function(l){ return l.LineageID === id; }).map(function(l){ return l.LeagueID; }));
label = 'LINEAGE "'+ (lrec ? lrec.DisplayName : ('LineageID '+ id)) + '"  (leagues: '+
Array.from(memberIDs).sort(function(a,b){return a-b;}).join(', ') + ')';
seriesList = (db.series || []).filter(function(s){ return memberIDs.has(s.LeagueID); });
} else {
scope = 'league';
id = id || 129;
var l = (db.leagues || []).find(function(x){ return x.LeagueID === id; });
label = 'LEAGUE '+ id + (l ? ' - '+ l.LeagueName : ' (not found)');
seriesList = (db.series || []).filter(function(s){ return s.LeagueID === id; });
}
var out = [];
out.push('ROLLING AVERAGE STREAK DRY RUN - '+ label);
out.push('Cumulative average per series (standings-sheet number), continuous across the');
out.push('whole scope — same engine as the per-series-average streaks, different input.');
out.push('');
var rolling = _streakRollingScopeAvgs(seriesList);
var seriesAvgs = _streakSeriesAvgs(seriesList);
if (!rolling.length) {
out.push('No series with scored games in this scope.');
if (result) result.textContent = out.join('\n');
return;
}
var lo = Math.floor(Math.min.apply(null, rolling.map(function(a){return a.avg;})) / 10) * 10;
var hi = Math.floor(Math.max.apply(null, rolling.map(function(a){return a.avg;})) / 10) * 10;
var floors = [];
for (var f = lo; f <= hi; f += 10) floors.push(f);
var floorCurrent = {}, floorMax = {}; floors.forEach(function(fl){ floorCurrent[fl] = 0; floorMax[fl] = 0; });
var bucketCurrent = 0, bucketMax = 0, bucketTarget = null;
rolling.forEach(function(r, i) {
var ownNight = seriesAvgs[i]; 
var bucket = _streakBucketOf(r.avg);
if (bucketTarget !== null && bucket === bucketTarget) { bucketCurrent++; }
else { bucketCurrent = 1; bucketTarget = bucket; }
if (bucketCurrent > bucketMax) bucketMax = bucketCurrent;
var floorLines = [];
floors.forEach(function(fl) {
if (r.avg >= fl) {
floorCurrent[fl]++;
if (floorCurrent[fl] > floorMax[fl]) floorMax[fl] = floorCurrent[fl];
floorLines.push(fl + 's:'+ floorCurrent[fl]);
} else {
floorCurrent[fl] = 0;
}
});
out.push('#'+ (i+1) + '  '+ (r.date || '?') + '  SeriesID '+ r.seriesID);
out.push('   This series avg: '+ (ownNight ? ownNight.avg.toFixed(2) : '?') +
'   ->   Rolling avg after: '+ r.avg + '  ('+ r.totalGames + ' games total)');
out.push('   Bucket: '+ bucket + 's   Tier 1 streak now: '+ bucketCurrent);
out.push('   Active Tier 2 streaks: '+ (floorLines.length ? floorLines.join('   ') : '(none — below lowest floor)'));
out.push('');
});
out.push('FINAL — Tier 1: current '+ bucketCurrent + '   max '+ bucketMax);
out.push('FINAL — Tier 2 max per floor:');
out.push('  '+ floors.slice().reverse().map(function(fl){ return fl + 's: max '+ floorMax[fl]; }).join('\n  '));
out.push('');
out.push('Sanity check: does each rolling-avg jump/drop match the actual "This series');
out.push('avg" shown above it? A big series should pull the rolling avg up, a poor one');
out.push('down — by an amount that shrinks as totalGames grows, same as a real');
out.push('standings sheet.');
if (result) result.textContent = out.join('\n');
toast('Rolling average dry run complete — '+ scope);
} catch(e) {
if (result) result.textContent = 'Rolling average dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}




async function dkBestSeriesStreakDryRun(scope, id) {
scope = scope || 'lineage';
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Loading scoring data...';
try {
var before = JSON.stringify(db.series || []) + JSON.stringify(db.games || []);
await loadScoringData();
var label;
if (scope === 'calendar') {
label = 'CALENDAR (all leagues, global)';
} else if (scope === 'lineage') {
ensureLineages();
id = id || 1;
var lrec = (db.lineages || []).find(function(x){ return x.LineageID === id; });
label = 'LINEAGE "'+ (lrec ? lrec.DisplayName : ('LineageID '+ id)) + '"';
} else {
scope = 'league';
id = id || 129;
var l = (db.leagues || []).find(function(x){ return x.LeagueID === id; });
label = 'LEAGUE '+ id + (l ? ' - '+ l.LeagueName : ' (not found)');
}
var res = calculateBestSeriesStreak(scope, id, 5, 10);
var out = [];
out.push('BEST SERIES STREAK DRY RUN - '+ label);
out.push('Variant: '+ res.variant + '   (perLeague ranks by cumulative pins; calendar ranks by weighted avg pins/games, v30.90)');
out.push('');
for (var x = 5; x <= 10; x++) {
var entry = res.windows[x];
var w = entry ? entry.best : null;
var c = entry ? entry.current : null;
out.push('── '+ x + '-WEEK WINDOW ──');
if (!w) { out.push('  No qualifying window (not enough series/weeks yet).'); out.push(''); continue; }
out.push('  RECORD  pins '+ w.pins + '   games '+ w.games + '   avg '+ w.avg.toFixed(2));
if (res.variant === 'calendar') {
out.push('          span '+ w.startWeek + '  ->  '+ w.endWeek + '   multi-league weeks: '+ w.multiLeagueWeeks + '/'+ x);
} else {
out.push('          span '+ w.startDate + '  ->  '+ w.endDate + '   series: '+ w.seriesIDs.join(', '));
}
if (c) {
var pct = w.avg ? Math.round(c.avg / w.avg * 100) : 0;
out.push('  CURRENT pins '+ c.pins + '   games '+ c.games + '   avg '+ c.avg.toFixed(2) + '   ('+ pct + '% of record'+ (pct >= 100 ? ' — AT RECORD': '') + ')');
} else {
out.push('  CURRENT (not enough recent data for a full '+ x + '-window yet)');
}
out.push('');
}
var after = JSON.stringify(db.series || []) + JSON.stringify(db.games || []);
out.push('MUTATION CHECK  (dry run must write nothing)');
out.push('  '+ (before === after ? 'PASS - no writes': 'FAIL - dry run mutated state'));
if (result) result.textContent = out.join('\n');
toast('Best streak dry run complete — '+ scope);
} catch(e) {
if (result) result.textContent = 'Best streak dry run failed:\n'+ (e && e.message ? e.message : e) + '\n'+ (e && e.stack ? e.stack : '');
}
}async function dkIDBDump() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Reading raw IDB...';
try {
var [rawSeries, rawGames, rawFrames, rawAtts] = await Promise.all(
IDB_STORES.map(idbGetAllDirect)
);
var openSessIDs = new Set((db.openSessions||[]).map(s=>s.SessionID));
var leagueSIDs  = new Set((db.leagues||[]).map(l=>l.LeagueID));
var lines = [];
lines.push('=== RAW IDB COUNTS ===');
lines.push('Series:   '+rawSeries.length);
lines.push('Games:    '+rawGames.length);
lines.push('Frames:   '+rawFrames.length);
lines.push('Attempts: '+rawAtts.length);
lines.push('');
lines.push('=== db.openSessions (localStorage) ===');
lines.push('Count: '+(db.openSessions||[]).length);
(db.openSessions||[]).forEach(function(s){
lines.push('  SessionID='+s.SessionID+' date='+s.DateBowled+' center='+s.CenterID);
});
lines.push('');
lines.push('=== IDB SERIES (all) ===');
rawSeries.forEach(function(s){
var inOpenSess = openSessIDs.has(s.SeriesID) ? '[OPEN-SESSION]': '';
var inLeague   = leagueSIDs.has(s.LeagueID)  ? '[LEAGUE]': '';
var tag = inOpenSess||inLeague||'[ORPHAN?]';
lines.push('  SeriesID='+s.SeriesID+' LeagueID='+s.LeagueID+' date='+s.DateBowled+' GameType='+s.GameType+' '+tag);
});
lines.push('');
lines.push('=== IDB GAMES per Series ===');
var bySeries = {};
rawGames.forEach(function(g){ (bySeries[g.SeriesID]=bySeries[g.SeriesID]||[]).push(g.GameID); });
Object.keys(bySeries).sort().forEach(function(sid){
var inSeries = rawSeries.some(function(s){ return s.SeriesID==sid; });
lines.push('  SeriesID='+sid+' ('+bySeries[sid].length+' games) '+(inSeries?'':'[NO SERIES RECORD - ORPHAN]'));
});
if (result) result.textContent = lines.join('\n');
} catch(err) {
if (result) result.textContent = 'Dump error: '+err.message;
}
} 
async function dkAIAnalyze() {
var result = document.getElementById('dk-purge-result');
var aiKey = localStorage.getItem('bowlingdb_ai_key');
if (!aiKey) { if (result) result.textContent = 'No AI key set. Add key in Settings.'; return; }
if (result) result.textContent = 'Gathering IDB state for AI analysis...';
try {
var [rawSeries, rawGames, rawFrames, rawAtts] = await Promise.all(
IDB_STORES.map(idbGetAllDirect)
);
var openSessIDs = (db.openSessions||[]).map(function(s){ return s.SessionID; });
var leagueIDs   = (db.leagues||[]).map(function(l){ return l.LeagueID; });
var context = {
idb: { seriesCount: rawSeries.length, gamesCount: rawGames.length, framesCount: rawFrames.length, attemptsCount: rawAtts.length },
series: rawSeries.map(function(s){ return {SeriesID:s.SeriesID,LeagueID:s.LeagueID,DateBowled:s.DateBowled,GameType:s.GameType}; }),
gamesBySeriesID: (function(){
var m={};
rawGames.forEach(function(g){ (m[g.SeriesID]=m[g.SeriesID]||[]).push({GameID:g.GameID,GameNumber:g.GameNumber,FinalScore:g.FinalScore}); });
return m;
})(),
openSessions: db.openSessions||[],
openSessionIDs: openSessIDs,
leagueIDs: leagueIDs,
idCounters: db.ids
};
var prompt = 'You are debugging a bowling score tracking PWA. Analyze this IndexedDB state and identify: (1) orphan records (games/series with no matching parent), (2) phantom records from deleted sessions that survived in IDB, (3) any SeriesID collisions between open bowling sessions and league series, (4) what should be deleted to clean up. Be specific with IDs. State: '+JSON.stringify(context);
if (result) result.textContent = 'Asking AI...';
var resp = await fetch('https://api.anthropic.com/v1/messages', {
method:'POST',
headers:{'Content-Type':'application/json','x-api-key':aiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
body:JSON.stringify({model:getAIModelDeep(),max_tokens:1024,messages:[{role:'user',content:prompt}]})
});
var data = await resp.json();
var text = (data.content||[]).map(function(b){ return b.text||''; }).join('');
if (result) result.textContent = text || JSON.stringify(data);
} catch(err) {
if (result) result.textContent = 'AI error: '+err.message;
}
} 
async function dkPurgeOrphans() {
var result = document.getElementById('dk-purge-result');
if (result) result.textContent = 'Reading raw IDB...';
try {

var [rawSeries, rawGames, rawFrames, rawAtts] = await Promise.all(
IDB_STORES.map(idbGetAllDirect)
);
var openSessIDs = new Set((db.openSessions||[]).map(function(s){ return s.SessionID; }));
var rawSeriesIDs = new Set(rawSeries.map(function(s){ return s.SeriesID; }));
var rawGameIDs   = new Set(rawGames.map(function(g){ return g.GameID; }));
var rawFrameIDs  = new Set(rawFrames.map(function(f){ return f.FrameID; }));

var leagueSeriesIDs = new Set((db.series||[]).filter(function(s){ return s.LeagueID && s.LeagueID!=0; }).map(function(s){ return s.SeriesID; }));
var orphanSeries = rawSeries.filter(function(s){
var isOpenWithSession = (s.LeagueID==0||s.LeagueID==='0'||s.GameType==='Open') && openSessIDs.has(s.SeriesID);
var isLeagueSeries    = leagueSeriesIDs.has(s.SeriesID);
return !isOpenWithSession && !isLeagueSeries;
});
var orphanSeriesIDs = new Set(orphanSeries.map(function(s){ return s.SeriesID; }));

var orphanGames = rawGames.filter(function(g){ return !rawSeriesIDs.has(g.SeriesID); });


rawSeries.forEach(function(ser){
var league = (db.leagues||[]).find(function(l){ return l.LeagueID===ser.LeagueID; });
var gps = ser.GamesPerSeries || (league && league.GamesPerSeries) || 0;
if (!gps) return;
var serGames = rawGames.filter(function(g){ return g.SeriesID===ser.SeriesID; });
if (serGames.length > gps) {

serGames.sort(function(a,b){ return (b.GameNumber||0)-(a.GameNumber||0); });
var extras = serGames.slice(0, serGames.length - gps);
extras.forEach(function(g){
if (g.FinalScore === null || g.FinalScore === undefined) orphanGames.push(g);
});
}
});
var orphanGameIDs = new Set(orphanGames.map(function(g){ return g.GameID; }));

var orphanFrames = rawFrames.filter(function(f){ return !rawGameIDs.has(f.GameID); });
var orphanFrameIDs = new Set(orphanFrames.map(function(f){ return f.FrameID; }));

var orphanAtts = rawAtts.filter(function(a){ return !rawFrameIDs.has(a.FrameID); });
var orphanAttIDs = orphanAtts.map(function(a){ return a.AttemptID; });
var total = orphanSeries.length + orphanGames.length + orphanFrames.length + orphanAtts.length;
if (result) result.textContent = 'Found orphans: series='+orphanSeries.length+' games='+orphanGames.length+' frames='+orphanFrames.length+' atts='+orphanAtts.length+'\nDeleting from IDB...';
if (total === 0) {
if (result) result.textContent = 'No orphans in raw IDB. Run Dump to inspect series/game records.';
return;
}

await idbDeleteKeys('attempts', orphanAttIDs);
await idbDeleteKeys('frames',   Array.from(orphanFrameIDs));
await idbDeleteKeys('games',    Array.from(orphanGameIDs));
await idbDeleteKeys('series',   Array.from(orphanSeriesIDs));

_scoringLoaded = false;
await loadScoringData();
if (result) result.textContent = 'Purged '+total+' orphans.\nSeries: '+orphanSeries.length+' (IDs: '+Array.from(orphanSeriesIDs).join(',')+')'+'\nGames: '+orphanGames.length+'\nFrames: '+orphanFrames.length+'\nAttempts: '+orphanAtts.length+'\n\nRun Dump to verify IDB is clean.';
toast('Purged '+total+' orphan records');
} catch(err) {
if (result) result.textContent = 'Purge error: '+err.message;
console.error('dkPurgeOrphans:', err);
}
}

async function dkNukeOpenPhantoms() {
var result = document.getElementById('dk-purge-result');
if (!confirm('Delete ALL open bowling IDB records not matching a current session? This cannot be undone. Current sessions are preserved.')) return;
if (result) result.textContent = 'Nuclear purge: reading IDB...';
try {
var [rawSeries, rawGames, rawFrames, rawAtts] = await Promise.all(
IDB_STORES.map(idbGetAllDirect)
);
var keepSessIDs = new Set((db.openSessions||[]).map(function(s){ return s.SessionID; }));

var nukeSeries = rawSeries.filter(function(s){
var isOpenType = (s.LeagueID==0||s.LeagueID==='0'||s.LeagueID==-1||s.GameType==='Open');
return isOpenType && !keepSessIDs.has(s.SeriesID);
});
var nukeSeriesIDs = new Set(nukeSeries.map(function(s){ return s.SeriesID; }));

var nukeGames = rawGames.filter(function(g){ return nukeSeriesIDs.has(g.SeriesID); });
var nukeGameIDs = new Set(nukeGames.map(function(g){ return g.GameID; }));

var nukeFrames = rawFrames.filter(function(f){ return nukeGameIDs.has(f.GameID); });
var nukeFrameIDs = new Set(nukeFrames.map(function(f){ return f.FrameID; }));
var nukeAtts   = rawAtts.filter(function(a){ return nukeFrameIDs.has(a.FrameID); });
if (result) result.textContent = 'Nuking: series='+nukeSeries.length+' games='+nukeGames.length+' frames='+nukeFrames.length+' atts='+nukeAtts.length+'...';
await idbDeleteKeys('attempts', nukeAtts.map(function(a){ return a.AttemptID; }));
await idbDeleteKeys('frames',   Array.from(nukeFrameIDs));
await idbDeleteKeys('games',    Array.from(nukeGameIDs));
await loadScoringData();
if (result) result.textContent = 'Nuclear purge complete.\nRemoved: series='+nukeSeries.length+' games='+nukeGames.length+' frames='+nukeFrames.length+' atts='+nukeAtts.length+'\nSeries IDs nuked: '+Array.from(nukeSeriesIDs).join(',')+'\n\nRun Dump to verify. Start fresh open session now.';
toast('Nuclear purge done — '+nukeSeries.length+' phantom sessions removed');
} catch(err) {
if (result) result.textContent = 'Nuclear error: '+err.message;
console.error('dkNukeOpenPhantoms:', err);
}
} 
function dkCopyResult() {
var el = document.getElementById('dk-purge-result');
var txt = el ? el.textContent : '';
if (!txt.trim()) { toast('Nothing to copy'); return; }
navigator.clipboard.writeText(txt)
.then(function(){
var btn = document.querySelector('[onclick="dkCopyResult()"]');
var orig = btn ? btn.textContent : '';
if (btn) { btn.textContent = 'Copied!'; btn.style.background='#2d6a4f'; }
toast('Result copied to clipboard ('+ txt.length + ' chars)');
setTimeout(function(){ if(btn){ btn.textContent=orig; btn.style.background=''; } }, 2000);
})
.catch(function(err){
toast('Copy failed — try selecting text manually');
console.error('Copy error:', err);
});
} 
async function dkApplyAIFix() {
var result = document.getElementById('dk-purge-result');
if (!confirm('Apply AI-recommended fix? Deletes phantom series 4, 415, 422, 429 and their games. League data untouched.')) return;
if (result) result.textContent = 'Reading IDB...';
try {
var [rawSeries, rawGames, rawFrames, rawAtts] = await Promise.all(IDB_STORES.map(idbGetAllDirect));
var openSessIDs = new Set((db.openSessions||[]).map(function(s){ return s.SessionID; }));



var targetSeriesIDs = new Set([423]);
rawSeries.forEach(function(s){
if ((s.LeagueID===-1 || s.LeagueID==='-1') && !openSessIDs.has(s.SeriesID)) targetSeriesIDs.add(s.SeriesID);

var knownLeagueIDs = new Set((db.leagues||[]).map(function(l){ return l.LeagueID; }));
if (s.LeagueID && s.LeagueID!==0 && !knownLeagueIDs.has(s.LeagueID) && !openSessIDs.has(s.SeriesID)) targetSeriesIDs.add(s.SeriesID);
});
var delGames   = rawGames.filter(function(g){ return targetSeriesIDs.has(g.SeriesID); });
var delGameIDs  = new Set(delGames.map(function(g){ return g.GameID; }));
var delFrames  = rawFrames.filter(function(f){ return delGameIDs.has(f.GameID); });
var delFrameIDs = new Set(delFrames.map(function(f){ return f.FrameID; }));
var delAtts    = rawAtts.filter(function(a){ return delFrameIDs.has(a.FrameID); });
if (result) result.textContent = 'Deleting: series='+targetSeriesIDs.size+' games='+delGames.length+' frames='+delFrames.length+' atts='+delAtts.length+'...';
await idbDeleteKeys('attempts', delAtts.map(function(a){ return a.AttemptID; }));
await idbDeleteKeys('frames',   Array.from(delFrameIDs));
await idbDeleteKeys('games',    Array.from(delGameIDs));
await idbDeleteKeys('series',   Array.from(targetSeriesIDs));
_scoringLoaded = false;
await loadScoringData();
var maxSID = Math.max(0, ...(db.series||[]).map(function(s){ return s.SeriesID; }),
...(db.openSessions||[]).map(function(s){ return s.SessionID; }));
var safeCounter = Math.max(db.ids.series||1, maxSID) + 1;
db.ids.openSession = safeCounter;
db.ids.series = safeCounter;
saveDB();
if (result) result.textContent = 'AI fix applied.\nDeleted series: '+Array.from(targetSeriesIDs).join(',')+'\nGames: '+delGames.length+'\nFrames: '+delFrames.length+'\nAttempts: '+delAtts.length+'\n\nID counters reset: series=openSession='+safeCounter+'\n\nRun Dump to verify, then start fresh open session.';
toast('AI fix applied');
} catch(err) {
if (result) result.textContent = 'Error: '+err.message;
console.error('dkApplyAIFix:', err);
}
} 
/* ── Shared export display: visible, selectable text + real Save As ──
   Replaces navigator.share()-based export (dkExport/dkmExport used to
   push a raw JSON string through iOS's native share sheet, which didn't
   copy/paste cleanly and had no reliable Save As). Shows the payload in
   a plain readonly textarea (tap to select-all, explicit Copy button)
   and a Save File button using the same Blob + <a download> pattern
   dkIdbExport() already uses correctly. */
function dkShowExportText(title, text, filenameBase) {
var esc = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
var html =
'<div class="modal-title">'+ title + '</div>'+
'<textarea id="dk-export-text" readonly onclick="this.select()" '+
'style="width:100%;height:320px;font-family:monospace;font-size:11px;'+
'background:#0A0D14;color:#c9d1d9;border:1px solid #2a2f3a;border-radius:8px;'+
'padding:10px;box-sizing:border-box;">'+ esc + '</textarea>'+
'<div style="display:flex;gap:8px;margin-top:10px;">'+
'<button class="btn btn-primary" style="flex:1" onclick="dkExportCopy()">Copy</button>'+
'<button class="btn btn-secondary" style="flex:1" onclick="dkExportSaveFile(\''+ filenameBase + '\')">Save File</button>'+
'<button class="btn" style="flex:1" onclick="closeModal()">Close</button>'+
'</div>';
openModal(html);
var ta = document.getElementById('dk-export-text');
if (ta) ta.select();
}function dkExportCopy() {
var ta = document.getElementById('dk-export-text');
if (!ta) return;
ta.select();
if (navigator.clipboard && navigator.clipboard.writeText) {
navigator.clipboard.writeText(ta.value)
.then(function(){ toast('Copied ✓'); })
.catch(function(){ toast('Copy failed — text is selected, use manual copy'); });
} else {
try { document.execCommand('copy'); toast('Copied ✓'); }
catch(e) { toast('Copy failed — text is selected, use manual copy'); }
}
}function dkExportSaveFile(filenameBase) {
var ta = document.getElementById('dk-export-text');
if (!ta) return;
var ts = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
var filename = filenameBase + '_'+ ts + '.json';
var blob = new Blob([ta.value], { type:'application/json'});
var url = URL.createObjectURL(blob);
var a = document.createElement('a');
a.href = url; a.download = filename;
document.body.appendChild(a); a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);
toast('Saved '+ filename);
}function dkExport() {
var payload = JSON.stringify({
_devkit:     true,
_exported:   new Date().toISOString(),
_appVersion: 'BowlingDB PWA v30',
entries:     dkLoadLog(),
mapEdits:    (function(){ try{ return JSON.parse(localStorage.getItem(DKM_MAP_KEY)||'[]'); }catch(e){return[];} })()
}, null, 2);
dkShowExportText('DevLog Export', payload, 'bowlingdb_devlog');
} 
function dkRegenerateCodeMap() {
try {
var scripts = document.querySelectorAll('script');
var scriptText = '';
scripts.forEach(function(s){ if(!s.src) scriptText += s.textContent+'\n'; });
var lines  = scriptText.split('\n');
var fnPat  = /^function\s+(\w+)\s*\(([^)]*)\)/;
var fns    = [];
lines.forEach(function(line,i){
var m = fnPat.exec(line.trim());
if(m) fns.push({fn:m[1],params:m[2].trim(),line:i+1});
});
var allEls = document.querySelectorAll('[id]');
var idSet  = {};
allEls.forEach(function(el){
var id=el.id; if(!id||id.length>50) return;
var parts=id.split('-');
if(parts.length>1&&/^\d+$/.test(parts[parts.length-1])){
idSet[parts.slice(0,-1).join('-')+'-']=true;
} else { idSet[id]=true; }
});
var keyIds = Object.keys(idSet).sort().slice(0,150);
window._DK_CODE_MAP_LIVE = {
version:'BowlingDB v22',
totalLines:document.documentElement.outerHTML.split('\n').length,
functions:fns, keyIds:keyIds
};
} catch(err) {}
} 
function dkmScreenKey() {
var s = getCurrentScreen();
var map = {
's-home':             'HOME',
's-leagues':          'LEAGUES',
's-series':           'SERIES',
's-scoring':          'SCORING',
's-game-complete':    'SCORING',
's-game-select':      'SCORING',
's-group':            'TEAMBOWL',
's-tb-sessions':      'TEAMBOWL',
's-tb-games':         'TEAMBOWL',
's-stats':            'STATS',
's-games':            'STATS',
's-balls':            'BALLS',
's-open':             'OPEN',
's-notap':            'SERIES',
's-tournaments':      'LEAGUES',
's-tournament-series':'SERIES',
's-handicap-league':  'LEAGUES',
's-handicap-tb':      'TEAMBOWL',
};
return map[s] || 'MODALS';
} 
function dkmSaveEdits() {
try {
localStorage.setItem(DKM_MAP_KEY, JSON.stringify(
DKM_ROWS.map(function(r){
return {
id:r.id, desired:r.desired, notes:r.notes,
status:r.status, priority:r.priority,
cat:r.cat||'note', desc:r.desc||'', ref:r.ref||'',

_dynamic: r._dynamic||false,
object:r.object, form:r.form, current:r.current||'',
type:r.type||'BUTTON', trigger:r.trigger||'tap',
stores:r.stores||'no', domHint:r.domHint||''
};
})
));
} catch(e) {}
}function dkmLoadEdits() {
try {
var saved = JSON.parse(localStorage.getItem(DKM_MAP_KEY)||'null');
if (!saved) return;
saved.forEach(function(s){
var r = DKM_ROWS.find(function(x){ return x.id===s.id; });
if (r) {

if (s.desired  !==undefined) r.desired  = s.desired;
if (s.notes    !==undefined) r.notes    = s.notes;
if (s.status   !==undefined) r.status   = s.status;
if (s.priority !==undefined) r.priority = s.priority;
if (s.cat      !==undefined) r.cat      = s.cat;
if (s.desc     !==undefined) r.desc     = s.desc;
if (s.ref      !==undefined) r.ref      = s.ref;
} else if (s.object) {

DKM_ROWS.push({
id:s.id, form:s.form||'HOME', object:s.object, type:s.type||'BUTTON',
trigger:s.trigger||'tap', stores:s.stores||'no',
status:s.status||'tbd', priority:s.priority||2,
current:s.current||'', desired:s.desired||'', notes:s.notes||'',
domHint:s.domHint||'', cat:s.cat||'note', desc:s.desc||'', ref:s.ref||'',
_dynamic:true
});
}
});
} catch(e) {}
} 
function dkmInit() { dkmLoadEdits(); dkmStep('screen'); dkmRenderScreens(); }function dkmStep(step) {
DKM.step = step;
['screen','object','detail','new','quicklog'].forEach(function(s){
var el = document.getElementById('dkm-step-'+s);
if (el) el.style.display = s===step ? '': 'none';
});
if (step === 'quicklog') dkmRenderQuickLog();
dkmRenderBreadcrumb();
}function dkmRenderQuickLog() {
var cats = [
{id:'bug',  label:'Bug',     cls:'dk-sel-bug'},
{id:'ui',   label:'UI',      cls:'dk-sel-ui'},
{id:'feat', label:'Feature', cls:'dk-sel-feat'},
{id:'note', label:'Note',    cls:'dk-sel-note'}
];
var selCat = DKM._editCat || 'note';
var catBtns = cats.map(function(c){
return '<button class="dk-cat-btn'+(selCat===c.id?' '+c.cls:'')+'" onclick="dkmSetQuickCat(\''+c.id+ '\')">'
+c.label+'</button>';
}).join('');
var screens = ['HOME','LEAGUES','SERIES','SCORING','TEAMBOWL','STATS','BALLS','OPEN','MODALS'];
var curScreen = dkmScreenKey();
var screenOpts = screens.map(function(s){
return '<option value="'+s+'"'+(curScreen===s?' selected':'')+'>'+s+'</option>';
}).join('');
var el = document.getElementById('dkm-step-quicklog');
if (!el) return;
el.innerHTML =
'<div style="padding:10px 10px 12px">'
+'<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:6px">Type</div>'
+'<div class="dk-cat-row" id="dkm-ql-cats">'+catBtns+'</div>'
+'<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:6px">Description</div>'
+'<textarea id="dkm-ql-msg" rows="3" style="width:100%;background:var(--bg3);border:1px solid var(--border1);'
+'color:var(--t1);font-size:13px;padding:8px 10px;border-radius:8px;font-family:inherit;resize:none;outline:none;'
+'box-sizing:border-box;line-height:1.5;margin-bottom:8px" placeholder="Describe the issue or request…"></textarea>'
+'<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:6px">Screen</div>'
+'<select id="dkm-ql-screen" style="width:100%;background:var(--bg3);border:1px solid var(--border1);'
+'color:var(--t1);font-size:13px;padding:8px 10px;border-radius:8px;outline:none;margin-bottom:12px;'
+'font-family:inherit;-webkit-appearance:none">'+screenOpts+'</select>'
+'<button onclick="dkmSaveQuickLog()" style="width:100%;padding:11px;border-radius:10px;'
+'background:rgba(0,217,217,0.15);color:var(--teal);font-size:14px;font-weight:700;'
+'border:1px solid rgba(0,217,217,0.35);cursor:pointer">Save Log Entry</button>'
+'<button onclick="dkmStep(\'new\')" style="width:100%;margin-top:6px;padding:9px;border-radius:10px;'
+'background:var(--bg3);color:var(--t3);font-size:12px;font-weight:600;'
+'border:1px solid var(--border1);cursor:pointer">+ Add to Map instead</button>'
+'</div>';
}function dkmSetQuickCat(cat) {
DKM._editCat = cat;
var cats = ['bug','ui','feat','note'];
var clsMap = {bug:'dk-sel-bug',ui:'dk-sel-ui',feat:'dk-sel-feat',note:'dk-sel-note'};
document.querySelectorAll('#dkm-ql-cats .dk-cat-btn').forEach(function(btn, i){
btn.className = 'dk-cat-btn'+ (cats[i]===cat ? ' '+clsMap[cat] : '');
});
}function dkmSaveQuickLog() {
var msg    = (document.getElementById('dkm-ql-msg')    ||{}).value||'';
var screen = (document.getElementById('dkm-ql-screen') ||{}).value||getCurrentScreen();
if (!msg.trim()) { toast('Add a description first'); return; }
var snap = {
screen:   getCurrentScreen(),
leagueID: G.leagueID||null, seriesID: G.seriesID||null, gameID: G.gameID||null,
modalOpen: !!(document.getElementById('modal-bg')&&document.getElementById('modal-bg').classList.contains('open'))
};
var entry = {
id: Date.now(), ts: new Date().toISOString(),
cat: DKM._editCat||'note', msg: msg.trim(),
screen: screen, ref: null, mapRowId: null,
status: 'open', snap: snap
};
var log = dkLoadLog();
log.unshift(entry);
dkSaveLog(log);
dkRenderEntries();

var msgEl = document.getElementById('dkm-ql-msg');
if (msgEl) msgEl.value = '';
toast('Log entry saved ✓');
}function dkmRenderBreadcrumb() {
var bc = document.getElementById('dkm-breadcrumb');
if (!bc) return;
var parts = ['<span style="color:var(--t3);cursor:pointer" onclick="dkmStep(\'screen\')">All</span>'];
if (DKM.screen) {
var sm = DKM_SCREENS[DKM.screen]||{icon:'',name:DKM.screen};
parts.push('<span style="color:var(--t3)">›</span>');
parts.push('<span style="color:var(--teal);cursor:pointer" onclick="dkmStep(\'object\')">'+sm.icon+' '+sm.name+'</span>');
}
if ((DKM.step==='detail'||DKM.step==='new') && DKM.rowId) {
var row = DKM_ROWS.find(function(r){ return r.id===DKM.rowId; });
if (row) {
parts.push('<span style="color:var(--t3)">›</span>');
var name = row.object.length>22 ? row.object.slice(0,20)+'…': row.object;
parts.push('<span style="color:var(--t1)">'+_escHtml(name)+'</span>');
}
}
if (DKM.step==='new') {
parts.push('<span style="color:var(--t3)">›</span>');
parts.push('<span style="color:var(--purple)">New Entry</span>');
}
bc.innerHTML = parts.join(' ');
} 
function dkmRenderScreens() {
var grid = document.getElementById('dkm-screen-grid');
if (!grid) return;
var html = '';
Object.keys(DKM_SCREENS).forEach(function(key){
var meta    = DKM_SCREENS[key];
var rows    = DKM_ROWS.filter(function(r){ return r.form===key; });
var broken  = rows.filter(function(r){ return r.status==='broken'; }).length;
var partial = rows.filter(function(r){ return r.status==='partial'; }).length;
var badge   = broken
? '<span style="position:absolute;top:5px;right:5px;background:rgba(232,93,76,0.2);color:var(--red);font-size:10px;font-weight:800;padding:1px 5px;border-radius:8px">'+broken+'</span>'
: partial
? '<span style="position:absolute;top:5px;right:5px;background:rgba(255,215,0,0.15);color:var(--gold);font-size:10px;font-weight:800;padding:1px 5px;border-radius:8px">'+partial+'</span>'
: '';
var border = broken ? 'rgba(232,93,76,0.3)': partial ? 'rgba(255,215,0,0.2)': 'var(--border1)';
html += '<div style="background:var(--bg2);border:1px solid '+border+';border-radius:10px;padding:10px;cursor:pointer;position:relative;-webkit-tap-highlight-color:transparent" ontouchstart="" onclick="dkmSelectScreen(\''+key+'\')">'+
badge+
'<div style="font-size:20px;margin-bottom:5px">'+meta.icon+'</div>'+
'<div style="font-size:12px;font-weight:700;color:var(--t1);margin-bottom:2px;line-height:1.2">'+meta.name+'</div>'+
'<div style="font-size:10px;color:var(--t3)">'+rows.length+' objects</div>'+
'</div>';
});
grid.innerHTML = html;
}function dkmSelectScreen(key) {
DKM.screen = key; DKM.typeF = 'ALL';
var s = document.getElementById('dkm-search'); if (s) s.value='';
dkmRenderTypeRow(); dkmRenderObjects(); dkmStep('object');
} 
function dkmRenderTypeRow() {
var row = document.getElementById('dkm-type-row');
if (!row) return;
var types = [];
DKM_ROWS.filter(function(r){ return r.form===DKM.screen; }).forEach(function(r){
if (types.indexOf(r.type)<0) types.push(r.type);
});
var chips = '<div style="padding:3px 9px;border-radius:14px;font-size:11px;font-weight:600;border:1px solid var(--border1);background:'+(DKM.typeF==='ALL'?'rgba(0,217,217,0.1)':'var(--bg2)')+';color:'+(DKM.typeF==='ALL'?'var(--teal)':'var(--t3)')+';cursor:pointer;white-space:nowrap;flex-shrink:0" ontouchstart="" onclick="dkmSetType(\'ALL\')">All</div>';
types.forEach(function(t){
var icon = DKM_TYPE_ICONS[t]||'•';
chips += '<div style="padding:3px 9px;border-radius:14px;font-size:11px;font-weight:600;border:1px solid var(--border1);background:'+(DKM.typeF===t?'rgba(157,78,221,0.1)':'var(--bg2)')+';color:'+(DKM.typeF===t?'var(--purple)':'var(--t3)')+';cursor:pointer;white-space:nowrap;flex-shrink:0" ontouchstart="" onclick="dkmSetType(\''+t+'\')">'+icon+' '+t+'</div>';
});
row.innerHTML = chips;
}function dkmSetType(t) { DKM.typeF=t; dkmRenderTypeRow(); dkmRenderObjects(); }function dkmSortRows(a,b) {
var sv={broken:0,partial:1,ok:2,tbd:3};
if (sv[a.status]!==sv[b.status]) return sv[a.status]-sv[b.status];
return a.priority-b.priority;
}function dkmRenderObjects() {
var list = document.getElementById('dkm-obj-list');
if (!list) return;
var q = ((document.getElementById('dkm-search')||{}).value||'').toLowerCase();
var rows = DKM_ROWS.filter(function(r){
if (r.form!==DKM.screen) return false;
if (DKM.typeF!=='ALL'&& r.type!==DKM.typeF) return false;
if (q && !(r.object+r.current+r.desired+r.notes).toLowerCase().includes(q)) return false;
return true;
}).slice().sort(dkmSortRows);
if (!rows.length) { list.innerHTML='<div style="padding:16px 12px;color:var(--t3);font-size:12px;text-align:center">No objects match</div>'; return; }
var sc={ok:'🟢',broken:'🔴',partial:'🟡',tbd:'⚪'};
var priColor={'1':'var(--red)','2':'var(--gold)','3':'var(--t3)'};
var html = rows.map(function(r){
var hasD = r.desired && r.desired.trim();
return '<div style="margin:0 8px 5px;background:var(--bg3);border-radius:8px;border:1px solid var(--border1);border-left:3px solid '+priColor[r.priority]+';padding:9px 10px;cursor:pointer;-webkit-tap-highlight-color:transparent;display:flex;align-items:center;gap:8px" ontouchstart="" onclick="dkmSelectRow('+r.id+')">'+
'<div style="flex:1;min-width:0">'+
'<div style="font-size:12px;font-weight:600;color:var(--t1);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+_escHtml(r.object)+'</div>'+
'<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">'+
'<span style="font-size:10px">'+sc[r.status]+'</span>'+
'<span style="font-size:10px;color:var(--t3)">'+(DKM_TYPE_ICONS[r.type]||'•')+' '+r.type+'</span>'+
(hasD?'<span style="font-size:9px;font-weight:700;color:var(--teal)">✎</span>':'')+
'</div>'+
'</div>'+
'<div style="color:var(--t3);font-size:14px">›</div>'+
'</div>';
}).join('');
html += '<div style="margin:8px 8px 0;padding:9px 10px;border-radius:8px;border:1px dashed var(--border1);cursor:pointer;text-align:center;color:var(--t3);font-size:12px;font-weight:600;-webkit-tap-highlight-color:transparent" ontouchstart="" onclick="dkmNewRow()">+ Add New Object</div>';
list.innerHTML = html;
} 
function dkmSelectRow(id) {
DKM.rowId = id;
var r = DKM_ROWS.find(function(x){ return x.id===id; });
DKM._editStatus   = r ? r.status   : 'tbd';
DKM._editPriority = r ? r.priority : 2;
DKM._editCat      = r ? (r.cat || 'note') : 'note';
dkmRenderDetail();
dkmStep('detail');
}function dkmRenderDetail() {
var row = DKM_ROWS.find(function(r){ return r.id===DKM.rowId; });
if (!row) return;
var sm = DKM_SCREENS[row.form]||{icon:'',name:row.form};
var dc = document.getElementById('dkm-detail-card');
if (dc) dc.innerHTML =
'<div style="padding:10px 12px;border-bottom:1px solid var(--border1)">'+
'<div style="font-size:13px;font-weight:700;color:var(--t1);margin-bottom:4px">'+_escHtml(row.object)+'</div>'+
'<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">'+
'<span style="font-size:10px;padding:2px 7px;border-radius:10px;background:rgba(0,217,217,0.07);color:var(--teal);border:1px solid rgba(0,217,217,0.15)">'+sm.icon+' '+sm.name+'</span>'+
'<span style="font-size:10px;padding:2px 7px;border-radius:10px;background:var(--bg3);color:var(--t3);border:1px solid var(--border1)">'+row.trigger+'</span>'+
(row.stores==='yes'?'<span style="font-size:10px;padding:2px 7px;border-radius:10px;background:rgba(255,215,0,0.07);color:var(--gold);border:1px solid rgba(255,215,0,0.15)">💾 stores</span>':'')+
'</div>'+
'<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--t3);margin-bottom:4px">Current Behavior</div>'+
'<div style="font-size:12px;color:var(--t2);line-height:1.5">'+_escHtml(row.current)+'</div>'+
(row.notes&&!row.desired?'<div style="font-size:11px;color:var(--t3);margin-top:6px;font-style:italic;line-height:1.4">'+_escHtml(row.notes)+'</div>':'')+
'</div>';
var des = document.getElementById('dkm-desired');
var not = document.getElementById('dkm-notes');
var dsc = document.getElementById('dkm-desc');
var ref = document.getElementById('dkm-ref-display');
if (des) des.value = row.desired||'';
if (not) not.value = row.notes  ||'';
if (dsc) dsc.value = row.desc   ||'';

if (ref) {
if (row.ref) { ref.textContent = '📌 '+row.ref; ref.style.display='block'; }
else { ref.style.display='none'; }
}

var cr = document.getElementById('dkm-cat-row');
var rowCat = row.cat||'note';
if (cr) cr.innerHTML = ['bug','ui','feat','note'].map(function(c){
var labels = {bug:'🔴 Bug',ui:'🟣 UI',feat:'🔵 Feature',note:'🟡 Note'};
var sel = c===rowCat;
var bg  = sel?(c==='bug'?'rgba(232,93,76,0.18)':c==='ui'?'rgba(157,78,221,0.18)':c==='feat'?'rgba(0,217,217,0.15)':'rgba(255,215,0,0.12)'):'var(--bg3)';
var col = sel?(c==='bug'?'var(--red)':c==='ui'?'var(--purple)':c==='feat'?'var(--teal)':'var(--gold)'):'var(--t3)';
var bdr = sel?(c==='bug'?'rgba(232,93,76,0.35)':c==='ui'?'rgba(157,78,221,0.35)':c==='feat'?'rgba(0,217,217,0.3)':'rgba(255,215,0,0.28)'):'var(--border1)';
return '<button style="flex:1;padding:6px 3px;border-radius:8px;font-size:11px;font-weight:700;border:1px solid '+bdr+';background:'+bg+';color:'+col+';cursor:pointer" data-c="'+c+'" onclick="dkmSetCat(this.dataset.c)" ontouchstart="">'+labels[c]+'</button>';
}).join('');
DKM._editCat = rowCat;

var sr = document.getElementById('dkm-status-row');
if (sr) sr.innerHTML = ['ok','partial','broken','tbd'].map(function(s){
var sel=s===row.status;
var bg =sel?(s==='ok'?'rgba(61,220,132,0.15)':s==='partial'?'rgba(255,215,0,0.1)':s==='broken'?'rgba(232,93,76,0.12)':'rgba(255,255,255,0.06)'):'var(--bg3)';
var col=sel?(s==='ok'?'#3ddc84':s==='partial'?'var(--gold)':s==='broken'?'var(--red)':'var(--t2)'):'var(--t3)';
var bdr=sel?(s==='ok'?'rgba(61,220,132,0.4)':s==='partial'?'rgba(255,215,0,0.35)':s==='broken'?'rgba(232,93,76,0.4)':'rgba(255,255,255,0.2)'):'var(--border1)';
return '<button style="flex:1;padding:7px 4px;border-radius:8px;font-size:11px;font-weight:700;border:1px solid '+bdr+';background:'+bg+';color:'+col+';cursor:pointer" data-s="'+s+'" onclick="dkmSetStatus(this.dataset.s)" ontouchstart="">'+_DKM_STATUS_LABELS[s]+'</button>';
}).join('');

var pr = document.getElementById('dkm-pri-row');
if (pr) pr.innerHTML = [1,2,3].map(function(p){
var sel=p===row.priority;
var col=p===1?'var(--red)':p===2?'var(--gold)':'var(--t3)';
var bg =sel?(p===1?'rgba(232,93,76,0.12)':p===2?'rgba(255,215,0,0.1)':'rgba(255,255,255,0.05)'):'var(--bg3)';
var bdr=sel?(p===1?'rgba(232,93,76,0.4)':p===2?'rgba(255,215,0,0.35)':'rgba(255,255,255,0.2)'):'var(--border1)';
var lbl=p===1?'1 — Must fix':p===2?'2 — Should fix':'3 — Nice to have';
return '<button style="flex:1;padding:7px 4px;border-radius:8px;font-size:11px;font-weight:700;border:1px solid '+bdr+';background:'+bg+';color:'+(sel?col:'var(--t3)')+';cursor:pointer" data-p="'+p+'" onclick="dkmSetPri('+p+')" ontouchstart="">'+lbl+'</button>';
}).join('');

var peers = DKM_ROWS.filter(function(r){ return r.form===DKM.screen; }).slice().sort(dkmSortRows);
var idx   = peers.findIndex(function(r){ return r.id===DKM.rowId; });
var nav   = document.getElementById('dkm-detail-nav');
if (nav) nav.innerHTML =
(idx>0?'<button style="flex:1;padding:8px;border-radius:8px;background:var(--bg3);border:1px solid var(--border1);color:var(--t2);font-size:12px;font-weight:600;cursor:pointer" ontouchstart="" onclick="dkmNavDetail(-1)">← Prev</button>':'')+
(idx<peers.length-1?'<button style="flex:1;padding:8px;border-radius:8px;background:var(--bg3);border:1px solid var(--border1);color:var(--t2);font-size:12px;font-weight:600;cursor:pointer" ontouchstart="" onclick="dkmNavDetail(1)">Next →</button>':'');
}function dkmSetStatus(s) {
DKM._editStatus = s;
var sr = document.getElementById('dkm-status-row');
if (!sr) return;
sr.querySelectorAll('button').forEach(function(b){
var bs = b.getAttribute('data-s');
var sel= bs===s;
b.style.background  = sel?(bs==='ok'?'rgba(61,220,132,0.15)':bs==='partial'?'rgba(255,215,0,0.1)':bs==='broken'?'rgba(232,93,76,0.12)':'rgba(255,255,255,0.06)'):'var(--bg3)';
b.style.color       = sel?(bs==='ok'?'#3ddc84':bs==='partial'?'var(--gold)':bs==='broken'?'var(--red)':'var(--t2)'):'var(--t3)';
b.style.borderColor = sel?(bs==='ok'?'rgba(61,220,132,0.4)':bs==='partial'?'rgba(255,215,0,0.35)':bs==='broken'?'rgba(232,93,76,0.4)':'rgba(255,255,255,0.2)'):'var(--border1)';
});
}function dkmSetPri(p) {
DKM._editPriority = p;
var pr = document.getElementById('dkm-pri-row');
if (!pr) return;
pr.querySelectorAll('button').forEach(function(b){
var bp  = parseInt(b.getAttribute('data-p'));
var sel = bp===p;
var col = bp===1?'var(--red)':bp===2?'var(--gold)':'var(--t3)';
var bg  = sel?(bp===1?'rgba(232,93,76,0.12)':bp===2?'rgba(255,215,0,0.1)':'rgba(255,255,255,0.05)'):'var(--bg3)';
var bdr = sel?(bp===1?'rgba(232,93,76,0.4)':bp===2?'rgba(255,215,0,0.35)':'rgba(255,255,255,0.2)'):'var(--border1)';
b.style.background=bg; b.style.borderColor=bdr; b.style.color=sel?col:'var(--t3)';
});
}function dkmSetCat(c) {
DKM._editCat = c;
var cr = document.getElementById('dkm-cat-row');
if (!cr) return;
cr.querySelectorAll('button').forEach(function(b){
var bc  = b.getAttribute('data-c');
var sel = bc===c;
var bg  = sel?(bc==='bug'?'rgba(232,93,76,0.18)':bc==='ui'?'rgba(157,78,221,0.18)':bc==='feat'?'rgba(0,217,217,0.15)':'rgba(255,215,0,0.12)'):'var(--bg3)';
var col = sel?(bc==='bug'?'var(--red)':bc==='ui'?'var(--purple)':bc==='feat'?'var(--teal)':'var(--gold)'):'var(--t3)';
var bdr = sel?(bc==='bug'?'rgba(232,93,76,0.35)':bc==='ui'?'rgba(157,78,221,0.35)':bc==='feat'?'rgba(0,217,217,0.3)':'rgba(255,215,0,0.28)'):'var(--border1)';
b.style.background=bg; b.style.color=col; b.style.borderColor=bdr;
});
}function dkmSaveDetail(silent) {
var row = DKM_ROWS.find(function(r){ return r.id===DKM.rowId; });
if (!row) { if (!silent) toast('Save failed — row not found'); return; }
var des = document.getElementById('dkm-desired');
var not = document.getElementById('dkm-notes');
var dsc = document.getElementById('dkm-desc');
var ref = document.getElementById('dkm-ref-display');
row.desired  = des ? des.value.trim() : row.desired;
row.notes    = not ? not.value.trim() : row.notes;
row.desc     = dsc ? dsc.value.trim() : (row.desc||'');
row.cat      = DKM._editCat      || row.cat || 'note';
row.status   = DKM._editStatus   || row.status || 'tbd';
row.priority = DKM._editPriority || row.priority || 2;
if (ref && ref.style.display !== 'none') {
row.ref = (ref.textContent||'').replace(/^📌\s*/,'').trim();
}
dkmSaveEdits();
if (!silent) {
toast('Log item saved ✓');
dkTab('entries');
}
}function dkmNavDetail(dir) {
dkmSaveDetail(true);
var peers = DKM_ROWS.filter(function(r){ return r.form===DKM.screen; }).slice().sort(dkmSortRows);
var idx   = peers.findIndex(function(r){ return r.id===DKM.rowId; });
var next  = peers[idx+dir];
if (next) { DKM.rowId=next.id; DKM._editStatus=next.status; DKM._editPriority=next.priority; dkmRenderDetail(); }
} 
function dkmNewRow(snap) {
var ctx = document.getElementById('dkm-new-ctx');
var obj = document.getElementById('dkm-new-obj');
var frm = document.getElementById('dkm-new-form');
var cur = document.getElementById('dkm-new-current');
var des = document.getElementById('dkm-new-desired');
var nsr = document.getElementById('dkm-new-status-row');
if (snap) {
if (ctx) ctx.textContent = 'Pre-filled from tapped element — edit as needed.';
if (obj) obj.value = snap.object||'';
if (frm) frm.value = snap.form||DKM.screen||'HOME';
if (cur) cur.value = snap.current||'';
} else {
if (ctx) ctx.textContent = 'Describe a new interaction not yet in the map.';
if (obj) obj.value='';
if (frm) frm.value = DKM.screen||'HOME';
if (cur) cur.value='';
}
if (des) des.value='';
DKM._newStatus='tbd';
if (nsr) nsr.innerHTML = ['ok','partial','broken','tbd'].map(function(s){
return '<button style="flex:1;padding:6px 3px;border-radius:8px;font-size:10px;font-weight:700;border:1px solid var(--border1);background:var(--bg3);color:var(--t3);cursor:pointer" data-s="'+s+'" onclick="dkmNewSetStatus(this.dataset.s)" ontouchstart="">'+_DKM_STATUS_LABELS[s]+'</button>';
}).join('');
dkmStep('new');
}function dkmNewSetStatus(s) {
DKM._newStatus = s;
var nsr = document.getElementById('dkm-new-status-row');
if (!nsr) return;
nsr.querySelectorAll('button').forEach(function(b){
var bs=b.getAttribute('data-s'), sel=bs===s;
b.style.background  = sel?'rgba(0,217,217,0.1)':'var(--bg3)';
b.style.color       = sel?'var(--teal)':'var(--t3)';
b.style.borderColor = sel?'rgba(0,217,217,0.35)':'var(--border1)';
});
}function dkmSaveNew() {
var obj  = (document.getElementById('dkm-new-obj')    ||{}).value||'';
var form = (document.getElementById('dkm-new-form')   ||{}).value||'HOME';
var cur  = (document.getElementById('dkm-new-current')||{}).value||'';
var des  = (document.getElementById('dkm-new-desired')||{}).value||'';
if (!obj.trim()) { toast('Enter an object name'); return; }
var newId = Date.now();
DKM_ROWS.push({
id:newId, form:form, object:obj.trim(), type:'BUTTON', trigger:'tap',
stores:'no', status:DKM._newStatus||'tbd', priority:2,
current:cur.trim(), desired:des.trim(), notes:'', domHint:'',
cat:'note', desc:'', ref:''
});
dkmSaveEdits();
var entry = {id:Date.now()+1, ts:new Date().toISOString(), cat:'note',
msg:'[Map] New entry: '+obj.trim()+' ('+form+')',
screen:form, ref:null, status:'open', snap:null, mapRowId:newId};
var log = dkLoadLog(); log.unshift(entry); dkSaveLog(log);
toast('Added to map ✓');
DKM.screen = form;
dkmSelectRow(newId);
} 
function dkmExport() {
var out = JSON.stringify(DKM_ROWS.map(function(r){
return {id:r.id,form:r.form,object:r.object,type:r.type,status:r.status,
priority:r.priority,current:r.current,desired:r.desired,notes:r.notes};
}), null, 2);
dkShowExportText('Interaction Map Export', out, 'bowlingdb_interaction_map');
} 
function dkBubbleCat(cat) {
_dk.pendingCat = cat;
var cats = ['bug','ui','feat','note'];
cats.forEach(function(c) {
var btn = document.getElementById('dkbbl-'+c);
if (!btn) return;
btn.className = 'dk-bbl-cat'+ (c === cat ? ' dk-bbl-sel-'+c : '');
});
} 
function dkBubbleLogAndLink() {

var cat      = _dk.pendingCat || 'bug';
var screen   = _dk.tagScreen  || getCurrentScreen();
var desc     = _dk.tagElDesc  || '';
var mapRowId = _dk.tagRowId   || null;
var ref      = _dk.pendingRef || null;
var snap = null;
try {
snap = {
screen:    getCurrentScreen(),
leagueID:  G.leagueID || null,
seriesID:  G.seriesID || null,
gameID:    G.gameID   || null,
modalOpen: !!(document.getElementById('modal-bg') &&
document.getElementById('modal-bg').classList.contains('open'))
};
} catch(ex) { snap = {error: ex.message}; }

var mapRow  = mapRowId && (typeof DKM_ROWS !== 'undefined')
? DKM_ROWS.find(function(r){ return r.id === mapRowId; }) : null;
var autoMsg = (mapRow ? mapRow.object : desc) + ' — '+ screen;
var entry = {
id:       Date.now(),
ts:       new Date().toISOString(),
cat:      cat,
msg:      autoMsg,
screen:   screen,
ref:      ref,
mapRowId: mapRowId,
status:   'open',
snap:     snap
};
var log = dkLoadLog();
log.unshift(entry);
dkSaveLog(log);

_dk.pendingRef      = null;
_dk.pendingMapRowId = null;

dkmTagDismiss(true);
var panel = document.getElementById('dk-panel');
if (panel) panel.classList.add('dk-open');
_dk.panelOpen = true;
if (!_dk.mapLoaded) { dkmInit(); _dk.mapLoaded = true; }
dkTab('map');

setTimeout(function() {
if (mapRow) {

DKM.screen = mapRow.form;
dkmSelectRow(mapRow.id);

DKM._editCat = cat; dkmSetCat(cat);

var dsc = document.getElementById('dkm-desc');
if (dsc) dsc.value = desc || autoMsg;

var refEl = document.getElementById('dkm-ref-display');
if (refEl) {
if (ref) { refEl.textContent = '📌 '+ref; refEl.style.display='block'; }
else { refEl.style.display='none'; }
}

mapRow.ref = ref || mapRow.ref || '';
} else {

var screenKey = screen || dkmScreenKey();
var newId = Date.now();
DKM_ROWS.push({
id:newId, form:screenKey, object:desc||ref||'New Item', type:'BUTTON', trigger:'tap',
stores:'no', status:'tbd', priority:2,
current: ref ? 'Tapped: '+ref : '',
desired:'', notes:'', domHint:'',
cat:cat, desc:desc||'', ref:ref||''
});
dkmSaveEdits();
DKM.screen = screenKey;
DKM._editCat = cat;
dkmSelectRow(newId);

var dsc2 = document.getElementById('dkm-desc');
if (dsc2) dsc2.value = desc || '';
var refEl2 = document.getElementById('dkm-ref-display');
if (refEl2) {
if (ref) { refEl2.textContent = '\u{1F4CC} '+ref; refEl2.style.display='block'; }
else { refEl2.style.display='none'; }
}
dkmSetCat(cat);
}
}, 80);
toast((mapRow ? mapRow.object : desc || 'Element') + ' ready to log ✓');
} 
function dkmTagConfirm() {
var savedRowId  = _dk.tagRowId;
var savedScreen = _dk.tagScreen||'HOME';
var savedDesc   = _dk.tagElDesc||'';
var savedCtx    = _dk.tagElContext||'';
dkmTagDismiss(true);
var panel = document.getElementById('dk-panel');
if (panel) panel.classList.add('dk-open');
_dk.panelOpen = true;
if (!_dk.mapLoaded) { dkmInit(); _dk.mapLoaded=true; }
dkTab('map');
setTimeout(function() {
if (savedRowId) {
var row = DKM_ROWS.find(function(r){ return r.id===savedRowId; });
if (row) { DKM.screen=row.form; dkmSelectRow(row.id); }
} else {
var snap = {object:savedDesc, form:savedScreen, current:savedCtx};
DKM.screen = savedScreen;
dkmNewRow(snap);
}
}, 80);
}function dkmTagDismiss(silent) {
var bubble = document.getElementById('dk-tag-bubble');
if (bubble) bubble.style.display='none';
if (!silent && _dk.pendingRef) {
var panel = document.getElementById('dk-panel');
if (panel) panel.classList.add('dk-open');
_dk.panelOpen = true;
dkTab('entries');
dkRenderRefChip();
}
_dk.tagEl=null; _dk.tagRowId=null; _dk.tagScreen=null;
_dk.tagElDesc=null; _dk.tagElContext=null;
} 
function dkToggleInspect() {
_dk.inspecting = !_dk.inspecting;
var overlay = document.getElementById('dk-inspect-overlay');
var banner  = document.getElementById('dk-inspect-banner');
var btn     = document.getElementById('dk-inspect-btn');
if (overlay) overlay.classList.toggle('dk-inspecting', _dk.inspecting);
if (banner)  banner.classList.toggle('dk-inspecting', _dk.inspecting);
if (btn)     btn.classList.toggle('dk-active', _dk.inspecting);
if (_dk.inspecting) {
dkmTagDismiss(true);
var panel = document.getElementById('dk-panel');
if (panel) panel.classList.remove('dk-open');
_dk.inspectHandler = function(e) {
var x = e.touches ? e.touches[0].clientX : e.clientX;
var y = e.touches ? e.touches[0].clientY : e.clientY;
if (overlay) overlay.style.display='none';
var target = document.elementFromPoint(x, y);
if (overlay) overlay.style.display='';
if (!target||target===document.body||target.id==='dk-inspect-overlay') return;
e.preventDefault();

var ref='', walk=target;
for (var i=0;i<6;i++) {
if (!walk||walk===document.body) break;
if (walk.id&&walk.id!=='app'&&!walk.id.startsWith('dk-')) { ref='#'+walk.id; break; }
if (walk.className&&typeof walk.className==='string') {
var cls=walk.className.trim().split(/\s+/).filter(function(c){
return c&&!c.startsWith('dk-')&&c!=='active'&&c!=='open'&&c!=='dk-open';
});
if (cls.length) { ref='.'+cls[0]; break; }
}
walk=walk.parentElement;
}
var label=(target.textContent||target.placeholder||'').trim().slice(0,50);
var fullRef=(ref||'['+target.tagName.toLowerCase()+']')+(label?' · "'+label+'"':'');

if (_dk.inspectHoverEl) _dk.inspectHoverEl.classList.remove('dk-inspect-highlight');
target.classList.add('dk-inspect-highlight');
_dk.inspectHoverEl=target;
setTimeout(function(){ if(target) target.classList.remove('dk-inspect-highlight'); }, 1200);
_dk.pendingRef = fullRef;
_dk.tagEl      = target;

_dk.inspecting=false;
if (overlay) { overlay.classList.remove('dk-inspecting'); overlay.style.display=''; }
if (banner)  banner.classList.remove('dk-inspecting');
if (btn)     btn.classList.remove('dk-active');
document.removeEventListener('touchstart', _dk.inspectHandler, true);
_dk.inspectHandler=null;

var screenKey = dkmScreenKey();

var elInfo={tag:target.tagName.toLowerCase(),id:'',cls:'',text:'',screenKey:screenKey};
var walk2=target;
for (var j=0;j<8;j++){
if (!walk2||walk2===document.body||walk2.id==='app') break;
if (!elInfo.id&&walk2.id&&!walk2.id.startsWith('s-')&&!walk2.id.startsWith('dk-')) elInfo.id='#'+walk2.id;
if (!elInfo.cls&&walk2.className&&typeof walk2.className==='string'){
var gc=walk2.className.trim().split(/\s+/).filter(function(c){
return c&&c!=='active'&&c!=='open'&&c!=='dk-open'&&!c.startsWith('dk-');
});
if (gc.length) elInfo.cls='.'+gc[0];
}
walk2=walk2.parentElement;
}
elInfo.text=(target.textContent||target.placeholder||target.title||'').trim().slice(0,60);

var matched=null;

DKM_ROWS.forEach(function(row){
if (!row.domHint||matched) return;
row.domHint.split(',').forEach(function(h){
h=h.trim(); if(!h||matched) return;
try { if(target.matches(h)) matched=row; } catch(err){}
});
});

if (!matched) {
DKM_ROWS.forEach(function(row){
if (!row.domHint||matched) return;
row.domHint.split(',').forEach(function(h){
h=h.trim(); if(!h||matched) return;
try { if(target.closest(h)) matched=row; } catch(err){}
});
});
}

if (!matched&&elInfo.text) {
var q=elInfo.text.toLowerCase();
var candidates=DKM_ROWS.filter(function(r){ return r.form===screenKey; });
candidates.forEach(function(r){
if (matched) return;
if (r.object.toLowerCase().includes(q)||q.includes(r.object.toLowerCase().slice(0,8))) matched=r;
});
}
_dk.tagRowId    = matched ? matched.id : null;
_dk.tagScreen   = screenKey;
_dk.tagElDesc   = matched ? matched.object : (elInfo.text.slice(0,40)||elInfo.id||elInfo.cls||elInfo.tag);
_dk.tagElContext= 'Tapped: '+(elInfo.id||elInfo.cls||elInfo.tag)+(elInfo.text?' "'+elInfo.text.slice(0,40)+'"':'')+' on '+screenKey;

_dk.pendingCat = 'bug'; dkBubbleCat('bug');

var bubble    = document.getElementById('dk-tag-bubble');
var nameEl    = document.getElementById('dk-tag-bubble-name');
var ctxEl     = document.getElementById('dk-tag-bubble-ctx');
if (bubble&&nameEl&&ctxEl) {
nameEl.textContent = matched ? matched.object : _dk.tagElDesc;
var sm2 = matched ? DKM_SCREENS[matched.form] : null;
ctxEl.innerHTML = matched
? '<span style="color:var(--teal)">'+(sm2?sm2.icon+' '+sm2.name:matched.form)+'</span> · '+matched.type+
(matched.status!=='ok'?' · <span style="color:var('+(matched.status==='broken'?'--red':'--gold')+')">'+matched.status+'</span>':'')
: '<span style="color:var(--t3)">'+screenKey+' · No existing entry — will create</span>';
var bw=280, bh=135;
var left=Math.min(x+8, window.innerWidth-bw-8);
var top=y+16; if(top+bh>window.innerHeight-50) top=y-bh-12;
bubble.style.left=left+'px'; bubble.style.top=top+'px'; bubble.style.display='block';
setTimeout(function(){
function _od(ev){
if(bubble.style.display==='none'){ document.removeEventListener('touchstart',_od,true); return; }
if(!bubble.contains(ev.target)){ dkmTagDismiss(true); document.removeEventListener('touchstart',_od,true); }
}
document.addEventListener('touchstart',_od,true);
}, 100);
}
};
document.addEventListener('touchstart', _dk.inspectHandler, true);
} else {
if (_dk.inspectHandler) {
document.removeEventListener('touchstart', _dk.inspectHandler, true);
_dk.inspectHandler=null;
}
var panel2 = document.getElementById('dk-panel');
if (panel2) panel2.classList.add('dk-open');
}
}
