// PreToolUse hook for the Light SDD toolkit (L3).
// Blocks operations a Light SDD cycle never needs: publishing or rewriting history, discarding
// uncommitted work, deleting recursively, installing tools globally, and writing outside the
// repository or into the guardrails themselves (.claude/, .git/).
// File tools (Write, Edit, ...) are judged by their path. Shell commands (Bash, PowerShell) are split
// into simple commands, and each is judged by what it writes to: redirections, output options
// (-o, -OutFile, ...), and the path arguments of commands that write files (cp, mkdir, tee,
// Set-Content, ...). After a cd out of the repository, only commands that read are let through.
// A write made inside a script (node -e, python -c, a script file) is not judged: this guard catches
// slips, it is not a sandbox.
// Exit 2 blocks the call and shows stderr to Claude. Any error also blocks (fail closed), because
// a hook that crashes would otherwise let the call through without anyone noticing.
// Each decision is appended to .git/lsdd-guard.log (set LSDD_GUARD_NO_LOG=1 to skip).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMMAND_RULES = [
  [/\bgit\s+push\b/i, 'git push はしない（共有先への反映は人が行う）'],
  [/\bgit\s+reset\s+--hard\b/i, 'git reset --hard はしない（未コミットの作業が消える）'],
  [/\bgit\s+clean\b/i, 'git clean はしない（追跡していないファイルが消える）'],
  [/\bgit\s+checkout\s+(--\s|\.(\s|$))/i, 'git checkout -- / git checkout . はしない（未コミットの変更が消える）'],
  [/\bgit\s+restore\b(?![^;&|\n]*--staged)/i, 'git restore はしない（未コミットの変更が消える。--staged だけは可）'],
  [/\bgit\s+commit\b[^;&|\n]*--amend\b/i, '既存のコミットは書き換えない（--amend はしない）'],
  [/\bgit\s+rebase\b/i, '既存のコミットは書き換えない（rebase はしない）'],
  [/\bgit\s+branch\s+(-D|--delete\s+--force)\b/, 'ブランチを強制削除しない'],
  [/\bgit\s+stash\s+(drop|clear)\b/i, 'stash を捨てない'],
  [/--no-verify\b/i, '--no-verify で検査を飛ばさない'],
  [/\brm\s+(-[a-z]*r|-R|--recursive)/i, 'ディレクトリごと削除しない（rm -r）'],
  [/\bRemove-Item\b[^;&|\n]*-Recurse\b/i, 'ディレクトリごと削除しない（Remove-Item -Recurse）'],
  [/\b(rd|rmdir)\s+\/s\b/i, 'ディレクトリごと削除しない（rd /s）'],
  [/(>|\b(tee|cp|mv|sed\s+-i|Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|New-Item|Remove-Item|rm)\b)[^;&|\n]*\.(claude|git)[\\/]/i,
    '.claude/ と .git/ の下はコマンドでも書き換えない（ガードの設定とリポジトリの管理領域）'],
  [/\b(npm|pnpm|yarn)\s+(install|i|add|update|remove|uninstall|link)\b[^;&|\n]*\s(-g|--global)\b/i, 'パッケージをグローバルに入れない（リポジトリの外に書かれる）'],
  [/\bdotnet\s+tool\s+(install|update|uninstall)\b[^;&|\n]*\s(-g|--global|--tool-path)\b/i, 'ツールをグローバルに入れない（リポジトリの外に書かれる）'],
  [/\bNew-TemporaryFile\b|::GetTempFileName\b/i, '一時フォルダー（リポジトリの外）にファイルを作らない'],
  [/\b(pwsh|powershell)(\.exe)?\b[^;&|\n]*\s-(e|ec|enc|encodedcommand)\b/i, 'エンコードしたコマンドは判定できない'],
];

// Words that come before the command name (if, do, sudo, export, ...).
const PREFIXES = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac',
  'function', '!', 'time', 'nohup', 'sudo', 'env', 'command', 'builtin', 'exec', 'xargs', 'export', 'local', 'declare',
  'readonly', 'foreach']);
