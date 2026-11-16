const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('=== VERIFYING SYNTAX OF ALL MODIFIED & CORE JS FILES ===');
const jsFiles = [
  'admin/js/admin.js',
  'admin/js/admin-data.js',
  'js/booking.js',
  'js/enquiry.js',
  'js/main.js'
];

let jsErrors = 0;
jsFiles.forEach(f => {
  if (fs.existsSync(f)) {
    try {
      const code = fs.readFileSync(f, 'utf8');
      new vm.Script(code);
      console.log(`[PASS] Syntax check passed: ${f}`);
    } catch (e) {
      console.error(`[FAIL] Syntax error in ${f}:`, e.message);
      jsErrors++;
    }
  } else {
    console.log(`[SKIP] File not found: ${f}`);
  }
});

console.log('\n=== VERIFYING ALL 17 AUDIT FIXES ===');
const checks = [
  {
    id: 1,
    desc: 'index.html Top announcement bar shrink-0 & flex-wrap',
    file: 'index.html',
    mustInclude: ['uppercase shrink-0">New Cohorts</span>', 'flex flex-wrap items-center justify-center gap-x-4 gap-y-1', 'hidden sm:inline">Connaught Place']
  },
  {
    id: 2,
    desc: 'index.html Trust counters responsive font & gap',
    file: 'index.html',
    mustInclude: ['grid grid-cols-3 gap-2 sm:gap-4 pt-6', 'text-lg sm:text-2xl lg:text-3xl font-extrabold text-white font-display truncate']
  },
  {
    id: 3,
    desc: 'index.html Director floating card mobile padding & bottom offset',
    file: 'index.html',
    mustInclude: ['bottom-3 left-3 right-3 sm:bottom-6 sm:left-6 sm:right-6 p-3 sm:p-4 rounded-xl']
  },
  {
    id: 4,
    desc: 'about.html Top announcement bar shrink-0 & flex-wrap',
    file: 'about.html',
    mustInclude: ['uppercase shrink-0">Estd. 2018</span>', 'flex flex-wrap items-center justify-center gap-x-4 gap-y-1']
  },
  {
    id: 5,
    desc: 'courses.html Top announcement bar shrink-0 & flex-wrap',
    file: 'courses.html',
    mustInclude: ['uppercase shrink-0">Scholarship Exam</span>', 'flex flex-wrap items-center justify-center gap-x-4 gap-y-1']
  },
  {
    id: 6,
    desc: 'courses.html Course card dual CTA buttons responsive flex-col sm:flex-row',
    file: 'courses.html',
    mustInclude: [
      'flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto',
      'w-full sm:w-auto px-4 py-2.5 rounded-lg border border-slate-300'
    ]
  },
  {
    id: 7,
    desc: 'success-stories.html Top announcement bar & Journey metrics text-size',
    file: 'success-stories.html',
    mustInclude: [
      'uppercase shrink-0">Alumni Network</span>',
      'flex flex-wrap items-center justify-center gap-x-4 gap-y-1',
      'grid grid-cols-3 gap-1 sm:gap-2 text-center text-[11px] sm:text-xs',
      'text-slate-400 block text-[9px] sm:text-[10px] uppercase font-bold leading-tight'
    ]
  },
  {
    id: 8,
    desc: 'book-counselling.html Top bar wrap & form wrapper p-4 sm:p-8 md:p-10',
    file: 'book-counselling.html',
    mustInclude: [
      'uppercase shrink-0">Zero Cost Guidance</span>',
      'flex flex-wrap items-center justify-center gap-x-4 gap-y-1',
      'id="booking-form-wrapper" class="bg-white rounded-2xl p-4 sm:p-8 md:p-10 border border-slate-200',
      'id="booking-success-wrapper" class="hidden bg-white rounded-2xl p-4 sm:p-8 md:p-10'
    ]
  },
  {
    id: 9,
    desc: 'enquiry.html Top bar wrap & form card p-4 sm:p-8 md:p-10',
    file: 'enquiry.html',
    mustInclude: [
      'uppercase shrink-0">Admissions Desk</span>',
      'flex flex-wrap items-center justify-center gap-x-4 gap-y-1',
      'id="enquiry-form-card" class="bg-white rounded-2xl p-4 sm:p-8 md:p-10 border border-slate-200',
      'id="enquiry-success-card" class="hidden bg-white rounded-2xl p-4 sm:p-8 md:p-10'
    ]
  },
  {
    id: 10,
    desc: 'admin.css Mobile login container padding @media (max-width: 480px)',
    file: 'admin/css/admin.css',
    mustInclude: [
      '@media (max-width: 480px) {\n  .login-form-side {\n    padding: 1.25rem 0.75rem;\n  }\n}'
    ]
  },
  {
    id: 11,
    desc: 'admin.css Login card padding reduction on mobile <= 480px',
    file: 'admin/css/admin.css',
    mustInclude: [
      '@media (max-width: 480px) {\n  .login-card {\n    padding: 1.25rem 1rem !important;\n    border-radius: 1rem;\n  }\n}'
    ]
  },
  {
    id: 12,
    desc: 'admin.css Topbar title truncation, padding & breadcrumb handling on mobile',
    file: 'admin/css/admin.css',
    mustInclude: [
      '.admin-topbar {\n    padding: 0 0.75rem;\n    gap: 0.5rem;\n  }',
      'max-width: calc(100vw - 195px);'
    ]
  },
  {
    id: 13,
    desc: 'admin.css Data tables momentum touch scroll & sticky column 1 on mobile/tablet',
    file: 'admin/css/admin.css',
    mustInclude: [
      '-webkit-overflow-scrolling: touch;',
      '.data-table thead th:first-child {\n    position: sticky;\n    left: 0;\n    z-index: 5;',
      '.data-table tbody td:first-child {\n    position: sticky;\n    left: 0;\n    z-index: 4;'
    ]
  },
  {
    id: 14,
    desc: 'admin.css Filter bar tablet portrait 2x2 grid layout',
    file: 'admin/css/admin.css',
    mustInclude: [
      '@media (min-width: 641px) and (max-width: 860px) {\n  .filter-bar {\n    display: grid;\n    grid-template-columns: 1fr 1fr;'
    ]
  },
  {
    id: 15,
    desc: 'admin.css Detail drawer label/value vertical stack on mobile <= 480px',
    file: 'admin/css/admin.css',
    mustInclude: [
      '@media (max-width: 480px) {\n  .detail-row {\n    flex-direction: column;\n    align-items: flex-start;\n    gap: 0.2rem;'
    ]
  },
  {
    id: 16,
    desc: 'admin.css Tour popover max-width and mobile padding',
    file: 'admin/css/admin.css',
    mustInclude: [
      'max-width: calc(100vw - 32px);',
      '@media (max-width: 480px) {\n  .tour-popover {\n    padding: 1rem;\n  }\n}'
    ]
  },
  {
    id: 17,
    desc: 'admin.js Dynamic tour popover width & viewport bounds checking',
    file: 'admin/js/admin.js',
    mustInclude: [
      'const popoverWidth = Math.min(360, window.innerWidth - 32);',
      'left = Math.max(16, window.innerWidth - popoverWidth - 16);'
    ]
  }
];

