const fs = require('fs');
const path = require('path');

function replaceInFile(filePath, searchStr, replaceStr, desc) {
  const fullPath = path.resolve(__dirname, '..', filePath);
  let content = fs.readFileSync(fullPath, 'utf8');
  
  // Normalize search and content for line endings during search if needed
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const normalizedSearch = searchStr.replace(/\r\n/g, '\n');
  
  if (!normalizedContent.includes(normalizedSearch)) {
    console.error(`[FAIL] ${desc} in ${filePath}: search string not found.`);
    return false;
  }
  
  // Replace preserving existing file line ending style
  const isCRLF = content.includes('\r\n');
  const actualReplace = isCRLF ? replaceStr.replace(/\r?\n/g, '\r\n') : replaceStr.replace(/\r\n/g, '\n');
  const actualSearch = isCRLF ? searchStr.replace(/\r?\n/g, '\r\n') : searchStr.replace(/\r\n/g, '\n');
  
  content = content.replace(actualSearch, actualReplace);
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log(`[OK] ${desc} in ${filePath}`);
  return true;
}

let allOk = true;

// 1. courses.html - Top Bar
const coursesTopBarSearch = `  <div class="top-animated-boundary bg-slate-950 text-slate-300 text-xs py-2.5 px-4 border-b border-slate-800/80">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase">Scholarship Exam</span>
        <span>Apex National Aptitude Test (ANAT) • Up to 100% Tuition Waiver for Top 50 Aspirants (Demo Program)</span>
      </div>
      <div class="flex items-center gap-4 text-xs font-medium">
        <a href="enquiry.html" class="hover:text-amber-400 transition-colors">Apply for ANAT Scholarship</a>
        <span class="text-slate-700">|</span>
        <a href="tel:+911140928739" class="hover:text-amber-400 transition-colors">Helpline: +91 (011) 4982-APEX</a>
      </div>
    </div>
  </div>`;

const coursesTopBarReplace = `  <div class="top-animated-boundary bg-slate-950 text-slate-300 text-xs py-2.5 px-4 border-b border-slate-800/80">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
      <div class="flex items-center gap-2 text-center sm:text-left">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase shrink-0">Scholarship Exam</span>
        <span>Apex National Aptitude Test (ANAT) • Up to 100% Tuition Waiver for Top 50 Aspirants (Demo Program)</span>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs font-medium">
        <a href="enquiry.html" class="hover:text-amber-400 transition-colors hidden sm:inline">Apply for ANAT Scholarship</a>
        <span class="hidden sm:inline text-slate-700">|</span>
        <a href="tel:+911140928739" class="hover:text-amber-400 transition-colors flex items-center gap-1 shrink-0">
          <svg class="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
          Helpline: +91 (011) 4982-APEX
        </a>
      </div>
    </div>
  </div>`;
allOk = replaceInFile('courses.html', coursesTopBarSearch, coursesTopBarReplace, 'Top Bar') && allOk;

// 2. courses.html - Course Card CTA Row 1 (Civil Services)
const coursesCta1Search = `                <div class="flex items-center gap-2.5 w-full sm:w-auto">
                  <button type="button" onclick="openSyllabusModal('Civil Services & SSC Exam Preparation', '8 to 12 Months (650+ Hours)', ['Module 1: Number Systems, Quantitative & Advanced Mathematics', 'Module 2: Indian Polity, Constitution & Administrative Framework', 'Module 3: History, Geography & Economic Survey Analysis', 'Module 4: Advanced English Comprehension & Vocabulary Matrix', 'Module 5: Analytical Reasoning, Logic Puzzles & Data Sufficiency', 'Module 6: 120+ Mock CBTs, Descriptive Papers & Interview Guidance Board'])" class="px-4 py-2.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors hover-lift">
                    View Course Details
                  </button>
                  <a href="enquiry.html?course=civil-services-ssc" class="btn-primary-navy w-full sm:w-auto px-6 py-2.5 rounded-lg text-xs font-bold text-center hover-lift">
                    Enquire Now →
                  </a>
                </div>`;