const SHELLS = { bash: 'sh', sh: 'sh', zsh: 'sh', dash: 'sh', ksh: 'sh', pwsh: 'ps', powershell: 'ps', cmd: 'ps' };
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const CD_BACK = new Set(['popd', 'pop-location']);
// Commands that write files. Their path arguments are judged (a source that is only read included).
const WRITERS = new Set(['cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'tee', 'ln', 'mktemp', 'dd', 'truncate', 'shred',
  'unzip', 'tar', 'zip', 'gzip', 'gunzip', '7z', 'patch', 'chmod', 'chown', 'rsync', 'scp',
  'set-content', 'add-content', 'out-file', 'tee-object', 'new-item', 'copy-item', 'move-item', 'remove-item',
  'rename-item', 'clear-content', 'set-item', 'new-itemproperty', 'set-itemproperty', 'remove-itemproperty',
  'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'expand-archive', 'compress-archive', 'export-csv',
  'export-clixml', 'start-bitstransfer', 'ni', 'sc', 'ac', 'cpi', 'mi', 'ri', 'rni', 'del', 'erase', 'copy', 'move',
  'ren', 'rename', 'md', 'rd', 'xcopy', 'robocopy']);
// Commands that only read. Outside the repository, nothing else is let through.
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'dir', 'find',
  'wc', 'diff', 'cmp', 'echo', 'printf', 'pwd', 'which', 'where', 'type', 'file', 'stat', 'du', 'df', 'sort', 'uniq',
  'cut', 'tr', 'awk', 'sed', 'jq', 'test', '[', '[[', 'true', 'false', 'sleep', 'seq', 'date', 'basename', 'dirname',
  'realpath', 'readlink', 'cygpath', 'printenv', 'column', 'nl', 'od', 'xxd', 'md5sum', 'sha256sum', 'tasklist', 'ps',
  'read', 'set', 'shift', 'unset', 'return', 'break', 'continue', 'exit', 'wait', 'trap', 'shopt', 'let',
  'get-content', 'gc', 'get-childitem', 'gci', 'select-string', 'sls', 'get-item', 'gi', 'test-path', 'resolve-path',
  'get-location', 'gl', 'write-output', 'write-host', 'measure-object', 'select-object', 'where-object', 'sort-object',
  'format-table', 'format-list', 'out-string', 'out-null', 'convertfrom-json', 'convertto-json', 'get-date',
  'start-sleep', 'get-process', 'get-command', 'join-path', 'split-path', 'get-filehash', 'compare-object',
  'foreach-object']);
const GIT_READERS = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'blame',
  'grep', 'cat-file', 'describe', 'shortlog', 'for-each-ref', 'show-ref', 'version', 'help', 'name-rev', 'merge-base',
  'check-ignore']);
const GIT_PATH_WRITERS = new Set(['clone', 'init', 'worktree', 'bundle', 'submodule']);
// Options whose value is a file to write, whatever the command (dotnet build -o, curl -o, Invoke-WebRequest -OutFile).
const OUTPUT_OPTIONS = new Set(['-o', '--output', '--output-file', '--output-document', '--output-dir',
  '--directory-prefix', '--cookie-jar', '--dump-header', '--log-file', '-outfile', '-outputpath', '-destination',
  '-destinationpath', '-redirectstandardoutput', '-redirectstandarderror']);
// curl and wget write files only through these short options (case-sensitive; may end a cluster such as -sSo).
// Their other arguments are URLs, headers and data, so they are not judged as paths.
const SHORT_OUTPUT = { curl: 'ocD', wget: 'OoaP' };
const NULL_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'nul', '$null', 'con']);
const UNKNOWN = '\u0000'; // stands for the output of a command substitution
const WIN = process.platform === 'win32';

const cmdName = (t) => t.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '');
const contains = (root, p) => {
  const rel = path.relative(root, p);
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
};
const guarded = (root, p) => ['.claude', '.git'].includes(path.relative(root, p).split(/[\\/]/)[0].toLowerCase());
const show = (t) => t.replaceAll(UNKNOWN, '$(...)');

function readDelim(src, j) {
  const strip = src[j] === '-';
  if (strip) j++;
  while (src[j] === ' ' || src[j] === '\t') j++;
  let d = '';
  for (; j < src.length && !/[\s;&|<>()]/.test(src[j]); j++) if (!'\'"\\'.includes(src[j])) d += src[j];
  return { d, strip, end: j };
}

function skipHeredocs(src, i, docs) {
  for (const { d, strip } of docs) {
    while (i < src.length) {
      const e = src.indexOf('\n', i), k = e < 0 ? src.length : e;
      let line = src.slice(i, k).replace(/\r$/, '');
      if (strip) line = line.replace(/^\t+/, '');
      i = k + 1;
      if (line === d) break;
    }
  }
  return i;
}

