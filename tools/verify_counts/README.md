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

### Sending the result without sending your code

```bash
pnpm verify-counts --repo /path/to/camel-repo --tests /path/to/test-repo --share
```

also writes **`verify-counts-share.zip`**: the summary (counts only) and, for each kind of
disagreement (up to 3 each, 40 in all), a small repro: the route's XML file, the properties it
uses, and the test files involved with the `conftest.py` files and modules they import.
Everything in it is renamed:

- every name and string becomes a made-up word of the same length, the same everywhere (a route
  id in the XML and in a test still match; `parseInvoice` and `parse-invoice` still match);
- comments are dropped; passwords and user names in URIs become `REDACTED`;
- Camel and Python syntax, option names, regexes, cron expressions and file extensions are kept,
  and so are prefixes that patterns rely on (`starts with 'PAY'` still matches `PAYMENTS`).

Each repro is re-checked after renaming and says whether it still shows the disagreement.
Renaming never changes a count: CI anonymizes generated repos and checks they scan identically
(`python3 tools/verify_counts/share.py --selftest 0:300`).

Send the zip. Keep **`verify-counts-share.map.json`** (generic words → your names) to
yourself: it is what turns a fix's explanation back into your route names.

### Sending the routes your sheet says are tested but the dashboard doesn't link

```bash
pnpm share-examples --repo /path/to/camel-repo --tests /path/to/test-repo --sheet your-sheet.xlsx
```

reads your spreadsheet (.xlsx or .csv, with a route id column and a test files column; an
`automated` column limits it to the rows marked yes), scans both repos the way the dashboard does,
and packages every route the sheet calls automated that the dashboard links to no test (up to
`--max`, default 25), each with the test files the sheet lists. Each example holds the route's XML
file and the properties it uses, the test files with the `conftest.py` files and modules they
import, and what the dashboard makes of it; all renamed like `--share`. Send
`route-test-examples.zip`; keep `route-test-examples.map.json` to yourself.

The test repo is read as it is checked out (usually `main`): a route whose test files are only on
an open PR's branch is skipped and counted ("test files not in this checkout"). To include those,
run it again with the test repo checked out on that PR's branch.

To pick routes by hand instead (or as well): `--route some-route-id=test_some_route.py`, repeated.

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
