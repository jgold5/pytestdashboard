# verify_counts: check the dashboard's counts against an independent implementation

`oracle.py` counts route triggers and the tests that cover them **from the documented rules**,
with its own code: Python's XML parser (expat) for the Camel XML and Python's own parser (`ast`)
for the tests. `compare.py` runs it and the dashboard's scanner on the same repos and reports
every trigger they disagree on: whether it exists, its kind, scheme and pattern, whether a
test covers it (and which), and its Overview status.

## On your own repos

From the dashboard's checkout (Node and Python 3.9+, no packages):

```bash
pnpm verify-counts --repo /path/to/camel-repo --tests /path/to/test-repo
# also the not-merged status: a checkout of the test repo on an open PR into the default branch
pnpm verify-counts --repo /path/to/camel-repo --tests /path/to/test-repo --pr /path/to/test-repo-pr
```

The files are read as an upload reads them: route XML and `.properties` from the Camel repo
(not under `src/test/`, `src/it/`…), Python from the test repo. The summary ends with the
number of disagreements; `report.json` lists each one, and `python3 tools/verify_counts/triage.py
report.json` groups them. Both sides agreeing on your repos is the strongest check there is: if
anything disagrees, the repro is in the report.

`python3 tools/verify_counts/oracle.py <repo> --summary` prints the oracle's own counts (per
kind and folder) for one checkout.

## On generated repos

```bash
pnpm verify-counts --seeds 0:300            # realistic repos (20–200 routes each, a PR test scan)
pnpm verify-counts --seeds 1000:1300 --probes   # repos full of edge cases
```

`gen.py` writes each case; `repros/` holds the minimal cases of every disagreement found so
far (all fixed; `test/countingRepros.test.ts` keeps them fixed). CI runs 40 + 40 seeds on every
change (`apps/server/test/verifyCounts.test.ts`).
