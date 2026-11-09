import json,collections,sys
d=json.load(open(sys.argv[1] if len(sys.argv)>1 else 'report.json'))
c=collections.Counter(); ex={}
for x in d['diffs']:
    x['case']=x['case'].split('/')[-1]
    t=x['type']
    if t=='cover-FP': key=(t,x['kind'],x['sig'][4])
    elif t=='cover-FN': key=(t,x['kind'],x['sig'][4])
    elif t=='cover-tests': key=(t,x['kind'],x['sig'][4], 'S' if x['scanner_only'] else '', 'O' if x['oracle_only'] else '')
    else: key=(t,)
    c[key]+=1; ex.setdefault(key,[]).append(x)
for k,v in c.most_common(): 
    print(v,k)
    for x in ex[k][:2]: print('    ',json.dumps(x)[:500])
