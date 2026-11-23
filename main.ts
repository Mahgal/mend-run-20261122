// mend: apply AI-written edits in four formats to a tree of text files.
// Written from scratch from SPEC.md (version 1) in the kit. Node 22, the
// standard library alone. Run as `node main.ts [options] [PATCH]`; SPEC.md is
// the whole contract: every sentence below implements one of its sentences.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

/** An exit-2 answer: the one line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** Per-run context shared by the edits: the moves they performed, old then new. */
interface Ctx {
  moves: [string, string][];
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is not empty, does not start with `/`, holds no `\`,
 * and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

/** Section 3: the break is CRLF when the first line feed follows a carriage return, LF
 * otherwise; the text split at that break; the last, empty piece after a final break is
 * not a line; an empty file has no lines and does not end with a line break. */
function parseFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

/** A file of no lines is written empty; otherwise its lines joined by its own break,
 * with a final one exactly when it ended with one. */
function renderFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

/** One line's key at a tier: every line equal; every line equal once trailing spaces
 * and tabs are removed from both; every line equal once leading and trailing spaces
 * and tabs are removed from both. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  if (tier === 1) return t;
  return t.replace(/^[ \t]+/, '');
}

/** Positions where O occurs in `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0) return out;
  const keys = oldLines.map((l) => tierKey(l, tier));
  for (let i = 0; i + n <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < n; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. With --strict
 * only tier 0 is tried. */
function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** One line of N: patch text, or a context line taken from the file's own matched line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number; // its index in O when ctx, else -1
}

/** Build the replacement lines for a match at `pos` at `tier`: a context line is written
 * as the file's own matched line, never the patch's; at tier 2 every other line is
 * re-indented, the leading spaces and tabs of O's first line replaced by those of the
 * file's first matched line. */