const coursesCta1Replace = `                <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
                  <button type="button" onclick="openSyllabusModal('Civil Services & SSC Exam Preparation', '8 to 12 Months (650+ Hours)', ['Module 1: Number Systems, Quantitative & Advanced Mathematics', 'Module 2: Indian Polity, Constitution & Administrative Framework', 'Module 3: History, Geography & Economic Survey Analysis', 'Module 4: Advanced English Comprehension & Vocabulary Matrix', 'Module 5: Analytical Reasoning, Logic Puzzles & Data Sufficiency', 'Module 6: 120+ Mock CBTs, Descriptive Papers & Interview Guidance Board'])" class="w-full sm:w-auto px-4 py-2.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors hover-lift text-center">
                    View Course Details
                  </button>
                  <a href="enquiry.html?course=civil-services-ssc" class="btn-primary-navy w-full sm:w-auto px-6 py-2.5 rounded-lg text-xs font-bold text-center hover-lift">
                    Enquire Now →
                  </a>
                </div>`;
allOk = replaceInFile('courses.html', coursesCta1Search, coursesCta1Replace, 'Course Card CTA 1') && allOk;

// courses.html - Course Card CTA Row 2 (Banking)
const coursesCta2Search = `                <div class="flex items-center gap-2.5 w-full sm:w-auto">
                  <button type="button" onclick="openSyllabusModal('Banking & Railway Exam Preparation', '6 to 9 Months (520+ Hours)', ['Module 1: High-Speed Speed Math, Vedic Multiplication & Approximation', 'Module 2: Advanced Data Interpretation (Radar, Caselet, Missing DI)', 'Module 3: Critical Reasoning, Seating Arrangements & Complex Puzzles', 'Module 4: Banking Awareness, RBI Regulations, Financial Economy & Budget', 'Module 5: Error Detection, Cloze Tests & Reading Comprehension Matrix', 'Module 6: Daily Timed Sectional Drills & Exam Simulation Test Series'])" class="px-4 py-2.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors hover-lift">
                    View Course Details
                  </button>
                  <a href="enquiry.html?course=banking-railway" class="btn-primary-navy w-full sm:w-auto px-6 py-2.5 rounded-lg text-xs font-bold text-center hover-lift">
                    Enquire Now →
                  </a>
                </div>`;

const coursesCta2Replace = `                <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
                  <button type="button" onclick="openSyllabusModal('Banking & Railway Exam Preparation', '6 to 9 Months (520+ Hours)', ['Module 1: High-Speed Speed Math, Vedic Multiplication & Approximation', 'Module 2: Advanced Data Interpretation (Radar, Caselet, Missing DI)', 'Module 3: Critical Reasoning, Seating Arrangements & Complex Puzzles', 'Module 4: Banking Awareness, RBI Regulations, Financial Economy & Budget', 'Module 5: Error Detection, Cloze Tests & Reading Comprehension Matrix', 'Module 6: Daily Timed Sectional Drills & Exam Simulation Test Series'])" class="w-full sm:w-auto px-4 py-2.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors hover-lift text-center">
                    View Course Details
                  </button>
                  <a href="enquiry.html?course=banking-railway" class="btn-primary-navy w-full sm:w-auto px-6 py-2.5 rounded-lg text-xs font-bold text-center hover-lift">
                    Enquire Now →
                  </a>
                </div>`;
allOk = replaceInFile('courses.html', coursesCta2Search, coursesCta2Replace, 'Course Card CTA 2') && allOk;