// Index of the ")" that closes the "(" at `open`, skipping quotes and heredoc bodies.
function closeParen(src, open, ps) {
  const esc = ps ? '`' : '\\';
  let depth = 0, docs = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === esc) { i++; continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e < 0) return src.length; i = e; continue; }
    if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') j += src[j] === esc ? 2 : 1; i = j; continue; }
    if (!ps && c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') { const d = readDelim(src, i + 2); docs.push(d); i = d.end - 1; continue; }
    if (c === '\n' && docs.length) { i = skipHeredocs(src, i + 1, docs) - 1; docs = []; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return src.length;
}

// Splits a command line into simple commands, in the order they run: { words: [{ t, q }], redirects }.
// q marks a word with a quoted part, so that a quoted "rm" is not taken for a command. A command
// substitution ($(...), backticks) becomes { sub } and is judged on its own. (...) and {...} only
// separate commands. Heredoc bodies are data and are skipped.
function split(src, ps) {
  const out = [];
  let seg = { words: [], redirects: [] }, cur = null, mode = null, docs = [];
  const push = () => { if (seg.words.length || seg.redirects.length) out.push(seg); seg = { words: [], redirects: [] }; };
  const endWord = () => {
    const w = cur;
    cur = null;
    if (!w) return;
    if (mode === 'out') seg.redirects.push(w.t);
    else if (mode !== 'in') { if (!w.q && (w.t === '{' || w.t === '}')) push(); else seg.words.push(w); }
    mode = null;
  };
  const end = () => { endWord(); push(); };
  const add = (s, q) => { cur ??= { t: '', q: false }; cur.t += s; if (q) cur.q = true; };
  const esc = ps ? '`' : '\\';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '\n') { end(); if (docs.length) { i = skipHeredocs(src, i + 1, docs) - 1; docs = []; } continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    if (c === esc) {
      if (n === '\n') i++;
      else if (n === '\r' && src[i + 2] === '\n') i += 2;
      else { add(n ?? '', true); i++; }
      continue;
    }
    if (c === '#' && !cur) { const e = src.indexOf('\n', i); i = (e < 0 ? src.length : e) - 1; continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1), k = e < 0 ? src.length : e; add(src.slice(i + 1, k), true); i = k; continue; }
    if (ps && c === '@' && (n === "'" || n === '"') && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
      const e = src.indexOf('\n' + n + '@', i + 2), k = e < 0 ? src.length : e;
      add(src.slice(i + 2, k), true);
      i = k + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1, t = '';
      while (j < src.length && src[j] !== '"') {
        const d = src[j];
        if (d === esc && (ps || '$`"\\\n'.includes(src[j + 1] ?? ''))) { t += src[j + 1] ?? ''; j += 2; continue; }
        if (d === '$' && src[j + 1] === '(') {
          const k = closeParen(src, j + 1, ps);
          if (src[j + 2] !== '(') out.push({ sub: src.slice(j + 2, k) });
          t += UNKNOWN;
          j = k + 1;
          continue;
        }
        if (!ps && d === '`') { const e = src.indexOf('`', j + 1), k = e < 0 ? src.length : e; out.push({ sub: src.slice(j + 1, k) }); t += UNKNOWN; j = k + 1; continue; }
        t += d;
        j++;
      }
      add(t, true);
      i = j;
      continue;
    }
    if (c === '$' && n === '(') {
      const k = closeParen(src, i + 1, ps);
      if (src[i + 2] !== '(') out.push({ sub: src.slice(i + 2, k) });
      add(UNKNOWN, false);
      i = k;
      continue;
    }
    if (!ps && c === '`') { const e = src.indexOf('`', i + 1), k = e < 0 ? src.length : e; out.push({ sub: src.slice(i + 1, k) }); add(UNKNOWN, false); i = k; continue; }
    if (c === '(' && n === ')' && cur && !cur.q) { out.push({ func: cur.t }); cur = null; end(); i++; continue; } // name() { ... }
    if (c === ';' || c === '(' || c === ')') { end(); continue; }
    if (c === '|') { end(); if (n === '|') i++; continue; }
    if (c === '&') {
      if (n === '>') { endWord(); i += src[i + 2] === '>' ? 2 : 1; mode = 'out'; continue; } // &> and &>>
      end();
      if (n === '&') i++;
      continue;
    }
    if (c === '>' || c === '<') {
      if (n === '(') { end(); i++; continue; } // process substitution
      if (c === '<') {
        if (n === '<' && src[i + 2] !== '<') { endWord(); const d = readDelim(src, i + 2); docs.push(d); i = d.end - 1; continue; }
        endWord();
        mode = 'in'; // < file and <<< word are read, not written
        if (n === '<') i += 2;
        continue;
      }
      if (cur && !cur.q && /^(\d+|\*)$/.test(cur.t)) cur = null; // 2> and *> : the number is a descriptor
      else endWord();
      let j = i + 1;
      if (src[j] === '>' || src[j] === '|') j++;
      if (src[j] === '&') { j++; while (/[\d-]/.test(src[j] ?? '')) j++; i = j - 1; continue; } // 2>&1
      mode = 'out';
      i = j - 1;
      continue;
    }
    add(c, false);
  }
  end();
  return out;
}

