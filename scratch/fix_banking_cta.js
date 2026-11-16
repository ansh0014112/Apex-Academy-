const fs = require('fs');
let c = fs.readFileSync('courses.html', 'utf8');
const search = '<div class="flex items-center gap-2.5 w-full sm:w-auto">\r\n                  <button type="button" onclick="openSyllabusModal(\'Banking & Railway Exam Preparation';
const replace = '<div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">\r\n                  <button type="button" onclick="openSyllabusModal(\'Banking & Railway Exam Preparation';

if (!c.includes(search)) {
  // Try with \n
  const searchLF = search.replace(/\r\n/g, '\n');
  const replaceLF = replace.replace(/\r\n/g, '\n');
  if (c.includes(searchLF)) {
    c = c.replace(searchLF, replaceLF);
    console.log('Replaced LF search');
  } else {
    console.error('Neither CRLF nor LF matched');
    process.exit(1);
  }
} else {
  c = c.replace(search, replace);
  console.log('Replaced CRLF search');
}

const bSearch = 'class="px-4 py-2.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors hover-lift">';
const idx = c.indexOf('Banking & Railway Exam Preparation');
const bIdx = c.indexOf(bSearch, idx);
if (bIdx !== -1) {
  c = c.substring(0, bIdx) + 'class="w-full sm:w-auto px-4 py-2.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors hover-lift text-center">' + c.substring(bIdx + bSearch.length);
  console.log('Replaced button class');
}

fs.writeFileSync('courses.html', c, 'utf8');
console.log('Done.');
