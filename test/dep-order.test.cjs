// Static TDZ check: a hook dependency array must not name a binding declared later in the component.
const fs = require('node:fs');

const source = fs.readFileSync(require('node:path').resolve(__dirname, '..', 'client.js'), 'utf8');
const lines = source.split('\n');

const start = lines.findIndex((line) => /function RefBoard\(/.test(line));
const end = lines.findIndex((line, index) => index > start && /^      \/\* -+ render -+ \*\/|^    \/\*\* Keep a board failure/.test(line));
const body = lines.slice(start, end > 0 ? end : lines.length);

const declared = new Map();
const patterns = [
  /^\s*const\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*let\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*const\s+\{([^}]*)\}\s*=/,
  /^\s*const\s+\[([^\]]*)\]\s*=/,
];
body.forEach((line, index) => {
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match) continue;
    for (const raw of match[1].split(',')) {
      const name = raw.split(':').pop().trim().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && !declared.has(name)) declared.set(name, index);
    }
  }
});

const problems = [];
body.forEach((line, index) => {
  let cursor = 0;
  while (true) {
    const at = line.indexOf('}, [', cursor);
    const at2 = line.indexOf(']), [', cursor);
    const positions = [at, at2].filter((value) => value >= 0);
    if (positions.length === 0) break;
    const from = Math.min(...positions);
    const open = line.indexOf('[', from + 2);
    let close = -1;
    for (let scan = open; scan < line.length; scan += 1) if (line[scan] === ']') { close = scan; break; }
    if (close > open) {
      const deps = line.slice(open + 1, close).split(',').map((entry) => entry.trim()).filter(Boolean);
      for (const dep of deps) {
        if (!/^[A-Za-z_$][\w$]*$/.test(dep)) continue;
        const declaredAt = declared.get(dep);
        if (declaredAt !== undefined && declaredAt > index) {
          problems.push(`line ${start + index + 1}: dependency "${dep}" is declared later (line ${start + declaredAt + 1})`);
        }
      }
    }
    cursor = from + 1;
  }
});

// Multi-line dependency arrays: a lone "]," line followed by a list, closed by "],".
body.forEach((line, index) => {
  if (!/^\s*\], \[$/.test(line) && !/^\s*\},\s*\[$/.test(line)) return;
  const names = [];
  for (let scan = index + 1; scan < body.length; scan += 1) {
    const text = body[scan].trim();
    if (text.startsWith(']')) break;
    for (const entry of text.split(',')) {
      const name = entry.trim().replace(/,$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  for (const dep of names) {
    const declaredAt = declared.get(dep);
    if (declaredAt !== undefined && declaredAt > index) {
      problems.push(`line ${start + index + 1}: dependency "${dep}" is declared later (line ${start + declaredAt + 1})`);
    }
  }
});

const unique = [...new Set(problems)];
if (unique.length === 0) console.log('no dependency-order problems');
else {
  console.log(`${unique.length} dependency-order problem(s):`);
  for (const entry of unique) console.log(`  ${entry}`);
}