function lookup(name, st, ps) {
  const key = ps ? name.toLowerCase() : name;
  if (st.vars.has(key)) return st.vars.get(key);
  if (/^CLAUDE_PROJECT_DIR$/i.test(name)) return st.root;
  if (ps ? key === 'pwd' : name === 'PWD') return st.base;
  if (/^(HOME|USERPROFILE)$/i.test(name)) return process.env[name] || os.homedir();
  if (/^(TMPDIR|TEMP|TMP)$/i.test(name)) return process.env[name] || os.tmpdir();
  const env = Object.keys(process.env).find((k) => (WIN ? k.toUpperCase() === name.toUpperCase() : k === name));
  return env ? process.env[env] : null;
}

// Expands $NAME, ${NAME}, $env:NAME and %NAME%. Null when the path starts with something that
// cannot be known here (a command substitution, a positional parameter, an unset variable).
function expand(token, st, ps) {
  if (token.startsWith(UNKNOWN)) return null;
  let unknownFirst = false;
  const out = token.replace(/\$env:(\w+)|\$\{(\w+)\}|\$(\w+|[!@#?$*-])|%(\w+)%/gi, (m, a, b, c, d, at) => {
    const v = lookup(a ?? b ?? c ?? d, st, ps);
    if (v !== null) return v;
    if (at === 0) unknownFirst = true;
    return UNKNOWN;
  });
  return unknownFirst ? null : out;
}

// Where a path argument points: { abs }, { out } (outside for sure), { unknown }, or {} (not a path).
function locate(token, st, ps) {
  if (NULL_TARGETS.has(token.toLowerCase())) return {};
  let t = expand(token, st, ps);
  if (t === null) return { unknown: true };
  if (NULL_TARGETS.has(t.toLowerCase()) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return {};
  if (t === '~' || /^~[\\/]/.test(t)) t = os.homedir() + t.slice(1);
  if (!ps && /^\\(?!\\)/.test(t)) return {}; // "\nHTTP..." in a shell is text, not a path from the drive root
  if (WIN) {
    t = t.replace(/^\/(?:cygdrive\/)?([a-z])(\/|$)/i, '$1:/'); // Git Bash: /c/Users -> c:/Users
    t = t.replace(/^\/tmp(?=\/|$)/i, os.tmpdir().replaceAll('\\', '/'));
  }
  if (/^(\\\\|\/\/)/.test(t) || /^[a-z][a-z0-9]+:[\\/]/i.test(t)) return { out: true }; // UNC, or a drive such as HKCU:\
  if (!WIN) {
    if (/^[a-z]:([\\/]|$)/i.test(t)) return { out: true }; // a Windows path on a POSIX host
    if (ps) t = t.replaceAll('\\', '/');
  }
  if (path.isAbsolute(t) || (WIN && /^[a-z]:/i.test(t))) return { abs: path.resolve(t) };
  if (st.base === null) return { unknown: true };
  return { abs: path.resolve(st.base, t) };
}

// Judges one simple command. Updates st (current directory, variables, functions) as the shell would.
function judgeSimple({ words, redirects }, ps, st, depth) {
  const first = words[0] && !words[0].q ? words[0].t.toLowerCase() : '';
  if (!ps && (first === 'for' || first === 'select' || first === 'case')) return null; // loop header: names a variable
  if (!ps && first === 'function' && words[1]) { st.funcs.add(words[1].t); return null; }
  let i = 0;
  for (; i < words.length; i++) {
    const t = words[i].t;
    const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(t);
    if (m) { st.vars.set(ps ? m[1].toLowerCase() : m[1], expand(m[2], st, ps)); continue; }
    if (ps && /^\$\w+$/.test(t) && words[i + 1]?.t === '=') { // $x = value
      st.vars.set(t.slice(1).toLowerCase(), words.length === i + 3 ? expand(words[i + 2].t, st, ps) : null);
      i++;
      continue;
    }
    if (!words[i].q && PREFIXES.has(t.toLowerCase())) continue;
    break;
  }
  const tail = words.slice(i);
  const head = tail[0];
  const name = head ? cmdName(head.t) : '';
  const bare = (w) => !w.q;

  if (CD.has(name)) {
    const args = tail.slice(1).filter((w) => w.q || !/^(-\w+|\/d)$/i.test(w.t));
    if (tail.some((w) => w.t === '-')) st.base = null;
    else if (!args.length) st.base = os.homedir();
    else st.base = locate(args[0].t, st, ps).abs ?? null;
  } else if (CD_BACK.has(name)) st.base = null;

  // bash -c "...", pwsh -Command ..., cmd /c ..., eval ...: judge the inner command too.
  const k = tail.findIndex((w) => bare(w) && (SHELLS[cmdName(w.t)] || cmdName(w.t) === 'eval'));
  if (k >= 0) {
    const sh = cmdName(tail[k].t);
    const innerPs = sh === 'eval' ? ps : SHELLS[sh] === 'ps';
    let inner = null;
    if (sh === 'eval') inner = tail.slice(k + 1).map((w) => w.t).join(' ');
    else {
      const f = tail.findIndex((w, j) => j > k && /^(-c|-command|\/c|\/k)$/i.test(w.t));
      if (f > 0) inner = innerPs ? tail.slice(f + 1).map((w) => w.t).join(' ') : (tail[f + 1]?.t ?? '');
    }
    if (inner !== null) {
      if (depth >= 4) return 'コマンドの入れ子が深すぎて判定できない';
      const r = judgeCommand(inner, innerPs, { root: st.root, base: st.base, vars: new Map(), funcs: new Set() }, depth + 1);
      if (r) return r;
    }
  }

  const explicit = redirects.slice(); // written for sure: unknown targets are blocked
  const args = []; // path arguments of a writing command: may be a source that is only read
  const names = tail.filter(bare).map((w) => cmdName(w.t));
  const fetcher = names.find((n) => SHORT_OUTPUT[n]);
  const isOutput = (o) => OUTPUT_OPTIONS.has(o) && (o !== '-o' || !READERS.has(name) || name === 'sort'); // not grep -o
  tail.forEach((w, j) => {
    if (w.q) return;
    const eq = /^(--?[A-Za-z][\w-]*)[=:](.*)$/s.exec(w.t);
    if (eq && isOutput(eq[1].toLowerCase())) explicit.push(eq[2]);
    else if (isOutput(w.t.toLowerCase()) && tail[j + 1]) explicit.push(tail[j + 1].t);
    else if (fetcher && /^-[A-Za-z]+$/.test(w.t) && SHORT_OUTPUT[fetcher].includes(w.t.at(-1)) && tail[j + 1]) explicit.push(tail[j + 1].t);
  });
  const writes = names.some((n) => WRITERS.has(n))
    || (names.includes('sed') && tail.some((w) => bare(w) && /^(-[a-zA-Z]*i|--in-place)/.test(w.t)))
    || (names.includes('find') && tail.some((w) => bare(w) && /^-(delete|fprint|fls)/.test(w.t)));
  if (writes) for (const w of tail.slice(1)) if (w.q || !w.t.startsWith('-')) args.push(w.t);
  if (names.includes('mktemp')) {
    const p = tail.findIndex((w) => /^(-p|--tmpdir)$/.test(w.t));
    if (p >= 0) explicit.push(tail[p + 1]?.t ?? os.tmpdir());
    else if (tail.some((w) => /^(-t|--tmpdir=)/.test(w.t)) || !tail.slice(1).some((w) => !w.t.startsWith('-'))) explicit.push(os.tmpdir());
  }
  const g = tail.findIndex((w) => bare(w) && cmdName(w.t) === 'git');
  let gitSub = null;
  if (g >= 0) {
    const dirs = [];
    let j = g + 1;
    for (; j < tail.length; j++) {
      const t = tail[j].t;
      if (/^(-C|--git-dir|--work-tree)$/.test(t)) { dirs.push(tail[++j]?.t ?? ''); continue; }
      const m = /^--(git-dir|work-tree)=(.*)$/.exec(t);
      if (m) { dirs.push(m[2]); continue; }
      if (/^(-c|--namespace|--exec-path)$/.test(t)) { j++; continue; }
      if (t.startsWith('-')) continue;
      gitSub = t;
      break;
    }
    if (gitSub && !GIT_READERS.has(gitSub)) {
      explicit.push(...dirs);
      if (GIT_PATH_WRITERS.has(gitSub)) for (const w of tail.slice(j + 1)) if (w.q || !w.t.startsWith('-')) args.push(w.t);
    }
  }
  const targets = explicit.filter((t) => !NULL_TARGETS.has(t.toLowerCase()));

  if (head && !CD.has(name) && !CD_BACK.has(name) && (st.base === null || !contains(st.root, st.base))) {
    // A function defined in the same command is judged where its body is written.
    const reads = ((READERS.has(name) || st.funcs.has(head.t)) && !writes && !targets.length)
      || (name === 'git' && GIT_READERS.has(gitSub ?? ''))
      || (name === 'curl' && !targets.length && !tail.some((w) => bare(w) && /^(-[A-Za-z]*O[A-Za-z]*|--remote-name(-all)?)$/.test(w.t)));
    if (!reads) return `リポジトリの外（${st.base ?? '移動先を判定できないディレクトリ'}）では、読み取り以外のコマンドを実行しない`;
  }
  for (const [list, strict] of [[targets, true], [args, false]]) {
    for (const t of list) {
      const r = locate(t, st, ps);
      if (r.unknown) { if (strict) return `書き込み先を判定できない（${show(t)}）`; continue; }
      if (r.out || (r.abs && !contains(st.root, r.abs))) return `リポジトリの外には書かない（${show(t)}）`;
      if (r.abs && guarded(st.root, r.abs)) return '.claude/ と .git/ の下はコマンドでも書き換えない（ガードの設定とリポジトリの管理領域）';
    }
  }
  return null;
}

// Judges a whole command line. Returns the reason to block, or null.
function judgeCommand(src, ps, st, depth) {
  for (const seg of split(src, ps)) {
    if (seg.func !== undefined) { st.funcs.add(seg.func); continue; }
    const r = seg.sub !== undefined
      ? (depth >= 4 ? 'コマンドの入れ子が深すぎて判定できない' : judgeCommand(seg.sub, ps, { ...st, vars: new Map(st.vars), funcs: new Set(st.funcs) }, depth + 1))
      : judgeSimple(seg, ps, st, depth);
    if (r) return r;
  }
  return null;
}

function decide(input, root) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(ti.command || '');
    for (const [re, reason] of COMMAND_RULES) if (re.test(cmd)) return reason;
    return judgeCommand(cmd, tool === 'PowerShell', { root, base: path.resolve(input.cwd || root), vars: new Map(), funcs: new Set() }, 0);
  }
  const file = ti.file_path || ti.notebook_path;
  if (!file) return 'ファイルのパスが無い書き込みは判定できない';
  const abs = path.resolve(input.cwd || root, String(file));
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return `リポジトリの外には書かない（${abs}）`;
  const top = rel.split(/[\\/]/)[0].toLowerCase();
  if (top === '.claude' || top === '.git') return `${top}/ の下は書き換えない（ガードの設定とリポジトリの管理領域）`;
  return null;
}

function log(root, entry) {
  if (process.env.LSDD_GUARD_NO_LOG === '1') return;
  const dir = path.join(root, '.git');
  if (!fs.existsSync(dir)) return;
  fs.appendFileSync(path.join(dir, 'lsdd-guard.log'), JSON.stringify(entry) + '\n');
}

let root = process.cwd();
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || root);
  const reason = decide(input, root);
  log(root, { t: new Date().toISOString(), tool: input.tool_name, block: reason });
  if (reason) {
    process.stderr.write(`ガードが止めた: ${reason}。この操作が要るなら、別の手段で回避せず、止まって人に判断を仰ぐこと。\n`);
    process.exit(2);
  }
  process.exit(0);
} catch (err) {
  try { log(root, { t: new Date().toISOString(), error: String(err && err.message || err) }); } catch {}
  process.stderr.write(`ガードが入力を判定できなかったので止めた（${err && err.message || err}）。止まって人に判断を仰ぐこと。\n`);
  process.exit(2);
}