function buildNew(fileLines: string[], pos: number, oldLines: string[], newLines: NewLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && oldLines.length > 0) {
    f = leadingWs(fileLines[pos] ?? '');
    p = leadingWs(oldLines[0]!);
  }
  for (const nl of newLines) {
    if (nl.ctx) {
      out.push(fileLines[pos + nl.oIdx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && oldLines.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(p)) {
      t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

/** Apply one matched replacement to a file's lines, returning the new lines and whether
 * the result ends with a line break. `touchesEnd` says the matched lines ran to the end
 * of the file (or, for an empty O, the insertion is at the end); then the result ends
 * with a line break unless `noEol` says a `\` line followed the hunk's last context or
 * `+` line; otherwise the file's final break stays as it was. */
function spliceLines(
  f: FileText,
  pos: number,
  oLen: number,
  replacement: string[],
  touchesEnd: boolean,
  noEol: boolean,
): FileText {
  const lines = [...f.lines];
  lines.splice(pos, oLen, ...replacement);
  return { br: f.br, lines, final: touchesEnd ? !noEol : f.final };
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format.
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. A wrong command or a missing or
 * mistyped key is a parse fault, reported by the caller. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const crlf = parseFile(before).br === '\r\n';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile({ br: f.br, lines, final: f.final }));
    };
  }
  return null;
}

/** The patch is either one JSON array of edit objects, or JSON Lines: one edit object
 * a line, blank lines ignored. In array form any fault is `error: parse <the line where
 * the array starts>`; in JSON Lines form a line that does not hold one valid edit object
 * is `error: parse <that line>`. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 6 to 8: unified diffs, SEARCH/REPLACE blocks, V4A patches.
// Written in the steps that follow; each returns the patch's edits in order.
// ---------------------------------------------------------------------------

type Edit = (tree: Tree, ctx: Ctx) => void;

/** Section 6: unified diffs. */

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One hunk: its old start A (1-based, 0 for a pure insertion), its body lines with
 * trailing empty lines removed, and what its body names. */
interface Hunk {
  a: number;
  body: string[];
  noEol: boolean; // a `\` line follows the hunk's last context or `+` line
  lastAddNoEol: boolean; // a `\` line follows the hunk's last `+` line
  oldLines: string[];
  newLines: NewLine[];
}

/** One section: its old and new path (`/dev/null` is null), its mode flags, its hunks. */
interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `---`/`+++` path: the text after the four characters, up to the first tab, with
 * surrounding spaces removed; `/dev/null` means no file; a leading `a/` or `b/` is
 * removed from either. */
function headerPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Parse one hunk at `at`, returning it and the index of the first line after its body.
 * The body is the lines after the header that start with ` `, `-`, `+` or `\`, or are
 * empty; it ends at the first other line, at a `diff --git ` line, at a `--- ` line
 * followed by a `+++ ` line, or at the end of the patch; empty lines at the end of a
 * body are not part of it. */
function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[at]!);
  if (m === null) throw new Exit2(`error: parse ${at + 1}`);
  const a = Number(m[1]);
  let j = at + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  let lastCtxOrAdd = -1;
  let lastAdd = -1;
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ') {
      const text = l === '' ? '' : l.slice(1);
      oldLines.push(text);
      newLines.push({ text, ctx: true, oIdx: oldLines.length - 1 });
      lastCtxOrAdd = k;
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      newLines.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxOrAdd = k;
      lastAdd = k;
    }
    // A `\` line refers to the body line before it; otherwise it is ignored here.
  }
  const follows = (k: number): boolean => k >= 0 && body[k + 1] !== undefined && body[k + 1]![0] === '\\';
  return {
    hunk: { a, body, noEol: follows(lastCtxOrAdd), lastAddNoEol: follows(lastAdd), oldLines, newLines },
    next: j,
  };
}

/** Apply one hunk to a file's lines. `d` is the sum over this section's hunks applied so
 * far of (N's length minus O's length). When O is not empty the hunk takes the occurrence
 * whose 0-based position is nearest to A - 1 + d, of two equally near the earlier; when
 * O is empty N is inserted after the first A + d lines. */
function applyHunk(f: FileText, h: Hunk, strict: boolean, d: number, path: string): FileText {
  if (h.oldLines.length === 0) {
    const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
    const replacement = buildNew(f.lines, pos, [], h.newLines, 0);
    return spliceLines(f, pos, 0, replacement, pos === f.lines.length, h.noEol);
  }
  const found = findTier(f.lines, h.oldLines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const pos of found.occ) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const replacement = buildNew(f.lines, best, h.oldLines, h.newLines, found.tier);
  return spliceLines(f, best, h.oldLines.length, replacement, best + h.oldLines.length === f.lines.length, h.noEol);
}

/** One section as one edit: a creation, a deletion, a move, or a change of the one path.
 * Every path the edit names is checked for safety before anything else about it. */
function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  return (tree, ctx) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = oldP === null || s.newFile;
    const isDelete = !isCreate && (newP === null || s.deletedFile);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) return; // both paths /dev/null: a creation of no file, nothing to do
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const lines: string[] = [];
      for (const h of s.hunks) {
        for (const nl of h.newLines) if (!nl.ctx) lines.push(nl.text);
      }
      let noEol = false;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        if (s.hunks[k]!.newLines.some((nl) => !nl.ctx)) {
          noEol = s.hunks[k]!.lastAddNoEol;
          break;
        }
      }
      tree.now.set(newP, lines.length === 0 ? '' : `${lines.join('\n')}${noEol ? '' : '\n'}`);
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const src = oldP!;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let f = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      f = applyHunk(f, h, strict, d, src);
      d += h.newLines.length - h.oldLines.length;
    }
    const out = renderFile(f);
    if (isMove) {
      tree.now.set(newP!, out);
      tree.now.set(src, null);
      ctx.moves.push([src, newP!]);
    } else {
      tree.now.set(src, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const startSection = (oldPath: string | null, newPath: string | null): void => {
    cur = { oldPath, newPath, hasPair: false, newFile: false, deletedFile: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line.slice(4));
      const newP = headerPath(lines[i + 1]!.slice(4));
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hasPair = true;
      } else {
        startSection(oldP, newP);
        cur!.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1; // prose outside any section
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        inHeader = false;
        i = h.next;
        continue;
      }
      if (line.startsWith('--- ')) {
        // A `--- ` line not followed by a `+++ ` line, inside a section's header.
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ') && !cur.hasPair) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !cur.hasPair) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`
      // and `Index:` lines, and any other line, are ignored.
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i += 1; // outside bodies, lines that are not part of a section header are ignored
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Section 7: SEARCH/REPLACE blocks. A block is a path line, `<<<<<<< SEARCH`, old
 * lines, `=======`, new lines, `>>>>>>> REPLACE`. The three marker lines are matched
 * with their trailing whitespace removed. The path is the nearest line before the
 * SEARCH line, and after the previous block's REPLACE line (or the start of the patch),
 * that is not blank and, its surrounding whitespace removed, does not start with three
 * backticks; when there is no such line the block takes the previous block's path; the
 * first block with none is `error: parse <its SEARCH line>`. A SEARCH line with no
 * `=======` and then `>>>>>>> REPLACE` after it is `error: parse <the SEARCH line>`. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // index of the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/** One SEARCH/REPLACE block as an edit: empty old lines create the file; otherwise the
 * file exists and the old lines occur at their tier exactly once, or the block fails
 * with `ambiguous`. The file's final break stays as it was. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const nl: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const replacement = buildNew(f.lines, pos, oldLines, nl, found.tier);
    tree.now.set(path, renderFile(spliceLines(f, pos, oldLines.length, replacement, false, false)));
  };
}

/** Section 8: V4A patches. */

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

/** One chunk: its anchor (null: no anchor), whether `*** End of File` ended it, and the
 * lines it names. */
