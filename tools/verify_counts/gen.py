#!/usr/bin/env python3
"""
Randomized fixture-repo generator for differential testing of the trigger scanner.

    python3 gen.py <seed> <out-dir> [--probes]

Writes a repo (src/main/resources/<module>/routes/*.xml, *.properties, tests/**/*.py) to
<out-dir>/repo and a PR variant of the test files to <out-dir>/pr (tests added / edited /
deleted). --probes also emits constructs whose expected result is decided by Camel/pytest
semantics the scanner may not follow (see PROBES in the source).
"""
from __future__ import annotations

import keyword
import os
import random
import re
import shutil
import sys
from xml.sax.saxutils import escape, quoteattr

MODULES = ['invoice', 'credit', 'orders', 'payments', 'accounts', 'shipping', 'billing', 'customer', 'ledger', 'reporting']
WORDS = ['load', 'export', 'import', 'sync', 'archive', 'notify', 'reconcile', 'poll', 'dispatch', 'audit', 'purge', 'merge']
PREFIXES = ['INV', 'CRN', 'PAY', 'ORD', 'GL', 'AR', 'AP', 'SHP', 'CUST', 'LED']
GENERIC = ['orders', 'load', 'job', 'in', 'x', 'out', 'input', 'events', 'tick', 'start']
DECOYS = ['OK', 'application/json', 'utf-8', 'SELECT 1 FROM DUAL', 'expected', 'status', 'data.csv', 'report.txt',
          'tmp.xml', 'x', 'in', 'job', 'load', 'orders', 'missing-route', 'legacy-load', 'INV', 'ERROR', 'done']


