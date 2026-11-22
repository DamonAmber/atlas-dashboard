import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL('./dashboard.html', import.meta.url);
writeFileSync(new URL('./dashboard.js', import.meta.url), '// 由 build-dashboard.mjs 从 dashboard.html 生成。\nexport const DASHBOARD = ' + JSON.stringify(readFileSync(source, 'utf8')) + ';\n');
