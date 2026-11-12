/**
 * APEX ACADEMY — Admission Enquiry Script
 * Handles dynamic exam dropdown population from canonical APEX_COURSES,
 * course category pill selection, query parameter parsing,
 * strict multi-field validation, loading state, and confirmation receipt.
 */

document.addEventListener('DOMContentLoaded', () => {
  initEnquiryForm();
});

let currentCourseId = 'civil-services-ssc';

function initEnquiryForm() {
  const form = document.getElementById('admission-enquiry-form');
  if (!form) return;

  // 1. Initial exam dropdown population
  populateTargetExams(currentCourseId);

  // 2. Setup Course Category Pills
  const coursePills = document.querySelectorAll('.course-pill');
  coursePills.forEach(pill => {
    pill.addEventListener('click', () => {
      const courseId = pill.getAttribute('data-course-id');
      const courseName = pill.getAttribute('data-value');
      selectCourseCategory(courseId, courseName);
    });
  });

  // 3. Setup Learning Mode Pills
  const modePills = document.querySelectorAll('.mode-pill');
  modePills.forEach(pill => {
    pill.addEventListener('click', () => {
      modePills.forEach(p => {
        p.classList.remove('bg-amber-600', 'text-white', 'border-amber-600');
        p.classList.add('bg-white', 'text-slate-700', 'border-slate-200');
      });
      pill.classList.remove('bg-white', 'text-slate-700', 'border-slate-200');
      pill.classList.add('bg-amber-600', 'text-white', 'border-amber-600');

      const modeInput = document.getElementById('selected-mode-input');
      if (modeInput) {
        modeInput.value = pill.getAttribute('data-value');
      }
      clearFieldError('selected-mode-input');
    });
  });

  // 4. Setup Batch Timing Pills
  const batchPills = document.querySelectorAll('.batch-pill');
  batchPills.forEach(pill => {
    pill.addEventListener('click', () => {
      batchPills.forEach(p => {
        p.classList.remove('bg-slate-900', 'text-white', 'border-slate-900');
        p.classList.add('bg-white', 'text-slate-700', 'border-slate-200');
      });
      pill.classList.remove('bg-white', 'text-slate-700', 'border-slate-200');
      pill.classList.add('bg-slate-900', 'text-white', 'border-slate-900');

      const batchInput = document.getElementById('selected-batch-input');
      if (batchInput) {
        batchInput.value = pill.getAttribute('data-value');
      }
      clearFieldError('selected-batch-input');
    });
  });

  // 5. Live input error removal
  ['student-name', 'mobile-number', 'email-address', 'educational-qualification', 'target-examination'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => clearFieldError(id));
      el.addEventListener('change', () => clearFieldError(id));
    }
  });

  // 6. Parse URL query params after event listeners are attached
  parseUrlQueryParams();

  // 7. Form submission handler
  form.addEventListener('submit', handleFormSubmit);
}

/**
 * Dynamically populate the target examination select dropdown
 * using centralized data from js/courses-data.js (APEX_COURSES)
 */
function populateTargetExams(courseId, preselectedExam = null) {
  const examSelect = document.getElementById('target-examination');
  if (!examSelect) return;

  const previousValue = examSelect.value;
  examSelect.innerHTML = '<option value="">-- Select Specific Examination --</option>';

  let exams = [];
  if (typeof getExamsByCourseId === 'function') {
    exams = getExamsByCourseId(courseId);
  } else if (typeof APEX_COURSES !== 'undefined') {
    const course = APEX_COURSES.find(c => c.id === courseId);
    if (course && course.examinationList) {
      exams = course.examinationList;
    }
  }

  // Fallbacks if data file not loaded
  if (!exams || exams.length === 0) {
    if (courseId === 'civil-services-ssc') {
      exams = [
        "UPSC Civil Services Examination (CSE)",
        "State Public Service Commission (State PCS)",
        "SSC CGL (Combined Graduate Level)",
        "SSC CHSL (Combined Higher Secondary)",
        "SSC GD (General Duty Constable)",
        "SSC MTS (Multi-Tasking Staff)",
        "State Subordinate & Administrative Exams"
      ];
    } else if (courseId === 'banking-railway') {
      exams = [
        "IBPS PO (Probationary Officer)",
        "IBPS Clerk (Clerical Cadre)",
        "SBI PO (State Bank of India)",
        "SBI Clerk (Junior Associate)",
        "RBI Assistant (Reserve Bank)",
        "RRB NTPC (Non-Technical Popular Categories)",
        "RRB Group D (Operations & Maintenance)",
        "RRB ALP (Assistant Loco Pilot)",
        "RRB Technician (Grade I & III)"
      ];
    } else {
      exams = [
        "All-Govt Exam Beginner Foundation (SSC, Bank & Railways)",
        "Undergraduate 1-Year Early Career Track",
        "Fundamental Quantitative & Reasoning Skill-Builder"
      ];
    }
  }

  let valueStillValid = false;
  exams.forEach(examName => {
    const option = document.createElement('option');
    option.value = examName;
    option.textContent = examName;
    if (preselectedExam && examName.toLowerCase().includes(preselectedExam.toLowerCase())) {
      option.selected = true;
      valueStillValid = true;
    } else if (previousValue && previousValue === examName) {
      option.selected = true;
      valueStillValid = true;
    }
    examSelect.appendChild(option);
  });

  // If user changed category and previous exam is not in new list, reset target exam
  if (!valueStillValid && !preselectedExam) {
    examSelect.value = '';
  }
}

