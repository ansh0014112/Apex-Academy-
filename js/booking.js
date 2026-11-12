/**
 * APEX ACADEMY — Counselling Call Booking Script
 * Interactive date picker, slot selector, dynamic category & exam dropdown,
 * query parameter parsing, full form validation, and appointment request pass generator.
 */

document.addEventListener('DOMContentLoaded', () => {
  initBookingSystem();
});

function initBookingSystem() {
  generateDateCards();
  initSlotSelection();
  initCourseAndExamSelectors();
  initBookingForm();
  parseBookingQueryParams();
}

/**
 * Generate Next 7 Days for quick selection
 */
function generateDateCards() {
  const container = document.getElementById('date-picker-container');
  if (!container) return;

  container.innerHTML = '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const today = new Date();

  // Next 7 days
  for (let i = 1; i <= 7; i++) {
    const nextDate = new Date();
    nextDate.setDate(today.getDate() + i);

    const dayName = days[nextDate.getDay()];
    const dateNum = nextDate.getDate();
    const monthName = months[nextDate.getMonth()];
    const fullDateStr = `${dayName}, ${dateNum} ${monthName} ${nextDate.getFullYear()}`;

    const dateCard = document.createElement('button');
    dateCard.type = 'button';
    dateCard.className = `date-card p-3 rounded-xl border text-center transition-all flex flex-col items-center justify-center min-w-[70px] ${
      i === 1 
        ? 'bg-slate-900 text-white border-slate-900 shadow-sm' 
        : 'bg-white text-slate-800 border-slate-200 hover:border-slate-400'
    }`;
    // Store both display format and ISO format (YYYY-MM-DD for Supabase RPC)
    const isoDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
    dateCard.setAttribute('data-date', fullDateStr);
    dateCard.setAttribute('data-date-iso', isoDateStr);

    dateCard.innerHTML = `
      <span class="text-xs uppercase font-medium tracking-wider ${i === 1 ? 'text-amber-400' : 'text-slate-400'}">${dayName}</span>
      <span class="text-lg font-bold my-0.5">${dateNum}</span>
      <span class="text-[11px] ${i === 1 ? 'text-slate-300' : 'text-slate-500'}">${monthName}</span>
    `;

    dateCard.addEventListener('click', () => {
      document.querySelectorAll('.date-card').forEach(c => {
        c.classList.remove('bg-slate-900', 'text-white', 'border-slate-900', 'shadow-sm');
        c.classList.add('bg-white', 'text-slate-800', 'border-slate-200');
        const daySpan = c.querySelector('span:first-child');
        const monthSpan = c.querySelector('span:last-child');
        if (daySpan) {
          daySpan.classList.remove('text-amber-400');
          daySpan.classList.add('text-slate-400');
        }
        if (monthSpan) {
          monthSpan.classList.remove('text-slate-300');
          monthSpan.classList.add('text-slate-500');
        }
      });

      dateCard.classList.remove('bg-white', 'text-slate-800', 'border-slate-200');
      dateCard.classList.add('bg-slate-900', 'text-white', 'border-slate-900', 'shadow-sm');
      const daySpan = dateCard.querySelector('span:first-child');
      const monthSpan = dateCard.querySelector('span:last-child');
      if (daySpan) {
        daySpan.classList.remove('text-slate-400');
        daySpan.classList.add('text-amber-400');
      }
      if (monthSpan) {
        monthSpan.classList.remove('text-slate-500');
        monthSpan.classList.add('text-slate-300');
      }

      const dateInput = document.getElementById('selected-date-input');
      if (dateInput) {
        dateInput.value = fullDateStr;
        dateInput.setAttribute('data-iso', isoDateStr);
      }
      clearBookingError('selected-date-input');
      // Load dynamic slots for the selected date if Supabase is live
      loadDynamicSlotsForDate(isoDateStr);
    });

    // Set first day as default
    if (i === 1) {
      const dateInput = document.getElementById('selected-date-input');
      if (dateInput) {
        dateInput.value = fullDateStr;
        dateInput.setAttribute('data-iso', isoDateStr);
      }
      // Load dynamic slots for the first (default) date
      loadDynamicSlotsForDate(isoDateStr);
    }

    container.appendChild(dateCard);
  }
}