class Gen:
    def __init__(self, seed: int, probes: bool):
        self.r = random.Random(seed)
        self.probes = probes
        self.files: dict[str, str] = {}
        self.props: dict[str, dict[str, str]] = {}   # path -> {key: value}
        self.refs: list[tuple[str, str]] = []        # (module, string a test can use to name a trigger)
        self.file_refs: list[tuple[str, str]] = []   # (module, file name a route would pick up)
        self.route_ids: dict[str, list[str]] = {}
        self.endpoint_names: list[str] = []
        self.direct_jobs: list[str] = []
        self.common_consts: dict[str, str] = {}
        self.emitted: dict[str, list] = {}
        self.fixtures: dict[str, list[str]] = {}
        self.n = 0

    # ---- helpers -------------------------------------------------------
    def chance(self, p):
        return self.r.random() < p

    def pick(self, xs):
        return self.r.choice(xs)

    def uid(self):
        self.n += 1
        return self.n

    def prop(self, path, key, value):
        self.props.setdefault(path, {})[key] = value

    def ref(self, mod, s):
        self.refs.append((mod, s))

    # ---- file patterns -------------------------------------------------
    def date(self):
        return f'2026{self.r.randint(1, 12):02d}{self.r.randint(1, 28):02d}'

    def include_pattern(self):
        """(option string, sample file names it matches)"""
        P = self.r.sample(PREFIXES, 3)
        d = self.date()
        c = self.r.randint(0, 11)
        if c == 0:
            return f'include={P[0]}_\\d{{8}}\\.csv', [f'{P[0]}_{d}.csv']
        if c == 1:
            return f'include=({P[0]}|{P[1]})_.*\\.csv', [f'{P[0]}_{d}.csv', f'{P[1]}_{d}.csv']
        if c == 2:
            return f'include={P[0]}_.*\\.csv|{P[1]}_.*\\.txt|{P[2]}_.*\\.xml', [f'{P[0]}_{d}.csv', f'{P[1]}_{d}.txt', f'{P[2]}_{d}.xml']
        if c == 3:
            return f'include=(?:{P[0]}|{P[1]})_[0-9]{{8}}\\.(csv|txt)', [f'{P[0]}_{d}.csv', f'{P[1]}_{d}.txt']
        if c == 4:
            return f'include=({P[0]}|{P[1]})+_x\\.csv', [f'{P[0]}_x.csv']
        if c == 5:
            return self.pick(['include=.*', 'include=.*\\..*', 'include=(?i).*']), ['data.csv', 'whatever.txt']
        if c == 6:
            return f'include=RAW({P[0]}_\\d+\\.csv)', [f'{P[0]}_{d}.csv']
        if c == 7:
            return f'antInclude={P[0]}_*.csv,{P[1]}_*.csv', [f'{P[0]}_{d}.csv', f'{P[1]}_{d}.csv']
        if c == 8:
            return self.pick([f'antInclude={P[0]}_*.txt', 'antInclude=*', 'antInclude=*.*']), [f'{P[0]}_{d}.txt', 'notes.txt']
        if c == 9:
            return f'fileName={P[0]}_${{date:now:yyyyMMdd}}.csv', [f'{P[0]}_{d}.csv']
        if c == 10:
            return f'fileName={P[0].lower()}.csv', [f'{P[0].lower()}.csv']
        return f'include={P[0]}_[0-9]{{8}}\\.csv&amp;doneFileName=${{file:name}}.done', [f'{P[0]}_{d}.csv', f'{P[0]}_{d}.csv.done']

    def file_uri(self, mod):
        scheme = self.pick(['file', 'file', 'file', 'sftp', 'ftp', 'ftps', 'smb'])
        if self.chance(0.05):
            scheme = scheme.upper()
        if scheme.lower() == 'file':
            base = f'file:/data/{mod}/in{self.uid()}'
        else:
            base = f'{scheme}://{{{{{mod}.host}}}}/{mod}/in{self.uid()}'
            self.prop('src/main/resources/application.properties', f'{mod}.host', f'{mod}.example.com')
        return base

    # ---- routes --------------------------------------------------------
    def route(self, mod, rid, file_path):
        """XML for one <route>, plus endpoint definitions it needs."""
        r = self.r
        eps = []
        idattr = f' id={quoteattr(rid)}' if rid else ''
        if rid:
            self.ref(mod, rid)
        kind = r.choices(
            ['file', 'filepat', 'choice', 'marker', 'schedule', 'direct', 'queue', 'kafka', 'rest', 'other', 'placeholder', 'ref', 'multi', 'master'],
            [5, 9, 5, 2, 6, 5, 6, 3, 4, 4, 5, 3, 2, 1])[0]
        body = '      <log message="${body}"/>\n      <to uri="bean:handler?method=process"/>\n'
        froms = []
        if kind == 'file':
            u = self.file_uri(mod) + '?delete=true'
            froms.append(u)
        elif kind == 'filepat':
            opt, samples = self.include_pattern()
            froms.append(self.file_uri(mod) + '?' + opt + ('&amp;move=.done' if self.chance(0.4) else ''))
            for s in samples:
                self.file_refs.append((mod, s))
        elif kind == 'marker':
            froms.append(self.file_uri(mod) + '?noop=true')
            name = self.pick(['LOADTRIGGER', 'LOAD.trg', 'READY.flag', f'{mod.upper()}.done'])
            if self.chance(0.5):
                body = f'      <setHeader name="deleteFileName"><constant>{name}</constant></setHeader>\n' + body
            else:
                body = f'      <setHeader name="trigger"><simple>${{file:parent}}/{name}</simple></setHeader>\n' + body
            self.ref(mod, name)
            if '.' in name:
                self.file_refs.append((mod, name))
        elif kind == 'choice':
            # sometimes the <from> has its own patterns too: they count when the branches only filter files out
            own = ''
            if self.chance(0.3):
                Q = self.pick(PREFIXES)
                own = self.pick([f'&amp;include=({Q}_.*|{Q}-.*)', f'&amp;include={Q}_.*\\.csv', f'&amp;fileName={Q}.TXT', f'&amp;antInclude={Q}_*.csv'])
                self.file_refs.append((mod, f'{Q}_{self.date()}.csv'))
            froms.append(self.file_uri(mod) + '?delete=true' + own)
            whens = []
            for _ in range(r.randint(1, 4)):
                P = self.pick(PREFIXES)
                job = self.pick([f'{P.lower()}Job', f'{mod}{P.title()}Job', self.pick(GENERIC) + 'Job'])
                if self.direct_jobs and self.chance(0.3):
                    job = self.pick(self.direct_jobs)  # a target that is also a direct route
                d = self.date()
                forms = [
                    (f"${{file:name}} starts with '{P}_'", f'{P}_{d}.csv'),
                    (f"${{file:onlyname}} regex '{P}_[0-9]+\\.csv'", f'{P}_{d}.csv'),
                    (f"${{header.CamelFileName}} ends with '_{P}.xml'", f'X_{P}.xml'),
                    (f"${{file:name}} starts with '{P}' &amp;&amp; ${{file:name}} ends with '.txt'", f'{P}_{d}.txt'),
                    (f"${{file:name}} starts with '{P}' and ${{file:ext}} == 'csv'", f'{P}_{d}.csv'),
                    (f"${{header.CamelFileName.startsWith('{P}_')}}", f'{P}_{d}.csv'),
                    (f"${{in.header.CamelFileName}} contains '_{P}_'", f'A_{P}_{d}.csv'),
                    (f"${{file:name}} starts with '{{{{{mod}.{P.lower()}.prefix}}}}'", f'{P}X_{d}.csv'),
                    (f"${{file:name.noext}} == '{P}_DAILY'", f'{P}_DAILY.csv'),
                    (f"${{header.CamelFileName}} in '{P}.csv,{P}.txt'", f'{P}.csv'),
                    (f"${{file:name}} starts with '{P}_' || ${{file:name}} starts with '{P}-'", f'{P}-{d}.csv'),
                    (f"${{header.type}} == '{P}'", None),  # not a file-name condition
                    (f"${{file:name}} contains 'x'", 'x.csv'),  # not specific enough to link by file name
                    # only "not": filters files out (the <from>'s patterns stay the triggers when every job is like this)
                    (f"${{file:name}} not ends with '.tmp'", None),
                    (f"${{file:name}} != '{P}.SKIP'", None),
                    (f"${{file:name}} not starts with 'DOWNLOAD' &amp;&amp; ${{file:name}} not ends with '.part'", None),
                ]
                if self.probes:
                    forms += [
                        (f"${{file:name}} ~~ '{P.lower()}_'", f'{P}_{d}.csv'),            # Camel 3+: contains, ignore case
                        (f"${{file:name}} !startsWith 'TMP' &amp;&amp; ${{file:name}} startsWith '{P}'", f'{P}_{d}.csv'),
                        (f"${{header:CamelFileName}} starts with '{P}_'", f'{P}_{d}.csv'),
                        (f"${{file:name}} starts with '{P}_'", f'{P.lower()}_{d}.csv'),   # label case differs: Camel is case-sensitive
                    ]
                expr, sample = self.pick(forms)
                if '{{' in expr:
                    self.prop(f'src/main/resources/{mod}/config/application-{mod}.properties', f'{mod}.{P.lower()}.prefix', f'{P}X')
                if self.chance(0.15) and '&amp;' not in expr:
                    expr = f'<![CDATA[{expr}]]>'
                tag = 'when' if self.chance(0.85) else 'filter'
                # sometimes a branch sends the file nowhere (only logs): not a job
                send = '' if self.chance(0.12) else f'\n          <to uri="direct:{job}"/>'
                if tag == 'filter':
                    whens.append(f'      <filter>\n        <simple>{expr}</simple>{send or chr(10) + "        <log message=" + chr(34) + "skipped" + chr(34) + "/>"}\n      </filter>\n')
                else:
                    whens.append(f'        <when>\n          <simple>{expr}</simple>\n          <log message="branch"/>{send}\n        </when>\n')
                if sample:
                    self.file_refs.append((mod, sample))
                self.ref(mod, job)
            choice_whens = [w for w in whens if w.startswith('        <when>')]
            filters = [w for w in whens if not w.startswith('        <when>')]
            body = ''.join(filters)
            if choice_whens:
                # the <otherwise> sends the rest on, logs only, or isn't there
                other = self.pick(['        <otherwise><to uri="direct:unknownFile"/></otherwise>\n', '        <otherwise><log message="unknown"/></otherwise>\n', ''])
                body += '      <choice>\n' + ''.join(choice_whens) + other + '      </choice>\n'
        elif kind == 'schedule':
            name = self.pick([f'{mod}{self.pick(WORDS).title()}Job', self.pick(GENERIC), f'{mod}-nightly'])
            u = self.pick([
                f'quartz://{mod}Group/{name}?cron=0+0/5+*+*+*+?',
                f'quartz2://{name}?cron=0+0+2+*+*+?&amp;trigger.timeZone=Europe/Paris',
                f'cron:{name}?schedule=0/30+*+*+*+*+?',
                f'timer:{name}?period=60000',
                f'timer://{name}?repeatCount=1',
                f'scheduler:{name}?delay=5000',
                f'quartz://{name}?cron={{{{{mod}.cron}}}}',
            ])
            if '{{' in u:
                self.prop('src/main/resources/application-dev.properties', f'{mod}.cron', '0+*+*+*+*+?')
                self.prop('src/main/resources/application-prod.properties', f'{mod}.cron', '0+0+3+*+*+?')
            froms.append(u)
            self.ref(mod, name)
        elif kind == 'direct':
            name = self.pick([f'{mod}{self.pick(WORDS).title()}', self.pick(GENERIC), f'{mod}Job'])
            if self.direct_jobs and self.chance(0.2):
                name = self.pick(self.direct_jobs)
            froms.append(self.pick(['direct:', 'direct-vm:', 'direct://']) + name)
            self.direct_jobs.append(name)
            self.ref(mod, name)
        elif kind == 'queue':
            name = self.pick([f'{mod.upper()}.{self.pick(WORDS).upper()}', self.pick(GENERIC), f'{mod}-events'])
            if self.endpoint_names and self.chance(0.2):
                name = self.pick(self.endpoint_names)
            u = self.pick([f'seda:{name}', f'vm:{name}?concurrentConsumers=5', f'jms:queue:{name}', f'activemq:queue:{name}',
                           f'amqp:queue:{name}', f'sjms:{name}', f'sjms2:queue:{name}', f'jmsOrders:queue:{name}',
                           f'jms:topic:{name}?clientId=x&amp;durableSubscriptionName=y'])
            froms.append(u)
            self.endpoint_names.append(name)
            self.ref(mod, name)
        elif kind == 'kafka':
            name = self.pick([f'{mod}-events', f'{mod}.{self.pick(WORDS)}', self.pick(GENERIC)])
            froms.append(f'kafka:{name}?brokers={{{{kafka.brokers}}}}&amp;groupId={mod}')
            self.prop('src/main/resources/application-dev.properties', 'kafka.brokers', 'localhost:9092')
            self.prop('src/main/resources/application-prod.properties', 'kafka.brokers', 'kafka-prod:9092')
            self.endpoint_names.append(name)
            self.ref(mod, name)
        elif kind == 'rest':
            path = f'/api/{mod}/{self.pick(WORDS)}'
            forms = [f'rest:post:{path}', f'platform-http:{path}', f'servlet:{path}?matchOnUriPrefix=true',
                     f'jetty:http://0.0.0.0:8080{path}', f'netty-http:http://0.0.0.0:{{{{http.port}}}}{path}',
                     f'undertow:http://localhost:8080{path}', f'restlet:http://localhost:8081{path}?restletMethod=post']
            if self.probes:
                forms += [f'rest:get:/api/{mod}:/{self.pick(WORDS)}', f'http://0.0.0.0:8080{path}']
            u = self.pick(forms)
            self.prop('src/main/resources/application.properties', 'http.port', '8080')
            froms.append(u)
            if u.startswith('rest:get:/api/'):
                a, b = u[len('rest:get:'):].split(':/')
                self.ref(mod, f'{a}/{b}')
            else:
                self.ref(mod, self.pick([path, path.lstrip('/')]))
        elif kind == 'other':
            froms.append(self.pick(['bean:poller?method=run', 'imaps://mail.example.com?username=u&amp;delete=false',
                                    'log:x', 'sql:select * from t where done = 0?delay=5000', 'mail:pop3://host']))
        elif kind == 'placeholder':
            c = r.randint(0, 6 if self.probes else 5)
            key = f'{mod}.{self.pick(WORDS)}{self.uid()}'
            if c == 0:  # single value
                key += '.uri'
                opt, samples = self.include_pattern()
                self.prop(f'src/main/resources/{mod}/config/application-{mod}.properties', key,
                          self.pick([f'sftp://h/in?{opt}'.replace('&amp;', '&'), f'jms:queue:{mod.upper()}.IN', f'file:/in?{opt}'.replace('&amp;', '&')]))
                for s in samples:
                    self.file_refs.append((mod, s))
                froms.append(f'{{{{{key}}}}}')
            elif c == 1:  # per environment: classify by the first value
                key += '.uri'
                self.prop('src/main/resources/application-dev.properties', key, self.pick(['file:/tmp/in', 'seda:in']))
                self.prop('src/main/resources/application-prod.properties', key, self.pick([f'sftp://prod/{mod}', f'jms:queue:{mod}']))
                froms.append(f'{{{{{key}}}}}')
            elif c == 2:  # nobody fills it in, key names sftp
                froms.append(f'{{{{{mod}.sftp.inbound{self.uid()}}}}}')
            elif c == 3:  # nobody fills it in
                froms.append(f'{{{{{key}.inbound}}}}' + self.pick(['', '?x=1']))
            elif c == 4:  # default (Camel {{k:d}} or Spring ${k:d})
                froms.append(self.pick([f'{{{{{key}:file:/data/{mod}/default?delete=true}}}}', f'${{{key}:jms:queue:{mod}.DEFAULT}}']))
            elif c == 5:  # value referencing another key, java escapes
                k2 = f'{mod}.base{self.uid()}'
                self.prop('src/main/resources/application.properties', k2, '/data/' + mod)
                self.prop(f'src/main/resources/{mod}/config/application-{mod}.properties', key, f'file\\:{{{{{k2}}}}}/in?antInclude=*.csv')
                froms.append(f'{{{{{key}}}}}')
            else:  # PROBE: Camel's env function
                froms.append(self.pick([f'{{{{env:{mod.upper()}_SFTP_URL}}}}', f'{{{{env:{mod.upper()}_IN_URI}}}}']))
        elif kind == 'ref':
            eid = f'{mod}In{self.uid()}' if self.chance(0.6) else 'inbox'
            u = self.pick([f'file:/data/{mod}/ref?delete=true', f'jms:queue:{mod}.REF', f'timer:{mod}Ref?period=1000', 'bean:x'])
            eps.append(f'    <endpoint id="{eid}" uri="{u}"/>\n')
            if self.probes and self.chance(0.3):
                froms.append(f'ref:{eid}')
            else:
                froms.append(('ref', eid))
        elif kind == 'master':
            froms.append('master:lock' + str(self.uid()) + ':' + self.file_uri(mod) + '?delete=true')
        elif kind == 'multi':
            froms.append(self.file_uri(mod) + '?delete=true')
            froms.append(self.pick([f'direct:{mod}Manual{self.uid()}', f'timer:{mod}Kick{self.uid()}?period=1000', 'bean:x']))
        xml_from = ''
        for u in froms:
            if isinstance(u, tuple):
                xml_from += f'      <from ref="{u[1]}"/>\n'
            elif self.chance(0.1):
                xml_from += f"      <from uri='{u}' />\n"
            else:
                xml_from += f'      <from uri="{u}"/>\n'
        return f'    <route{idattr}>\n{xml_from}{body}    </route>\n', eps

    def xml_file(self, mod, path, n_routes):
        style = self.pick(['routes', 'routes', 'camelContext', 'routeContext', 'prefixed'])
        routes, eps = [], []
        for _ in range(n_routes):
            rid = None
            if not self.chance(0.08):
                if self.chance(0.08) and any(m != mod for m in self.route_ids):
                    other = self.pick([m for m in self.route_ids if m != mod])
                    rid = self.pick(self.route_ids[other])  # same id in another module
                else:
                    rid = self.pick([f'{mod}-{self.pick(WORDS)}-{self.uid()}', f'{mod}{self.pick(WORDS).title()}{self.uid()}Route',
                                     f'{self.pick(WORDS)}_{mod}_{self.uid()}'])
                self.route_ids.setdefault(mod, []).append(rid)
            if self.emitted.get(mod) and self.chance(0.03):
                x, e = self.pick(self.emitted[mod])  # an identical copy of a route of this module (counted once)
            else:
                x, e = self.route(mod, rid, path)
                self.emitted.setdefault(mod, []).append((x, []))
            if self.chance(0.03):
                x = f'    <routeTemplate id="tpl{self.uid()}">\n      <templateParameter name="in"/>\n  {x.replace("<from uri=", "<from uri=\"{{in}}\" x=")}    </routeTemplate>\n'
            routes.append(x)
            eps += e
            if self.chance(0.05):
                routes.append(f'    <!-- disabled:\n    <route id="{mod}-old-{self.uid()}"><from uri="file:/old"/></route>\n    -->\n')
        if eps and style in ('routes', 'routeContext'):
            style = 'camelContext'
        body = ''.join(routes)
        if style == 'routes':
            return f'<?xml version="1.0" encoding="UTF-8"?>\n<routes xmlns="http://camel.apache.org/schema/spring">\n{body}</routes>\n'
        if style == 'routeContext':
            return ('<?xml version="1.0" encoding="UTF-8"?>\n<beans xmlns="http://www.springframework.org/schema/beans">\n'
                    f'  <routeContext id="{mod}Routes{self.uid()}" xmlns="http://camel.apache.org/schema/spring">\n{body}  </routeContext>\n</beans>\n')
        if style == 'prefixed':
            body = re.sub(r'<(/?)(route|from|to|log|setHeader|constant|simple|choice|when|otherwise|filter)\b', r'<\1camel:\2', body)
            return ('<?xml version="1.0" encoding="UTF-8"?>\n<beans xmlns="http://www.springframework.org/schema/beans"\n'
                    '       xmlns:camel="http://camel.apache.org/schema/spring">\n'
                    f'  <camel:camelContext id="ctx{self.uid()}">\n{body}  </camel:camelContext>\n</beans>\n')
        return ('<?xml version="1.0" encoding="UTF-8"?>\n<beans xmlns="http://www.springframework.org/schema/beans">\n'
                f'  <camelContext id="ctx{self.uid()}" xmlns="http://camel.apache.org/schema/spring">\n{"".join(eps)}{body}  </camelContext>\n</beans>\n')

    # ---- tests ---------------------------------------------------------
    def test_fn(self, name, mod, indent='', ctx=None):
        """One test. ctx: names this test may use: module constants, imported constants, fixtures, class constants."""
        ctx = ctx or {}
        refs = [s for m, s in self.refs if m == mod or self.chance(0.05)] or [s for _, s in self.refs]
        frefs = [s for m, s in self.file_refs if m == mod] or ['nothing.csv']
        decos, body, params = [], [], ['client']
        for _ in range(self.r.choice([0, 1, 1, 2, 3])):
            s = self.pick(refs) if refs else 'x'
            style = self.r.randint(0, 15)
            if style == 0:
                decos.append(f'@allure.label("route", "{s}")')
            elif style == 1:
                decos.append(f'@pytest.mark.route("{s}")')
            elif style == 2 and re.fullmatch(r'[A-Za-z][\w\-.]*', s) and not keyword.iskeyword(re.sub(r'[-.]', '_', s)):
                decos.append(f'@pytest.mark.{re.sub(r"[-.]", "_", s)}')
            elif style == 3:
                ss = [s] + [self.pick(refs) for _ in range(self.r.randint(0, 2))]
                decos.append('@pytest.mark.parametrize("route_id", [' + ', '.join(f'"{x}"' for x in ss) + '])')
            elif style == 4:
                body.append(f'allure.dynamic.label("job", "{s}")')
            elif style == 5:
                body.append(f'client.post("{s}", json={{"id": 1}})')
            elif style == 6:
                body.append(f'drop_file(INBOX, "{self.pick(frefs)}")')
            elif style == 7:
                body.append(f'with allure.step("start {s}"):' if self.chance(0.3) else f'with allure.step("{s}"):')
                body.append('    pass')
            elif style == 8:
                decos.append(f'@pytest.mark.skip(reason="{s}")')  # ignored decorator: not coverage
            elif style == 9 and ctx.get('module'):
                c = self.pick(ctx['module'])
                body.append(self.pick([f'start_route({c})', f'assert run({c}).ok']))
            elif style == 10 and ctx.get('imported'):
                c = self.pick(ctx['imported'])
                if self.chance(0.5):
                    decos.append(f'@allure.label("route", {c})')
                else:
                    body.append(f'start_route({c})')
            elif style == 11 and ctx.get('fixtures'):
                params.append(self.pick(ctx['fixtures']))
            elif style == 12 and ctx.get('cls'):
                c = self.pick(ctx['cls'])
                body.append(self.pick([f'start_route(self.{c})', f'start_route({ctx["cls_name"]}.{c})']
                                      + ([f'start_route({c})'] if self.probes else [])))
            elif style == 13:
                body.append(f'send("{self.pick(["seda:", "jms:queue:", "direct:", "kafka:"])}{self.pick(self.endpoint_names or ["x"])}", body)')
            elif style == 14:
                g = self.pick(GENERIC)
                body.append(self.pick([f'assert step == "{g}"', f'decos.append(allure.attach("{g}"))']))
            else:
                body.append(f'start_route("{s}")')
        for _ in range(self.r.choice([0, 1, 2])):
            d = self.pick(DECOYS + [self.pick(self.endpoint_names or ['x'])])
            body.append(self.pick([f'assert resp.status == "{d}"', f'log.info("{d}")', f'x = cfg["{d}"]']))
        if self.chance(0.2):
            body.insert(0, f'"""Checks the {self.pick(refs) if refs else "x"} route.\n\n{indent}    More words.\n{indent}    """')
        if self.chance(0.1):
            decos.append('@pytest.mark.usefixtures("camel_context")')
        if self.chance(0.08):
            body.append(f'# start_route("{self.pick(refs) if refs else "x"}")  # disabled until the env is fixed')
        if all(b.lstrip().startswith('#') for b in body):
            body.append('assert True')
        params = list(dict.fromkeys(params))
        args = '(' + ', '.join((['self'] if indent else []) + params) + ')'
        out = ''.join(f'{indent}{d}\n' for d in decos)
        out += f'{indent}def {name}{args}:\n' + ''.join(f'{indent}    {b}\n' for b in body)
        return out + '\n'

    def test_file(self, mod, k):
        lines = ['import pytest', 'import allure', 'from helpers import start_route, drop_file, send, run', '']
        ctx = {'module': [], 'imported': [], 'fixtures': list(self.fixtures.get(mod, [])) + list(self.fixtures.get('', []))}
        refs = [s for m, s in self.refs if m == mod] or ['x']
        if self.common_consts and self.chance(0.5):
            names = self.r.sample(sorted(self.common_consts), min(3, len(self.common_consts)))
            if self.chance(0.5):
                lines.insert(3, f'from common.consts import {", ".join(names)}')
                ctx['imported'] += names
            else:
                lines.insert(3, 'from common import consts')
                ctx['imported'] += [f'consts.{n}' for n in names]
        lines.append(f'INBOX = "/data/{mod}/in"' if self.chance(0.3) else 'INBOX = "/data/in"')
        for j in range(self.r.choice([0, 0, 1, 2])):
            lines.append(f'ROUTE_{j} = "{self.pick(refs)}"')
            ctx['module'].append(f'ROUTE_{j}')
        if self.chance(0.1):
            lines.append(f'ROUTES = ["{self.pick(refs)}", "{self.pick(refs)}"]')
            ctx['module'].append('ROUTES')
        if self.chance(0.15):
            lines.append(f'pytestmark = [pytest.mark.route("{self.pick(refs)}"), pytest.mark.integration]')
        elif self.chance(0.05) and ctx['module']:
            lines.append(f'pytestmark = pytest.mark.route({ctx["module"][0]})')
        if self.chance(0.1):
            lines.append('pytestmark = pytest.mark.skipif(True, reason="load-only")')
        lines.append('')
        lines.append('')
        lines.append(f'def _helper():\n    return "{self.pick(DECOYS)}"\n')
        if self.chance(0.2):
            fx = f'{mod}_job_{k}'
            lines.append(f'@pytest.fixture\ndef {fx}():\n    return "{self.pick(refs)}"\n')
            ctx['fixtures'].append(fx)
        if self.probes and self.chance(0.2):
            fx = f'{mod}_param_route_{k}'
            lines.append(f'@pytest.fixture(params=["{self.pick(refs)}"])\ndef {fx}(request):\n    return request.param\n')
            ctx['fixtures'].append(fx)
        out = '\n'.join(lines) + '\n'
        for i in range(self.r.randint(1, 6)):
            out += self.test_fn(f'test_{mod}_{k}_{i}', mod, '', ctx)
        if self.chance(0.5):
            cdeco = f'@allure.feature("{self.pick(refs)}")\n' if self.chance(0.4) else ''
            cname = f'Test{mod.title()}{k}'
            out += f'{cdeco}class {cname}:\n'
            cctx = dict(ctx, cls=[], cls_name=cname)
            if self.chance(0.4):
                out += f'    pytestmark = pytest.mark.route("{self.pick(refs)}")\n'
            if self.chance(0.5):
                out += f'    ROUTE = "{self.pick(refs)}"\n'
                cctx['cls'].append('ROUTE')
            out += '\n'
            for i in range(self.r.randint(1, 4)):
                out += self.test_fn(f'test_case_{i}', mod, '    ', cctx)
            if self.chance(0.2):
                out += f'    class TestNested:\n        def test_inner(self):\n            start_route("{self.pick(refs)}")\n\n'
        if self.chance(0.15):
            out += f'class RouteClient:\n    def test_connection(self):\n        return start_route("{self.pick(refs)}")\n\n'
        if self.probes and self.chance(0.1):
            out += f'def test_{mod}_{k}_0(client):\n    assert client.ping("{self.pick(DECOYS)}")\n\n'
        return out

    # ---- repo ----------------------------------------------------------
    def build(self):
        r = self.r
        mods = r.sample(MODULES, r.randint(1, 6))
        total = r.randint(20, 200)
        per_file = []
        for m in mods:
            for _ in range(r.randint(1, 4)):
                per_file.append(m)
        counts = [1] * len(per_file)
        for _ in range(max(0, total - len(per_file))):
            counts[r.randrange(len(per_file))] += 1
        for i, (m, n) in enumerate(zip(per_file, counts)):
            path = self.pick([f'src/main/resources/{m}/routes/{m}-{i}.xml', f'src/main/resources/{m}/camel/routes-{i}.xml',
                              f'src/main/resources/{m}/{m}-context-{i}.xml'])
            self.files[path] = self.xml_file(m, path, n)
        if self.chance(0.1):
            # a route file outside any module folder
            self.files['src/main/resources/camel-common.xml'] = self.xml_file('common', 'src/main/resources/camel-common.xml', r.randint(1, 4))
        if self.probes and self.chance(0.5) and len(mods) >= 2:
            # a shared default overridden in a sibling module: the other module keeps the shared value
            a, b = mods[0], mods[1]
            self.prop('src/main/resources/application.properties', 'shared.in.uri', 'file:/data/shared/in')
            self.prop(f'src/main/resources/{b}/config/application-{b}.properties', 'shared.in.uri', 'jms:queue:SHARED')
            p = [k for k in self.files if f'/resources/{a}/' in k][0]
            self.files[p] = self.files[p].replace('</routes>', '    <route id="shared-in-a"><from uri="{{shared.in.uri}}"/></route>\n</routes>', 1)
        for path, kv in self.props.items():
            lines = ['# generated', '']
            for k, v in kv.items():
                sep = self.pick(['=', ' = ', ': ', ' '])
                lines.append(f'{k}{sep}{v}')
            self.files[path] = '\n'.join(lines) + '\n'
        test_files = {}
        if self.refs and self.chance(0.7):
            lines = ['"""Route ids shared by the tests."""', '']
            for j in range(r.randint(1, 6)):
                name = f'{self.pick(MODULES).upper()}_ROUTE_{j}'
                self.common_consts[name] = self.pick(self.refs)[1]
                lines.append(f'{name} = "{self.common_consts[name]}"')
            test_files['tests/common/consts.py'] = '\n'.join(lines) + '\n'
            test_files['tests/common/__init__.py'] = ''
        conf = ['import pytest', '', '', '@pytest.fixture', 'def client():', '    return "http://localhost:8080"', '']
        if self.refs and self.chance(0.6):
            fx = 'route_under_test'
            conf += ['', '@pytest.fixture', f'def {fx}():', f'    return "{self.pick(self.refs)[1]}"', '']
            self.fixtures.setdefault('', []).append(fx)
        test_files['tests/conftest.py'] = '\n'.join(conf) + '\n'
        for m in mods:
            if self.chance(0.3):
                refs = [s for mm, s in self.refs if mm == m] or ['x']
                fx = f'{m}_route'
                test_files[f'tests/{m}/conftest.py'] = f'import pytest\n\n\n@pytest.fixture\ndef {fx}(client):\n    return start("{self.pick(refs)}", client)\n'
                self.fixtures.setdefault(m, []).append(fx)
        for m in mods + (['common'] if 'src/main/resources/camel-common.xml' in self.files else []):
            for k in range(r.randint(1, 3)):
                test_files[f'tests/{m}/test_{m}_{k}.py'] = self.test_file(m, k)
        self.files.update(test_files)
        # PR branch: same tests, some added / edited / deleted
        pr = dict(test_files)
        for p in list(pr):
            if p.endswith('conftest.py'):
                continue
            c = r.random()
            if c < 0.1:
                del pr[p]
            elif c < 0.35:
                m = p.split('/')[1]
                pr[p] = pr[p] + self.test_fn(f'test_pr_added_{self.uid()}', m)
            elif c < 0.5:
                refs = [s for mm, s in self.refs if mm == p.split('/')[1]] or ['x']
                pr[p] = re.sub(r'start_route\("[^"]*"\)', lambda _: f'start_route("{self.pick(refs)}")', pr[p], count=1)
        if self.chance(0.5):
            m = self.pick(mods)
            pr[f'tests/{m}/test_{m}_new.py'] = self.test_file(m, 99)
        return self.files, pr


def write(seed, out, probes):
    files, pr = Gen(seed, probes).build()
    shutil.rmtree(out, ignore_errors=True)
    for base, fs in (('repo', files), ('pr', pr)):
        for p, text in fs.items():
            full = os.path.join(out, base, p)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'w', encoding='utf-8') as f:
                f.write(text)


if __name__ == '__main__':
    write(int(sys.argv[1]), sys.argv[2], '--probes' in sys.argv)
