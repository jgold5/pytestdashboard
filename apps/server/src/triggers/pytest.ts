/**
 * Reads pytest files for what each test names: the strings that can link it to a Camel
 * trigger, and the Jira/Xray keys it mentions. No Python runtime: a small tokenizer splits
 * the source into logical lines (strings, comments, brackets and line continuations
 * handled), and a block parser walks classes, decorators and functions by indentation.
 *
 * Each test gets two sets of strings:
 *   labels   what it is *labelled* with: decorator arguments and marker names (also
 *            `pytestmark` on the class or module), and `allure.*` calls in its body. A label
 *            may name a trigger by any of its names.
 *   strings  labels plus the short string literals in its body and its signature, the module
 *            and class constants it uses (also imported from another file), and the fixtures
 *            it asks for (in the same file or a conftest.py above it). Body strings are noisy
 *            ("orders", "start"), so coverage only trusts them for distinctive names.
 *
 * Module and class constants count only for the tests that use them, so a list of route ids
 * at the top of a file doesn't mark every test in it.
 */

export interface ScannedTest {
  /** pytest node id: `path::Class::test_name`. */
  id: string;
  file: string;
  cls: string | null;
  name: string;
  /** Every candidate string (labels first). */
  strings: string[];
  /** The strings it is labelled with (decorators, markers, pytestmark, allure.* calls). */
  labels: string[];
  /**
   * Jira/Xray keys (ABC-123) the test names anywhere: its docstring and comments (also the
   * comment lines just above it), decorators, strings, and the class / module docstring and
   * comments around it. A test on the default branch naming a case's key marks it automated.
   */
  keys: string[];
}

const JIRA_KEY_G = /\b[A-Z][A-Z0-9_]{1,50}-\d{1,12}\b/g;
const jiraKeys = (text: string): string[] => [...text.matchAll(JIRA_KEY_G)].map((m) => m[0]);

const STRING_LIT = /[rRbBuUfF]{0,2}("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
/** Decorators whose string arguments are not about what is tested. (parametrize counts: a list of route ids is.) */
const IGNORED_DECORATORS = /^@pytest\.mark\.(usefixtures|skip|skipif|xfail|filterwarnings|timeout|flaky|order|dependency)\b|^@pytest\.fixture\b|^@fixture\b|^@(staticmethod|classmethod|property)\b/;
const FIXTURE_DECORATOR = /^@(pytest\.)?fixture\b/;

/** The values of the string literals in some code (comments already removed). */
function strings(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(STRING_LIT)) {
    const lit = m[1] as string;
    const q = lit.startsWith('"""') || lit.startsWith("'''") ? 3 : 1;
    const v = lit
      .slice(q, -q)
      .replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
      .trim();
    if (v && v.length <= 300) out.push(v);
  }
  return out;
}

/** Body string literals worth matching: short, single-line values (not docstrings or SQL). */
const TRIPLE_LIT = /[rRbBuUfF]{0,2}("""[\s\S]*?"""|'''[\s\S]*?''')/g;
const shortStrings = (code: string): string[] => strings(code.replace(TRIPLE_LIT, ' ')).filter((v) => v.length <= 120 && !v.includes('\n'));

function decoratorStrings(text: string): string[] {
  if (IGNORED_DECORATORS.test(text)) return [];
  const out = strings(text);
  // a bare marker (`@pytest.mark.invoice_load`) names something by itself
  const marker = /^@pytest\.mark\.(\w+)/.exec(text);
  if (marker && marker[1] !== 'parametrize') out.push(marker[1] as string);
  return out;
}

/** `pytestmark = pytest.mark.x` / `[pytest.mark.x, pytest.mark.y("z")]`: marker names and their string arguments. */
function pytestmarkStrings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/pytest\.mark\.(\w+)\s*(\((?:[^()]|\([^()]*\))*\))?/g)) {
    if (IGNORED_DECORATORS.test(`@pytest.mark.${m[1]}`)) continue;
    out.push(m[1] as string, ...strings(m[2] ?? ''));
  }
  return out;
}

