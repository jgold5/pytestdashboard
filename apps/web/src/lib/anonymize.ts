/**
 * Renames everything that could be a name (route ids, folders, file and test names, branches,
 * sheet values, words inside the reasons) to made-up words, the same everywhere, so a comparison
 * can be shared without the names in it. Runs in the browser: the names never leave it.
 *
 * - a word becomes a made-up word of the same length (camelCase parts one by one), so
 *   invoice-load, invoiceLoad and INVOICE_LOAD stay recognisably the same thing;
 * - numbers of 4+ digits get a stand-in of the same length; shorter ones (PR #12, line 30) stay;
 * - the dashboard's own words (the sentences of its reasons, Camel and file vocabulary) stay, so
 *   the reasons still read as sentences.
 * The key (made-up → original) is for the person who shares, not for the one they share with.
 */

/**
 * Generic technical vocabulary, and every word of the dashboard's own messages (its reasons and labels, taken
 * from the string literals of sheetCompare.ts, SheetCompare.tsx and scan.ts): never names. Anything else is renamed.
 */
const KEEP = new Set(
  `a an and are as at be by for from in is it of on or the to with not no yes but than that this there them its it's so if
  above all also another any anywhere apart as at automated agree agrees calls closest column columns compare compared comparison
  condition contains copy count counted counts cover covered covers dashboard defined differ differs differences different does
  doesn don each else elsewhere every everything exists file files filled first found from full has have here how identical
  include instantiates isn kind kinds label labelled line lined lines list listing lists many match matches may merged missing
  more name names near nothing number numbers once one only ordinary other others outside passed per picked placeholder plain
  property properties read reading reason reasons route routes row rows run runs same says scan scanned several shared sheet
  sheets something status suggests tells test tested tests text too tool trigger triggers type types under until value values
  via was what when where which why word words you your yours its without also called call caller tested which
  file schedule direct queue kafka rest property load loads loader job jobs poll polls worker workers api http https
  seda vm jms activemq amqp sjms sftp ftp ftps smb quartz quartz2 cron timer scheduler netty jetty servlet restlet undertow
  platform bean imaps log stub ref master env sys uri url endpoint endpoints camel xml dsl java kotlin src main resources test
  tests conftest pytest allure mark parametrize fixture fixtures label labels csv txt json dat zip gz tar done tmp err xlsx tsv
  py properties yaml yml in out inbound outbound input output data dir path config default common app application
  pr prs branch branches folder folders module modules id ids key keys automated tested untested
  agrees differs sheetonly dashboardonly match differs merged none true false null
  starts ends with regex contains startswith endswith
  absolute accent against align ant auto bad body border browser button cancel center choose col color cols
  dashed details diffs download drop empty endss enrich entry everywhere ext failed field filter flex focus
  font gap ghost glob grid headers hidden holds hover inline interval items keep kept leave left length like
  made max medium mix mono noext nots nowrap oklab onlyname otherwise outline overflow own picks pointer
  points preview primary private problems rabbitmq relative removed repeat replaced required result ring
  rounded save scheduled schemes scope search semibold sets share sharing show shown shrink side simple size
  skip soft space spreadsheet spring start startss sticky strong substr substring surface tab tablist tabular
  tap template times tolowercase top touppercase tracking translate transparent truncate unlinked unresolved
  upload uppercase var visible warn whitespace wire wrap write yourself`.split(/\s+/).filter(Boolean),
);

/** File extensions kept on renamed paths (the type of a file is not a name). */
const EXTENSIONS = new Set('xml py csv tsv txt json properties yaml yml xlsx java kt groovy sql md'.split(' '));
/** In free text: a path with a folder (a/b/c.xml, a/b:12) or a file name with a known extension (test_jobs.py). */
const PATH_LIKE = /(?:[\w.-]+\/)+[\w.-]*[\w-](?::\d+)?|\b[\w.-]+\/(?![\w.-])|\b[\w-]+\.(?:xml|py|csv|tsv|txt|json|properties|yaml|yml|xlsx|java|kt|groovy|sql)\b(?::\d+)?/g;

/** Slash-joined words the dashboard writes in its own reasons: not paths of the repo. */
const OWN_PATHS = new Set(['java/kotlin', 'src/test', 'seda/jms', 'merged/pr', 'folder/types', 'queue/topic', 'port/path', 'file/simple']);

const CONSONANTS = 'bdfgklmnprstvz';
const VOWELS = 'aeiou';

export class Anonymizer {
  /** original (lower case) → made-up */
  private words = new Map<string, string>();
  private numbers = new Map<string, string>();
  private used = new Set<string>();
  private perLength = new Map<number, number>();