// courses.html - Course Card CTA Row 3 (Foundation)
const coursesCta3Search = `                <div class="flex items-center gap-2.5 w-full sm:w-auto">
                  <button type="button" onclick="openSyllabusModal('APEX Foundation Program', '10 to 12 Months (480+ Hours)', ['Module 1: Vedic Arithmetic, Number Sense & Calculation Drills', 'Module 2: Fundamental Quantitative Concepts (Percentages, Ratios, Equations)', 'Module 3: Core Logical Deduction, Analytical Reasoning & Puzzles', 'Module 4: English Grammar Foundations, Vocabulary Matrix & Reading Habit', 'Module 5: General Awareness Orientation (History, Polity, Geography Fundamentals)', 'Module 6: Study Routine Design, Note-Making Architecture & Exam Mindset'])" class="px-4 py-2.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors hover-lift">
                    View Course Details
                  </button>
                  <a href="enquiry.html?course=foundation" class="btn-primary-navy w-full sm:w-auto px-6 py-2.5 rounded-lg text-xs font-bold text-center hover-lift">
                    Enquire Now →
                  </a>
                </div>`;

const coursesCta3Replace = `                <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
                  <button type="button" onclick="openSyllabusModal('APEX Foundation Program', '10 to 12 Months (480+ Hours)', ['Module 1: Vedic Arithmetic, Number Sense & Calculation Drills', 'Module 2: Fundamental Quantitative Concepts (Percentages, Ratios, Equations)', 'Module 3: Core Logical Deduction, Analytical Reasoning & Puzzles', 'Module 4: English Grammar Foundations, Vocabulary Matrix & Reading Habit', 'Module 5: General Awareness Orientation (History, Polity, Geography Fundamentals)', 'Module 6: Study Routine Design, Note-Making Architecture & Exam Mindset'])" class="w-full sm:w-auto px-4 py-2.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors hover-lift text-center">
                    View Course Details
                  </button>
                  <a href="enquiry.html?course=foundation" class="btn-primary-navy w-full sm:w-auto px-6 py-2.5 rounded-lg text-xs font-bold text-center hover-lift">
                    Enquire Now →
                  </a>
                </div>`;
allOk = replaceInFile('courses.html', coursesCta3Search, coursesCta3Replace, 'Course Card CTA 3') && allOk;

// courses.html - Modal padding
const modalSearch = `<div class="bg-white rounded-2xl max-w-xl w-full p-8 text-slate-900 space-y-5 relative shadow-2xl border border-slate-200">`;
const modalReplace = `<div class="bg-white rounded-2xl max-w-xl w-full p-5 sm:p-8 text-slate-900 space-y-5 relative shadow-2xl border border-slate-200">`;
allOk = replaceInFile('courses.html', modalSearch, modalReplace, 'Syllabus Modal Padding') && allOk;

// 3. success-stories.html - Top Bar
const successTopBarSearch = `  <div class="top-animated-boundary bg-slate-950 text-slate-300 text-xs py-2.5 px-4 border-b border-slate-800/80">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase">Alumni Network</span>
        <span>5,800+ Aspirants Trained • Strict Merit-Based Pedagogy • Verified Preparation Journeys</span>
      </div>
      <div class="flex items-center gap-4 text-xs font-medium">
        <span class="text-amber-400 font-mono">* Demo Fictional Cohort Showcase</span>
        <span class="text-slate-700">|</span>
        <a href="tel:+911140928739" class="hover:text-amber-400 transition-colors">Desk: +91 (011) 4982-APEX</a>
      </div>
    </div>
  </div>`;

const successTopBarReplace = `  <div class="top-animated-boundary bg-slate-950 text-slate-300 text-xs py-2.5 px-4 border-b border-slate-800/80">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
      <div class="flex items-center gap-2 text-center sm:text-left">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase shrink-0">Alumni Network</span>
        <span>5,800+ Aspirants Trained • Strict Merit-Based Pedagogy • Verified Preparation Journeys</span>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs font-medium">
        <span class="text-amber-400 font-mono hidden sm:inline">* Demo Fictional Cohort Showcase</span>
        <span class="text-slate-700 hidden sm:inline">|</span>
        <a href="tel:+911140928739" class="hover:text-amber-400 transition-colors flex items-center gap-1 shrink-0">
          <svg class="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
          Desk: +91 (011) 4982-APEX
        </a>
      </div>
    </div>
  </div>`;
