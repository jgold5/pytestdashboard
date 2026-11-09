#!/usr/bin/env python3
"""
Differential test: oracle.py vs the dashboard scanner on generated (or real) repos.

    python3 compare.py --seeds 0:300 [--probes] [--keep] [--out report.json]
    python3 compare.py --repo /path/to/camel-repo [--tests /path/to/test-repo] [--pr /path/to/pr-checkout]

Per trigger it compares: existence (by file, route id, <from> index, line, pattern part /
condition), kind, scheme, pattern kind, covered/not covered on main (false positive = scanner
says tested and the oracle doesn't), the exact covering tests, and the Overview status
(tested / branch / none) with a PR test scan. Also checks scopeCounts/routeOverview invariants.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen  # noqa: E402
import oracle  # noqa: E402

SERVER = os.path.normpath(os.path.join(HERE, '..', '..', 'apps', 'server'))


def ws(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def oracle_case(case_dir):
    xml, props, tests = oracle.read_repo(os.path.join(case_dir, 'repo'))
    main = oracle.scan_repository(xml, props, tests)
    pr_dir = os.path.join(case_dir, 'pr')
    if os.path.isdir(pr_dir):
        _, _, pr_tests = oracle.read_repo(pr_dir)
        pr = oracle.scan_repository(xml, props, pr_tests)
    else:
        pr = None
    return main, pr


def osig(t):
    sub = t['sub']
    if sub and sub[0] == 'cond':
        return (t['file'], t['routeId'], t['input'], t['line'], 'cond', ws(sub[1]))
    if sub and sub[0] == 'part':
        return (t['file'], t['routeId'], t['input'], t['line'], 'part', sub[1])
    return (t['file'], t['routeId'], t['input'], t['line'], None, None)


def ssigs(triggers):
    groups = collections.Counter((t['file'], t['routeId'], t['input'], t['line']) for t in triggers if t['patternKind'] != 'condition')
    out = []
    for t in triggers:
        if t['patternKind'] == 'condition':
            out.append((t['file'], t['routeId'], t['input'], t['line'], 'cond', ws(t['condition'])))
        elif groups[(t['file'], t['routeId'], t['input'], t['line'])] > 1:
            out.append((t['file'], t['routeId'], t['input'], t['line'], 'part', t['filePattern']))
        else:
            out.append((t['file'], t['routeId'], t['input'], t['line'], None, None))
    return out


def run_scanner(dirs):
    res = {}
    for i in range(0, len(dirs), 40):
        chunk = dirs[i:i + 40]
        p = subprocess.run(['npx', 'tsx', os.path.join(HERE, 'run_scanner.ts'), *chunk], cwd=SERVER, capture_output=True, text=True)
        if p.returncode != 0:
            print(p.stderr[-3000:], file=sys.stderr)
            raise SystemExit('scanner run failed')
        for line in p.stdout.splitlines():
            if line.startswith('{'):
                d = json.loads(line)
                res[d['dir']] = d
    return res


def compare_case(case_dir, scan, stats, diffs):
    om, opr = oracle_case(case_dir)
    st = scan['triggers']
    ss = ssigs(st)
    smap = collections.defaultdict(list)
    for sig, t in zip(ss, st):
        smap[sig].append(t)
    omap = collections.defaultdict(list)
    for t in om['triggers']:
        omap[osig(t)].append(t)
    prmap = collections.defaultdict(list)
    if opr:
        for t in opr['triggers']:
            prmap[osig(t)].append(t)
    stats['cases'] += 1
    stats['oracle_triggers'] += len(om['triggers'])
    stats['scanner_triggers'] += len(st)
    o_tested = sum(1 for t in om['triggers'] if t['coveredBy'])
    s_tested = sum(1 for t in st if t['coveredBy'])
    stats['oracle_tested'] += o_tested
    stats['scanner_tested'] += s_tested
    stats['cases_total_equal'] += len(om['triggers']) == len(st)
    stats['cases_tested_equal'] += o_tested == s_tested
    stats['cases_all_equal'] += 0  # filled below
    case_ok = True
    if om['otherRoutes'] != scan['otherRoutes']:
        case_ok = False
        diffs.append({'case': case_dir, 'type': 'otherRoutes', 'oracle': om['otherRoutes'], 'scanner': scan['otherRoutes']})
    if set(om['tests']) != set(scan['tests']):
        diffs.append({'case': case_dir, 'type': 'tests', 'oracle_only': sorted(set(om['tests']) - set(scan['tests'])),
                      'scanner_only': sorted(set(scan['tests']) - set(om['tests']))})
    for v in scan['violations']:
        case_ok = False
        diffs.append({'case': case_dir, 'type': 'invariant', 'detail': v})
        stats['invariant_violations'] += 1
    for sig in set(smap) | set(omap):
        o_list, s_list = omap.get(sig, []), smap.get(sig, [])
        for i in range(max(len(o_list), len(s_list))):
            o = o_list[i] if i < len(o_list) else None
            s = s_list[i] if i < len(s_list) else None
            if o is None or s is None:
                case_ok = False
                stats['trigger_missing_in_scanner' if s is None else 'trigger_extra_in_scanner'] += 1
                diffs.append({'case': case_dir, 'type': 'missing' if s is None else 'extra', 'sig': sig,
                              'kind': (o or s)['kind'], 'scheme': (o or s)['scheme'], 'uri': s and s.get('uri')})
                continue
            stats['matched'] += 1
            for f in ('kind', 'scheme', 'patternKind', 'filePattern'):
                if f == 'filePattern' and o['patternKind'] == 'condition':
                    continue
                if (o[f] or None) != (s[f] or None):
                    case_ok = False
                    stats[f'{f}_mismatch'] += 1
                    diffs.append({'case': case_dir, 'type': f, 'sig': sig, 'oracle': o[f], 'scanner': s[f], 'uri': s['uri']})
            oc, sc = set(o['coveredBy']), set(s['coveredBy'])
            if bool(oc) == bool(sc):
                stats['covered_agree'] += 1
            elif sc:
                case_ok = False
                stats['covered_FP'] += 1
                diffs.append({'case': case_dir, 'type': 'cover-FP', 'sig': sig, 'kind': s['kind'], 'uri': s['uri'],
                              'scanner_via': {k: s['via'][k] for k in sc}})
            else:
                case_ok = False
                stats['covered_FN'] += 1
                diffs.append({'case': case_dir, 'type': 'cover-FN', 'sig': sig, 'kind': s['kind'], 'uri': s['uri'],
                              'oracle_via': {k: o['via'][k] for k in oc}})
            if oc != sc and bool(oc) == bool(sc):
                stats['covered_same_but_tests_differ'] += 1
                diffs.append({'case': case_dir, 'type': 'cover-tests', 'sig': sig, 'kind': s['kind'], 'uri': s['uri'],
                              'scanner_only': {k: s['via'][k] for k in sc - oc}, 'oracle_only': {k: o['via'][k] for k in oc - sc}})
            # Overview status with a PR test scan
            if opr is not None:
                pr_o = prmap.get(sig, [])
                pr_cov = bool(pr_o[i]['coveredBy']) if i < len(pr_o) else False
                ostatus = 'tested' if oc else 'branch' if pr_cov else 'none'
                if ostatus == s['status']:
                    stats['status_agree'] += 1
                else:
                    stats[f'status_{ostatus}_vs_{s["status"]}'] += 1
                    if bool(oc) == bool(sc):  # don't double-report main coverage diffs
                        case_ok = False
                        diffs.append({'case': case_dir, 'type': 'status', 'sig': sig, 'oracle': ostatus, 'scanner': s['status'],
                                      'scanner_pr_cov': s['prCoveredBy'], 'oracle_pr_cov': pr_o[i]['coveredBy'] if i < len(pr_o) else None})
    stats['cases_all_equal'] += case_ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', default='0:50')
    ap.add_argument('--probes', action='store_true')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--out', default=os.path.join(HERE, 'report.json'))
    ap.add_argument('--work', help='folder for the generated cases (default: cases/ here)')
    ap.add_argument('--strict', action='store_true', help='exit 1 on any disagreement (for CI)')
    ap.add_argument('--repo', help='compare on a real repo instead (routes + tests in one checkout)')
    ap.add_argument('--tests', help='with --repo: a separate test repo checkout')
    ap.add_argument('--pr', help='with --repo: a checkout of the test repo on a PR branch')
    a = ap.parse_args()
    work = a.work or os.path.join(HERE, 'cases-probes' if a.probes else 'cases')
    dirs = []
    if a.repo:
        d = os.path.join(work, 'real')
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(os.path.join(d, 'repo'))
        # repo/routes -> the Camel repo, repo/tests -> the test repo (if separate); pr/tests -> a PR checkout of the test repo
        # the two repos side by side, read as their uploads are: routes from one, tests from the other
        os.symlink(os.path.abspath(a.repo), os.path.join(d, 'repo', '__routes__'))
        os.symlink(os.path.abspath(a.tests or a.repo), os.path.join(d, 'repo', '__tests__'))
        if a.pr:
            os.makedirs(os.path.join(d, 'pr'))
            os.symlink(os.path.abspath(a.pr), os.path.join(d, 'pr', '__tests__'))
        dirs.append(d)
    else:
        lo, hi = (int(x) for x in a.seeds.split(':'))
        shutil.rmtree(work, ignore_errors=True)
        for seed in range(lo, hi):
            d = os.path.join(work, f's{seed}')
            gen.write(seed, d, a.probes)
            dirs.append(d)
    scans = run_scanner(dirs)
    stats = collections.Counter()
    diffs = []
    for d in dirs:
        compare_case(d, scans[d], stats, diffs)
    m = stats['matched'] or 1
    print(f"cases: {stats['cases']}   all-equal cases: {stats['cases_all_equal']}")
    print(f"triggers: oracle {stats['oracle_triggers']}  scanner {stats['scanner_triggers']}  matched {stats['matched']}  "
          f"missing-in-scanner {stats['trigger_missing_in_scanner']}  extra-in-scanner {stats['trigger_extra_in_scanner']}")
    print(f"tested (main): oracle {stats['oracle_tested']}  scanner {stats['scanner_tested']}")
    print(f"per-trigger covered agreement: {stats['covered_agree']}/{stats['matched']} = {stats['covered_agree'] / m:.4%}  "
          f"FP {stats['covered_FP']}  FN {stats['covered_FN']}  (same verdict, different tests: {stats['covered_same_but_tests_differ']})")
    print(f"per-case total equal: {stats['cases_total_equal']}/{stats['cases']}   per-case tested equal: {stats['cases_tested_equal']}/{stats['cases']}")
    status_seen = sum(v for k, v in stats.items() if k.startswith('status_'))
    if status_seen:
        print(f"status agreement: {stats['status_agree']}/{stats['matched']}  " + '  '.join(f'{k}={v}' for k, v in stats.items() if k.startswith('status_') and k != 'status_agree'))
    else:
        print('status agreement: not compared (pass --pr with a checkout of an open PR of the test repo)')
    for k in ('kind_mismatch', 'scheme_mismatch', 'patternKind_mismatch', 'filePattern_mismatch', 'invariant_violations'):
        print(f'{k}: {stats[k]}')
    by = collections.Counter(d['type'] for d in diffs)
    print('diff types:', dict(by))
    with open(a.out, 'w') as f:
        json.dump({'stats': stats, 'diffs': diffs}, f, indent=1, default=list)
    print('details:', a.out)
    if a.strict and (diffs or stats['invariant_violations']):
        sys.exit(1)


if __name__ == '__main__':
    main()
