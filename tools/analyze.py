# Replay analyzer for the flight recorder dumps (replays collection). Usage: python3 -I tools/analyze.py file.json [--windows]
import json, sys
BTN = ['A','B','X','Y','LB','RB','LT','RT','View','Menu','LS','RS','Up','Down','Left','Right']
KIND = {0:'ground',1:'wall',2:'ramp'}
def btns(mask): return '+'.join(n for i,n in enumerate(BTN) if mask>>i & 1) or '-'
windows = '--windows' in sys.argv
for path in [a for a in sys.argv[1:] if not a.startswith('--')]:
    d = json.load(open(path)); F = d['fields']; ix = {f:i for i,f in enumerate(F)}; S = d['samples']; E = d['events']
    g = lambda s,f: s[ix[f]]
    print('='*100); print(path.split('/')[-1], '| build', d.get('build'), '| reason', d.get('reason'), '| map', d.get('map'), '| pad', d.get('pad'), '| padInfo', d.get('padInfo'))
    print('window %.1f -> %.1f s, %d samples, %d events, marks %s' % (d['since'], d['until'], len(S), len(E), d.get('marks')))
    n=len(S); grounded=sum(1 for s in S if g(s,'grounded')); wall=sum(1 for s in S if g(s,'grounded') and g(s,'kind')!=0)
    tum=sum(1 for s in S if g(s,'tumbling')); upside=sum(1 for s in S if g(s,'upy')<0.3)
    print('time: grounded %.0f%% (wall %.0f%%), air %.0f%%, tumbling %.0f%%, roof/side-down %.0f%%' % (100*grounded/n, 100*wall/n, 100*(n-grounded)/n, 100*tum/n, 100*upside/n))
    used = {}
    for s in S:
        m = int(g(s,'btn'))
        for i,nm in enumerate(BTN):
            if m>>i & 1: used[nm]=used.get(nm,0)+1
    print('buttons held (samples):', dict(sorted(used.items(), key=lambda kv:-kv[1])))
    print('max mph %d | tank min %d | hp end %d' % (max(g(s,'mph') for s in S), min(g(s,'tank') for s in S), S[-1][ix['hp']]))
    drops=[]; prev=S[0][ix['hp']]
    for s in S:
        hp=g(s,'hp')
        if hp<prev-0.5: drops.append((g(s,'t'), int(prev), int(hp)))
        prev=hp
    print('health drops:', drops)
    line=['%.1f %s%s' % (t, ty, (':'+str(det)) if det!='' else '') for t,ty,det in E if not (ty=='touchdown' and det=='ground')]
    print('--- events ---')
    for i in range(0,len(line),6): print('   ' + ' | '.join(line[i:i+6]))
    run=None
    for s in S:
        bad = (not g(s,'grounded')) and g(s,'upy')<0.5 and g(s,'y')<3
        if bad and run is None: run=g(s,'t')
        if not bad and run is not None:
            if g(s,'t')-run>1.0: print('STUCK roof/side near ground from %.1f to %.1f s' % (run, g(s,'t')))
            run=None
    presses=0; prevA=0
    for s in S:
        a = int(g(s,'btn'))&1
        if a and not prevA: presses+=1
        prevA=a
    print('A press edges at 10Hz: %d | jump %d, double %d, dodge %d' % (presses, sum(1 for e in E if e[1]=='jump'), sum(1 for e in E if e[1]=='doublejump'), sum(1 for e in E if e[1]=='dodge')))
    if windows:
        def row(s):
            return ('%6.1f thr %.1f brk %.1f st %+.1f pit %+.1f rol %+.1f %s%s%s [%s] y %5.1f vy %+5.1f up(%+.2f,%+.2f,%+.2f) %s%s hp %3d tank %3d %s%s%s%s mph %3d' % (
                g(s,'t'), g(s,'thr'), g(s,'brk'), g(s,'steer'), g(s,'pitch'), g(s,'roll'), 'AR ' if g(s,'airRoll') else '', 'J ' if g(s,'jump') else '', 'B ' if g(s,'boost') else '', btns(int(g(s,'btn'))),
                g(s,'y'), g(s,'vy'), g(s,'upx'), g(s,'upy'), g(s,'upz'), 'G' if g(s,'grounded') else 'A', KIND.get(g(s,'kind'),'?')[0] if g(s,'grounded') else ' ',
                g(s,'hp'), g(s,'tank'), 'dbl ' if g(s,'canDouble') else '', 'DODGE ' if g(s,'dodge') else '', 'TUMBLE ' if g(s,'tumbling') else '', 'HOVER ' if g(s,'hovering') else '', g(s,'mph')))
        shown=set()
        for t,ty,det in E:
            if ty not in ('damage','explode'): continue
            if round(t) in shown: continue
            shown.add(round(t)); print('--- window around %.1f s ---' % t)
            for s in S:
                if t-2.0 <= g(s,'t') <= t+0.8: print(row(s))
