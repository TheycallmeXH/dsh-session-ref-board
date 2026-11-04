const fs = require('fs');
const path = require('node:path').resolve(__dirname, '..', 'client.js');
const src = fs.readFileSync(path, 'utf8');
const need = [
  ["measured clamp", /useLayoutEffect\(\(\) => \{\s*if \(menu === null\) return;/],
  ["menu ref wired", /ref: menuRef/],
  ["hidden until placed", /visibility: menuBox\.ready \? 'visible' : 'hidden'/],
  ["opens reset the box", /const placeMenu = useCallback/],
  ["no item-count height guess", /\.\.\./],
];
let bad = 0;
for (const [name, re] of need.slice(0, 4)) {
  const ok = re.test(src);
  console.log((ok ? 'ok   ' : 'FAIL ') + name);
  if (!ok) bad++;
}
if (/window\.innerHeight - 40 - menuActions\.length \* 30/.test(src)) { console.log('FAIL old height guess still present'); bad++; } else console.log('ok   old height guess removed');
process.exitCode = bad ? 1 : 0;
