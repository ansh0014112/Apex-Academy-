/**
 * APEX ACADEMY — Centralized Admin Management Data Layer
 * Architecture engineered for frontend demonstration with localStorage persistence,
 * designed for seamless future migration to Supabase Database & Row-Level Security.
 * 
 * Contains complete realistic records covering all 3 academic streams:
 * 1. Civil Services & SSC Preparation
 * 2. Banking & Railway Preparation
 * 3. APEX Foundation Program
 */

const AdminData = (() => {
  'use strict';

  const STORAGE_KEY = 'apex_academy_admin_store_v1';

  // ─── INITIAL MOCK USERS & COUNSELLORS ───
  const INITIAL_USERS = [
    {
      id: 'usr_001',
      email: 'admin@apexacademy.edu.in',
      name: 'Dr. Rajesh Sharma',
      role: 'super_admin',
      department: 'Executive Administration',
      avatar: null,
      status: 'active'
    },
    {
      id: 'usr_002',
      email: 'meera.counsellor@apexacademy.edu.in',
      name: 'Meera Kapoor',
      role: 'admission_counsellor',
      department: 'Admission Department',
      avatar: null,
      status: 'active'
    },
    {
      id: 'usr_003',
      email: 'vikram.counsellor@apexacademy.edu.in',
      name: 'Vikram Deshmukh',
      role: 'academic_counsellor',
      department: 'Academic Counselling Department',
      avatar: null,
      status: 'active'
    }
  ];

  const INITIAL_COUNSELLORS = [
    {
      id: 'coun_001',
      name: 'Meera Kapoor',
      email: 'meera.counsellor@apexacademy.edu.in',
      phone: '9876543201',
      department: 'Admission Department',
      role: 'admission_counsellor',
      status: 'active',
      joinDate: '2025-06-15',
      assignedEnquiries: 6,
      assignedBookings: 0,
      completedTasks: 38,
      conversionRate: 42
    },
    {
      id: 'coun_002',
      name: 'Rohit Malhotra',
      email: 'rohit.counsellor@apexacademy.edu.in',
      phone: '9876543202',
      department: 'Admission Department',
      role: 'admission_counsellor',
      status: 'active',
      joinDate: '2025-08-01',
      assignedEnquiries: 4,
      assignedBookings: 0,
      completedTasks: 27,
      conversionRate: 37
    },
    {
      id: 'coun_003',
      name: 'Vikram Deshmukh',
      email: 'vikram.counsellor@apexacademy.edu.in',
      phone: '9876543203',
      department: 'Academic Counselling Department',
      role: 'academic_counsellor',
      status: 'active',
      joinDate: '2025-05-20',
      assignedBookings: 6,
      assignedEnquiries: 0,
      completedTasks: 45,
      conversionRate: 48
    },
    {
      id: 'coun_004',
      name: 'Priya Nair',
      email: 'priya.counsellor@apexacademy.edu.in',
      phone: '9876543204',
      department: 'Academic Counselling Department',
      role: 'academic_counsellor',
      status: 'active',
      joinDate: '2025-09-10',
      assignedBookings: 4,
      assignedEnquiries: 0,
      completedTasks: 22,
      conversionRate: 39
    },
    {
      id: 'coun_005',
      name: 'Amit Verma',
      email: 'amit.counsellor@apexacademy.edu.in',
      phone: '9876543205',
      department: 'Admission Department',
      role: 'admission_counsellor',
      status: 'inactive',
      joinDate: '2025-03-01',
      assignedEnquiries: 0,
      assignedBookings: 0,
      completedTasks: 15,
      conversionRate: 33
    }
  ];

  // ─── INITIAL ADMISSION ENQUIRIES ───
  // Preserving EVERY SINGLE field from enquiry.html
  const INITIAL_ENQUIRIES = [
    {
      id: 'ENQ-2026-001',
      studentName: 'Abhinav Saxena',
      mobile: '9812345001',
      email: 'abhinav.s@gmail.com',
      qualification: 'Graduate Degree Completed (Any Stream)',
      courseCategory: 'Civil Services & SSC Exam Preparation',
      courseCategoryId: 'civil-services-ssc',
      targetExamination: 'SSC CGL (Combined Graduate Level)',
      preferredBatch: 'Morning Batch (08:00 AM – 11:30 AM)',
      learningMode: 'Offline Classroom (Delhi Flagship)',
      message: 'Completed BA History from Delhi University. Interested in joining the upcoming full-time classroom batch for SSC CGL Tier 1 & Tier 2.',
      assignedCounsellor: 'coun_001',
      status: 'new',
      submittedAt: '2026-11-09T08:30:00',
      notes: [
        { id: 'n_01', text: 'Lead received from direct web inquiry. High intent candidate for Delhi campus.', addedBy: 'System Bot', addedAt: '2026-11-09T08:31:00' }
      ],
      followUps: [
        { id: 'fu_001', date: '2026-11-09', purpose: 'Introductory syllabus overview & campus visit invitation', status: 'today', counsellorId: 'coun_001' }
      ]
    },
    {
      id: 'ENQ-2026-002',
      studentName: 'Priyanka Sharma',
      mobile: '9812345002',
      email: 'priyanka.sharma@outlook.com',
      qualification: 'Post Graduate / Master\'s Completed',
      courseCategory: 'Civil Services & SSC Exam Preparation',
      courseCategoryId: 'civil-services-ssc',
      targetExamination: 'UPSC Civil Services Examination (CSE)',
      preferredBatch: 'Evening Batch (04:30 PM – 08:00 PM)',
      learningMode: 'Offline Classroom (Delhi Flagship)',
      message: 'MA Political Science from JNU. Second attempt at UPSC CSE. Need structured guidance for Prelims test series and Mains answer writing.',
      assignedCounsellor: 'coun_001',
      status: 'contacted',
      submittedAt: '2026-11-08T14:15:00',
      notes: [
        { id: 'n_02', text: 'Called candidate. Discussed past attempt GS scores (87.5 in prelims). Shared demo lecture links on WhatsApp.', addedBy: 'Meera Kapoor', addedAt: '2026-11-08T16:00:00' }
      ],
      followUps: [
        { id: 'fu_002', date: '2026-11-10', purpose: 'Follow-up after demo lecture review & fee structure discussion', status: 'upcoming', counsellorId: 'coun_001' }
      ]
    },
    {
      id: 'ENQ-2026-003',
      studentName: 'Rahul Kumar Verma',
      mobile: '9812345003',
      email: 'rahul.k@yahoo.com',
      qualification: 'Undergraduate Final Year Student',
      courseCategory: 'Banking & Railway Exam Preparation',
      courseCategoryId: 'banking-railway',
      targetExamination: 'IBPS PO (Probationary Officer)',
      preferredBatch: 'Morning Batch (08:00 AM – 11:30 AM)',
      learningMode: 'Interactive Live Online (Zoom/App)',
      message: 'Final year B.Com student from Lucknow. Want to start comprehensive online bank PO preparation with speed tests.',
      assignedCounsellor: 'coun_002',
      status: 'interested',
      submittedAt: '2026-11-07T09:45:00',
      notes: [
        { id: 'n_03', text: 'Candidate attended Zoom demo orientation. Very interested in Banking Quant & DI shortcuts module.', addedBy: 'Rohit Malhotra', addedAt: '2026-11-07T11:30:00' }
      ],
      followUps: [
        { id: 'fu_003', date: '2026-11-09', purpose: 'Confirm enrollment in early bird live batch', status: 'today', counsellorId: 'coun_002' }
      ]
    },
    {
      id: 'ENQ-2026-004',
      studentName: 'Sneha Patel',
      mobile: '9812345004',
      email: 'sneha.patel@gmail.com',
      qualification: '10+2 / Higher Secondary (Pursuing or Completed)',
      courseCategory: 'APEX Foundation Program',
      courseCategoryId: 'foundation',
      targetExamination: 'All-Govt Exam Beginner Foundation (SSC, Bank, Railway)',
      preferredBatch: 'Evening Foundation (04:30 PM – 07:30 PM)',
      learningMode: 'Offline Classroom (Delhi Flagship)',
      message: 'Just passed 12th standard with 88%. Looking to build strong fundamentals in Arithmetic and Reasoning alongside college.',
      assignedCounsellor: 'coun_002',
      status: 'new',
      submittedAt: '2026-11-09T10:20:00',
      notes: [],
      followUps: [
        { id: 'fu_004', date: '2026-11-10', purpose: 'Schedule diagnostic aptitude audit', status: 'upcoming', counsellorId: 'coun_002' }
      ]
    },
    {
      id: 'ENQ-2026-005',
      studentName: 'Vikash Yadav',
      mobile: '9812345005',
      email: 'vikash.y@gmail.com',
      qualification: 'Graduate Degree Completed (Any Stream)',
      courseCategory: 'Banking & Railway Exam Preparation',
      courseCategoryId: 'banking-railway',
      targetExamination: 'SBI PO (State Bank of India)',
      preferredBatch: 'Weekend Intensive (Sat & Sun)',
      learningMode: 'Weekend Hybrid (Working Aspirants)',
      message: 'Working in private back-office. Looking for weekend intensive coaching to clear SBI PO in 2026-27.',
      assignedCounsellor: 'coun_001',
      status: 'converted',
      submittedAt: '2026-10-28T11:00:00',
      notes: [
        { id: 'n_05', text: 'Registration completed. Fee receipt #APX-REC-892 issued. Enrolled in Batch WB-2.', addedBy: 'Meera Kapoor', addedAt: '2026-11-02T10:00:00' }
      ],
      followUps: [
        { id: 'fu_005', date: '2026-11-02', purpose: 'Course material delivery confirmation', status: 'completed', counsellorId: 'coun_001' }
      ]
    },
    {
      id: 'ENQ-2026-006',
      studentName: 'Anjali Mishra',
      mobile: '9812345006',
      email: 'anjali.mishra@gmail.com',
      qualification: 'Graduate Degree Completed (Any Stream)',
      courseCategory: 'Civil Services & SSC Exam Preparation',
      courseCategoryId: 'civil-services-ssc',
      targetExamination: 'SSC CHSL (Combined Higher Secondary)',
      preferredBatch: 'Morning Batch (08:00 AM – 11:30 AM)',
      learningMode: 'Offline Classroom (Delhi Flagship)',
      message: 'BA English graduate. Preparing for SSC CHSL Postal Assistant vacancy.',
      assignedCounsellor: null,
      status: 'new',
      submittedAt: '2026-11-09T07:10:00',
      notes: [],
      followUps: []
    },
    {
      id: 'ENQ-2026-007',
      studentName: 'Deepak Tiwari',
      mobile: '9812345007',
      email: 'deepak.t@gmail.com',
      qualification: 'Working Professional (Seeking Career Switch to Govt Role)',
      courseCategory: 'Civil Services & SSC Exam Preparation',
      courseCategoryId: 'civil-services-ssc',
      targetExamination: 'State Public Service Commission (State PCS)',
      preferredBatch: 'Evening Batch (04:30 PM – 08:00 PM)',
      learningMode: 'Interactive Live Online (Zoom/App)',
      message: 'Software developer with 3 years IT experience. Wanting to pivot to State PCS Administrative Officer cadre.',
      assignedCounsellor: 'coun_002',
      status: 'contacted',
      submittedAt: '2026-11-05T17:30:00',
      notes: [
        { id: 'n_07', text: 'Informed candidate about evening batch timings and recorded vault access.', addedBy: 'Rohit Malhotra', addedAt: '2026-11-06T09:00:00' }
      ],
      followUps: [
        { id: 'fu_007', date: '2026-11-06', purpose: 'Send recorded trial lecture link', status: 'completed', counsellorId: 'coun_002' }
      ]
    },
    {
      id: 'ENQ-2026-008',
      studentName: 'Kavita Ranganathan',
      mobile: '9812345008',
      email: 'kavita.r@gmail.com',
      qualification: 'Graduate Degree Completed (Any Stream)',
      courseCategory: 'Banking & Railway Exam Preparation',
      courseCategoryId: 'banking-railway',
      targetExamination: 'RRB NTPC (Non-Technical Popular Categories)',
      preferredBatch: 'Morning Batch (08:00 AM – 11:30 AM)',
      learningMode: 'Offline Classroom (Delhi Flagship)',
      message: 'B.Sc Mathematics. Targeting Station Master and Traffic Assistant roles through upcoming RRB notifications.',
      assignedCounsellor: 'coun_001',
      status: 'interested',
      submittedAt: '2026-11-04T12:00:00',
      notes: [
        { id: 'n_08', text: 'Strong in basic maths, needs coaching in general awareness and Indian Railways GS module.', addedBy: 'Meera Kapoor', addedAt: '2026-11-05T10:00:00' }
      ],
      followUps: [
        { id: 'fu_008', date: '2026-11-11', purpose: 'Campus physical visit and book collection', status: 'upcoming', counsellorId: 'coun_001' }
      ]
    },
    {
      id: 'ENQ-2026-009',
      studentName: 'Arun Joshi',
      mobile: '9812345009',
      email: 'arun.joshi@gmail.com',
      qualification: 'Post Graduate / Master\'s Completed',
      courseCategory: 'Civil Services & SSC Exam Preparation',
      courseCategoryId: 'civil-services-ssc',
      targetExamination: 'UPSC Civil Services Examination (CSE)',
      preferredBatch: 'Morning Batch (08:00 AM – 11:30 AM)',
      learningMode: 'Offline Classroom (Delhi Flagship)',
      message: 'First attempt at UPSC CSE. Require intensive 1-year foundation and answer evaluation.',
      assignedCounsellor: 'coun_001',
      status: 'converted',
      submittedAt: '2026-10-20T09:00:00',
      notes: [
        { id: 'n_09', text: 'Admitted to Civil Services Batch 2026. Student ID #APX-STU-1049 assigned.', addedBy: 'Meera Kapoor', addedAt: '2026-10-25T14:00:00' }
      ],
      followUps: [
        { id: 'fu_009', date: '2026-10-25', purpose: 'Orientation kit handover', status: 'completed', counsellorId: 'coun_001' }
      ]
    },
    {
      id: 'ENQ-2026-010',
      studentName: 'Nisha Gupta',
      mobile: '9812345010',
      email: 'nisha.gupta@gmail.com',
      qualification: 'Undergraduate Final Year Student',
      courseCategory: 'APEX Foundation Program',
      courseCategoryId: 'foundation',
      targetExamination: 'Undergraduate 1-Year Early Career Track',
      preferredBatch: 'College Weekend Special (Sat & Sun Extended)',
      learningMode: 'Weekend Hybrid (Working Aspirants)',
      message: 'BBA final year student. Planning ahead for multiple central exams before university graduation.',
      assignedCounsellor: 'coun_002',
      status: 'contacted',
      submittedAt: '2026-11-03T15:00:00',
      notes: [
        { id: 'n_10', text: 'Discussed college timetable compatibility. Weekend program recommended.', addedBy: 'Rohit Malhotra', addedAt: '2026-11-04T09:00:00' }
      ],
      followUps: [
        { id: 'fu_010', date: '2026-11-12', purpose: 'Check parents approval for hybrid schedule', status: 'upcoming', counsellorId: 'coun_002' }
      ]
    },
    {
      id: 'ENQ-2026-011',
      studentName: 'Manish Kumar Singh',
      mobile: '9812345011',
      email: 'manish.s@gmail.com',
      qualification: 'Graduate Degree Completed (Any Stream)',
      courseCategory: 'Banking & Railway Exam Preparation',
      courseCategoryId: 'banking-railway',
      targetExamination: 'RBI Assistant (Reserve Bank)',
      preferredBatch: 'Evening Batch (04:30 PM – 08:00 PM)',
      learningMode: 'Offline Classroom (Delhi Flagship)',
      message: 'Targeting RBI Assistant and Grade B preliminary rounds. Need high-level DI and reasoning puzzles training.',
      assignedCounsellor: null,
      status: 'new',
      submittedAt: '2026-11-09T06:45:00',
      notes: [],
      followUps: []
    },
    {
      id: 'ENQ-2026-012',
      studentName: 'Sunita Devi',
      mobile: '9812345012',
      email: 'sunita.d@gmail.com',
      qualification: '10+2 / Higher Secondary (Pursuing or Completed)',
      courseCategory: 'APEX Foundation Program',
      courseCategoryId: 'foundation',
      targetExamination: 'Fundamental Quantitative & Reasoning Skill-Builder',
      preferredBatch: 'Morning Foundation (08:30 AM – 11:30 AM)',
      learningMode: 'Offline Classroom (Delhi Flagship)',
      message: 'Need foundational preparation starting from NCERT maths and english grammar.',
      assignedCounsellor: 'coun_001',
      status: 'interested',
      submittedAt: '2026-11-01T10:30:00',
      notes: [
        { id: 'n_12', text: 'Student visited campus desk with guardian. Attended counselling briefing.', addedBy: 'Meera Kapoor', addedAt: '2026-11-02T09:00:00' }
      ],
      followUps: [
        { id: 'fu_012', date: '2026-11-05', purpose: 'Diagnostic assessment follow-up', status: 'overdue', counsellorId: 'coun_001' }
      ]
    }
  ];

  // ─── INITIAL COUNSELLING BOOKINGS ───
  // Preserving EVERY SINGLE field from book-counselling.html
  const INITIAL_BOOKINGS = [
    {
      id: 'BK-2026-001',
      studentName: 'Ravi Shankar',
      mobile: '9812345101',
      email: 'ravi.shankar@gmail.com',
      courseCategory: 'Civil Services & SSC Exam Preparation',
      courseCategoryId: 'civil-services-ssc',
      targetExamination: 'SSC CGL (Combined Graduate Level)',
      preferredDate: '2026-11-10',
      preferredTime: '10:30 AM – 11:00 AM',
      sessionMedium: 'Google Meet HD Video Call',
      assignedCounsellor: 'coun_003',
      status: 'confirmed',
      submittedAt: '2026-11-08T09:00:00',
      notes: [
        { id: 'bn_01', text: 'Calendar invite and Google Meet link dispatched to student email.', addedBy: 'Vikram Deshmukh', addedAt: '2026-11-08T10:00:00' }
      ],
      followUps: [
        { id: 'fu_bk_01', date: '2026-11-10', purpose: 'Conduct 30-min exam strategy audit call', status: 'upcoming', counsellorId: 'coun_003' }
      ]
    },
    {
      id: 'BK-2026-002',
      studentName: 'Aarti Jain',
      mobile: '9812345102',
      email: 'aarti.jain@gmail.com',
      courseCategory: 'Banking & Railway Exam Preparation',
      courseCategoryId: 'banking-railway',
      targetExamination: 'IBPS PO (Probationary Officer)',
      preferredDate: '2026-11-09',
      preferredTime: '03:00 PM – 03:30 PM',
      sessionMedium: 'Direct Telephonic Call (Audio)',
      assignedCounsellor: 'coun_003',
      status: 'confirmed',
      submittedAt: '2026-11-07T14:30:00',
      notes: [
        { id: 'bn_02', text: 'Aspirant confirmed telephone availability for 3:00 PM today.', addedBy: 'Vikram Deshmukh', addedAt: '2026-11-08T11:00:00' }
      ],
      followUps: [
        { id: 'fu_bk_02', date: '2026-11-09', purpose: 'Conduct telephonic diagnostic session', status: 'today', counsellorId: 'coun_003' }
      ]
    },
    {
      id: 'BK-2026-003',
      studentName: 'Pooja Mehta',
      mobile: '9812345103',
      email: 'pooja.mehta@gmail.com',
      courseCategory: 'Civil Services & SSC Exam Preparation',
      courseCategoryId: 'civil-services-ssc',
      targetExamination: 'UPSC Civil Services Examination (CSE)',
      preferredDate: '2026-11-11',
      preferredTime: '05:00 PM – 05:30 PM',
      sessionMedium: 'Google Meet HD Video Call',
      assignedCounsellor: 'coun_004',
      status: 'assigned',
      submittedAt: '2026-11-08T11:00:00',
      notes: [
        { id: 'bn_03', text: 'Assigned to senior mentor Priya Nair for Civil Services roadmap review.', addedBy: 'Super Admin', addedAt: '2026-11-08T12:00:00' }
      ],
      followUps: [
        { id: 'fu_bk_03', date: '2026-11-10', purpose: 'Send pre-session diagnostic questionnaire', status: 'upcoming', counsellorId: 'coun_004' }
      ]
    },
    {
      id: 'BK-2026-004',
      studentName: 'Amit Dubey',
      mobile: '9812345104',
      email: 'amit.dubey@gmail.com',
      courseCategory: 'Banking & Railway Exam Preparation',
      courseCategoryId: 'banking-railway',
      targetExamination: 'SBI PO (State Bank of India)',
      preferredDate: '2026-11-09',
      preferredTime: '12:00 PM – 12:30 PM',
      sessionMedium: 'In-Person at Delhi Flagship Campus',
      assignedCounsellor: 'coun_003',
      status: 'completed',
      submittedAt: '2026-11-05T08:30:00',
      notes: [
        { id: 'bn_04', text: 'Completed in-person diagnostic at Connaught Place center. Handed over CBT Speed Lab pass voucher. Student enrolled.', addedBy: 'Vikram Deshmukh', addedAt: '2026-11-09T13:00:00' }
      ],
      followUps: [
        { id: 'fu_bk_04', date: '2026-11-12', purpose: 'Follow-up regarding classroom batch onboarding', status: 'upcoming', counsellorId: 'coun_003' }
      ]
    },
    {
      id: 'BK-2026-005',
      studentName: 'Meenakshi Reddy',
      mobile: '9812345105',
      email: 'meenakshi.r@gmail.com',
      courseCategory: 'APEX Foundation Program',
      courseCategoryId: 'foundation',
      targetExamination: 'All-Govt Exam Beginner Foundation (SSC, Bank, Railway)',
      preferredDate: '2026-11-12',
      preferredTime: '06:30 PM – 07:00 PM',
      sessionMedium: 'Google Meet HD Video Call',
      assignedCounsellor: null,
      status: 'pending',
      submittedAt: '2026-11-09T06:15:00',
      notes: [],
      followUps: []
    },
    {
      id: 'BK-2026-006',
      studentName: 'Sanjay Verma',
      mobile: '9812345106',
      email: 'sanjay.v@gmail.com',
      courseCategory: 'Civil Services & SSC Exam Preparation',
      courseCategoryId: 'civil-services-ssc',
      targetExamination: 'State Public Service Commission (State PCS)',
      preferredDate: '2026-11-09',
      preferredTime: '10:30 AM – 11:00 AM',
      sessionMedium: 'Direct Telephonic Call (Audio)',
      assignedCounsellor: 'coun_004',
      status: 'completed',
      submittedAt: '2026-11-04T16:00:00',
      notes: [
        { id: 'bn_06', text: '30-minute exam timetable mapped out. Recommended State PCS hybrid cohort.', addedBy: 'Priya Nair', addedAt: '2026-11-09T11:15:00' }
      ],
      followUps: []
    },
    {
      id: 'BK-2026-007',
      studentName: 'Rekha Bhatia',
      mobile: '9812345107',
      email: 'rekha.b@gmail.com',
      courseCategory: 'Banking & Railway Exam Preparation',
      courseCategoryId: 'banking-railway',
      targetExamination: 'RRB NTPC (Non-Technical Popular Categories)',
      preferredDate: '2026-11-08',
      preferredTime: '07:30 PM – 08:00 PM',
      sessionMedium: 'Google Meet HD Video Call',
      assignedCounsellor: 'coun_003',
      status: 'no_show',
      submittedAt: '2026-11-03T13:00:00',
      notes: [
        { id: 'bn_07', text: 'Candidate did not connect to Google Meet. Left reminder SMS and WhatsApp message to reschedule.', addedBy: 'Vikram Deshmukh', addedAt: '2026-11-08T20:00:00' }
      ],
      followUps: [
        { id: 'fu_bk_07', date: '2026-11-09', purpose: 'Follow up to reschedule missed counselling session', status: 'today', counsellorId: 'coun_003' }
      ]
    },
    {
      id: 'BK-2026-008',
      studentName: 'Gaurav Pandey',
      mobile: '9812345108',
      email: 'gaurav.p@gmail.com',
      courseCategory: 'Civil Services & SSC Exam Preparation',
      courseCategoryId: 'civil-services-ssc',
      targetExamination: 'SSC CGL (Combined Graduate Level)',
      preferredDate: '2026-11-10',
      preferredTime: '06:30 PM – 07:00 PM',
      sessionMedium: 'In-Person at Delhi Flagship Campus',
      assignedCounsellor: 'coun_004',
      status: 'confirmed',
      submittedAt: '2026-11-08T19:00:00',
      notes: [
        { id: 'bn_08', text: 'Appointment confirmed for Connaught Place campus visit.', addedBy: 'Priya Nair', addedAt: '2026-11-09T09:00:00' }
      ],
      followUps: [
        { id: 'fu_bk_08', date: '2026-11-10', purpose: 'Prepare mock test evaluation report for campus review', status: 'upcoming', counsellorId: 'coun_004' }
      ]
    },
    {
      id: 'BK-2026-009',
      studentName: 'Lakshmi Iyer',
      mobile: '9812345109',
      email: 'lakshmi.i@gmail.com',
      courseCategory: 'APEX Foundation Program',
      courseCategoryId: 'foundation',
      targetExamination: 'Undergraduate 1-Year Early Career Track',
      preferredDate: '2026-11-13',
      preferredTime: '03:00 PM – 03:30 PM',
      sessionMedium: 'Google Meet HD Video Call',
      assignedCounsellor: 'coun_004',
      status: 'confirmed',
      submittedAt: '2026-11-09T08:00:00',
      notes: [],
      followUps: []
    },
    {
      id: 'BK-2026-010',
      studentName: 'Naveen Chandra',
      mobile: '9812345110',
      email: 'naveen.c@gmail.com',
      courseCategory: 'Banking & Railway Exam Preparation',
      courseCategoryId: 'banking-railway',
      targetExamination: 'IBPS Clerk (Clerical Cadre)',
      preferredDate: '2026-11-14',
      preferredTime: '05:00 PM – 05:30 PM',
      sessionMedium: 'Direct Telephonic Call (Audio)',
      assignedCounsellor: null,
      status: 'pending',
      submittedAt: '2026-11-09T09:30:00',
      notes: [],
      followUps: []
    }
  ];

  // ─── INITIAL COURSES & BATCHES ───
  const INITIAL_COURSES = [
    {
      id: 'civil-services-ssc',
      name: 'Civil Services & SSC Exam Preparation',
      shortName: 'Civil Services & SSC',
      category: 'Civil Services & SSC',
      status: 'active',
      examinations: [
        'UPSC Civil Services Examination (CSE)',
        'State Public Service Commission (State PCS)',
        'SSC CGL (Combined Graduate Level)',
        'SSC CHSL (Combined Higher Secondary)',
        'SSC GD (General Duty Constable)',
        'SSC MTS (Multi-Tasking Staff)',
        'State Subordinate & Administrative Exams'
      ],
      batches: [
        { id: 'b_cssc_01', name: 'Morning Batch', timing: '08:00 AM – 11:30 AM', status: 'active', seats: 45, enrolled: 38 },
        { id: 'b_cssc_02', name: 'Evening Batch', timing: '04:30 PM – 08:00 PM', status: 'active', seats: 45, enrolled: 42 },
        { id: 'b_cssc_03', name: 'Weekend Executive Intensive', timing: 'Sat & Sun Full Day', status: 'active', seats: 30, enrolled: 22 }
      ],
      learningModes: [
        'Offline Classroom (Delhi Flagship)',
        'Interactive Live Online (Zoom/App)',
        'Weekend Hybrid (Working Aspirants)'
      ]
    },
    {
      id: 'banking-railway',
      name: 'Banking & Railway Exam Preparation',
      shortName: 'Banking & Railway',
      category: 'Banking & Railway',
      status: 'active',
      examinations: [
        'IBPS PO (Probationary Officer)',
        'IBPS Clerk (Clerical Cadre)',
        'SBI PO (State Bank of India)',
        'SBI Clerk (Junior Associate)',
        'RBI Assistant (Reserve Bank)',
        'RRB NTPC (Non-Technical Popular Categories)',
        'RRB Group D (Operations & Maintenance)',
        'RRB ALP (Assistant Loco Pilot)',
        'RRB Technician (Grade I & III)'
      ],
      batches: [
        { id: 'b_br_01', name: 'Morning Batch', timing: '08:00 AM – 11:30 AM', status: 'active', seats: 45, enrolled: 35 },
        { id: 'b_br_02', name: 'Evening Batch', timing: '04:30 PM – 08:00 PM', status: 'active', seats: 45, enrolled: 40 },
        { id: 'b_br_03', name: 'Weekend Intensive', timing: 'Sat & Sun', status: 'active', seats: 30, enrolled: 18 }
      ],
      learningModes: [
        'Offline Classroom (Delhi Flagship)',
        'Interactive Live Online (Zoom/App)',
        'Weekend Hybrid (Working Aspirants)'
      ]
    },
    {
      id: 'foundation',
      name: 'APEX Foundation Program',
      shortName: 'Foundation Program',
      category: 'Foundation Program',
      status: 'active',
      examinations: [
        'All-Govt Exam Beginner Foundation (SSC, Bank, Railway)',
        'Undergraduate 1-Year Early Career Track',
        'Fundamental Quantitative & Reasoning Skill-Builder'
      ],
      batches: [
        { id: 'b_fnd_01', name: 'Morning Foundation', timing: '08:30 AM – 11:30 AM', status: 'active', seats: 45, enrolled: 28 },
        { id: 'b_fnd_02', name: 'Evening Foundation', timing: '04:30 PM – 07:30 PM', status: 'active', seats: 45, enrolled: 32 },
        { id: 'b_fnd_03', name: 'College Weekend Special', timing: 'Sat & Sun Extended', status: 'upcoming', seats: 30, enrolled: 0 }
      ],
      learningModes: [
        'Offline Classroom (Delhi Flagship)',
        'Interactive Live Online (Zoom/App)',
        'Weekend Hybrid (Working Aspirants)'
      ]
    }
  ];

  // ─── INITIAL RECENT AUDIT LOG / ACTIVITY ───
  const INITIAL_ACTIVITY = [
    { id: 'act_01', type: 'new_enquiry', message: 'New admission enquiry from Manish Kumar Singh for RBI Assistant', time: '1 hour ago', icon: 'inbox' },
    { id: 'act_02', type: 'assignment', message: 'Meera Kapoor assigned to Abhinav Saxena\'s SSC CGL enquiry', time: '2 hours ago', icon: 'user-check' },
    { id: 'act_03', type: 'status_change', message: 'Rahul Kumar\'s enquiry status updated to Interested', time: '4 hours ago', icon: 'trending-up' },
    { id: 'act_04', type: 'booking_confirmed', message: 'Counselling session confirmed for Ravi Shankar on Nov 10', time: '5 hours ago', icon: 'calendar-check' },
    { id: 'act_05', type: 'session_completed', message: 'Amit Dubey\'s campus counselling session marked Completed', time: '6 hours ago', icon: 'check-circle' },
    { id: 'act_06', type: 'conversion', message: 'Vikash Yadav enrolled in Weekend Hybrid Banking cohort', time: '1 day ago', icon: 'award' },
    { id: 'act_07', type: 'follow_up', message: 'Follow-up scheduled for Priyanka Sharma on Nov 10', time: '1 day ago', icon: 'clock' },
    { id: 'act_08', type: 'new_booking', message: 'New counselling request received from Meenakshi Reddy', time: '1 day ago', icon: 'phone-incoming' }
  ];

  // ─── INITIAL ANALYTICS DATA ───
  const INITIAL_ANALYTICS = {
    monthlyEnquiries: [
      { month: 'Jun', count: 18 },
      { month: 'Jul', count: 24 },
      { month: 'Aug', count: 31 },
      { month: 'Sep', count: 28 },
      { month: 'Oct', count: 35 },
      { month: 'Nov', count: 12 }
    ],
    monthlyBookings: [
      { month: 'Jun', count: 8 },
      { month: 'Jul', count: 12 },
      { month: 'Aug', count: 15 },
      { month: 'Sep', count: 14 },
      { month: 'Oct', count: 18 },
      { month: 'Nov', count: 10 }
    ],
    courseWiseEnquiries: [
      { course: 'Civil Services & SSC', count: 42, percentage: 45 },
      { course: 'Banking & Railway', count: 32, percentage: 34 },
      { course: 'Foundation Program', count: 20, percentage: 21 }
    ],
    conversionFunnel: {
      totalEnquiries: 94,
      contacted: 68,
      interested: 45,
      converted: 28,
      conversionRate: 29.8
    }
  };

  // ─── STATE CONTAINER (with deep clone) ───
  let state = {
    users: JSON.parse(JSON.stringify(INITIAL_USERS)),
    counsellors: JSON.parse(JSON.stringify(INITIAL_COUNSELLORS)),
    enquiries: JSON.parse(JSON.stringify(INITIAL_ENQUIRIES)),
    bookings: JSON.parse(JSON.stringify(INITIAL_BOOKINGS)),
    courses: JSON.parse(JSON.stringify(INITIAL_COURSES)),
    activity: JSON.parse(JSON.stringify(INITIAL_ACTIVITY)),
    analytics: JSON.parse(JSON.stringify(INITIAL_ANALYTICS))
  };

  // ─── PERSISTENCE HELPERS ───
  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.enquiries && parsed.bookings && parsed.counsellors) {
          state = parsed;
          if (!state.tourCompleted) state.tourCompleted = {};
          if (Array.isArray(state.bookings)) {
            state.bookings.forEach(b => {
              if (b.sessionMedium && b.sessionMedium.includes('Google Meet') && !b.googleMeetLink) {
                b.googleMeetLink = 'https://meet.google.com/apx-' + b.id.toLowerCase().replace(/[^a-z0-9]/g, '');
              }
            });
          }
          return true;
        }
      }
    } catch (e) {
      console.warn('Could not read from localStorage, using initial dataset.', e);
    }
    return false;
  }

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Could not save to localStorage.', e);
    }
  }

  function resetDemoData() {
    state = {
      users: JSON.parse(JSON.stringify(INITIAL_USERS)),
      counsellors: JSON.parse(JSON.stringify(INITIAL_COUNSELLORS)),
      enquiries: JSON.parse(JSON.stringify(INITIAL_ENQUIRIES)),
      bookings: JSON.parse(JSON.stringify(INITIAL_BOOKINGS)),
      courses: JSON.parse(JSON.stringify(INITIAL_COURSES)),
      activity: JSON.parse(JSON.stringify(INITIAL_ACTIVITY)),
      analytics: JSON.parse(JSON.stringify(INITIAL_ANALYTICS))
    };
    saveStore();
  }

  // Initialize store on load
  loadFromStorage();

  // ─── STATUS CONFIGURATION ───
  const STATUS_CONFIG = {
    // Enquiry statuses
    new: { label: 'New', color: 'blue', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', dot: 'bg-blue-500' },
    contacted: { label: 'Contacted', color: 'amber', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', dot: 'bg-amber-500' },
    interested: { label: 'Interested', color: 'purple', bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', dot: 'bg-purple-500' },
    converted: { label: 'Converted', color: 'emerald', bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', dot: 'bg-emerald-500' },
    closed: { label: 'Closed', color: 'slate', bg: 'bg-slate-50', text: 'text-slate-500', border: 'border-slate-200', dot: 'bg-slate-400' },
    // Booking statuses
    pending: { label: 'Pending', color: 'amber', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', dot: 'bg-amber-500' },
    assigned: { label: 'Assigned', color: 'blue', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', dot: 'bg-blue-500' },
    confirmed: { label: 'Confirmed', color: 'emerald', bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', dot: 'bg-emerald-500' },
    completed: { label: 'Completed', color: 'slate', bg: 'bg-slate-100', text: 'text-slate-700', border: 'border-slate-300', dot: 'bg-slate-500' },
    cancelled: { label: 'Cancelled', color: 'red', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', dot: 'bg-red-500' },
    no_show: { label: 'No Show', color: 'red', bg: 'bg-red-50', text: 'text-red-600', border: 'border-red-200', dot: 'bg-red-400' },
    rescheduled: { label: 'Rescheduled', color: 'indigo', bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', dot: 'bg-indigo-500' },
    // Follow-up statuses
    today: { label: 'Today', color: 'amber', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', dot: 'bg-amber-500' },
    upcoming: { label: 'Upcoming', color: 'blue', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', dot: 'bg-blue-500' },
    overdue: { label: 'Overdue', color: 'red', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', dot: 'bg-red-500' }
  };

  function getStatusConfig(status) {
    return STATUS_CONFIG[status] || {
      label: status, color: 'slate', bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200', dot: 'bg-slate-400'
    };
  }

  // ─── QUERY & COMPUTED STATISTICS ───
  function getCounsellorName(id) {
    if (!id) return 'Unassigned';
    const c = state.counsellors.find(c => c.id === id);
    return c ? c.name : 'Unknown';
  }

  function getAllFollowUps() {
    const list = [];
    state.enquiries.forEach(enq => {
      if (Array.isArray(enq.followUps)) {
        enq.followUps.forEach(fu => {
          list.push({
            ...fu,
            studentName: enq.studentName,
            contactNumber: enq.mobile,
            source: 'enquiry',
            sourceId: enq.id,
            sourceLabel: 'Admission Enquiry'
          });
        });
      }
    });

    state.bookings.forEach(bk => {
      if (Array.isArray(bk.followUps)) {
        bk.followUps.forEach(fu => {
          list.push({
            ...fu,
            studentName: bk.studentName,
            contactNumber: bk.mobile,
            source: 'booking',
            sourceId: bk.id,
            sourceLabel: 'Counselling Booking'
          });
        });
      }
    });

    return list;
  }

  function getStats(role, userId) {
    let enquiries = state.enquiries;
    let bookings = state.bookings;

    if (role === 'admission_counsellor' && userId) {
      const user = state.users.find(u => u.id === userId);
      const c = user ? state.counsellors.find(co => co.email === user.email) : null;
      if (c) enquiries = enquiries.filter(e => e.assignedCounsellor === c.id);
    } else if (role === 'academic_counsellor' && userId) {
      const user = state.users.find(u => u.id === userId);
      const c = user ? state.counsellors.find(co => co.email === user.email) : null;
      if (c) bookings = bookings.filter(b => b.assignedCounsellor === c.id);
    }

    const totalEnquiries = enquiries.length;
    const newEnquiries = enquiries.filter(e => e.status === 'new').length;
    const contactedEnquiries = enquiries.filter(e => e.status === 'contacted').length;
    const interestedEnquiries = enquiries.filter(e => e.status === 'interested').length;
    const convertedEnquiries = enquiries.filter(e => e.status === 'converted').length;
    const assignedEnquiries = enquiries.filter(e => e.assignedCounsellor !== null && e.assignedCounsellor !== '').length;

    const totalBookings = bookings.length;
    const pendingBookings = bookings.filter(b => b.status === 'pending').length;
    const assignedBookings = bookings.filter(b => b.status === 'assigned').length;
    const confirmedBookings = bookings.filter(b => b.status === 'confirmed').length;
    const completedBookings = bookings.filter(b => b.status === 'completed').length;
    const noShowBookings = bookings.filter(b => b.status === 'no_show').length;
    const rescheduledBookings = bookings.filter(b => b.status === 'rescheduled').length;
    const cancelledBookings = bookings.filter(b => b.status === 'cancelled').length;

    const totalCounsellors = state.counsellors.filter(c => c.status === 'active').length;

    let allFollowUps = getAllFollowUps();
    if (role === 'admission_counsellor' || role === 'academic_counsellor') {
      const user = state.users.find(u => u.id === userId);
      const c = user ? state.counsellors.find(co => co.email === user.email) : null;
      if (c) allFollowUps = allFollowUps.filter(f => f.counsellorId === c.id);
    }

    const today = new Date().toISOString().split('T')[0];
    const todayFollowUps = allFollowUps.filter(f => f.status === 'today' || f.date === today).length;
    const upcomingFollowUps = allFollowUps.filter(f => f.status === 'upcoming').length;
    const overdueFollowUps = allFollowUps.filter(f => {
      if (f.status === 'completed') return false;
      const fDate = new Date(f.date);
      const todayDate = new Date(today);
      return fDate < todayDate;
    }).length;
    const completedFollowUps = allFollowUps.filter(f => f.status === 'completed').length;

    return {
      totalEnquiries, newEnquiries, contactedEnquiries, interestedEnquiries,
      convertedEnquiries, assignedEnquiries,
      totalBookings, pendingBookings, assignedBookings, confirmedBookings,
      completedBookings, noShowBookings, rescheduledBookings, cancelledBookings,
      totalCounsellors,
      todayFollowUps, upcomingFollowUps, overdueFollowUps, completedFollowUps,
      allFollowUps
    };
  }

  // ─── ROLE-BASED ACCESS GATEWAY ───
  function getDataForRole(role, userId) {
    const user = state.users.find(u => u.id === userId);
    if (!user) return null;

    let counsellorId = null;
    if (role === 'admission_counsellor' || role === 'academic_counsellor') {
      const c = state.counsellors.find(c => c.email === user.email);
      counsellorId = c ? c.id : null;
    }

    if (role === 'super_admin') {
      return {
        enquiries: state.enquiries,
        bookings: state.bookings,
        counsellors: state.counsellors,
        followUps: getAllFollowUps(),
        courses: state.courses,
        analytics: state.analytics,
        activity: state.activity,
        counsellorId: null
      };
    }

    if (role === 'admission_counsellor') {
      const myEnquiries = counsellorId
        ? state.enquiries.filter(e => e.assignedCounsellor === counsellorId)
        : [];
      const myFollowUps = counsellorId
        ? getAllFollowUps().filter(f => f.counsellorId === counsellorId)
        : [];
      return {
        enquiries: myEnquiries,
        followUps: myFollowUps,
        counsellorId
      };
    }

    if (role === 'academic_counsellor') {
      const myBookings = counsellorId
        ? state.bookings.filter(b => b.assignedCounsellor === counsellorId)
        : [];
      const myFollowUps = counsellorId
        ? getAllFollowUps().filter(f => f.counsellorId === counsellorId)
        : [];
      return {
        bookings: myBookings,
        followUps: myFollowUps,
        counsellorId
      };
    }

    return null;
  }

  // ─── DATA MUTATION METHODS (Auto-Persisting) ───

  function addActivity(type, message, icon) {
    state.activity.unshift({
      id: 'act_' + Date.now(),
      type,
      message,
      time: 'Just now',
      icon: icon || 'note'
    });
    if (state.activity.length > 20) state.activity.pop();
    saveStore();
  }

  // ─── Enquiry Mutations ───
  function updateEnquiry(id, updates, authorName) {
    const enq = state.enquiries.find(e => e.id === id);
    if (!enq) return false;

    if (updates.status && updates.status !== enq.status) {
      const oldStatus = enq.status;
      enq.status = updates.status;
      addActivity('status_change', `${enq.studentName}'s enquiry updated from ${oldStatus} to ${updates.status}`, 'trending-up');
    }

    if (updates.assignedCounsellor !== undefined && updates.assignedCounsellor !== enq.assignedCounsellor) {
      enq.assignedCounsellor = updates.assignedCounsellor;
      const cName = getCounsellorName(enq.assignedCounsellor);
      addActivity('assignment', `Assigned ${enq.studentName}'s enquiry to ${cName}`, 'user-check');
    }

    saveStore();
    return true;
  }

  function addEnquiryNote(id, noteText, authorName) {
    const enq = state.enquiries.find(e => e.id === id);
    if (!enq || !noteText.trim()) return false;
    if (!Array.isArray(enq.notes)) enq.notes = [];
    enq.notes.unshift({
      id: 'n_' + Date.now(),
      text: noteText.trim(),
      addedBy: authorName || 'Staff',
      addedAt: new Date().toISOString()
    });
    addActivity('note', `Added internal note to ${enq.studentName}'s enquiry`, 'note');
    saveStore();
    return true;
  }

  function scheduleEnquiryFollowUp(id, followUpData) {
    const enq = state.enquiries.find(e => e.id === id);
    if (!enq) return false;
    if (!Array.isArray(enq.followUps)) enq.followUps = [];
    enq.followUps.push({
      id: 'fu_' + Date.now(),
      date: followUpData.date,
      purpose: followUpData.purpose,
      status: 'upcoming',
      counsellorId: followUpData.counsellorId || enq.assignedCounsellor
    });
    addActivity('follow_up', `Scheduled follow-up for ${enq.studentName} on ${followUpData.date}`, 'clock');
    saveStore();
    return true;
  }

  // ─── Booking Mutations ───
  function updateBooking(id, updates, authorName) {
    const bk = state.bookings.find(b => b.id === id);
    if (!bk) return false;

    if (updates.status && updates.status !== bk.status) {
      const oldStatus = bk.status;
      bk.status = updates.status;
      addActivity('status_change', `${bk.studentName}'s counselling booking changed to ${updates.status}`, 'calendar-check');
    }

    if (updates.assignedCounsellor !== undefined && updates.assignedCounsellor !== bk.assignedCounsellor) {
      bk.assignedCounsellor = updates.assignedCounsellor;
      const cName = getCounsellorName(bk.assignedCounsellor);
      addActivity('assignment', `Assigned ${bk.studentName}'s booking to ${cName}`, 'user-check');
    }

    saveStore();
    return true;
  }

  function addBookingNote(id, noteText, authorName) {
    const bk = state.bookings.find(b => b.id === id);
    if (!bk || !noteText.trim()) return false;
    if (!Array.isArray(bk.notes)) bk.notes = [];
    bk.notes.unshift({
      id: 'bn_' + Date.now(),
      text: noteText.trim(),
      addedBy: authorName || 'Mentor',
      addedAt: new Date().toISOString()
    });
    addActivity('note', `Added counselling note to ${bk.studentName}'s booking`, 'note');
    saveStore();
    return true;
  }

  function rescheduleBooking(id, newDate, newTime, reason, authorName) {
    const bk = state.bookings.find(b => b.id === id);
    if (!bk) return false;
    const oldDate = bk.preferredDate;
    const oldTime = bk.preferredTime;
    bk.preferredDate = newDate;
    bk.preferredTime = newTime;
    bk.status = 'rescheduled';
    if (!Array.isArray(bk.notes)) bk.notes = [];
    bk.notes.unshift({
      id: 'bn_' + Date.now(),
      text: `Rescheduled from ${oldDate} (${oldTime}) to ${newDate} (${newTime}). Reason: ${reason || 'Requested by aspirant/mentor'}`,
      addedBy: authorName || 'Admin',
      addedAt: new Date().toISOString()
    });
    addActivity('booking_confirmed', `Rescheduled ${bk.studentName}'s session to ${newDate} at ${newTime}`, 'clock');
    saveStore();
    return true;
  }

  function scheduleBookingFollowUp(id, followUpData) {
    const bk = state.bookings.find(b => b.id === id);
    if (!bk) return false;
    if (!Array.isArray(bk.followUps)) bk.followUps = [];
    bk.followUps.push({
      id: 'fu_bk_' + Date.now(),
      date: followUpData.date,
      purpose: followUpData.purpose,
      status: 'upcoming',
      counsellorId: followUpData.counsellorId || bk.assignedCounsellor
    });
    addActivity('follow_up', `Scheduled follow-up for ${bk.studentName} on ${followUpData.date}`, 'clock');
    saveStore();
    return true;
  }

  // ─── Follow-up Actions ───
  function completeFollowUp(followUpId) {
    let found = false;
    state.enquiries.forEach(e => {
      if (Array.isArray(e.followUps)) {
        e.followUps.forEach(f => {
          if (f.id === followUpId) {
            f.status = 'completed';
            found = true;
          }
        });
      }
    });
    state.bookings.forEach(b => {
      if (Array.isArray(b.followUps)) {
        b.followUps.forEach(f => {
          if (f.id === followUpId) {
            f.status = 'completed';
            found = true;
          }
        });
      }
    });
    if (found) {
      addActivity('follow_up', `Marked follow-up task #${followUpId.substring(0, 8)} as Completed`, 'check-circle');
      saveStore();
    }
    return found;
  }

  // ─── Counsellor Actions ───
  function addCounsellor(data) {
    const newC = {
      id: 'coun_' + Date.now(),
      name: data.name,
      email: data.email,
      phone: data.phone || '',
      department: data.department || 'Admission Department',
      role: data.department === 'Academic Counselling Department' ? 'academic_counsellor' : 'admission_counsellor',
      status: 'active',
      joinDate: new Date().toISOString().split('T')[0],
      assignedEnquiries: 0,
      assignedBookings: 0,
      completedTasks: 0,
      conversionRate: 0
    };
    state.counsellors.push(newC);
    addActivity('assignment', `New counsellor profile created: ${newC.name} (${newC.department})`, 'user-check');
    saveStore();
    return newC;
  }

  function updateCounsellor(id, data) {
    const c = state.counsellors.find(co => co.id === id);
    if (!c) return false;
    c.name = data.name || c.name;
    c.email = data.email || c.email;
    c.phone = data.phone || c.phone;
    if (data.department) {
      c.department = data.department;
      c.role = data.department === 'Academic Counselling Department' ? 'academic_counsellor' : 'admission_counsellor';
    }
    addActivity('assignment', `Updated counsellor details for ${c.name}`, 'user-check');
    saveStore();
    return true;
  }

  function toggleCounsellorStatus(id) {
    const c = state.counsellors.find(co => co.id === id);
    if (!c) return false;
    c.status = c.status === 'active' ? 'inactive' : 'active';
    // Live synchronization with auth users array
    const u = state.users.find(usr => (usr.email && usr.email.toLowerCase() === (c.email || '').toLowerCase()) || usr.name === c.name);
    if (u) {
      u.status = c.status;
    }
    addActivity('assignment', `${c.name}'s account ${c.status === 'active' ? 'activated' : 'deactivated'}`, 'user-check');
    saveStore();
    return c.status;
  }

  function getCounsellorWorkload(counsellorId) {
    const c = state.counsellors.find(co => co.id === counsellorId);
    if (!c) return null;

    const assignedEnqs = state.enquiries.filter(e => e.assignedCounsellor === counsellorId);
    const assignedBks = state.bookings.filter(b => b.assignedCounsellor === counsellorId);
    const assignedFus = getAllFollowUps().filter(f => f.counsellorId === counsellorId);

    return {
      counsellor: c,
      enquiries: assignedEnqs,
      bookings: assignedBks,
      followUps: assignedFus,
      enquiryBreakdown: {
        new: assignedEnqs.filter(e => e.status === 'new').length,
        contacted: assignedEnqs.filter(e => e.status === 'contacted').length,
        interested: assignedEnqs.filter(e => e.status === 'interested').length,
        converted: assignedEnqs.filter(e => e.status === 'converted').length
      },
      bookingBreakdown: {
        pending: assignedBks.filter(b => b.status === 'pending').length,
        confirmed: assignedBks.filter(b => b.status === 'confirmed').length,
        completed: assignedBks.filter(b => b.status === 'completed').length,
        no_show: assignedBks.filter(b => b.status === 'no_show').length
      }
    };
  }

  // ─── Courses & Batches Mutations ───
  function addBatch(courseId, batchData) {
    const course = state.courses.find(c => c.id === courseId);
    if (!course) return false;
    if (!Array.isArray(course.batches)) course.batches = [];
    const newB = {
      id: 'b_' + Date.now(),
      name: batchData.name,
      timing: batchData.timing,
      seats: parseInt(batchData.seats, 10) || 45,
      enrolled: 0,
      status: 'active'
    };
    course.batches.push(newB);
    addActivity('courses', `Added new batch "${newB.name}" to ${course.name}`, 'note');
    saveStore();
    return newB;
  }

  function toggleBatchStatus(courseId, batchId) {
    const course = state.courses.find(c => c.id === courseId);
    if (!course || !course.batches) return false;
    const batch = course.batches.find(b => b.id === batchId || b.name === batchId);
    if (!batch) return false;
    batch.status = batch.status === 'active' ? 'inactive' : 'active';
    addActivity('courses', `Batch "${batch.name}" status changed to ${batch.status}`, 'note');
    saveStore();
    return batch.status;
  }

  // ─── PUBLIC API ───
  
  // ─── AUTHENTICATION & ACCESS VERIFICATION ───
  function authenticate(email, password, expectedRole) {
    if (!email || !expectedRole) {
      return { success: false, reason: 'missing_fields', message: 'Please provide both email address and role selection.' };
    }
    const normEmail = email.trim().toLowerCase();
    const user = state.users.find(u => u.email.toLowerCase() === normEmail);
    if (!user) {
      return { success: false, reason: 'not_found', message: 'No registered administrative account found with this email address.' };
    }
    if (user.status === 'inactive') {
      return { success: false, reason: 'inactive', message: 'Account Deactivated: This counsellor account has been disabled by the Super Admin.' };
    }
    if (user.role !== expectedRole) {
      const userRoleTitle = user.role === 'super_admin' ? 'Super Admin' : (user.role === 'admission_counsellor' ? 'Admission Counsellor' : 'Academic Counsellor');
      const expectedRoleTitle = expectedRole === 'super_admin' ? 'Super Admin' : (expectedRole === 'admission_counsellor' ? 'Admission Counsellor' : 'Academic Counsellor');
      return {
        success: false,
        reason: 'unauthorized_role',
        message: `Access Denied: This account is registered as ${userRoleTitle}, which cannot access the ${expectedRoleTitle} portal. Please select the matching role portal.`
      };
    }
    return { success: true, user: JSON.parse(JSON.stringify(user)) };
  }

  // ─── GUIDED TOUR PERSISTENCE ───
  function isTourCompleted(userId) {
    if (!state.tourCompleted) state.tourCompleted = {};
    return Boolean(state.tourCompleted[userId]);
  }

  function setTourCompleted(userId, completed = true) {
    if (!state.tourCompleted) state.tourCompleted = {};
    state.tourCompleted[userId] = completed;
    saveStore();
  }

  // ─── DOUBLE BOOKING CONFLICT DETECTION ───
  function checkDoubleBooking(counsellorId, date, timeSlot, excludeBookingId = null) {
    if (!counsellorId || !date || !timeSlot) return null;
    const conflict = state.bookings.find(b => {
      if (excludeBookingId && b.id === excludeBookingId) return false;
      if (b.status === 'cancelled' || b.status === 'completed' || b.status === 'no_show') return false;
      return b.assignedCounsellor === counsellorId && b.preferredDate === date && b.preferredTime === timeSlot;
    });
    return conflict || null;
  }

  // ─── GOOGLE MEET LINK UPDATER ───
  function updateBookingMeetLink(id, meetLink, authorName) {
    const bk = state.bookings.find(b => b.id === id);
    if (!bk) return false;
    bk.googleMeetLink = meetLink;
    if (!Array.isArray(bk.notes)) bk.notes = [];
    bk.notes.unshift({
      id: 'bn_' + Date.now(),
      text: `Google Meet link configured: ${meetLink}`,
      addedBy: authorName || 'Staff',
      addedAt: new Date().toISOString()
    });
    saveStore();
    return true;
  }

  // ─── UNIFIED STUDENT PROFILE LOOKUP ───
  function getStudentProfile(identifier) {
    if (!identifier) return null;
    const norm = identifier.trim().toLowerCase();
    const cleanPhone = identifier.replace(/[^0-9]/g, '');

    const matchedEnquiries = state.enquiries.filter(e => {
      const ePhone = (e.mobile || '').replace(/[^0-9]/g, '');
      const eEmail = (e.email || '').trim().toLowerCase();
      return (cleanPhone && cleanPhone.length >= 7 && ePhone.includes(cleanPhone)) || (eEmail && eEmail === norm);
    });

    const matchedBookings = state.bookings.filter(b => {
      const bPhone = (b.mobile || '').replace(/[^0-9]/g, '');
      const bEmail = (b.email || '').trim().toLowerCase();
      return (cleanPhone && cleanPhone.length >= 7 && bPhone.includes(cleanPhone)) || (bEmail && bEmail === norm);
    });

    if (matchedEnquiries.length === 0 && matchedBookings.length === 0) {
      return null;
    }

    const prime = matchedEnquiries[0] || matchedBookings[0];

    // Combine notes
    const combinedNotes = [];
    matchedEnquiries.forEach(e => {
      (e.notes || []).forEach(n => combinedNotes.push({ ...n, source: `Enquiry #${e.id}`, type: 'enquiry' }));
    });
    matchedBookings.forEach(b => {
      (b.notes || []).forEach(n => combinedNotes.push({ ...n, source: `Booking #${b.id}`, type: 'booking' }));
    });
    combinedNotes.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));

    // Combine follow-ups
    const combinedFollowUps = [];
    matchedEnquiries.forEach(e => {
      (e.followUps || []).forEach(fu => combinedFollowUps.push({ ...fu, sourceId: e.id, sourceType: 'enquiry' }));
    });
    matchedBookings.forEach(b => {
      (b.followUps || []).forEach(fu => combinedFollowUps.push({ ...fu, sourceId: b.id, sourceType: 'booking' }));
    });

    return {
      studentName: prime.studentName,
      mobile: prime.mobile,
      email: prime.email,
      qualification: prime.qualification || 'Graduation / Post Graduation',
      targetExamination: prime.targetExamination,
      courseCategory: prime.courseCategory,
      enquiries: matchedEnquiries,
      bookings: matchedBookings,
      notes: combinedNotes,
      followUps: combinedFollowUps
    };
  }

  // ─── CSV EXPORT GENERATORS ───
  function exportAdmissionsCSV(enquiries) {
    const list = Array.isArray(enquiries) ? enquiries : state.enquiries;
    const headers = ['Enquiry ID', 'Student Name', 'Mobile', 'Email', 'Course Category', 'Target Exam', 'Qualification', 'Preferred Batch', 'Mode', 'Assigned Counsellor', 'Status', 'Submission Date'];
    const rows = list.map(e => [
      e.id,
      `"${(e.studentName || '').replace(/"/g, '""')}"`,
      e.mobile,
      e.email,
      `"${(e.courseCategory || '').replace(/"/g, '""')}"`,
      `"${(e.targetExamination || '').replace(/"/g, '""')}"`,
      `"${(e.qualification || '').replace(/"/g, '""')}"`,
      `"${(e.preferredBatch || '').replace(/"/g, '""')}"`,
      e.learningMode || 'Offline Classroom',
      `"${getCounsellorName(e.assignedCounsellor).replace(/"/g, '""')}"`,
      e.status,
      e.submittedAt
    ]);
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  function exportBookingsCSV(bookings) {
    const list = Array.isArray(bookings) ? bookings : state.bookings;
    const headers = ['Booking ID', 'Student Name', 'Mobile', 'Email', 'Target Exam', 'Preferred Date', 'Time Slot', 'Medium', 'Google Meet Link', 'Assigned Mentor', 'Status', 'Submitted At'];
    const rows = list.map(b => [
      b.id,
      `"${(b.studentName || '').replace(/"/g, '""')}"`,
      b.mobile,
      b.email,
      `"${(b.targetExamination || '').replace(/"/g, '""')}"`,
      b.preferredDate,
      `"${(b.preferredTime || '').replace(/"/g, '""')}"`,
      `"${(b.sessionMedium || '').replace(/"/g, '""')}"`,
      `"${(b.googleMeetLink || '').replace(/"/g, '""')}"`,
      `"${getCounsellorName(b.assignedCounsellor).replace(/"/g, '""')}"`,
      b.status,
      b.submittedAt
    ]);
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  function exportReportsCSV() {
    const stats = getStats();
    const headers = ['Metric', 'Count / Value'];
    const rows = [
      ['Total Admission Enquiries', stats.totalEnquiries],
      ['New Leads', stats.newEnquiries],
      ['Assigned Leads', stats.assignedEnquiries],
      ['Contacted Leads', stats.contactedEnquiries],
      ['Interested Leads', stats.interestedEnquiries],
      ['Converted Admissions', stats.convertedEnquiries],
      ['Total Counselling Bookings', stats.totalBookings],
      ['Pending Bookings', stats.pendingBookings],
      ['Confirmed Appointments', stats.confirmedBookings],
      ['Active Counsellors', stats.totalCounsellors],
      ['Overall Institute Conversion Rate', stats.conversionRate + '%']
    ];
    return [headers.join(','), ...rows.map(r => `"${r[0]}","${r[1]}"`)].join('\n');
  }

  return {
    get users() { return state.users; },
    get DEMO_USERS() { return state.users; },
    get counsellors() { return state.counsellors; },
    get COUNSELLORS() { return state.counsellors; },
    get enquiries() { return state.enquiries; },
    get ENQUIRIES() { return state.enquiries; },
    get bookings() { return state.bookings; },
    get BOOKINGS() { return state.bookings; },
    get courses() { return state.courses; },
    get COURSES_BATCHES() { return state.courses; },
    get activity() { return state.activity; },
    get RECENT_ACTIVITY() { return state.activity; },
    get analytics() { return state.analytics; },
    get ANALYTICS() { return state.analytics; },
    // Queries
    getStats,
    getAllFollowUps,
    getDataForRole,
    getCounsellorName,
    getStatusConfig,
    getCounsellorWorkload,
    // Extended Queries & Capabilities
    authenticate,
    isTourCompleted,
    setTourCompleted,
    checkDoubleBooking,
    getStudentProfile,
    exportAdmissionsCSV,
    exportBookingsCSV,
    exportReportsCSV,
    updateBookingMeetLink,
    // Mutations
    updateEnquiry,
    addEnquiryNote,
    scheduleEnquiryFollowUp,
    updateBooking,
    addBookingNote,
    rescheduleBooking,
    scheduleBookingFollowUp,
    completeFollowUp,
    addCounsellor,
    updateCounsellor,
    toggleCounsellorStatus,
    addBatch,
    toggleBatchStatus,
    resetDemoData,
    saveStore
  };
})();
