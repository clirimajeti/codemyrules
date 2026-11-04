import path from 'node:path';
const files = process.argv.slice(2);
console.log(JSON.stringify(files.map((f) => ({
  filePath: path.resolve(f),
  messages: [{ line: 2, ruleId: 'fake/rule', message: 'fake error', severity: 2 }],
}))));