allOk = replaceInFile('success-stories.html', successTopBarSearch, successTopBarReplace, 'Top Bar') && allOk;

// success-stories.html - Journey metric boxes
const metricSearch = `<div class="bg-slate-50 p-4 rounded-xl border border-slate-200 grid grid-cols-3 gap-2 text-center text-xs">`;
const metricReplace = `<div class="bg-slate-50 p-3 sm:p-4 rounded-xl border border-slate-200 grid grid-cols-3 gap-1 sm:gap-2 text-center text-[11px] sm:text-xs">`;
let sc = fs.readFileSync(path.resolve(__dirname, '..', 'success-stories.html'), 'utf8');
sc = sc.split(metricSearch).join(metricReplace);
// Also adjust uppercase label size
sc = sc.split('text-slate-400 block text-[10px] uppercase font-bold').join('text-slate-400 block text-[9px] sm:text-[10px] uppercase font-bold leading-tight');
fs.writeFileSync(path.resolve(__dirname, '..', 'success-stories.html'), sc, 'utf8');
console.log('[OK] Metrics boxes in success-stories.html');

// 4. book-counselling.html - Top Bar
const bookTopBarSearch = `  <div class="top-animated-boundary bg-slate-950 text-slate-300 text-xs py-2.5 px-4 border-b border-slate-800/80">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase">Zero Cost Guidance</span>
        <span>100% Free Strategic Counselling Session • No Sales Pressure • Objective Diagnostic Audit</span>
      </div>
      <div class="flex items-center gap-4 text-xs font-medium">
        <span class="text-amber-400 font-mono">* Demo Scheduling Simulation</span>
        <span class="text-slate-700">|</span>
        <a href="tel:+911140928739" class="hover:text-amber-400 transition-colors">Counselor Desk: +91 (011) 4982-APEX</a>
      </div>
    </div>
  </div>`;

const bookTopBarReplace = `  <div class="top-animated-boundary bg-slate-950 text-slate-300 text-xs py-2.5 px-4 border-b border-slate-800/80">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
      <div class="flex items-center gap-2 text-center sm:text-left">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase shrink-0">Zero Cost Guidance</span>
        <span>100% Free Strategic Counselling Session • No Sales Pressure • Objective Diagnostic Audit</span>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs font-medium">
        <span class="text-amber-400 font-mono hidden sm:inline">* Demo Scheduling Simulation</span>
        <span class="text-slate-700 hidden sm:inline">|</span>
        <a href="tel:+911140928739" class="hover:text-amber-400 transition-colors flex items-center gap-1 shrink-0">
          <svg class="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
          Counselor Desk: +91 (011) 4982-APEX
        </a>
      </div>
    </div>
  </div>`;
allOk = replaceInFile('book-counselling.html', bookTopBarSearch, bookTopBarReplace, 'Top Bar') && allOk;

// book-counselling.html - Form wrapper padding
const bookWrapperSearch = `<div id="booking-form-wrapper" class="bg-white rounded-2xl p-8 sm:p-10 border border-slate-200 shadow-xl space-y-8">`;
const bookWrapperReplace = `<div id="booking-form-wrapper" class="bg-white rounded-2xl p-4 sm:p-8 md:p-10 border border-slate-200 shadow-xl space-y-6 sm:space-y-8">`;
allOk = replaceInFile('book-counselling.html', bookWrapperSearch, bookWrapperReplace, 'Form Wrapper Padding') && allOk;

const bookSuccessSearch = `<div id="booking-success-wrapper" class="hidden bg-white rounded-2xl p-8 sm:p-10 border-2 border-amber-500 shadow-2xl space-y-6">`;
const bookSuccessReplace = `<div id="booking-success-wrapper" class="hidden bg-white rounded-2xl p-4 sm:p-8 md:p-10 border-2 border-amber-500 shadow-2xl space-y-6">`;
allOk = replaceInFile('book-counselling.html', bookSuccessSearch, bookSuccessReplace, 'Success Pass Padding') && allOk;