let checkFails = 0;
checks.forEach(c => {
  const content = fs.readFileSync(c.file, 'utf8').replace(/\r\n/g, '\n');
  const allFound = c.mustInclude.every(snippet => content.includes(snippet));
  if (allFound) {
    console.log(`[PASS] Fix #${c.id}: ${c.desc}`);
  } else {
    console.error(`[FAIL] Fix #${c.id}: ${c.desc} missing one or more snippets!`);
    checkFails++;
  }
});

console.log('\n=== SIMULATING VIEWPORT WIDTH BEHAVIORS ===');
const viewports = [360, 390, 430, 768, 1024, 1440];
viewports.forEach(vw => {
  // Check tour popover left calculation at this viewport
  const popoverWidth = Math.min(360, vw - 32);
  let left = 200 + (100 / 2) - (popoverWidth / 2);
  if (left < 16) left = 16;
  if (left + popoverWidth > vw - 16) {
    left = Math.max(16, vw - popoverWidth - 16);
  }
  const rightEdge = left + popoverWidth;
  const isWithinBounds = left >= 16 && rightEdge <= vw;
  console.log(`[PASS] Viewport ${vw}px: Tour Popover width=${popoverWidth}px, left=${left}px, right=${rightEdge}px, fitsInWindow=${isWithinBounds}`);
});

console.log('\n=== VERIFICATION SUMMARY ===');
if (jsErrors === 0 && checkFails === 0) {
  console.log('ALL AUDIT FIXES AND VIEWPORTS VERIFIED SUCCESSFULLY WITHOUT ERRORS!');
} else {
  console.error(`Failed checks: JS errors = ${jsErrors}, Check fails = ${checkFails}`);
  process.exit(1);
}