/**
 * Handle Course Category Selection
 */
function selectCourseCategory(courseId, courseName) {
  currentCourseId = courseId;

  // Update pills UI
  const coursePills = document.querySelectorAll('.course-pill');
  coursePills.forEach(p => {
    if (p.getAttribute('data-course-id') === courseId) {
      p.classList.remove('bg-white', 'text-slate-700', 'border-slate-200');
      p.classList.add('bg-slate-900', 'text-white', 'border-slate-900');
    } else {
      p.classList.remove('bg-slate-900', 'text-white', 'border-slate-900');
      p.classList.add('bg-white', 'text-slate-700', 'border-slate-200');
    }
  });

  // Update hidden input
  const hiddenInput = document.getElementById('selected-course-input');
  if (hiddenInput) {
    hiddenInput.value = courseName;
    hiddenInput.setAttribute('data-course-id', courseId);
  }
  clearFieldError('selected-course-input');

  // Repopulate dynamic exams & reset incompatible selection
  populateTargetExams(courseId);
}

/**
 * Parse URL Query Parameters (?course=... & ?exam=...)
 */
function parseUrlQueryParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const courseParam = urlParams.get('course');
  const examParam = urlParams.get('exam');

  if (!courseParam) return;

  const param = courseParam.toLowerCase();
  let targetId = 'civil-services-ssc';
  let targetName = 'Civil Services & SSC Exam Preparation';

  if (param.includes('bank') || param.includes('railway') || param.includes('rrb') || param.includes('ibps') || param.includes('sbi')) {
    targetId = 'banking-railway';
    targetName = 'Banking & Railway Exam Preparation';
  } else if (param.includes('foundation') || param.includes('undergrad') || param.includes('beginner') || param.includes('college')) {
    targetId = 'foundation';
    targetName = 'APEX Foundation Program';
  } else if (param.includes('civil') || param.includes('ssc') || param.includes('upsc') || param.includes('cgl') || param.includes('chsl')) {
    targetId = 'civil-services-ssc';
    targetName = 'Civil Services & SSC Exam Preparation';
  }

  selectCourseCategory(targetId, targetName);

  if (examParam) {
    populateTargetExams(targetId, examParam);
  }
}

/**
 * Validate and submit the admission enquiry
 */
