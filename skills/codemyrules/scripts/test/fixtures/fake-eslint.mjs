import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), 'fake-argv.json'), JSON.stringify(files));
const out = files.map((f) => ({
  filePath: f,
  messages: [{ line: 2, severity: 2, ruleId: 'fake/rule', message: 'bad' }],
}));
process.stdout.write(JSON.stringify(out));