/**
 * Slot click listener
 */
function initSlotSelection() {
  const slotButtons = document.querySelectorAll('.time-slot-btn');
  slotButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      slotButtons.forEach(b => {
        b.classList.remove('bg-amber-600', 'text-white', 'border-amber-600', 'ring-2', 'ring-amber-200');
        b.classList.add('bg-white', 'text-slate-700', 'border-slate-200');
      });

      btn.classList.remove('bg-white', 'text-slate-700', 'border-slate-200');
      btn.classList.add('bg-amber-600', 'text-white', 'border-amber-600', 'ring-2', 'ring-amber-200');

      const slotInput = document.getElementById('selected-slot-input');
      if (slotInput) {
        slotInput.value = btn.getAttribute('data-slot');
      }
      clearBookingError('selected-slot-input');
    });
  });

  // Select first slot by default if available
  if (slotButtons.length > 0) {
    const firstSlot = slotButtons[0];
    firstSlot.classList.remove('bg-white', 'text-slate-700', 'border-slate-200');
    firstSlot.classList.add('bg-amber-600', 'text-white', 'border-amber-600', 'ring-2', 'ring-amber-200');
    const slotInput = document.getElementById('selected-slot-input');
    if (slotInput) slotInput.value = firstSlot.getAttribute('data-slot');
  }
}

/**
 * Course Category and Target Exam dynamic synchronization
 */
function initCourseAndExamSelectors() {
  const categorySelect = document.getElementById('booking-course-category');
  const examSelect = document.getElementById('booking-exam');

  if (!categorySelect || !examSelect) return;

  categorySelect.addEventListener('change', () => {
    const selectedCategory = categorySelect.value;
    clearBookingError('booking-course-category');
    populateBookingExams(selectedCategory);
    clearBookingError('booking-exam');
  });

  examSelect.addEventListener('change', () => {
    clearBookingError('booking-exam');
  });

  // Live input error removal for personal details
  ['booking-name', 'booking-phone', 'booking-email'].forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', () => clearBookingError(id));
      input.addEventListener('change', () => clearBookingError(id));
    }
  });
}

/**
 * Populate exams into booking-exam select based on courseId
 */
function populateBookingExams(courseId, preselectedExam = null) {
  const examSelect = document.getElementById('booking-exam');
  if (!examSelect) return;

  examSelect.innerHTML = '';

  if (!courseId) {
    examSelect.innerHTML = '<option value="">-- First Select Course Category --</option>';
    return;
  }

  let exams = [];
  if (typeof getExamsByCourseId === 'function') {
    exams = getExamsByCourseId(courseId);
  } else if (typeof APEX_COURSES !== 'undefined') {
    const course = APEX_COURSES.find(c => c.id === courseId);
    if (course && course.examinationList) {
      exams = course.examinationList;
    }
  }

  // Fallbacks if data file not present
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

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = '-- Select Specific Examination --';
  examSelect.appendChild(defaultOption);

  exams.forEach(examName => {
    const opt = document.createElement('option');
    opt.value = examName;
    opt.textContent = examName;
    if (preselectedExam && examName.toLowerCase().includes(preselectedExam.toLowerCase())) {
      opt.selected = true;
    }
    examSelect.appendChild(opt);
  });
}

/**
 * Parse URL Query Params (?course=... & ?exam=...)
 */
function parseBookingQueryParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const courseParam = urlParams.get('course');
  const examParam = urlParams.get('exam');

  if (!courseParam) return;

  const categorySelect = document.getElementById('booking-course-category');
  if (!categorySelect) return;

  const param = courseParam.toLowerCase();
  let targetId = 'civil-services-ssc';

  if (param.includes('bank') || param.includes('railway') || param.includes('rrb') || param.includes('ibps') || param.includes('sbi')) {
    targetId = 'banking-railway';
  } else if (param.includes('foundation') || param.includes('undergrad') || param.includes('beginner') || param.includes('college')) {
    targetId = 'foundation';
  } else if (param.includes('civil') || param.includes('ssc') || param.includes('upsc') || param.includes('cgl') || param.includes('chsl')) {
    targetId = 'civil-services-ssc';
  }

  categorySelect.value = targetId;
  populateBookingExams(targetId, examParam);
}

/**
 * Booking form submission and validation
 */
function initBookingForm() {
  const form = document.getElementById('counselling-booking-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    let isValid = true;
    const name = document.getElementById('booking-name')?.value.trim();
    const phone = document.getElementById('booking-phone')?.value.trim();
    const email = document.getElementById('booking-email')?.value.trim();
    const categorySelect = document.getElementById('booking-course-category');
    const categoryId = categorySelect?.value.trim();
    const categoryName = categorySelect?.options[categorySelect.selectedIndex]?.text || '';
    const exam = document.getElementById('booking-exam')?.value.trim();
    const date = document.getElementById('selected-date-input')?.value.trim();
    const slot = document.getElementById('selected-slot-input')?.value.trim();
    const medium = document.getElementById('counselling-mode')?.value.trim();

    // 1. Validate Name
    if (!name || name.length < 3) {
      setBookingError('booking-name', 'Please enter your full name (at least 3 letters)');
      isValid = false;
    }

    // 2. Validate Phone
    const phoneDigits = phone ? phone.replace(/\D/g, '') : '';
    const phoneRegex = /^[6-9]\d{9}$/;
    if (!phoneDigits || !phoneRegex.test(phoneDigits)) {
      setBookingError('booking-phone', 'Please enter a valid 10-digit Indian phone number');
      isValid = false;
    }

    // 3. Validate Email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      setBookingError('booking-email', 'Please provide a valid email address');
      isValid = false;
    }

    // 4. Validate Course Category
    if (!categoryId) {
      setBookingError('booking-course-category', 'Please select a course category');
      isValid = false;
    }

    // 5. Validate Target Exam
    if (!exam) {
      setBookingError('booking-exam', 'Please select your target examination');
      isValid = false;
    }

    // 6. Validate Date & Slot
    if (!date) {
      setBookingError('selected-date-input', 'Please choose a session date');
      isValid = false;
    }
    if (!slot) {
      setBookingError('selected-slot-input', 'Please select a preferred time slot');
      isValid = false;
    }

    if (!isValid) return;

    // Show loading state
    const submitBtn = document.getElementById('booking-submit-btn');
    const originalContent = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
      <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      Submitting Booking Request...
    `;

    // Get ISO date (YYYY-MM-DD) for Supabase RPC — the displayed date is human-readable
    const dateInputEl = document.getElementById('selected-date-input');
    const isoDate = dateInputEl?.getAttribute('data-iso') || convertDisplayDateToISO(date);

    const formData = {
      fullName: name,
      phone: phoneDigits,
      email: email,
      courseCategory: categoryName || 'Civil Services & SSC Exam Preparation',
      targetExamination: exam,
      preferredDate: isoDate,  // ISO format required by Supabase DATE column
      preferredTime: slot,
      sessionMedium: medium || 'Google Meet HD Video Call'
    };

    (async () => {
    const existingError = document.getElementById('booking-error-banner');
    if (existingError) existingError.remove();

    try {
      if (typeof window.ApexSupabase === 'undefined') {
        throw new Error('Supabase client module failed to initialize. Please refresh.');
      }

      const res = await window.ApexSupabase.submitCounsellingBooking(formData);
      if (!res || !res.success || !res.bookingId) {
        throw new Error(res?.message || 'Counselling booking was not confirmed by the database.');
      }

      const passId = res.bookingId;
      const formSection = document.getElementById('booking-form-wrapper');
      const confirmationSection = document.getElementById('booking-success-wrapper');

      if (formSection && confirmationSection) {
        formSection.classList.add('hidden');
        confirmationSection.classList.remove('hidden');

        const passIdEl = document.getElementById('pass-id');
        if (passIdEl) passIdEl.textContent = passId;

        // Trigger server-side notification pipeline via secure outbox pattern.
        // The submit_counselling_booking RPC creates an outbox entry automatically.
        // We only need to signal the Edge Function with the outbox record ID (if provided).
        if (res.outboxId && typeof window.ApexSupabase?.processNotificationOutbox === 'function') {
          window.ApexSupabase.processNotificationOutbox(res.outboxId)
            .catch(notifErr => console.warn('Background notification scheduling error:', notifErr));
        }

        const passNameEl = document.getElementById('pass-name');
        if (passNameEl) passNameEl.textContent = name;

        const passCatEl = document.getElementById('pass-category');
        if (passCatEl) passCatEl.textContent = categoryName;

        const passExamEl = document.getElementById('pass-exam');
        if (passExamEl) passExamEl.textContent = exam;

        const passDateEl = document.getElementById('pass-date');
        if (passDateEl) passDateEl.textContent = date;

        const passTimeEl = document.getElementById('pass-time');
        if (passTimeEl) passTimeEl.textContent = slot;

        const passModeEl = document.getElementById('pass-mode');
        if (passModeEl) passModeEl.textContent = medium || 'Google Meet / Telephonic Video';

        confirmationSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      submitBtn.disabled = false;
      submitBtn.innerHTML = originalContent;
    } catch (err) {
      console.error('Booking submission error:', err);
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalContent;

      const errorBanner = document.createElement('div');
      errorBanner.id = 'booking-error-banner';
      errorBanner.className = 'mb-6 p-4 bg-red-50 border border-red-200 text-red-800 rounded-lg text-sm flex items-start space-x-3';
      errorBanner.innerHTML = `
        <svg class="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <div>
          <strong class="font-semibold block mb-1">Appointment Request Failed</strong>
          <span>${err.message || 'Unable to schedule counselling session. Please verify your details or check database connection.'}</span>
        </div>
      `;

      const formSection = document.getElementById('booking-form-wrapper');
      if (formSection) {
        formSection.insertBefore(errorBanner, formSection.firstChild);
        errorBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  })();
  });
}


/**
 * Convert display date string "Mon, 12 Nov 2026" to ISO "2026-11-12"
 */
function convertDisplayDateToISO(displayDate) {
  if (!displayDate) return null;
  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(displayDate)) return displayDate;
  try {
    const monthMap = {
      'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
      'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
      'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
    };
    // Format: "Mon, 12 Nov 2026"
    const parts = displayDate.replace(/,/g, '').trim().split(/\s+/);
    // parts = ['Mon', '12', 'Nov', '2026']
    if (parts.length >= 4) {
      const day = parts[1].padStart(2, '0');
      const month = monthMap[parts[2]] || '01';
      const year = parts[3];
      return `${year}-${month}-${day}`;
    }
    // Fallback: try Date constructor
    const d = new Date(displayDate);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  } catch (e) {
    console.warn('Date conversion failed:', e);
  }
  return null;
}

/**
 * Default time slots (shown when Supabase is not configured or as fallback)
 */
const DEFAULT_TIME_SLOTS = [
  '10:30 AM - 11:00 AM',
  '12:00 PM - 12:30 PM',
  '03:00 PM - 03:30 PM',
  '05:00 PM - 05:30 PM',
  '06:30 PM - 07:00 PM',
  '07:30 PM - 08:00 PM'
];

/**
 * Render time slot buttons into the slot container
 */
function renderSlotButtons(slots, container) {
  container.innerHTML = '';
  if (!slots || slots.length === 0) {
    container.innerHTML = `
      <p class="text-sm text-slate-500 col-span-full py-3 text-center italic">
        No available slots for this date. Please choose another date.
      </p>`;
    // Clear the hidden input so form validation catches no selection
    const slotInput = document.getElementById('selected-slot-input');
    if (slotInput) slotInput.value = '';
    return;
  }

  let firstSelected = false;
  slots.forEach(slotLabel => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'time-slot-btn p-3 rounded-xl border text-xs font-semibold text-center transition-all bg-white text-slate-700 border-slate-200 hover:border-slate-400';
    btn.setAttribute('data-slot', slotLabel);
    btn.textContent = slotLabel;

    // Select first available slot by default
    if (!firstSelected) {
      btn.classList.remove('bg-white', 'text-slate-700', 'border-slate-200');
      btn.classList.add('bg-amber-600', 'text-white', 'border-amber-600', 'ring-2', 'ring-amber-200');
      const slotInput = document.getElementById('selected-slot-input');
      if (slotInput) slotInput.value = slotLabel;
      firstSelected = true;
    }

    btn.addEventListener('click', () => {
      container.querySelectorAll('.time-slot-btn').forEach(b => {
        b.classList.remove('bg-amber-600', 'text-white', 'border-amber-600', 'ring-2', 'ring-amber-200');
        b.classList.add('bg-white', 'text-slate-700', 'border-slate-200');
      });
      btn.classList.remove('bg-white', 'text-slate-700', 'border-slate-200');
      btn.classList.add('bg-amber-600', 'text-white', 'border-amber-600', 'ring-2', 'ring-amber-200');
      const slotInput = document.getElementById('selected-slot-input');
      if (slotInput) slotInput.value = slotLabel;
      clearBookingError('selected-slot-input');
    });

    container.appendChild(btn);
  });
}

/**
 * Load dynamic time slots from Supabase for a specific date.
 * Falls back to DEFAULT_TIME_SLOTS if Supabase is offline or unconfigured.
 */
async function loadDynamicSlotsForDate(isoDate) {
  const container = document.getElementById('slot-buttons-container');
  if (!container) return; // No slot container in DOM — static slots in HTML

  // Show loading indicator
  container.innerHTML = `
    <div class="col-span-full flex items-center justify-center py-4 text-slate-500 text-sm">
      <svg class="animate-spin h-4 w-4 mr-2 text-amber-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
      </svg>
      Loading available slots...
    </div>`;

  try {
    // If Supabase is live, fetch real availability
    if (typeof window.ApexSupabase !== 'undefined' && window.ApexSupabase.isLive()) {
      const result = await window.ApexSupabase.getAvailableBookingSlots(isoDate);
      if (result && result.success && Array.isArray(result.slots) && result.slots.length > 0) {
        renderSlotButtons(result.slots, container);
        return;
      }
    }
  } catch (err) {
    console.warn('Could not load dynamic slots, using defaults:', err.message);
  }

  // Fallback: use default static slots
  renderSlotButtons(DEFAULT_TIME_SLOTS, container);
}

function setBookingError(fieldId, errorMsg) {
  const input = document.getElementById(fieldId);
  const errEl = document.getElementById(`${fieldId}-error`);
  if (input) input.classList.add('border-red-500', 'bg-red-50/50');
  if (errEl) {
    errEl.textContent = errorMsg;
    errEl.classList.remove('hidden');
  }
}

function clearBookingError(fieldId) {
  const input = document.getElementById(fieldId);
  const errEl = document.getElementById(`${fieldId}-error`);
  if (input) input.classList.remove('border-red-500', 'bg-red-50/50');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
}

window.resetBookingFlow = function() {
  const formSection = document.getElementById('booking-form-wrapper');
  const confirmationSection = document.getElementById('booking-success-wrapper');
  const form = document.getElementById('counselling-booking-form');

  if (formSection && confirmationSection && form) {
    form.reset();
    formSection.classList.remove('hidden');
    confirmationSection.classList.add('hidden');
    generateDateCards(); // Also triggers loadDynamicSlotsForDate for first day
    // initSlotSelection() is handled by renderSlotButtons() after dynamic load

    const categorySelect = document.getElementById('booking-course-category');
    if (categorySelect) categorySelect.value = '';
    populateBookingExams('');

    formSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};
