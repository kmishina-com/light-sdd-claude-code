// Self-check for guard.mjs. A guard that does not run, or runs but lets everything through, shows
// nothing on screen, so check both the guard's decisions and its registration in settings.json.
// Usage: node .claude/hooks/guard.test.mjs   (exit 0 = all passed)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const guard = path.join(here, 'guard.mjs');

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path } });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });
const outside = path.dirname(root);
const rootSlash = root.replaceAll('\\', '/');
const gitBashRoot = rootSlash.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()); // C:/x -> /c/x

const CASES = [
  // allowed
  [bash('git status --short'), 0], [bash('dotnet test'), 0], [bash('git add spec/a.md && git commit -m "x"'), 0],
  [bash('git restore --staged spec/a.md'), 0], [bash('dotnet test 2>&1 | tail -20'), 0], [bash('cat .claude/settings.json'), 0],
  [ps('dotnet build; git diff --stat'), 0], [edit('spec/a.md'), 0], [write(path.join(root, 'src', 'A.cs')), 0],
  // allowed: shell commands that write inside the repository, or only read outside it
  [bash('curl -s -o /dev/null -w "%{http_code}" http://localhost:5227/'), 0],
  [bash('curl -s -w "\\nHTTP %{http_code}\\n" http://localhost:5227/'), 0], [bash('cd /tmp && curl -s http://localhost:5227/ | grep -c tr'), 0],
  [bash('dotnet run --project src/App > out/app.log 2>&1 &'), 0], [bash(`echo x > "${rootSlash}/notes/a.md"`), 0],
  [bash('cat /tmp/app.log; diff /tmp/a.md spec/a.md'), 0], [bash('cd src && dotnet build'), 0], [bash('cd /tmp && ls'), 0],
  [bash('cd /tmp && show() { curl -s "$1" | grep -o "/[a-z]*"; }; for q in a b; do show "http://localhost:5227/$q"; done'), 0],
  [bash('B=http://localhost:5227; curl -s "$B/WorkOrder" | grep -c tr'), 0],
  [bash('for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:5199/ && break; sleep 1; done'), 0],
  [bash("git commit -m \"$(cat <<'EOF'\nwrite to /tmp (don't)\nEOF\n)\""), 0],
  [bash("cat > notes/a.md <<'EOF'\ncp x /tmp/y\nEOF"), 0], [bash('git -C ../other log --oneline'), 0],
  [ps('Get-Content $env:TEMP\\a.log'), 0], [ps('Set-Content -Path notes\\a.md -Value x'), 0],
  [ps('dotnet build > $null; dotnet test 2>&1 | Select-Object -Last 20'), 0],
  [{ ...bash('ls ..'), cwd: outside }, 0],
  ...(process.platform === 'win32' ? [[bash(`cd ${gitBashRoot} && echo x > notes/a.md`), 0]] : []),
  // blocked
  [bash('git push origin main'), 2], [bash('cd x && git push'), 2], [bash('bash -c "git push"'), 2],
  [bash('git reset --hard HEAD'), 2], [bash('git clean -fd'), 2], [bash('git checkout -- src/A.cs'), 2],
  [bash('git restore src/A.cs'), 2], [bash('git commit --amend -m x'), 2], [bash('git commit -m x --no-verify'), 2],
  [bash('git rebase -i HEAD~2'), 2], [bash('rm -rf bin'), 2], [bash('git stash drop'), 2],
  [ps('Remove-Item obj -Recurse -Force'), 2], [bash('echo {} > .claude/settings.json'), 2],
  [bash("sed -i 's/x/y/' .claude/hooks/guard.mjs"), 2], [ps('Set-Content .claude\\settings.json "{}"'), 2],
  [edit('.claude/settings.json'), 2], [write('.git/config'), 2], [edit(path.join(root, '..', 'other', 'a.md')), 2],
  [{ tool_name: 'Edit', tool_input: {} }, 2],
  // blocked: shell commands that write outside the repository
  [bash('curl -s -o /tmp/due0.html http://localhost:5227/'), 2], [bash('curl -sSo /tmp/a.html http://localhost:5227/'), 2],
  [bash('cd /tmp && curl -sO http://localhost:5227/a.html'), 2],[bash('dotnet run --project src/App > /tmp/app.log 2>&1 &'), 2],
  [bash('cp spec/a.md /tmp/spec-before.md'), 2], [bash('mkdir -p ../scratch'), 2], [bash('cd /tmp && echo x > a.txt'), 2],
  [bash('cd .. && dotnet new console -o scratch'), 2], [bash('S=$(mktemp -d) && cd $S && dotnet test'), 2],
  [bash('J=/tmp/cj.txt; curl -s -c $J http://localhost:5227/'), 2], [bash('echo x | tee ~/notes.txt'), 2],
  [bash('bash -c "echo x > /tmp/a"'), 2], [bash('git -C ../other commit -m x'), 2], [bash('git worktree add ../wt'), 2],
  [bash('dotnet build -o ../out'), 2], [bash('npm install -g some-tool'), 2], [bash('dotnet tool install --global dotnet-ef'), 2],
  [bash('echo x > "$LSDD_GUARD_TEST_UNSET/a.txt"'), 2], [bash("cat > /tmp/x <<'EOF'\nhello\nEOF"), 2],
  [bash('curl -s -o .claude/x http://localhost:5227/'), 2],
  [ps('Set-Content -Path C:\\temp\\a.txt -Value x'), 2], [ps('Invoke-WebRequest http://localhost:5227/ -OutFile $env:TEMP\\a.html'), 2],
  [ps('Start-Process dotnet -ArgumentList run -RedirectStandardOutput ..\\app.log'), 2], [ps('"x" | Out-File ..\\a.txt'), 2],
  [ps('Copy-Item spec\\a.md -Destination ..\\b.md'), 2], [{ ...bash('touch a.txt'), cwd: outside }, 2],
];

let failed = 0;
const run = (input, raw) => spawnSync(process.execPath, [guard], {
  input: raw ?? JSON.stringify({ cwd: root, ...input }), encoding: 'utf8',
  env: { ...process.env, CLAUDE_PROJECT_DIR: root, LSDD_GUARD_NO_LOG: '1' },
});
for (const [input, expect] of CASES) {
  const r = run(input);
  const ok = r.status === expect;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} exit=${r.status} expect=${expect} ${input.tool_name} ${JSON.stringify(input.tool_input)}${input.cwd ? ` cwd=${input.cwd}` : ''}`);
  if (!ok && r.stderr) console.log(`     ${r.stderr.trim()}`);
}
// A broken input must block, not pass (fail closed).
const broken = run({}, 'not json');
if (broken.status !== 2) failed++;
console.log(`${broken.status === 2 ? 'ok  ' : 'FAIL'} exit=${broken.status} expect=2 (broken input)`);

// Registration: a PreToolUse hook that runs guard.mjs and whose matcher covers every tool the guard judges.
try {
  const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const entries = (s.hooks && s.hooks.PreToolUse) || [];
  const hit = entries.find((e) => (e.hooks || []).some((h) => /guard\.mjs/.test(h.command || '')));
  const re = hit && new RegExp(`^(?:${hit.matcher})$`);
  const missing = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].filter((t) => !re || !re.test(t));
  if (!hit || missing.length) { failed++; console.log(`FAIL registration: ${hit ? 'matcher misses ' + missing.join(', ') : 'guard.mjs is not registered'}`); }
  else console.log(`ok   registration: PreToolUse matcher "${hit.matcher}"`);
} catch (err) { failed++; console.log(`FAIL registration: ${err.message}`); }

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
