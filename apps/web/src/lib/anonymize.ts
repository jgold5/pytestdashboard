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

/** Words the dashboard writes itself (every word of its reasons and labels), and generic technical vocabulary: never names. */
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
  absolute accent activemq agree agrees align all allure also amqp and another antinclude apart api
  application auto automated bad body border branch branches but button calls camelfilename center choose
  closest coap color column compare compared comparison condition config const contains copy count counted
  counts cover covered createelement createobjecturl cron csv cxfrs dash dashboard dashboardonly dashed
  default defined deletefilename dialog differ differences differs diffs direct document doesn don download
  drop dsl dynamic each else elsewhere endpoint ends endswith enrich entry env errors events every everything
  exec ext failed file filename files filled filter first flex focus folder folders font for found from ftp
  ftps full gap get ghost glob grid has have head headers here hidden hover how href http https identical
  import include inline inonly inout inp input inputs instantiates isn items its java jetty jms join kafka
  key kind kinds kotlin label leave left length lib lined lines list listing lists load main many map mark
  master match max may medium merged missing mix module mono more mqtt name names near netty new noext none
  norm not note nothing nowrap number numbers oklab once one only onlyname ordinary other otherwise out
  outline outside overflow parse passed per picked placeholder plain platform pointer points poll pollenrich
  prbranches preview primary prlabel problems properties property prs push pytest quartz queue rabbitmq raw
  read reading reason reasons ref regex relative removed repeatcount repeatinterval required resources rest
  restlet result ring rounded route routecoverage routeid routes routetemplate row rows run runvia same says
  scan scanned schedule scheduled scheduler schema search seda select semibold service servlet sets several
  sftp shared sheet sheetids sheetonly sheetrow show shrink side simple size sjms skip smb soft something
  space spreadsheet spring src start starts startswith status sticky store strays strong substr substring
  suggests surface sys tab tablist tabular tells test tested testedinpronly testfiles tests testscope text
  than that the them there this timer tmp tolowercase too tool top touppercase tracking translate transparent
  trigger triggers trim truncate tsv txt type types under undertow unresolved until upload uppercase uri url
  utils value values via visible warn was what when where which whitespace why wiretap with without word
  words worker wrap xlsx xml yes you your
  about abs acc add against among array automat base best boolean both can candidates canon cap case cell
  cells change client close cols containing continue core coverage covering cur delete desc describe detect
  dev develop drizzle edits entries entrykind exp export extends extra field find flat function header idx
  includes index interface into keyof knows latest let levenshtein like link linked listed location lower
  manual matched math mean min mine most node nums numtriggers object ones open order orm oui own page parsed
  partial pending pop prefix prev ptd pullrequests readonly record reg replace req request response return
  routefile routename say scans scheme schemes scope scoped separator set skipped slice some sort source
  sourcefile split string strings tell testfile testpath theirs then those throw times todo trig triggercount
  typeof typo undefined unlinked unmerged upper used usual ways weak wheres within write xmlfile`.split(/\s+/).filter(Boolean),
);

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

  private one(w: string): string {
    const low = w.toLowerCase();
    if (low.length <= 2 || KEEP.has(low)) return w;
    let g = this.words.get(low);
    if (!g) {
      g = this.madeUp(low.length);
      this.words.set(low, g);
    }
    if (w === w.toUpperCase()) return g.toUpperCase();
    return w[0] === w[0]!.toUpperCase() ? g[0]!.toUpperCase() + g.slice(1) : g;
  }

  private word(run: string): string {
    if (KEEP.has(run.toLowerCase())) return run;
    const parts = run.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[A-Z]+/g) ?? [run];
    return parts.join('') === run ? parts.map((p) => this.one(p)).join('') : this.one(run);
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

  /** Any text: letters runs and long digit runs renamed, everything else as it is. */
  text(s: string): string;
  text(s: string | null): string | null;
  text(s: string | null | undefined): string | null | undefined;
  text(s: string | null | undefined): string | null | undefined {
    if (s === null || s === undefined) return s;
    return s.replace(/[A-Za-z]+|\d+/g, (m) => (/\d/.test(m[0]!) ? this.number(m) : this.word(m)));
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

/** Rename every string in a JSON value (keys of objects stay: they are field names). */
export function anonymizeDeep<T>(value: T, a: Anonymizer, skipKeys: ReadonlySet<string> = new Set()): T {
  if (typeof value === 'string') return a.text(value) as T;
  if (Array.isArray(value)) return value.map((v) => anonymizeDeep(v, a, skipKeys)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = skipKeys.has(k) ? v : anonymizeDeep(v, a, skipKeys);
    return out as T;
  }
  return value;
}