/**
 * Any Python file can hold tests: pytest's default names are test_*.py and *_test.py, but
 * python_files can change them and a file passed on the command line is collected whatever
 * its name. Only `def test…` functions are read from them; other files lend their constants.
 */
export const isPytestFile = (path: string): boolean => /\.py$/.test(path);

// ---------------------------------------------------------------------------
// Tokenizer: logical lines
// ---------------------------------------------------------------------------

interface LogicalLine {
  /** 1-based line of its first physical line. */
  line: number;
  indent: number;
  /** Code with string literals kept and comments removed (physical lines joined by \n). */
  text: string;
  /** The same with every string literal replaced by "" (for names). */
  bare: string;
  /** Comments on it (without the #). */
  comments: string[];
  /** A line holding only a comment. */
  commentOnly: boolean;
}

/** Python source → logical lines: brackets, triple-quoted strings and `\` continuations join physical lines. */
export function logicalLines(source: string): LogicalLine[] {
  const src = source.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const out: LogicalLine[] = [];
  const n = src.length;
  let i = 0;
  let lineNo = 1;
  while (i < n) {
    // start of a physical line that begins a logical line
    let indent = 0;
    while (i < n && (src[i] === ' ' || src[i] === '\t')) {
      indent += src[i] === '\t' ? 8 - (indent % 8) : 1;
      i++;
    }
    if (i >= n) break;
    if (src[i] === '\n') {
      i++;
      lineNo++;
      continue;
    }
    if (src[i] === '#') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out.push({ line: lineNo, indent, text: '', bare: '', comments: [src.slice(i + 1, stop)], commentOnly: true });
      i = stop;
      continue;
    }
    const start = lineNo;
    let text = '';
    let bare = '';
    const comments: string[] = [];
    let depth = 0;
    while (i < n) {
      const c = src[i] as string;
      if (c === '#') {
        const end = src.indexOf('\n', i);
        const stop = end < 0 ? n : end;
        comments.push(src.slice(i + 1, stop));
        i = stop;
        continue;
      }
      if (c === '"' || c === "'") {
        const triple = src.startsWith(c.repeat(3), i);
        const q = triple ? c.repeat(3) : c;
        let j = i + q.length;
        while (j < n) {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (!triple && src[j] === '\n') break; // unterminated: stop at the line end
          if (src.startsWith(q, j)) {
            j += q.length;
            break;
          }
          j++;
        }
        const lit = src.slice(i, Math.min(j, n));
        for (const ch of lit) if (ch === '\n') lineNo++;
        text += lit;
        bare += '""';
        i = j;
        continue;
      }
      if (c === '\\' && src[i + 1] === '\n') {
        text += ' ';
        bare += ' ';
        i += 2;
        lineNo++;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
      if (c === '\n') {
        lineNo++;
        i++;
        if (depth > 0) {
          text += '\n';
          bare += '\n';
          continue;
        }
        break;
      }
      text += c;
      bare += c;
      i++;
    }
    out.push({ line: start, indent, text, bare, comments, commentOnly: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

const PY_WORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls print len str int float bool list dict set tuple range open isinstance super object type pytest allure'.split(
    ' ',
  ),
);

/** Names (possibly dotted: `consts.ROUTE`, `self.ROUTE`) used in some code with strings blanked out. */
function namesIn(bare: string): string[] {
  const out = new Set<string>();
  for (const m of bare.matchAll(/(?<![\w.])([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)/g)) {
    const name = (m[1] as string).replace(/\s+/g, '');
    if (!PY_WORDS.has(name)) out.add(name);
    // self.X / cls.X refer to the class's X
    const attr = /^(?:self|cls)\.([A-Za-z_]\w*)/.exec(name);
    if (attr) out.add(`self.${attr[1]}`);
  }
  return [...out];
}

interface Strings {
  strong: string[];
  weak: string[];
  strongRefs: string[];
  weakRefs: string[];
}
const emptyStrings = (): Strings => ({ strong: [], weak: [], strongRefs: [], weakRefs: [] });

interface Value {
  strings: string[];
  refs: string[];
}

interface RawTest extends Strings {
  id: string;
  file: string;
  cls: string | null;
  name: string;
  params: string[];
  keys: string[];
}

interface FileModel {
  path: string;
  consts: Map<string, Value>;
  /** `labels`/`labelRefs`: the fixture's `params=[…]`, which parametrize every test asking for it. */
  fixtures: Map<string, Value & { params: string[]; labels: string[]; labelRefs: string[] }>;
  /** Local name → what it imports: a module (`name` null) or a name in a module. */
  imports: Map<string, { module: string; name: string | null; level: number }>;
  tests: RawTest[];
  moduleMarks: string[];
  moduleMarkRefs: string[];
  moduleKeys: string[];
}

const STRING_AT = new RegExp(STRING_LIT.source, 'y');
/** Code with every string literal replaced by "" (prefix letters kept), as in LogicalLine.bare. */
const bareOf = (text: string): string => text.replace(STRING_LIT, (whole: string, lit: string) => `${whole.slice(0, whole.length - lit.length)}""`);

/** Walk code outside string literals, with the bracket depth before each character; stop when `visit` returns true. */
function walkCode(text: string, visit: (c: string, at: number, depth: number) => boolean | void): void {
  let depth = 0;
  for (let k = 0; k < text.length; ) {
    const c = text[k] as string;
    if (/[rRbBuUfF"']/.test(c) && (k === 0 || !/\w/.test(text[k - 1] as string))) {
      STRING_AT.lastIndex = k;
      const m = STRING_AT.exec(text);
      if (m) {
        k += m[0].length;
        continue;
      }
    }
    if (visit(c, k, depth) === true) return;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
    k++;
  }
}

/** `def name(params) -> X: inline body` → its parameter names, the parameter list (defaults hold strings) and any body on the same line. */
function splitDef(line: LogicalLine): { params: string[]; defaults: LogicalLine; inline: LogicalLine | null } {
  const text = line.text;
  let open = -1;
  let close = -1;
  let colon = -1;
  walkCode(text, (c, at, depth) => {
    if (open < 0) {
      if (c === '(') open = at;
    } else if (close < 0) {
      if (c === ')' && depth === 1) close = at;
    } else if (c === ':' && depth === 0) {
      colon = at;
      return true;
    }
  });
  const paramsText = open >= 0 && close > open ? text.slice(open + 1, close) : '';
  const params: string[] = [];
  let from = 0;
  const take = (to: number) => {
    const name = /^\s*\*{0,2}\s*([A-Za-z_]\w*)/.exec(paramsText.slice(from, to))?.[1];
    if (name && name !== 'self' && name !== 'cls') params.push(name);
    from = to + 1;
  };
  walkCode(paramsText, (c, at, depth) => {
    if (c === ',' && depth === 0) take(at);
  });
  take(paramsText.length);
  const defaults: LogicalLine = { ...line, text: paramsText, bare: bareOf(paramsText), comments: [] };
  const rest = colon >= 0 ? text.slice(colon + 1) : '';
  const inline = rest.trim() ? { ...line, text: rest, bare: bareOf(rest), comments: [] } : null;
  return { params, defaults, inline };
}

/** The strings and names of some lines; `allure.*` lines are labels. */
function collect(lines: readonly LogicalLine[], into: Strings): void {
  for (const l of lines) {
    if (l.commentOnly) continue;
    if (/\ballure\s*\.\s*\w/.test(l.bare)) {
      into.strong.push(...strings(l.text));
      into.strongRefs.push(...namesIn(l.bare));
    } else {
      into.weak.push(...shortStrings(l.text));
      into.weakRefs.push(...namesIn(l.bare));
    }
  }
}

interface ClassScope {
  name: string;
  indent: number;
  isTest: boolean;
  strong: string[];
  strongRefs: string[];
  keys: string[];
  consts: Map<string, Value>;
}

function parseFile(file: string, source: string): FileModel {
  const lines = logicalLines(source);
  const model: FileModel = { path: file, consts: new Map(), fixtures: new Map(), imports: new Map(), tests: [], moduleMarks: [], moduleMarkRefs: [], moduleKeys: [] };
  const classes: ClassScope[] = [];
  let decorators: LogicalLine[] = [];
  /** Keys in the comments directly above the next def/class. */
  let pendingKeys: string[] = [];
  const scopeKeys = (indent: number): string[] => {
    const c = classes[classes.length - 1];
    return c && indent > c.indent ? c.keys : model.moduleKeys;
  };
  const flushPendingKeys = (indent: number) => {
    if (pendingKeys.length) scopeKeys(indent).push(...pendingKeys);
    pendingKeys = [];
  };
  /** Index just past a block's body: the last line indented deeper than `indent` (comments after it belong to what follows). */
  const blockEnd = (from: number, indent: number): number => {
    let end = from;
    for (let j = from; j < lines.length; j++) {
      const l = lines[j] as LogicalLine;
      if (l.commentOnly) continue;
      if (l.indent <= indent) break;
      end = j + 1;
    }
    return end;
  };
  /** A class's own constant, else an outer class's: for `self.X`, `cls.X`, `Klass.X` or a bare `X` used in a method. */
  const classConst = (ref: string): Value | null => {
    for (let k = classes.length - 1; k >= 0; k--) {
      const c = classes[k] as ClassScope;
      // a bare X in a method is not the class's X (Python looks it up in the module): only self.X, cls.X, Klass.X
      const name = ref.startsWith('self.') ? ref.slice(5) : ref.startsWith(`${c.name}.`) ? ref.slice(c.name.length + 1) : null;
      const v = name ? c.consts.get(name) : undefined;
      if (v) return v;
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as LogicalLine;
    if (l.commentOnly) {
      pendingKeys.push(...jiraKeys(l.comments.join(' ')));
      continue;
    }
    while (classes.length && l.indent <= (classes[classes.length - 1] as ClassScope).indent) classes.pop();
    const t = l.text.trim();
    const inClass = classes.length > 0;
    const top = classes[classes.length - 1];
    const lineKeys = jiraKeys(`${l.text} ${l.comments.join(' ')}`);

    if (t.startsWith('@')) {
      decorators.push(l);
      pendingKeys.push(...lineKeys);
      continue;
    }

    const c = /^class\s+(\w+)/.exec(t);
    if (c) {
      const name = c[1] as string;
      // pytest collects Test* classes (nested ones too, inside a Test* class)
      const isTest = /^Test/.test(name) && (!top || top.isTest);
      if (!isTest) {
        flushPendingKeys(l.indent);
        decorators = [];
        i = blockEnd(i + 1, l.indent) - 1;
        continue;
      }
      const decoStrong = decorators.flatMap((d) => decoratorStrings(d.text.trim()));
      const decoRefs = decorators.filter((d) => !IGNORED_DECORATORS.test(d.text.trim())).flatMap((d) => namesIn(d.bare));
      classes.push({
        name,
        indent: l.indent,
        isTest: true,
        strong: [...(top?.strong ?? []), ...decoStrong],
        strongRefs: [...(top?.strongRefs ?? []), ...decoRefs],
        keys: [...(top?.keys ?? []), ...pendingKeys, ...lineKeys],
        consts: new Map(),
      });
      decorators = [];
      pendingKeys = [];
      continue;
    }

    const d = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(t);
    if (d) {
      const name = d[1] as string;
      const end = blockEnd(i + 1, l.indent);
      const body = lines.slice(i + 1, end);
      const { params, defaults, inline } = splitDef(l);
      const isFixture = decorators.some((x) => FIXTURE_DECORATOR.test(x.text.trim()));
      const atTop = l.indent === 0 && !inClass;
      const inTestClass = top !== undefined && top.isTest && l.indent > top.indent;
      if (/^test/.test(name) && !isFixture && (atTop || inTestClass)) {
        const s = emptyStrings();
        for (const x of decorators) {
          const dt = x.text.trim();
          if (IGNORED_DECORATORS.test(dt)) continue;
          s.strong.push(...decoratorStrings(dt));
          s.strongRefs.push(...namesIn(x.bare));
        }
        if (inTestClass && top) {
          s.strong.push(...top.strong);
          s.strongRefs.push(...top.strongRefs);
        }
        collect([defaults, ...(inline ? [inline] : []), ...body], s);
        // class constants are resolved here; the rest (module constants, imports) once every file is read
        for (const kind of ['strongRefs', 'weakRefs'] as const) {
          const keep: string[] = [];
          for (const ref of s[kind]) {
            const v = inTestClass ? classConst(ref) : null;
            if (v) {
              (kind === 'strongRefs' ? s.strong : s.weak).push(...v.strings);
              keep.push(...v.refs);
            } else keep.push(ref);
          }
          s[kind] = keep;
        }
        const bodyKeys = body.flatMap((b) => jiraKeys(`${b.text} ${b.comments.join(' ')}`));
        model.tests.push({
          id: inTestClass ? `${file}::${classes.map((k) => k.name).join('::')}::${name}` : `${file}::${name}`,
          file,
          cls: inTestClass && top ? top.name : null,
          name,
          params,
          ...s,
          keys: [...pendingKeys, ...decorators.flatMap((x) => jiraKeys(x.text)), ...(inTestClass && top ? top.keys : []), ...lineKeys, ...bodyKeys],
        });
      } else if (isFixture && (atTop || inClass)) {
        const s = emptyStrings();
        collect([defaults, ...(inline ? [inline] : []), ...body], s);
        // @pytest.fixture(params=[…]): like parametrize, its values are what each test using it runs with
        const fxDeco = decorators.find((x) => FIXTURE_DECORATOR.test(x.text.trim()));
        const paramsArg = fxDeco ? /\bparams\s*=\s*(\[[\s\S]*\]|\([\s\S]*\)|[A-Za-z_][\w.]*)/.exec(fxDeco.text)?.[1] : undefined;
        model.fixtures.set(name, {
          strings: [...s.strong, ...s.weak],
          refs: [...s.strongRefs, ...s.weakRefs],
          params,
          labels: paramsArg ? strings(paramsArg) : [],
          labelRefs: paramsArg ? namesIn(bareOf(paramsArg)) : [],
        });
      }
      decorators = [];
      pendingKeys = [];
      i = end - 1;
      continue;
    }

    // a statement: what follows a decorator can only be a def or class
    decorators = [];

    if (/^pytestmark\s*=/.test(t)) {
      const marks = pytestmarkStrings(l.text);
      const refs = namesIn(l.bare).filter((n) => !/^pytestmark$/.test(n));
      if (top && l.indent > top.indent) {
        top.strong.push(...marks);
        top.strongRefs.push(...refs);
        top.keys.push(...lineKeys);
      } else if (l.indent === 0) {
        model.moduleMarks.push(...marks);
        model.moduleMarkRefs.push(...refs);
        model.moduleKeys.push(...lineKeys);
      }
      flushPendingKeys(l.indent);
      continue;
    }

    if (l.indent === 0 && !inClass) {
      const from = /^from\s+(\.*)([\w.]*)\s+import\s+(.+)$/s.exec(t);
      if (from) {
        const level = (from[1] as string).length;
        const mod = from[2] as string;
        for (const part of (from[3] as string).replace(/[()\n\\]/g, ' ').split(',')) {
          const m = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
          if (m && m[1] !== '*') model.imports.set((m[2] ?? m[1]) as string, { module: mod, name: m[1] as string, level });
        }
        flushPendingKeys(0);
        continue;
      }
      const imp = /^import\s+(.+)$/s.exec(t);
      if (imp) {
        for (const part of (imp[1] as string).split(',')) {
          const m = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
          if (!m) continue;
          const mod = m[1] as string;
          // `import a.b` binds `a`; `a.b.X` is then resolved by trying the longest module prefix
          model.imports.set(m[2] ?? (mod.split('.')[0] as string), { module: m[2] ? mod : (mod.split('.')[0] as string), name: null, level: 0 });
        }
        flushPendingKeys(0);
        continue;
      }
    }

    const assign = /^([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)\s*(?::[^=]+)?=(?!=)/.exec(t);
    if (assign && (l.indent === 0 || (top && l.indent > top.indent))) {
      const eq = l.text.indexOf('=', l.text.indexOf((assign[1] as string).split(',')[0] as string));
      const rhsText = l.text.slice(eq + 1);
      const rhsBare = l.bare.slice(l.bare.indexOf('=') + 1);
      const value: Value = { strings: shortStrings(rhsText), refs: namesIn(rhsBare) };
      const target = top && l.indent > top.indent ? top.consts : model.consts;
      for (const name of (assign[1] as string).split(',').map((x) => x.trim())) if (/^\w+$/.test(name)) target.set(name, value);
      scopeKeys(l.indent).push(...lineKeys);
      flushPendingKeys(l.indent);
      continue;
    }

    // anything else (docstrings, statements): its keys belong to the module or class
    scopeKeys(l.indent).push(...lineKeys);
    flushPendingKeys(l.indent);
  }
  flushPendingKeys(0);
  return model;
}

// ---------------------------------------------------------------------------
// Every file: names resolved across files
// ---------------------------------------------------------------------------

const MAX_DEPTH = 4;

/** Read pytest files and resolve the constants, imports and fixtures their tests use. */
export function scanPytestFiles(files: ReadonlyArray<{ path: string; text: string }>): ScannedTest[] {
  const models = files.map((f) => parseFile(f.path, f.text));
  const byPath = new Map(models.map((m) => [m.path, m] as const));
  // dotted module name suffixes → files (`tests/common/consts.py` answers to consts, common.consts, tests.common.consts)
  const bySuffix = new Map<string, FileModel[]>();
  for (const m of models) {
    const segs = m.path.replace(/\.py$/, '').split('/').filter(Boolean);
    if (segs[segs.length - 1] === '__init__') segs.pop();
    for (let k = 1; k <= segs.length; k++) {
      const key = segs.slice(-k).join('.');
      bySuffix.set(key, [...(bySuffix.get(key) ?? []), m]);
    }
  }
  const dirOf = (p: string) => p.split('/').slice(0, -1);
  const shared = (a: string[], b: string[]) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };
  const moduleFile = (from: FileModel, module: string, level: number): FileModel | null => {
    if (level > 0) {
      const base = dirOf(from.path).slice(0, Math.max(0, dirOf(from.path).length - (level - 1)));
      const rel = [...base, ...module.split('.').filter(Boolean)].join('/');
      return byPath.get(`${rel}.py`) ?? byPath.get(`${rel}/__init__.py`) ?? null;
    }
    const found = bySuffix.get(module) ?? [];
    if (found.length <= 1) return found[0] ?? null;
    // the same module name in several places: the one nearest the importing file
    const here = dirOf(from.path);
    return [...found].sort((a, b) => shared(dirOf(b.path), here) - shared(dirOf(a.path), here))[0] ?? null;
  };

  const resolve = (m: FileModel, ref: string, depth: number, seen: Set<string>): string[] => {
    const key = `${m.path}\0${ref}`;
    if (depth > MAX_DEPTH || seen.has(key)) return [];
    seen.add(key);
    const segs = ref.split('.');
    const head = segs[0] as string;
    const value = (v: Value | undefined, owner: FileModel): string[] => (v ? [...v.strings, ...v.refs.flatMap((r) => resolve(owner, r, depth + 1, seen))] : []);
    if (segs.length === 1 && m.consts.has(head)) return value(m.consts.get(head), m);
    const imp = m.imports.get(head);
    if (!imp) return [];
    const rest = segs.slice(1);
    if (imp.name === null) {
      // `import a` / `import a.b as x`: the longest module prefix that is a file, then a name in it
      const parts = [...imp.module.split('.'), ...rest];
      for (let k = parts.length - 1; k >= 1; k--) {
        const target = moduleFile(m, parts.slice(0, k).join('.'), imp.level);
        if (target) return resolve(target, parts.slice(k).join('.'), depth + 1, seen);
      }
      return [];
    }
    // `from a import X`: X is a name in a, or a module a.X
    const target = moduleFile(m, imp.module, imp.level);
    if (target && (target.consts.has(imp.name) || target.imports.has(imp.name))) return resolve(target, [imp.name, ...rest].join('.'), depth + 1, seen);
    const sub = moduleFile(m, imp.module ? `${imp.module}.${imp.name}` : imp.name, imp.level);
    return sub && rest.length ? resolve(sub, rest.join('.'), depth + 1, seen) : [];
  };

  /** The fixture a test (or fixture) asks for by parameter name: its own file, then conftest.py files above it, nearest first. */
  const conftests = models.filter((m) => /(^|\/)conftest\.py$/.test(m.path));
  const fixtureFor = (m: FileModel, name: string): { owner: FileModel; fx: Value & { params: string[]; labels: string[]; labelRefs: string[] } } | null => {
    const own = m.fixtures.get(name);
    if (own) return { owner: m, fx: own };
    const here = dirOf(m.path);
    const above = conftests
      .filter((c) => {
        const d = dirOf(c.path);
        return d.length <= here.length && d.every((s, k) => here[k] === s);
      })
      .sort((a, b) => dirOf(b.path).length - dirOf(a.path).length);
    for (const c of above) {
      const fx = c.fixtures.get(name);
      if (fx) return { owner: c, fx };
    }
    const imp = m.imports.get(name);
    if (imp?.name) {
      const target = moduleFile(m, imp.module, imp.level);
      const fx = target?.fixtures.get(imp.name);
      if (target && fx) return { owner: target, fx };
    }
    return null;
  };
  const fixtureStrings = (m: FileModel, params: readonly string[], depth: number, seen: Set<string>, out = { strong: [] as string[], weak: [] as string[] }) => {
    if (depth > 2) return out;
    for (const p of params) {
      const found = fixtureFor(m, p);
      if (!found || seen.has(`${found.owner.path}\0fixture:${p}`)) continue;
      seen.add(`${found.owner.path}\0fixture:${p}`);
      out.strong.push(...found.fx.labels, ...found.fx.labelRefs.flatMap((r) => resolve(found.owner, r, 0, new Set())));
      out.weak.push(...found.fx.strings, ...found.fx.refs.flatMap((r) => resolve(found.owner, r, 0, new Set())));
      fixtureStrings(found.owner, found.fx.params, depth + 1, seen, out);
    }
    return out;
  };

  const out: ScannedTest[] = [];
  for (const m of models) {
    const markStrong = [...m.moduleMarks, ...m.moduleMarkRefs.flatMap((r) => resolve(m, r, 0, new Set()))];
    // two tests with one name: pytest collects only the last (the first is shadowed)
    const last = new Map(m.tests.map((t) => [t.id, t] as const));
    for (const t of m.tests) {
      if (last.get(t.id) !== t) continue;
      const fx = fixtureStrings(m, t.params, 0, new Set());
      const strong = [...t.strong, ...t.strongRefs.flatMap((r) => resolve(m, r, 0, new Set())), ...markStrong, ...fx.strong];
      const weak = [...t.weak, ...t.weakRefs.flatMap((r) => resolve(m, r, 0, new Set())), ...fx.weak];
      const labels = [...new Set(strong)];
      out.push({
        id: t.id,
        file: t.file,
        cls: t.cls,
        name: t.name,
        labels,
        strings: [...new Set([...labels, ...weak])],
        keys: [...new Set([...t.keys, ...m.moduleKeys])],
      });
    }
  }
  return out;
}

/** One file on its own (constants it imports from other files stay unresolved). */
export function scanPytestFile(file: string, source: string): ScannedTest[] {
  return scanPytestFiles([{ path: file, text: source }]);
}

/** allure-pytest's fullName for a scanned test: `tests.routes.test_invoice.TestLoad#test_x`. */
export function allureFullName(t: ScannedTest): string {
  const mod = t.file.replace(/\.py$/, '').split('/').filter(Boolean).join('.');
  return `${mod}${t.cls ? `.${t.cls}` : ''}#${t.name}`;
}