// 5. enquiry.html - Top Bar
const enqTopBarSearch = `  <div class="top-animated-boundary bg-slate-950 text-slate-300 text-xs py-2.5 px-4 border-b border-slate-800/80">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase">Admissions Desk</span>
        <span>Admissions Open for Upcoming Cohorts • Seat Confirmation on Merit Basis</span>
      </div>
      <div class="flex items-center gap-4 text-xs font-medium">
        <a href="tel:+911140928739" class="hover:text-amber-400 transition-colors">Direct Desk: +91 (011) 4982-APEX</a>
        <span class="text-slate-700">|</span>
        <span class="text-amber-400 font-mono">Walk-in: 07:30 AM - 08:30 PM</span>
      </div>
    </div>
  </div>`;

const enqTopBarReplace = `  <div class="top-animated-boundary bg-slate-950 text-slate-300 text-xs py-2.5 px-4 border-b border-slate-800/80">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
      <div class="flex items-center gap-2 text-center sm:text-left">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase shrink-0">Admissions Desk</span>
        <span>Admissions Open for Upcoming Cohorts • Seat Confirmation on Merit Basis</span>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs font-medium">
        <a href="tel:+911140928739" class="hover:text-amber-400 transition-colors flex items-center gap-1 shrink-0">
          <svg class="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
          Direct Desk: +91 (011) 4982-APEX
        </a>
        <span class="hidden sm:inline text-slate-700">|</span>
        <span class="text-amber-400 font-mono hidden sm:inline">Walk-in: 07:30 AM - 08:30 PM</span>
      </div>
    </div>
  </div>`;
allOk = replaceInFile('enquiry.html', enqTopBarSearch, enqTopBarReplace, 'Top Bar') && allOk;

// enquiry.html - Form card padding
const enqCardSearch = `<div id="enquiry-form-card" class="bg-white rounded-2xl p-8 sm:p-10 border border-slate-200 shadow-xl space-y-8">`;
const enqCardReplace = `<div id="enquiry-form-card" class="bg-white rounded-2xl p-4 sm:p-8 md:p-10 border border-slate-200 shadow-xl space-y-6 sm:space-y-8">`;
allOk = replaceInFile('enquiry.html', enqCardSearch, enqCardReplace, 'Form Card Padding') && allOk;

const enqSuccessSearch = `<div id="enquiry-success-card" class="hidden bg-white rounded-2xl p-8 sm:p-10 border-2 border-emerald-500 shadow-2xl space-y-6">`;
const enqSuccessReplace = `<div id="enquiry-success-card" class="hidden bg-white rounded-2xl p-4 sm:p-8 md:p-10 border-2 border-emerald-500 shadow-2xl space-y-6">`;
allOk = replaceInFile('enquiry.html', enqSuccessSearch, enqSuccessReplace, 'Success Card Padding') && allOk;

// 6. admin/js/admin.js - Tour popover bounds
const tourJsSearch = `      // Position popover
      const popoverWidth = 360;
      let left = rect.left + (rect.width / 2) - (popoverWidth / 2);
      if (left < 16) left = 16;
      if (left + popoverWidth > window.innerWidth - 16) left = window.innerWidth - popoverWidth - 16;`;

const tourJsReplace = `      // Position popover
      const popoverWidth = Math.min(360, window.innerWidth - 32);
      let left = rect.left + (rect.width / 2) - (popoverWidth / 2);
      if (left < 16) left = 16;
      if (left + popoverWidth > window.innerWidth - 16) {
        left = Math.max(16, window.innerWidth - popoverWidth - 16);
      }`;
allOk = replaceInFile('admin/js/admin.js', tourJsSearch, tourJsReplace, 'Tour Popover Bounds') && allOk;

console.log('Script execution finished. All OK:', allOk);
