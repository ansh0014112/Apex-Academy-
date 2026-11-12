/**
 * APEX ACADEMY — Centralized Course & Examination Configuration
 * Canonical repository for all three major program categories, examinations,
 * subjects, target student audiences, visual assets, and dynamic form options.
 */

const APEX_COURSES = [
  {
    id: "civil-services-ssc",
    name: "Civil Services & SSC Exam Preparation",
    shortName: "Civil Services & SSC",
    category: "Civil Services & SSC",
    badge: "Flagship Academy Cohort",
    image: "assets/images/course-civil-services-ssc.jpg",
    imageAlt: "Civil Services & SSC Examination Preparation - Apex Academy",
    description: "An elite, multi-tiered preparation program combining rigorous conceptual depth, administrative analytical thinking, and high-speed calculation heuristics. Designed for serious aspirants targeting premier Central & State administrative and officer cadres.",
    audience: "Graduates, final-year college students, and determined aspirants aiming for Group A & Group B Gazetted and Non-Gazetted government officer roles across India.",
    status: "Admissions Open",
    duration: "10 – 12 Months Comprehensive",
    mode: "Delhi Flagship Offline & Interactive Live Hybrid",
    batchOptions: [
      "Morning Batch (08:00 AM – 11:30 AM)",
      "Evening Batch (04:30 PM – 08:00 PM)",
      "Weekend Executive Intensive (Sat & Sun)"
    ],
    examGroups: [
      {
        groupTitle: "Civil Services Examinations",
        exams: [
          { id: "upsc-cse", name: "UPSC Civil Services Examination (CSE)", badge: "All-India IAS/IPS/IFS" },
          { id: "state-pcs", name: "State Public Service Commission (State PCS)", badge: "State Administrative Services" }
        ]
      },
      {
        groupTitle: "Staff Selection Commission (SSC)",
        exams: [
          { id: "ssc-cgl", name: "SSC CGL (Combined Graduate Level)", badge: "Inspectors & ASO Cadres" },
          { id: "ssc-chsl", name: "SSC CHSL (10+2 Level)", badge: "Postal & Sorting Assistant" },
          { id: "ssc-gd", name: "SSC GD (General Duty Constable)", badge: "Central Armed Forces" },
          { id: "ssc-mts", name: "SSC MTS (Multi-Tasking Staff)", badge: "Central Subordinate" }
        ]
      },
      {
        groupTitle: "State-Level Competitive Exams",
        exams: [
          { id: "state-subordinate", name: "State Subordinate & Administrative Services", badge: "State Govt Departments" }
        ]
      }
    ],
    // Flat list of target examinations for dropdowns
    examinationList: [
      "UPSC Civil Services Examination (CSE)",
      "State Public Service Commission (State PCS)",
      "SSC CGL (Combined Graduate Level)",
      "SSC CHSL (Combined Higher Secondary)",
      "SSC GD (General Duty Constable)",
      "SSC MTS (Multi-Tasking Staff)",
      "State Subordinate & Administrative Exams"
    ],
    subjects: [
      "Quantitative Aptitude & Advanced Higher Mathematics",
      "General Intelligence, Analytical & Spatial Reasoning",
      "English Language Comprehension & Descriptive Drafting",
      "Indian Polity, Constitution & Public Governance",
      "Indian & World History, Art & Culture",
      "Macro-Economics, Budget Analysis & Economic Survey",
      "Physical, Indian & Human Geography, Environment & Ecology",
      "Daily National & International Current Affairs Briefings"
    ],
    features: [
      "Daily 4-Hour Modular Lecture Plan with Concept-to-Speed Transition",
      "Direct Mentorship by Ex-Civil Servants and Top 0.1% SSC CGL Rankers",
      "Forensic 15-Year PYQ (Previous Year Questions) Pattern Deconstruction",
      "TCS-iON Calibrated Daily Computer-Based Testing (CBT) Speed Laboratories",
      "Strict Cohort Cap (Max 45 Aspirants) with Weekly Individual Score Audits"
    ]
  },
  {
    id: "banking-railway",
    name: "Banking & Railway Exam Preparation",
    shortName: "Banking & Railway",
    category: "Banking & Railway",
    badge: "Speed & Precision Rankers",
    image: "assets/images/course-banking-railway.jpg",
    imageAlt: "Banking & Railway Exam Preparation - Apex Academy",
    description: "High-precision, speed-oriented examination program engineered specifically for banking officer cadres and technical/non-technical railway recruitment vacancies. Emphasizes sub-second calculations, complex puzzle heuristics, and exam-timed diagnostic drills.",
    audience: "Graduates, final-year degree students, and technical/diploma holders targeting high-stability, career-track positions in Nationalized Banks, the Reserve Bank of India, and Indian Railways.",
    status: "Admissions Open",
    duration: "6 – 8 Months Targeted",
    mode: "Delhi Flagship Offline & Interactive Live Hybrid",
    batchOptions: [
      "Morning Batch (08:00 AM – 11:30 AM)",
      "Evening Batch (04:30 PM – 08:00 PM)",
      "Weekend Intensive (Sat & Sun)"
    ],
    examGroups: [
      {
        groupTitle: "Banking Examinations",
        exams: [
          { id: "ibps-po", name: "IBPS PO (Probationary Officer)", badge: "Public Sector Banks" },
          { id: "ibps-clerk", name: "IBPS Clerk (Clerical Cadre)", badge: "Nationalized Banks" },
          { id: "sbi-po", name: "SBI PO (State Bank of India)", badge: "Premier Bank Cadre" },
          { id: "sbi-clerk", name: "SBI Clerk (Junior Associate)", badge: "State Bank Cadre" },
          { id: "rbi-assistant", name: "RBI Assistant (Reserve Bank of India)", badge: "Central Banking Apex" }
        ]
      },
      {
        groupTitle: "Railway Examinations (RRB)",
        exams: [
          { id: "rrb-ntpc", name: "RRB NTPC (Non-Technical Popular Categories)", badge: "Station Master, Goods Guard, TA" },
          { id: "rrb-group-d", name: "RRB Group D (Track Maintainer & Operations)", badge: "Indian Railways Technical" },
          { id: "rrb-alp", name: "RRB ALP (Assistant Loco Pilot)", badge: "Technical Locomotives" },
          { id: "rrb-technician", name: "RRB Technician (Grade I & III)", badge: "Railway Technical Workshops" }
        ]
      }
    ],
    // Flat list of target examinations for dropdowns
    examinationList: [
      "IBPS PO (Probationary Officer)",
      "IBPS Clerk (Clerical Cadre)",
      "SBI PO (State Bank of India)",
      "SBI Clerk (Junior Associate)",
      "RBI Assistant (Reserve Bank)",
      "RRB NTPC (Non-Technical Popular Categories)",
      "RRB Group D (Operations & Maintenance)",
      "RRB ALP (Assistant Loco Pilot)",
      "RRB Technician (Grade I & III)"
    ],
    subjects: [
      "Advanced Quantitative Aptitude & Complex Data Interpretation (DI)",
      "High-Level Puzzles, Circular Seating & Logical Arrangements",
      "Banking & Financial System Awareness, RBI Monetary Policy Updates",
      "General Science (Physics, Chemistry, Life Sciences for RRB ALP/Tech)",
      "Basic Science & Engineering Concepts for Technical Railways",
      "English Verbal Ability, Grammar Heuristics & Editorial Comprehension",
      "Static General Knowledge & Indian Railways Operational History",
      "Sub-Second Calculation Shortcuts & Vedic Speed Matrices"
    ],
    features: [
      "Sectional Speed Drills with Real-Time Accuracy Diagnostic Tracking",
      "Dedicated Technical Coaching for RRB ALP & Technician Candidates",
      "Realistic Panel Mock Interviews Led by Retired Bank General Managers",
      "High-Frequency 100+ Full-Length Mock Exams with Adaptive Difficulty"
    ]
  },
  {
    id: "foundation",
    name: "APEX Foundation Program",
    shortName: "Foundation Program",
    category: "Foundation Program",
    badge: "Early Career Advantage",
    image: "assets/images/course-foundation.jpg",
    imageAlt: "APEX Foundation Program - Govt Exam Beginner Batch",
    description: "A transformative bridge curriculum constructed specifically to eliminate fear of mathematics, build intuitive reasoning logic, master standard English comprehension, and establish a firm grounding in General Studies from fundamental NCERT first principles.",
    audience: "Students who have completed Class 12, undergraduate college students (1st, 2nd, and 3rd year), and beginners preparing early for future competitive government examinations.",
    status: "Upcoming Cohort",
    duration: "6 Months Comprehensive Foundation",
    mode: "Delhi Flagship Classroom & Interactive Live Hybrid",
    batchOptions: [
      "Morning Foundation (08:30 AM – 11:30 AM)",
      "Evening Foundation (04:30 PM – 07:30 PM)",
      "College Weekend Special (Sat & Sun Extended)"
    ],
    examGroups: [
      {
        groupTitle: "Foundation Curriculum Tracks",
        exams: [
          { id: "foundation-beginner", name: "All-Govt Exam Beginner Foundation (SSC, Bank & Railways)", badge: "Comprehensive Base" },
          { id: "foundation-undergrad", name: "Undergraduate 1-Year Early Career Track", badge: "College Flexible" },
          { id: "foundation-basics", name: "Fundamental Quantitative & Reasoning Skill-Builder", badge: "Zero-Level Starter" }
        ]
      }
    ],
    // Flat list of target examinations for dropdowns
    examinationList: [
      "All-Govt Exam Beginner Foundation (SSC, Bank, Railway)",
      "Undergraduate 1-Year Early Career Track",
      "Fundamental Quantitative & Reasoning Skill-Builder"
    ],
    subjects: [
      "Basic Mathematics & Arithmetic Fundamentals (NCERT Class 6–10 Base)",
      "Quantitative Aptitude Core Concepts & Number Intuition",
      "Basic Logical Reasoning & Structural Problem-Solving Frameworks",
      "English Language Foundations: Grammar Rules, Vocabulary & Reading",
      "General Awareness Fundamentals: Indian Constitution, History & Geography",
      "General Science Basics: Everyday Physics, Chemistry & Biology",
      "Essential Study Skills: Forensic Syllabus Mapping & Notes-Making",
      "Examination Psychology, Error-Log Maintenance & Time Management"
    ],
    features: [
      "Zero-Presumption Instruction: Concepts Taught From Absolute Ground Up",
      "Supportive Small-Cohort Environment (Max 45 Students) for Fear-Free Learning",
      "Personalized Weekly Diagnostic Audits to Identify & Correct Weaknesses",
      "Seamless Direct Progression Pathway into Specialised Exam Cohorts"
    ]
  }
];

// Helper utilities for lookup and form synchronization
function getCourseById(courseId) {
  if (!courseId) return null;
  const cleanId = courseId.toLowerCase().trim();
  return APEX_COURSES.find(c => 
    c.id === cleanId || 
    c.id.includes(cleanId) || 
    cleanId.includes(c.id) ||
    c.name.toLowerCase().includes(cleanId)
  ) || null;
}

function getAllCourses() {
  return APEX_COURSES;
}

function getExamsByCourseId(courseId) {
  const course = getCourseById(courseId);
  return course ? course.examinationList : [];
}

// Export for module environments if present
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { APEX_COURSES, getCourseById, getAllCourses, getExamsByCourseId };
}