  private madeUp(length: number): string {
    for (;;) {
      let n = this.perLength.get(length) ?? 0;
      this.perLength.set(length, n + 1);
      let w = '';
      for (let i = 0; i < length; i++) {
        const abc = i % 2 === 0 ? CONSONANTS : VOWELS;
        w += abc[n % abc.length];
        n = Math.floor(n / abc.length);
      }
      if (n > 0) w = `${w.slice(0, -1)}q${this.perLength.get(length)}`.slice(0, Math.max(length, 4));
      if (!KEEP.has(w) && !this.used.has(w)) {
        this.used.add(w);
        return w;
      }
    }
  }

  private one(w: string, strict = false): string {
    const low = w.toLowerCase();
    if (low.length <= 2 || (!strict && KEEP.has(low))) return w;
    let g = this.words.get(low);
    if (!g) {
      g = this.madeUp(low.length);
      this.words.set(low, g);
    }
    if (w === w.toUpperCase()) return g.toUpperCase();
    return w[0] === w[0]!.toUpperCase() ? g[0]!.toUpperCase() + g.slice(1) : g;
  }

  private word(run: string, strict = false): string {
    if (!strict && KEEP.has(run.toLowerCase())) return run;
    const parts = run.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[A-Z]+/g) ?? [run];
    return parts.join('') === run ? parts.map((p) => this.one(p, strict)).join('') : this.one(run, strict);
  }

  private number(run: string): string {
    if (run.length < 4) return run;
    let g = this.numbers.get(run);
    if (!g) {
      g = String(this.numbers.size + 1).padStart(run.length, '0').slice(-run.length);
      this.numbers.set(run, g);
    }
    return g;
  }

  private words_(s: string, strict: boolean): string {
    return s.replace(/[A-Za-z]+|\d+/g, (m) => (/\d/.test(m[0]!) ? this.number(m) : this.word(m, strict)));
  }

  /**
   * A file path, folder or branch: every word renamed, generic ones too (src, main, common…), so no
   * part of the layout shows; only the file extension and the separators stay.
   */
  path(s: string): string;
  path(s: string | null): string | null;
  path(s: string | null | undefined): string | null | undefined;
  path(s: string | null | undefined): string | null | undefined {
    if (s === null || s === undefined) return s;
    const ext = /\.([A-Za-z0-9]{1,10})(:\d+)?$/.exec(s);
    const keepExt = ext && EXTENSIONS.has(ext[1]!.toLowerCase());
    const body = keepExt ? s.slice(0, ext!.index) : s;
    return this.words_(body, true) + (keepExt ? `.${ext![1]}${ext![2] ?? ''}` : '');
  }

  /** Any text: file paths in it as paths, other letter runs and long digit runs renamed, the dashboard's words kept. */
  text(s: string): string;
  text(s: string | null): string | null;
  text(s: string | null | undefined): string | null | undefined;
  text(s: string | null | undefined): string | null | undefined {
    if (s === null || s === undefined) return s;
    let out = '';
    let last = 0;
    for (const m of s.matchAll(PATH_LIKE)) {
      if (OWN_PATHS.has(m[0].toLowerCase())) continue; // the dashboard's own words (Java/Kotlin, src/test)
      out += this.words_(s.slice(last, m.index), false) + this.path(m[0]);
      last = (m.index ?? 0) + m[0].length;
    }
    return out + this.words_(s.slice(last), false);
  }

  /** made-up → original, for the person sharing (keep it private). */
  key(): { words: Record<string, string>; numbers: Record<string, string> } {
    const words: Record<string, string> = {};
    for (const [orig, made] of this.words) words[made] = orig;
    const numbers: Record<string, string> = {};
    for (const [orig, made] of this.numbers) numbers[made] = orig;
    return { words, numbers };
  }
}

/** Fields that hold a file path, folder or branch: renamed as paths (every word). */
export const PATH_FIELDS = new Set(['sourceFile', 'testFiles', 'xml', 'module', 'folder', 'file']);

/** Rename every string in a JSON value (keys of objects stay: they are field names). */
export function anonymizeDeep<T>(value: T, a: Anonymizer, skipKeys: ReadonlySet<string> = new Set(), asPath = false, folders: ReadonlySet<string> = new Set()): T {
  if (typeof value === 'string') return (asPath || folders.has(value.toLowerCase().replace(/\/$/, '')) ? a.path(value) : a.text(value)) as T;
  if (Array.isArray(value)) return value.map((v) => anonymizeDeep(v, a, skipKeys, asPath, folders)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = skipKeys.has(k) ? v : anonymizeDeep(v, a, skipKeys, asPath || PATH_FIELDS.has(k), folders);
    return out as T;
  }
  return value;
}

/** The folder names a comparison mentions: a sheet value equal to one (its "where" column) is renamed like the folder. */
export function foldersOf(result: { folder?: string | null; rows: Array<{ dashboard?: { module?: string | null } | null }> }): Set<string> {
  const out = new Set<string>();
  for (const f of (result.folder ?? '').split(',')) if (f.trim()) out.add(f.trim().toLowerCase());
  for (const r of result.rows) if (r.dashboard?.module) out.add(r.dashboard.module.toLowerCase());
  return out;
}