interface Chunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newLines: NewLine[];
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith(V4A_ADD) || line.startsWith(V4A_DELETE) || line.startsWith(V4A_UPDATE);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.trim() === '*** End Patch') throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith(V4A_ADD)) {
      const r = parseV4aAdd(lines, i, last);
      edits.push(r.edit);
      i = r.next;
      continue;
    }
    if (line.startsWith(V4A_DELETE)) {
      const r = parseV4aDelete(lines, i, last);
      edits.push(r.edit);
      i = r.next;
      continue;
    }
    if (line.startsWith(V4A_UPDATE)) {
      const r = parseV4aUpdate(lines, i, last, strict);
      edits.push(r.edit);
      i = r.next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/** An Add File section: its lines start with `+` (the rest is a line of the file) or are
 * empty (an empty line of the file); blank lines at the end of the section are not part
 * of it. */
function parseV4aAdd(lines: string[], at: number, last: number): { edit: Edit; next: number } {
  const path = lines[at]!.slice(V4A_ADD.length).trim();
  const fileLines: string[] = [];
  // Blank lines not yet known to be inside the section. A blank line in the middle of
  // an Add section is an empty line of the file only when it is empty; a whitespace-only
  // line there starts with neither `+` nor nothing, so it is a parse fault at its line.
  const pending: { raw: string; num: number }[] = [];
  let j = at + 1;
  while (j < last) {
    const l = lines[j]!;
    if (isV4aSectionStart(l) || l.trim() === '*** End Patch') break; // pending blanks are at the end of the section
    if (blank(l)) {
      pending.push({ raw: l, num: j + 1 });
      j += 1;
      continue;
    }
    if (l[0] === '+') {
      for (const p of pending) {
        if (p.raw !== '') throw new Exit2(`error: parse ${p.num}`);
        fileLines.push('');
      }
      pending.length = 0;
      fileLines.push(l.slice(1));
      j += 1;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
  const edit: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
  return { edit, next: j };
}

/** A Delete File section has no lines. */
function parseV4aDelete(lines: string[], at: number, last: number): { edit: Edit; next: number } {
  const path = lines[at]!.slice(V4A_DELETE.length).trim();
  let j = at + 1;
  while (j < last) {
    const l = lines[j]!;
    if (isV4aSectionStart(l) || l.trim() === '*** End Patch') break;
    if (blank(l)) {
      j += 1;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  const edit: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
  return { edit, next: j };
}

/** Apply one chunk to a file's lines, with the cursor: a chunk with an anchor first finds
 * the first line at or after the cursor equal to the anchor at the first tier where one
 * is, else `no-match`, and the cursor moves past it. The chunk takes the first occurrence
 * of O at or after the cursor, at the first tier with one; an end-of-file chunk takes only
 * an occurrence that ends at the file's last line. When O is empty, N is inserted at the
 * cursor, or at the end of the file for an end-of-file chunk. The cursor then moves to
 * just after the lines written. The file's final break stays as it was. */
function applyV4aChunk(
  f: FileText,
  ch: Chunk,
  strict: boolean,
  cursor: number,
  path: string,
): { f: FileText; cursor: number } {
  const tiers = strict ? [0] : [0, 1, 2];
  let cur = cursor;
  if (ch.anchor !== null) {
    let foundPos: number | null = null;
    for (const t of tiers) {
      for (let i = cur; i < f.lines.length; i += 1) {
        if (tierKey(f.lines[i]!, t) === tierKey(ch.anchor, t)) {
          foundPos = i;
          break;
        }
      }
      if (foundPos !== null) break;
    }
    if (foundPos === null) throw new Fail('no-match', path);
    cur = foundPos + 1;
  }
  if (ch.oldLines.length === 0) {
    const pos = ch.eof ? f.lines.length : cur;
    const replacement = buildNew(f.lines, pos, [], ch.newLines, 0);
    const lines = [...f.lines];
    lines.splice(pos, 0, ...replacement);
    return { f: { br: f.br, lines, final: f.final }, cursor: pos + replacement.length };
  }
  let chosen: { tier: number; pos: number } | null = null;
  for (const t of tiers) {
    const occ = occurrences(f.lines, ch.oldLines, t).filter(
      (p) => p >= cur && (!ch.eof || p + ch.oldLines.length === f.lines.length),
    );
    if (occ.length > 0) {
      chosen = { tier: t, pos: occ[0]! };
      break;
    }
  }
  if (chosen === null) throw new Fail('no-match', path);
  const replacement = buildNew(f.lines, chosen.pos, ch.oldLines, ch.newLines, chosen.tier);
  const lines = [...f.lines];
  lines.splice(chosen.pos, ch.oldLines.length, ...replacement);
  return { f: { br: f.br, lines, final: f.final }, cursor: chosen.pos + replacement.length };
}

/** An Update File section may have `*** Move to: <path>` as its first line, then chunks.
 * A chunk starts at an `@@` line (the text after `@@`, its surrounding spaces removed,
 * is the chunk's anchor; an empty text is no anchor) or, for the first chunk, at a body
 * line. Body lines start with ` `, `-` or `+`, or are empty (an empty context line). A
 * `*** End of File` line ends a chunk and anchors it to the end of the file. An Update
 * File section with no chunk and no `*** Move to:` is `error: parse <its Update File
 * line>`. Blank lines at the end of the section are not part of it, so blank lines are
 * only folded into a chunk as empty context lines once a later line shows they are
 * inside the section. */
function parseV4aUpdate(lines: string[], at: number, last: number, strict: boolean): { edit: Edit; next: number } {
  const path = lines[at]!.slice(V4A_UPDATE.length).trim();
  let moveTo: string | null = null;
  let j = at + 1;
  if (j < last && lines[j]!.startsWith(V4A_MOVE)) {
    moveTo = lines[j]!.slice(V4A_MOVE.length).trim();
    j += 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  const pending: { raw: string; num: number }[] = []; // blank lines not yet known to be inside the section
  const ensureChunk = (): Chunk => {
    if (cur === null) cur = { anchor: null, eof: false, oldLines: [], newLines: [] };
    return cur;
  };
  const finishChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  // A blank line inside a chunk is an empty context line; one at the end of the section
  // is not part of it, so blanks are only folded in once a later line shows they are
  // inside the section. A blank line's text as a context line is the line after its
  // first character (the body-line marker space); a blank line that does not start with
  // a space is no body line at all, so in the middle of a section it is a parse fault
  // at its line.
  const flushPending = (): void => {
    for (const p of pending) {
      if (p.raw !== '' && !p.raw.startsWith(' ')) throw new Exit2(`error: parse ${p.num}`);
      const c = ensureChunk();
      const text = p.raw === '' ? '' : p.raw.slice(1);
      c.oldLines.push(text);
      c.newLines.push({ text, ctx: true, oIdx: c.oldLines.length - 1 });
    }
    pending.length = 0;
  };
  while (j < last) {
    const l = lines[j]!;
    if (isV4aSectionStart(l) || l.trim() === '*** End Patch') break; // pending blanks are at the end of the section
    if (blank(l)) {
      pending.push({ raw: l, num: j + 1 });
      j += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      flushPending();
      finishChunk();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, oldLines: [], newLines: [] };
      j += 1;
      continue;
    }
    if (l.trim() === '*** End of File') {
      flushPending();
      if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
      cur.eof = true;
      finishChunk();
      j += 1;
      continue;
    }
    if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      flushPending();
      const c = ensureChunk();
      if (l[0] === ' ') {
        const text = l.slice(1);
        c.oldLines.push(text);
        c.newLines.push({ text, ctx: true, oIdx: c.oldLines.length - 1 });
      } else if (l[0] === '-') {
        c.oldLines.push(l.slice(1));
      } else {
        c.newLines.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      }
      j += 1;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  finishChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${at + 1}`);
  const edit: Edit = (tree, ctx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(f, ch, strict, cursor, path);
      f = r.f;
      cursor = r.cursor;
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      ctx.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
  return { edit, next: j };
}

// ---------------------------------------------------------------------------
// Section 1: invocation. Section 2: output and exit codes. Section 10: order
// and atomicity.
// ---------------------------------------------------------------------------

interface Opts {
  format: string;
  check: boolean;
  strict: boolean;
  file: string | null;
}

function parseArgs(args: string[]): Opts | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && (FORMATS as readonly string[]).includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return null;
    } else pos.push(a);
  }
  if (pos.length > 1) return null;
  return { format: format ?? 'auto', check, strict, file: pos.length === 0 || pos[0] === '-' ? null : pos[0]! };
}

function run(args: string[]): { code: number; out: string[] } {
  const opts = parseArgs(args);
  if (opts === null) return { code: 2, out: ['error: usage'] };
  let text = '';
  try {
    text = readFileSync(opts.file ?? 0, 'utf8');
  } catch {
    if (opts.file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = opts.format === 'auto' ? detect(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, opts.strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, opts.strict);
    else edits = v4aEdits(lines, opts.strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // The change rows, in byte order of the paths (UTF-8); a move that succeeded
  // replaces its pair's `D` and `A` lines and sorts by its new path.
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  const sortedMoves = [...ctx.moves].sort((a, b) => byteCmp(a[1], b[1]));
  for (const [oldP, newP] of sortedMoves) {
    if (used.has(oldP) || used.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!opts.check) {
    // Deletes first, so a path can change from a file into a directory a new file needs.
    for (const p of tree.now.keys()) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const out = rows.map((r) => r.line);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
