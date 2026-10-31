/* v30.248: share.js index cache must notice frames / attempts pushed into the same arrays */
const S = require(process.argv[3] + '/share.js');
const snap = JSON.parse(require('fs').readFileSync(process.argv[2]));
const d = snap.doc; let ok = 0, fail = 0;
const t = (n, c, i) => { if (c) { ok++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, i || ''); } };
const live = { frames: d.frames.filter(f => f.GameID !== 1212), attempts: d.attempts.filter(a => a.GameID !== 1212), leaves: d.leaves, balls: d.balls };
const G = d.games.filter(g => g.SeriesID === 476);
let r = S.detailFor(live, G);
t('before game 3 frames: 2 of 3 games', r.withFrames === 2 && r.strikes === 9 && r.strikeOpps === 22, JSON.stringify(r));
d.frames.filter(f => f.GameID === 1212).forEach(f => live.frames.push(f));
d.attempts.filter(a => a.GameID === 1212).forEach(a => live.attempts.push(a));
r = S.detailFor(live, G);
t('after push into same arrays: 3 of 3', r.withFrames === 3, JSON.stringify(r));
t('strikes 15/33', r.strikes === 15 && r.strikeOpps === 33);
t('spares 15/17', r.spares === 15 && r.spareOpps === 17);
t('splits 2, none made', r.splits === 2 && r.splitsMade === 0);
t('4 balls incl Night Road', r.balls.length === 4 && r.balls.some(b => b.name === 'Night Road'));
t('version', S.SHARE_VERSION === 'v30.248');
console.log(ok + '/' + (ok + fail));