function handleFormSubmit(e) {
  e.preventDefault();

  let isValid = true;
  const name = document.getElementById('student-name')?.value.trim();
  const phone = document.getElementById('mobile-number')?.value.trim();
  const email = document.getElementById('email-address')?.value.trim();
  const qualification = document.getElementById('educational-qualification')?.value.trim();
  const courseCategory = document.getElementById('selected-course-input')?.value.trim();
  const targetExam = document.getElementById('target-examination')?.value.trim();
  const batch = document.getElementById('selected-batch-input')?.value.trim();
  const mode = document.getElementById('selected-mode-input')?.value.trim();
  const message = document.getElementById('enquiry-message')?.value.trim() || 'None provided';

  // 1. Validate Full Name
  if (!name || name.length < 3) {
    setFieldError('student-name', 'Please enter your full name (at least 3 letters)');
    isValid = false;
  }

  // 2. Validate Indian Mobile Phone Number
  const phoneDigits = phone ? phone.replace(/\D/g, '') : '';
  const phoneRegex = /^[6-9]\d{9}$/;
  if (!phoneDigits || !phoneRegex.test(phoneDigits)) {
    setFieldError('mobile-number', 'Please enter a valid 10-digit Indian mobile number');
    isValid = false;
  }

  // 3. Validate Email Address
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    setFieldError('email-address', 'Please enter a valid email address');
    isValid = false;
  }

  // 4. Validate Highest Educational Qualification
  if (!qualification) {
    setFieldError('educational-qualification', 'Please select your highest educational qualification');
    isValid = false;
  }

  // 5. Validate Course Category
  if (!courseCategory) {
    setFieldError('selected-course-input', 'Please select a course category');
    isValid = false;
  }

  // 6. Validate Target Examination
  if (!targetExam) {
    setFieldError('target-examination', 'Please select your target examination from the list');
    isValid = false;
  }

  // 7. Validate Preferred Batch
  if (!batch) {
    setFieldError('selected-batch-input', 'Please select your preferred batch timing');
    isValid = false;
  }

  // 8. Validate Learning Mode
  if (!mode) {
    setFieldError('selected-mode-input', 'Please select your preferred learning mode');
    isValid = false;
  }

  if (!isValid) return;

  // Show submitting loading state
  const submitBtn = document.getElementById('enquiry-submit-btn');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = `
    <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
    Registering Admission Enquiry...
  `;

  const formData = {
    fullName: name,
    phone: phoneDigits,
    email: email,
    qualification: qualification,
    courseCategory: courseCategory,
    targetExamination: targetExam,
    preferredBatch: batch,
    learningMode: mode,
    message: message
  };

  // Asynchronous submission via Supabase with strict error handling (No fake success)
  (async () => {
    // Remove previous error banner if any
    const existingError = document.getElementById('enquiry-error-banner');
    if (existingError) existingError.remove();

    try {
      if (typeof window.ApexSupabase === 'undefined') {
        throw new Error('Supabase client module failed to initialize. Please refresh.');
      }

      const res = await window.ApexSupabase.submitAdmissionEnquiry(formData);
      if (!res || !res.success || !res.enquiryId) {
        throw new Error(res?.message || 'Admission enquiry submission was not confirmed by the database.');
      }

      const token = res.enquiryId;
      const formCard = document.getElementById('enquiry-form-card');
      const confirmationCard = document.getElementById('enquiry-success-card');

      if (formCard && confirmationCard) {
        formCard.classList.add('hidden');
        confirmationCard.classList.remove('hidden');

        // Populate confirmation receipt values
        const nameEl = document.getElementById('confirm-name');
        if (nameEl) nameEl.textContent = name;
        
        const phoneEl = document.getElementById('confirm-phone');
        if (phoneEl) phoneEl.textContent = '+91 ' + phoneDigits;

        const courseEl = document.getElementById('confirm-course');
        if (courseEl) courseEl.textContent = courseCategory;

        const examEl = document.getElementById('confirm-exam');
        if (examEl) examEl.textContent = targetExam;

        const modeEl = document.getElementById('confirm-mode');
        if (modeEl) modeEl.textContent = mode;

        const batchEl = document.getElementById('confirm-batch');
        if (batchEl) batchEl.textContent = batch;

        const qualEl = document.getElementById('confirm-qual');
        if (qualEl) qualEl.textContent = qualification;

        const tokenEl = document.getElementById('confirm-token');
        if (tokenEl) tokenEl.textContent = token;

        // Trigger server-side notification pipeline via secure outbox pattern.
        // The submit_admission_enquiry RPC inserts an outbox record automatically.
        // We only signal the Edge Function with the outbox record ID (if provided).
        if (res.outboxId && typeof window.ApexSupabase?.processNotificationOutbox === 'function') {
          window.ApexSupabase.processNotificationOutbox(res.outboxId)
            .catch(notifErr => console.warn('Background notification scheduling error:', notifErr));
        }

        // WhatsApp direct follow-up link
        const waLink = document.getElementById('confirm-wa-btn');
        if (waLink) {
          const waText = encodeURIComponent(
            `Hello APEX ACADEMY, I have registered an admission enquiry on the portal (ID: ${token}).\n` +
            `• Candidate: ${name}\n` +
            `• Course: ${courseCategory}\n` +
            `• Target Exam: ${targetExam}\n` +
            `• Batch Timing: ${batch}\n` +
            `• Learning Mode: ${mode}`
          );
          waLink.href = `https://wa.me/919876543210?text=${waText}`;
        }

        confirmationCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    } catch (err) {
      console.error('Enquiry submission error:', err);
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;

      const errorBanner = document.createElement('div');
      errorBanner.id = 'enquiry-error-banner';
      errorBanner.className = 'mb-6 p-4 bg-red-50 border border-red-200 text-red-800 rounded-lg text-sm flex items-start space-x-3';
      errorBanner.innerHTML = `
        <svg class="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <div>
          <strong class="font-semibold block mb-1">Enquiry Registration Failed</strong>
          <span>${err.message || 'Unable to register enquiry. Please verify your details or ensure the database is connected.'}</span>
        </div>
      `;

      const formCard = document.getElementById('enquiry-form-card');
      if (formCard) {
        formCard.insertBefore(errorBanner, formCard.firstChild);
        errorBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  })();
}

function setFieldError(fieldId, errorMsg) {
  const input = document.getElementById(fieldId);
  const errEl = document.getElementById(`${fieldId}-error`);
  if (input) {
    input.classList.add('error', 'border-red-500');
  }
  if (errEl) {
    errEl.textContent = errorMsg;
    errEl.classList.remove('hidden');
  }
}

function clearFieldError(fieldId) {
  const input = document.getElementById(fieldId);
  const errEl = document.getElementById(`${fieldId}-error`);
  if (input) {
    input.classList.remove('error', 'border-red-500');
  }
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
}

window.resetEnquiryForm = function() {
  const formCard = document.getElementById('enquiry-form-card');
  const confirmationCard = document.getElementById('enquiry-success-card');
  const form = document.getElementById('admission-enquiry-form');

  if (formCard && confirmationCard && form) {
    form.reset();
    formCard.classList.remove('hidden');
    confirmationCard.classList.add('hidden');

    // Reset to default Category 1
    selectCourseCategory('civil-services-ssc', 'Civil Services & SSC Exam Preparation');

    formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};
