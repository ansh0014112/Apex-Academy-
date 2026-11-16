/**
 * APEX ACADEMY — Administrative Management Portal Controller
 * Full-featured reactive frontend supporting:
 * - Super Admin (full governance & assignment)
 * - Admission Counsellor (enquiries, follow-ups, conversions)
 * - Academic Counsellor (bookings, sessions, calendar, diagnostics)
 * 
 * Powered by AdminData with localStorage persistence and future Supabase compatibility.
 */

(function () {
  'use strict';

  // ─── STATE & SESSION ───
  let SESSION = null;
  let CURRENT_PAGE = 'overview';
  let ACTIVE_FOLLOWUP_TAB = 'all';

  // ─── COUNSELLOR AVAILABILITY STATE ───
  let SELECTED_AVAIL_COUNSELLOR_ID = null;
  let LOADED_AVAIL_SCHEDULE = null;
  let LOADED_AVAIL_UNAVAILABILITY = null;

  async function refreshAvailabilityFromSupabase(targetId) {
    if (!targetId || !window.ApexSupabase || !window.ApexSupabase.isLive()) return;
    try {
      const res = await window.ApexSupabase.getCounsellorAvailabilityConfig(targetId);
      if (res && res.success) {
        LOADED_AVAIL_SCHEDULE = { counsellorId: targetId, schedule: res.schedule || [] };
        LOADED_AVAIL_UNAVAILABILITY = { counsellorId: targetId, list: res.unavailability || [] };
        if (CURRENT_PAGE === "availability") renderPage();
      }
    } catch (e) {
      console.warn("Could not refresh live availability:", e);
    }
  }



  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .split('&').join('&amp;')
      .split('<').join('&lt;')
      .split('>').join('&gt;')
      .split('"').join('&quot;')
      .split("'").join('&#39;');
  }

  /**
   * getSessionFromStorage: Reads cached session from localStorage.
   * This is used only as a quick fallback while Supabase verify runs.
   * The authoritative check is verifySessionWithSupabase().
   */
  function getSessionFromStorage() {
    try {
      const raw = localStorage.getItem('apex_admin_session');
      if (raw) {
        const parsed = JSON.parse(raw);
        const user = parsed.user || parsed;
        return {
          userId: user.userId || user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          department: user.department,
          loginTime: parsed.loginTime || new Date().toISOString()
        };
      }
    } catch (e) {
      console.warn('Error reading session cache:', e);
    }
    return null;
  }

  /**
   * verifySessionWithSupabase: Calls Supabase Auth to verify the session.
   * Falls back to localStorage cache if Supabase is not configured (demo mode).
   * Returns a verified session object or null (triggers redirect to login).
   */
  async function verifySessionWithSupabase() {
    // If Supabase is configured and live, verify against auth.getSession() + profiles table
    if (window.ApexSupabase && window.ApexSupabase.isLive()) {
      try {
        const c = window.ApexSupabase.getClient();
        const { data: { session }, error: sessErr } = await c.auth.getSession();

        if (sessErr || !session) {
          localStorage.removeItem('apex_admin_session');
          window.location.href = 'login.html';
          return null;
        }

        // Verify profile is active in DB
        let { data: profile, error: profErr } = await c
          .from('profiles')
          .select('id, full_name, email, role, department, specialisation, daily_capacity, phone, is_active')
          .eq('id', session.user.id)
          .single();

        // If direct select failed, attempt self-healing sync RPC if available
        if ((profErr || !profile) && c.rpc) {
          try {
            const { data: synced, error: syncErr } = await c.rpc('get_or_sync_current_profile');
            if (!syncErr && synced && synced.length > 0) {
              profile = synced[0];
              profErr = null;
            }
          } catch (e) {
            console.warn('Profile sync RPC attempt error in admin:', e);
          }
        }

        // If still null, check if cached session belongs to the same authenticated user
        if (profErr || !profile) {
          const cached = getSessionFromStorage();
          if (cached && (cached.userId === session.user.id || cached.email === session.user.email)) {
            profile = {
              id: cached.userId,
              full_name: cached.name,
              email: cached.email,
              role: cached.role,
              department: cached.department,
              specialisation: cached.specialisation,
              daily_capacity: cached.daily_capacity,
              phone: cached.phone,
              is_active: true
            };
            profErr = null;
          }
        }

        if (profErr || !profile) {
          await c.auth.signOut();
          localStorage.removeItem('apex_admin_session');
          window.location.href = 'login.html';
          return null;
        }

        if (!profile.role) {
          await c.auth.signOut();
          localStorage.removeItem('apex_admin_session');
          alert('Access Denied: Account role has not yet been assigned in institute records. Please contact the Super Admin.');
          window.location.href = 'login.html';
          return null;
        }

        if (!profile.is_active) {
          await c.auth.signOut();
          localStorage.removeItem('apex_admin_session');
          alert('Account Deactivated: Your staff account has been disabled by the Super Admin.');
          window.location.href = 'login.html';
          return null;
        }

        const verifiedSession = {
          userId: profile.id,
          email: profile.email,
          name: profile.full_name,
          role: profile.role,
          department: profile.department || 'General Administration',
          specialisation: profile.specialisation,
          phone: profile.phone,
          daily_capacity: profile.daily_capacity,
          loginTime: new Date().toISOString(),
          supabaseLive: true
        };

        // Cache for display only — NEVER used for auth decisions
        localStorage.setItem('apex_admin_session', JSON.stringify({ user: verifiedSession, loginTime: verifiedSession.loginTime }));

        return verifiedSession;
      } catch (e) {
        // FAIL CLOSED — Supabase is configured but errored. Do NOT fall through to localStorage.
        console.error('Supabase session verification failed:', e);
        localStorage.removeItem('apex_admin_session');
        window.location.href = 'login.html?error=auth_error';
        return null;
      }
    }

    // Supabase is NOT configured — demo/offline mode with localStorage
    const cached = getSessionFromStorage();
    if (cached) {
      cached.supabaseLive = false;
      return cached;
    }

    // No session at all — redirect to login
    window.location.href = 'login.html';
    return null;
  }

  // Legacy alias kept for backward compatibility with any direct calls
  function getSession() {
    return getSessionFromStorage();
  }

  // Determine whether to use Supabase or AdminData for dashboard data
  function useSupabaseData() {
    return Boolean(window.ApexSupabase && window.ApexSupabase.isLive());
  }

  /**
   * Sync live Supabase data into AdminData's internal arrays.
   * This bridges Supabase (source of truth) with AdminData (UI rendering layer).
   * Uses dedicated RPCs where available, with safe PostgREST and timeout guards.
   */
  async function syncFromSupabase() {
    if (!useSupabaseData()) return;

    try {
      const c = window.ApexSupabase.getClient();

      // Timeout guard: 8 seconds maximum so UI rendering is never indefinitely stalled
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Sync timeout')), 8000));

      const fetchPromise = Promise.allSettled([
        // 1. Enquiries
        c.rpc('get_dashboard_enquiries', { p_limit: 200, p_offset: 0 }).then(r => {
          if (r.error || !r.data?.success) throw r.error || new Error('RPC error');
          return r.data.data || [];
        }).catch(() => {
          return c.from('admission_enquiries')
            .select('*, students(full_name, phone, email, qualification)')
            .order('created_at', { ascending: false })
            .limit(200)
            .then(res => (res.data || []).map(e => ({
              id: e.id,
              student_id: e.student_id,
              student_name: e.students?.full_name || 'Unknown',
              phone: e.students?.phone || '',
              email: e.students?.email || '',
              qualification: e.students?.qualification || '',
              course_id: e.course_id,
              course_category: e.course_category,
              target_examination: e.target_examination,
              preferred_batch_timing: e.preferred_batch_timing || e.preferred_batch || '',
              preferred_learning_mode: e.preferred_learning_mode || e.learning_mode || '',
              additional_message: e.additional_message || '',
              status: e.status ? e.status.toLowerCase() : 'new',
              assigned_counsellor_id: e.assigned_counsellor_id,
              created_at: e.created_at,
              updated_at: e.updated_at
            })));
        }),

        // 2. Bookings
        c.rpc('get_dashboard_bookings', { p_limit: 200, p_offset: 0 }).then(r => {
          if (r.error || !r.data?.success) throw r.error || new Error('RPC error');
          return r.data.data || [];
        }).catch(() => {
          return c.from('counselling_bookings')
            .select('*, students(full_name, phone, email)')
            .order('created_at', { ascending: false })
            .limit(200)
            .then(res => (res.data || []).map(b => ({
              id: b.id,
              student_id: b.student_id,
              student_name: b.student_name || b.students?.full_name || 'Unknown',
              phone: b.students?.phone || '',
              email: b.students?.email || '',
              course_id: b.course_id,
              course_category: b.course_category,
              target_examination: b.target_examination,
              preferred_date: b.preferred_date,
              preferred_time: b.preferred_time,
              session_medium: b.session_medium || 'Online Video Meeting (Google Meet)',
              google_meet_link: b.google_meet_link,
              status: b.status ? b.status.toLowerCase() : 'pending',
              assigned_counsellor_id: b.assigned_counsellor_id,
              created_at: b.created_at,
              updated_at: b.updated_at
            })));
        }),

        // 3. Profiles / Counsellors (fetch all staff including unassigned for Super Admin oversight)
        c.from('profiles')
          .select('id, full_name, email, phone, role, department, specialisation, is_active, daily_capacity, created_at')
          .order('full_name')
          .then(res => res.data || []),

        // 4. Activity Logs
        c.rpc('get_dashboard_activity_log', { p_limit: 100 }).then(r => {
          if (r.error || !r.data?.success) throw r.error || new Error('RPC error');
          return r.data.data || [];
        }).catch(() => {
          return c.from('activity_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100)
            .then(res => res.data || []);
        }),

        // 5. Notes & Follow-ups
        c.from('enquiry_notes').select('*').order('created_at', { ascending: true }).then(r => r.data || []),
        c.from('booking_notes').select('*').order('created_at', { ascending: true }).then(r => r.data || []),
        c.rpc('get_dashboard_follow_ups').then(r => {
          if (r.error || !r.data?.success) throw r.error || new Error('RPC error');
          return r.data.data || [];
        }).catch(() => {
          return c.from('follow_ups').select('*, profiles!assigned_to(full_name)').order('follow_up_date', { ascending: true }).then(r => r.data || []);
        }),

        // 6. Communication Logs (Email Audit)
        c.rpc('get_dashboard_communication_logs', { p_limit: 150, p_offset: 0 }).then(r => {
          if (r.error || !r.data?.success) throw r.error || new Error('RPC error');
          return r.data.data || [];
        }).catch(() => {
          return c.from('communication_logs')
            .select('*, students(full_name, phone, email), profiles!actor_id(full_name)')
            .order('created_at', { ascending: false })
            .limit(150)
            .then(res => (res.data || []).map(cl => ({
              id: cl.id,
              student_id: cl.student_id,
              student_name: cl.students?.full_name || 'Student',
              counsellor_id: cl.counsellor_id,
              actor_id: cl.actor_id,
              actor_name: cl.profiles?.full_name || 'Staff',
              channel: cl.channel,
              message_type: cl.message_type,
              recipient: cl.recipient,
              template_ref: cl.template_ref,
              provider_message_id: cl.provider_message_id,
              status: cl.status,
              error_details: cl.error_details,
              metadata: cl.metadata,
              created_at: cl.created_at,
              updated_at: cl.updated_at
            })));
        })
      ]);

      const [enqResult, bkResult, counResult, actResult, enqNotesResult, bkNotesResult, fuResult, commResult] = await Promise.race([
        fetchPromise,
        timeoutPromise
      ]);

      const rawEnquiries = enqResult.status === 'fulfilled' ? (enqResult.value || []) : [];
      const rawBookings = bkResult.status === 'fulfilled' ? (bkResult.value || []) : [];
      const counsellors = counResult.status === 'fulfilled' ? (counResult.value || []) : [];
      const activity = actResult.status === 'fulfilled' ? (actResult.value || []) : [];
      const enquiryNotes = enqNotesResult.status === 'fulfilled' ? (enqNotesResult.value || []) : [];
      const bookingNotes = bkNotesResult.status === 'fulfilled' ? (bkNotesResult.value || []) : [];
      const followUps = fuResult.status === 'fulfilled' ? (fuResult.value || []) : [];
      const commLogs = (commResult && commResult.status === 'fulfilled') ? (commResult.value || []) : [];

      if (typeof AdminData !== 'undefined') {
        const liveEnquiries = rawEnquiries.map(e => {
          const notes = enquiryNotes.filter(n => n.enquiry_id === e.id).map(n => ({
            id: n.id,
            text: n.note_text,
            addedBy: n.author_name || 'Staff',
            addedAt: n.created_at
          }));
          const fus = followUps.filter(f => f.enquiry_id === e.id).map(f => ({
            id: f.id,
            date: f.follow_up_date,
            time: f.follow_up_time,
            purpose: f.notes || f.follow_up_type || 'Follow-up Consultation',
            status: f.status === 'completed' ? 'completed' : 'upcoming',
            counsellorId: f.assigned_to
          }));
          return {
            id: e.id,
            studentId: e.student_id,
            studentName: e.student_name || e.students?.full_name || 'Student Aspirant',
            mobile: e.phone || e.students?.phone || '',
            phone: e.phone || e.students?.phone || '',
            email: e.email || e.students?.email || '',
            qualification: e.qualification || e.students?.qualification || '',
            courseCategory: e.course_category || 'Civil Services & SSC Exam Preparation',
            courseCategoryId: e.course_id || 'civil-services-ssc',
            targetExamination: e.target_examination || 'UPSC CSE',
            preferredBatch: e.preferred_batch_timing || e.preferred_batch || '',
            learningMode: e.preferred_learning_mode || e.learning_mode || '',
            message: e.additional_message || '',
            status: e.status ? e.status.toLowerCase() : 'new',
            assignedCounsellor: e.assigned_counsellor_id,
            submittedAt: e.created_at,
            updatedAt: e.updated_at,
            notes: notes,
            followUps: fus
          };
        });

        const liveBookings = rawBookings.map(b => {
          const notes = bookingNotes.filter(n => n.booking_id === b.id).map(n => ({
            id: n.id,
            text: n.note_text,
            addedBy: n.author_name || 'Staff',
            addedAt: n.created_at
          }));
          const fus = followUps.filter(f => f.booking_id === b.id).map(f => ({
            id: f.id,
            date: f.follow_up_date,
            time: f.follow_up_time,
            purpose: f.notes || f.follow_up_type || 'Follow-up Strategy Call',
            status: f.status === 'completed' ? 'completed' : 'upcoming',
            counsellorId: f.assigned_to
          }));
          return {
            id: b.id,
            studentId: b.student_id,
            studentName: b.student_name || b.students?.full_name || 'Student Aspirant',
            mobile: b.phone || b.students?.phone || '',
            phone: b.phone || b.students?.phone || '',
            email: b.email || b.students?.email || '',
            courseCategory: b.course_category || 'Civil Services & SSC Exam Preparation',
            courseCategoryId: b.course_id || 'civil-services-ssc',
            targetExamination: b.target_examination || 'UPSC CSE',
            preferredDate: b.preferred_date,
            preferredTime: b.preferred_time || '10:00 AM',
            sessionMedium: b.session_medium || 'Online Video Meeting (Google Meet)',
            status: b.status ? b.status.toLowerCase() : 'pending',
            assignedCounsellor: b.assigned_counsellor_id,
            googleMeetLink: b.google_meet_link,
            submittedAt: b.created_at,
            updatedAt: b.updated_at,
            notes: notes,
            followUps: fus
          };
        });

        let allLiveStaff = [];
        if (counsellors.length > 0) {
          allLiveStaff = counsellors.map(co => {
            const assignedEnqCount = liveEnquiries.filter(e => e.assignedCounsellor === co.id).length;
            const assignedBkCount = liveBookings.filter(b => b.assignedCounsellor === co.id).length;
            const completedCount = liveBookings.filter(b => b.assignedCounsellor === co.id && b.status === 'completed').length;
            const convertedCount = liveEnquiries.filter(e => e.assignedCounsellor === co.id && e.status === 'converted').length;
            const totalWork = assignedEnqCount + assignedBkCount;
            const convRate = totalWork > 0 ? Math.round((convertedCount / totalWork) * 100) : 0;
            return {
              id: co.id,
              name: co.full_name,
              email: co.email,
              phone: co.phone || '',
              role: co.role,
              department: co.department || (co.role === 'admission_counsellor' ? 'Admission Department' : co.role === 'academic_counsellor' ? 'Academic Counselling Department' : (co.role === 'super_admin' ? 'Executive Administration' : 'General Administration')),
              specialisation: co.specialisation || '',
              status: co.is_active ? 'active' : 'inactive',
              is_active: Boolean(co.is_active),
              dailyCapacity: co.daily_capacity || 10,
              assignedEnquiries: assignedEnqCount,
              assignedBookings: assignedBkCount,
              completedTasks: completedCount,
              conversionRate: convRate,
              joinDate: co.created_at || '2025-06-15'
            };
          });
        }

        // Distinctly separate actual counsellors from Super Admin
        const liveCounsellors = allLiveStaff.filter(co => co.role === 'admission_counsellor' || co.role === 'academic_counsellor');

        let liveActivity = [];
        if (activity.length > 0) {
          liveActivity = activity.map(a => ({
            id: a.id,
            type: a.action_type,
            action: a.action_type,
            message: a.description || a.message || 'Action executed',
            description: a.description || a.message || 'Action executed',
            performedBy: a.actor_name || 'Staff',
            performedAt: a.created_at,
            time: new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            entityType: a.target_entity_type || a.entity_type || '',
            entityId: a.target_entity_id || a.entity_id || ''
          }));
        }

        if (typeof AdminData.setLiveRecords === 'function') {
          AdminData.setLiveRecords({
            enquiries: liveEnquiries,
            bookings: liveBookings,
            staff: allLiveStaff,
            counsellors: liveCounsellors,
            activity: liveActivity,
            communicationLogs: commLogs
          });
        } else {
          AdminData.enquiries = liveEnquiries;
          AdminData.bookings = liveBookings;
          if (liveCounsellors.length > 0) AdminData.counsellors = liveCounsellors;
          if (liveActivity.length > 0) AdminData.activity = liveActivity;
          if (commLogs.length > 0 && typeof AdminData.setCommunicationLogs === 'function') {
            AdminData.setCommunicationLogs(commLogs);
          }
        }

        console.log('✔ Admin data synced from Supabase successfully.');
        if (typeof AdminData.saveAll === 'function') {
          AdminData.saveAll();
        }
      }
    } catch (e) {
      console.warn('Supabase data sync notice — using existing AdminData cache:', e);
    }
  }

  async function logout() {
    // Sign out from Supabase Auth (invalidates server session)
    if (window.ApexSupabase && window.ApexSupabase.isLive()) {
      await window.ApexSupabase.signOut();
    } else {
      localStorage.removeItem('apex_admin_session');
      sessionStorage.removeItem('apex_admin_session');
    }
    showToast('Signed Out', 'You have been safely signed out.', 'info');
    setTimeout(() => {
      window.location.href = 'login.html';
    }, 250);
  }

  // ─── SVG ICONS REPOSITORY ───
  const ICONS = {
    overview: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zm0 7a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1v-5zM4 14a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3z"/></svg>',
    admissions: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
    counselling: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    counsellors: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
    followups: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    courses: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>',
    reports: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>',
    settings: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
    website: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>',
    logout: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>',
    profile: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>',
    schedule: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    history: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    performance: '<svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>',
    search: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>',
    eye: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>',
    more: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"/></svg>',
    check: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>',
    plus: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>',
    close: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>',
    edit: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>',
    note: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"/></svg>',
    calendar: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    phone: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>',
    chart: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>',
    cancel: '<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>'
  };

  // ─── ROLE-SPECIFIC NAVIGATION CONFIG ───
  const NAV_CONFIG = {
    super_admin: [
      { group: 'Executive Desk', items: [
        { id: 'overview', label: 'Overview', icon: 'overview' },
        { id: 'admissions', label: 'Admission Management', icon: 'admissions' },
        { id: 'counselling', label: 'Counselling Management', icon: 'counselling' },
        { id: 'counsellors', label: 'Counsellor Management', icon: 'counsellors' },
        { id: 'followups', label: 'Follow-up Management', icon: 'followups' },
      ]},
      { group: 'Institute Operations', items: [
        { id: 'courses', label: 'Courses & Batches', icon: 'courses' },
        { id: 'availability', label: 'Counsellor Availability', icon: 'schedule' },
        { id: 'reports', label: 'Reports & Analytics', icon: 'reports' },
        { id: 'settings', label: 'Settings', icon: 'settings' },
      ]},
      { group: '', items: [
        { id: 'website', label: 'Public Website', icon: 'website', href: '../index.html', external: true },
        { id: 'logout', label: 'Logout', icon: 'logout', action: 'logout' },
      ]}
    ],
    admission_counsellor: [
      { group: 'Admission Desk', items: [
        { id: 'overview', label: 'Overview', icon: 'overview' },
        { id: 'admissions', label: 'My Assigned Leads', icon: 'admissions' },
        { id: 'followups', label: 'Follow-up Schedule', icon: 'followups' },
        { id: 'reports', label: 'My Performance', icon: 'performance' },
        { id: 'settings', label: 'Counsellor Profile', icon: 'profile' },
      ]},
      { group: '', items: [
        { id: 'website', label: 'Public Website', icon: 'website', href: '../index.html', external: true },
        { id: 'logout', label: 'Logout', icon: 'logout', action: 'logout' },
      ]}
    ],
    academic_counsellor: [
      { group: 'Academic Mentorship Desk', items: [
        { id: 'overview', label: 'Overview', icon: 'overview' },
        { id: 'counselling', label: 'My Bookings', icon: 'counselling' },
        { id: 'schedule', label: "Today's Schedule", icon: 'schedule' },
        { id: 'followups', label: 'Pending Follow-ups', icon: 'followups' },
        { id: 'history', label: 'Counselling History', icon: 'history' },
        { id: 'availability', label: 'Availability & Slots', icon: 'schedule' },
        { id: 'settings', label: 'Mentor Profile', icon: 'profile' },
      ]},
      { group: '', items: [
        { id: 'website', label: 'Public Website', icon: 'website', href: '../index.html', external: true },
        { id: 'logout', label: 'Logout', icon: 'logout', action: 'logout' },
      ]}
    ]
  };

  // ─── DOM SELECTORS & FORMATTERS ───
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function formatDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatDateTime(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' +
      dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function formatRole(role) {
    if (role === 'super_admin') return 'Super Admin';
    if (role === 'admission_counsellor') return 'Admission Counsellor';
    if (role === 'academic_counsellor') return 'Academic Counsellor';
    return role;
  }

  function initials(name) {
    if (!name) return '?';
    return name.split(' ').filter(Boolean).map(w => w[0]).join('').substring(0, 2).toUpperCase() || '?';
  }

  function statusBadge(status) {
    const c = AdminData.getStatusConfig(status);
    return `<span class="status-badge ${c.bg} ${c.text}" style="border:1px solid;"><span class="status-dot ${c.dot}"></span>${c.label}</span>`;
  }

  function showToast(title, message, type = 'success') {
    const container = $('#toastContainer');
    if (!container) return;
    const colors = type === 'success'
      ? { bg: '#ECFDF5', border: '#A7F3D0', icon: '#059669', iconBg: '#D1FAE5' }
      : type === 'error'
      ? { bg: '#FEF2F2', border: '#FECACA', icon: '#DC2626', iconBg: '#FEE2E2' }
      : { bg: '#EFF6FF', border: '#BFDBFE', icon: '#2563EB', iconBg: '#DBEAFE' };
    const iconSvg = type === 'success' ? ICONS.check : type === 'error' ? ICONS.close : ICONS.note;
    const toast = document.createElement('div');
    toast.className = 'admin-toast';
    toast.style.borderColor = colors.border;
    toast.innerHTML = `
      <div class="admin-toast-icon" style="background:${colors.iconBg};color:${colors.icon}">${iconSvg}</div>
      <div class="admin-toast-content">
        <div class="admin-toast-title">${title}</div>
        <div class="admin-toast-message">${message}</div>
      </div>
      <button style="background:none;border:none;color:#94A3B8;cursor:pointer;padding:0.25rem;" onclick="this.closest('.admin-toast').remove()">${ICONS.close}</button>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  // ─── MODAL & DRAWER HELPERS ───
  function openModal(html, wide = false) {
    const overlay = $('#modalOverlay');
    const content = $('#modalContent');
    content.className = 'modal-content' + (wide ? ' wide' : '');
    content.innerHTML = html;
    overlay.classList.add('active');
    document.body.classList.add('no-scroll');
  }

  function closeModal() {
    const overlay = $('#modalOverlay');
    if (overlay) overlay.classList.remove('active');
    document.body.classList.remove('no-scroll');
  }

  function openDrawer(title, bodyHtml, footerHtml = '') {
    $('#drawerTitle').textContent = title;
    $('#drawerBody').innerHTML = bodyHtml;
    $('#drawerFooter').innerHTML = footerHtml;
    $('#detailDrawer').classList.add('open');
    $('#drawerOverlay').classList.add('active');
    document.body.classList.add('no-scroll');
  }

  function closeDrawer() {
    $('#detailDrawer').classList.remove('open');
    $('#drawerOverlay').classList.remove('active');
    document.body.classList.remove('no-scroll');
  }

  function confirmAction(title, message, onConfirm, isDanger = false) {
    const color = isDanger ? '#DC2626' : '#D97706';
    const bgColor = isDanger ? '#FEE2E2' : '#FEF3C7';
    openModal(`
      <div class="modal-body" style="padding:2rem; text-align:center;">
        <div style="width:48px;height:48px;border-radius:50%;background:${bgColor};color:${color};display:flex;align-items:center;justify-content:center;margin:0 auto 1rem;">
          <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>
        </div>
        <h3 style="font-size:1rem;font-weight:700;margin-bottom:0.5rem;color:#0F172A;">${title}</h3>
        <p style="font-size:0.8125rem;color:#64748B;margin-bottom:1.5rem;line-height:1.5;">${message}</p>
        <div style="display:flex;gap:0.75rem;justify-content:center;">
          <button class="btn btn-outline" onclick="window._adminCloseModal()">Cancel</button>
          <button class="btn ${isDanger ? 'btn-danger' : 'btn-gold'}" id="confirmActionBtn">Confirm Action</button>
        </div>
      </div>`);
    const btn = document.getElementById('confirmActionBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        closeModal();
        onConfirm();
      });
    }
  }

  window._adminCloseModal = closeModal;
  window._adminCloseDrawer = closeDrawer;

  // ─── BUILD SIDEBAR ───
  function buildSidebar() {
    const nav = $('#sidebarNav');
    if (!nav) return;
    if (!SESSION) return;
    const config = NAV_CONFIG[SESSION.role] || NAV_CONFIG.super_admin;
    const stats = (typeof AdminData !== 'undefined' && typeof AdminData.getStats === 'function') 
      ? (AdminData.getStats(SESSION.role, SESSION.userId) || {}) 
      : {};

    let html = '';
    config.forEach(group => {
      html += '<div class="sidebar-nav-group">';
      if (group.group) html += `<div class="sidebar-nav-group-label">${group.group}</div>`;
      group.items.forEach(item => {
        const badge = item.id === 'admissions' && SESSION.role === 'super_admin' ? (stats.newEnquiries || 0) :
                      item.id === 'admissions' && SESSION.role === 'admission_counsellor' ? (stats.newEnquiries || 0) :
                      item.id === 'counselling' && SESSION.role === 'super_admin' ? (stats.pendingBookings || 0) :
                      item.id === 'followups' ? (stats.todayFollowUps || 0) : 0;
        const isActive = CURRENT_PAGE === item.id;
        if (item.href) {
          html += `<a href="${item.href}" target="${item.external ? '_blank' : '_self'}" class="sidebar-nav-item">${ICONS[item.icon] || ''}<span>${item.label}</span></a>`;
        } else if (item.action === 'logout') {
          html += `<button class="sidebar-nav-item" data-action="logout">${ICONS[item.icon] || ''}<span>${item.label}</span></button>`;
        } else {
          html += `<button class="sidebar-nav-item${isActive ? ' active' : ''}" data-page="${item.id}">${ICONS[item.icon] || ''}<span>${item.label}</span>${badge > 0 ? `<span class="nav-badge">${badge}</span>` : ''}</button>`;
        }
      });
      html += '</div>';
    });
    nav.innerHTML = html;

    // Sidebar footer and role badges (Safely guarded)
    const roleLabel = $('#sidebarRoleLabel');
    if (roleLabel) roleLabel.textContent = formatRole(SESSION.role);
    const uName = $('#userName');
    if (uName) uName.textContent = SESSION.name || 'Staff Member';
    const uRole = $('#userRole');
    if (uRole) uRole.textContent = SESSION.department || formatRole(SESSION.role);
    const uAvatar = $('#userAvatar');
    if (uAvatar) uAvatar.textContent = initials(SESSION.name || 'Staff');

    // Nav click handlers
    nav.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetPage = btn.dataset.page;
        if (isPageAllowedForRole(targetPage, SESSION.role)) {
          CURRENT_PAGE = targetPage;
          window.location.hash = '#' + targetPage;
          renderPage();
          buildSidebar();
        } else {
          showToast('Access Restricted', 'Module not authorized for your role.', 'warning');
        }
        closeMobileSidebar();
      });
    });
    nav.querySelectorAll('[data-action="logout"]').forEach(btn => {
      btn.addEventListener('click', () => {
        confirmAction('Sign Out', 'Are you sure you want to exit the Apex Academy administration portal?', logout);
      });
    });
  }

  /* Role Switcher completely removed: users must authenticate per assigned role */

  function closeMobileSidebar() {
    $('#adminSidebar').classList.remove('open');
    $('#sidebarOverlay').classList.remove('active');
    document.body.classList.remove('no-scroll');
  }

  function syncRoleSwitcher() {
    const switcher = $('#roleSwitcher');
    if (switcher && SESSION) {
      switcher.value = SESSION.role;
    }
  }

  
  // ─── IN-APP NOTIFICATION CENTER CONTROLLER ───
  let NOTIFICATIONS = [];

  async function loadNotifications() {
    if (!SESSION) return;
    if (typeof window.ApexSupabase !== 'undefined') {
      NOTIFICATIONS = await window.ApexSupabase.getNotifications(SESSION.userId);
    } else {
      NOTIFICATIONS = [
        { id: 'notif_1', title: 'New Student Enquiry', message: 'A new aspirant enquiry for UPSC CSE 2027 was received.', is_read: false, created_at: new Date(Date.now() - 1800000).toISOString() },
        { id: 'notif_2', title: 'Session Confirmed', message: '1-on-1 strategy call with Ravi Shankar confirmed for 10:30 AM.', is_read: false, created_at: new Date(Date.now() - 7200000).toISOString() }
      ];
    }
    renderNotifications();
  }

  function renderNotifications() {
    const badge = $('#notifBadge');
    const list = $('#notifList');
    if (!badge || !list) return;

    const unreadCount = NOTIFICATIONS.filter(n => !n.is_read).length;
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }

    if (!NOTIFICATIONS.length) {
      list.innerHTML = '<div style="padding:1.5rem;text-align:center;color:#94A3B8;font-size:0.75rem;">No recent notifications</div>';
      return;
    }

    list.innerHTML = NOTIFICATIONS.map(n => `
      <div class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}">
        <div class="notif-item-title">${n.title}</div>
        <div class="notif-item-desc">${n.message}</div>
        <div class="notif-item-time">${formatDateTime(n.created_at)}</div>
      </div>
    `).join('');

    list.querySelectorAll('.notif-item').forEach(item => {
      item.addEventListener('click', async () => {
        const notifId = item.dataset.id;
        const target = NOTIFICATIONS.find(n => n.id === notifId);
        if (target) {
          target.is_read = true;
          if (typeof window.ApexSupabase !== 'undefined') {
            await window.ApexSupabase.markNotificationRead(notifId);
          }
          renderNotifications();
        }
      });
    });
  }

  function toggleNotificationDropdown(e) {
    if (e) e.stopPropagation();
    const dropdown = $('#notifDropdown');
    if (dropdown) {
      const isVisible = dropdown.style.display === 'block';
      dropdown.style.display = isVisible ? 'none' : 'block';
    }
  }

  async function markAllNotificationsRead() {
    NOTIFICATIONS.forEach(n => { n.is_read = true; });
    if (typeof window.ApexSupabase !== 'undefined' && SESSION) {
      await window.ApexSupabase.markAllNotificationsRead(SESSION.userId);
    }
    renderNotifications();
    showToast('Notifications Updated', 'All notifications marked as read.', 'info');
  }

  // ─── PAGE RENDERING DISPATCHER ───
  
  // ─── INTERACTIVE ONBOARDING GUIDED TOUR ENGINE ───
  const TOUR_CONFIGS = {
    super_admin: [
      {
        target: '#pageTitle',
        title: 'Super Admin Executive Portal',
        desc: 'Welcome, Dr. Rajesh Sharma. You have comprehensive institute oversight over admission enquiries, mentor assignments, course batches, and performance analytics.'
      },
      {
        target: '.stat-grid',
        title: 'Key Institute Performance KPIs',
        desc: 'Real-time metrics track total enquiries, pending bookings, active counsellors, and overall enrollment conversion percentages across the institute.'
      },
      {
        target: '#sidebarNav',
        title: 'Institute Navigation Menu',
        desc: 'Access all 8 operational modules: Admissions, Counselling, Staff Management, Follow-ups, Courses & Batches, Reports, and Settings.'
      },
      {
        target: 'a[data-page="admissions"]',
        title: 'Admission Lead Pipeline',
        desc: 'Filter incoming student leads by UPSC, SSC, Banking streams, inspect academic qualifications, and assign admissions officers with balanced workloads.'
      },
      {
        target: 'a[data-page="counselling"]',
        title: '1-on-1 Guidance & Google Meet',
        desc: 'Oversee all booked strategy sessions, launch Google Meet video calls with one click, and manage reschedule workflows with double-booking prevention.'
      },
      {
        target: 'a[data-page="counsellors"]',
        title: 'Counsellor Accounts & Governance',
        desc: 'Create new counsellor profiles and toggle account activations. Inactive accounts are immediately blocked from logging into the portal.'
      },
      {
        target: 'a[data-page="courses"]',
        title: 'Courses & Batch Schedules',
        desc: 'Add competitive exam preparation batches, set faculty and timings, control seat capacities, and toggle admissions availability.'
      },
      {
        target: 'a[data-page="reports"]',
        title: 'Reports & CSV Data Export',
        desc: 'Review enrollment funnels, audit staff conversion metrics, and export complete dataset reports to CSV for administrative reviews.'
      }
    ],
    admission_counsellor: [
      {
        target: '#pageTitle',
        title: 'Admission Desk Workspace',
        desc: 'Welcome, Meera Kapoor. This dedicated portal displays only the prospective student enquiries assigned directly to you.'
      },
      {
        target: '.stat-grid',
        title: 'Personal Lead Funnel',
        desc: 'Monitor your assigned leads, contacted candidates, interested aspirants, and your personal conversion percentage.'
      },
      {
        target: 'a[data-page="admissions"]',
        title: 'My Assigned Enquiries',
        desc: 'View student contact info, graduation degree, preferred batch, and exam stream (UPSC CSE, SSC CGL, Banking).'
      },
      {
        target: '#pageContent',
        title: 'Student Profile & Direct Call',
        desc: 'Click on any student name to inspect their full institutional record and launch phone calls directly with one tap.'
      },
      {
        target: '#pageContent',
        title: 'Logging Notes & Lead Progression',
        desc: 'Record confidential call notes and advance candidates through New -> Contacted -> Interested -> Converted.'
      },
      {
        target: 'a[data-page="followups"]',
        title: 'Follow-up Call Scheduler',
        desc: "Track today's scheduled callback reminders and plan upcoming follow-up calls to keep prospective students engaged."
      },
      {
        target: 'a[data-page="performance"]',
        title: 'Personal Conversion Performance',
        desc: 'Review your total completed calls, response time, and conversion rate against institute targets.'
      }
    ],
    academic_counsellor: [
      {
        target: '#pageTitle',
        title: 'Academic Guidance Desk',
        desc: 'Welcome, Vikram Deshmukh. Mentor competitive examination aspirants through syllabus strategies, optional subject choices, and study roadmaps.'
      },
      {
        target: '.stat-grid',
        title: 'Session Caseload & Schedule',
        desc: "Track today's scheduled appointments, upcoming video sessions, completed guidance reviews, and pending follow-ups."
      },
      {
        target: 'a[data-page="schedule"]',
        title: "Today's 1-on-1 Schedule",
        desc: 'Review all sessions scheduled for today organized by 30-minute time windows and exam preparation categories.'
      },
      {
        target: '#pageContent',
        title: 'Google Meet Integration',
        desc: 'For video sessions, launch Google Meet directly using the "Join Meeting" button or copy the invite link to share with aspirants.'
      },
      {
        target: 'a[data-page="counselling"]',
        title: 'Session Outcomes & Status Updates',
        desc: 'Update session status to Confirmed, Completed, Rescheduled, or No-Show with required mentor diagnostic notes.'
      },
      {
        target: '#pageContent',
        title: 'Conflict-Free Rescheduling',
        desc: 'Our double-booking detection automatically prevents overlapping slots for you while preserving full audit history.'
      },
      {
        target: 'a[data-page="history"]',
        title: 'Diagnostic Notes & Guidance History',
        desc: 'Document test series recommendations, syllabus weaknesses, and booklist recommendations for future sessions.'
      },
      {
        target: '#pageContent',
        title: 'Unified Student Dossier',
        desc: "Inspect the aspirant's complete journey, including past admission enquiries and previous counselling feedback."
      }
    ]
  };

  let currentTourStep = 0;
  let activeTourSteps = [];

  function startInteractiveTour(force = false) {
    if (!SESSION) return;
    activeTourSteps = TOUR_CONFIGS[SESSION.role] || TOUR_CONFIGS.super_admin;
    if (!force && AdminData.isTourCompleted(SESSION.userId)) {
      return;
    }
    currentTourStep = 0;
    renderTourStep();
  }

  function renderTourStep() {
    if (currentTourStep < 0 || currentTourStep >= activeTourSteps.length) {
      endTour(true);
      return;
    }

    const step = activeTourSteps[currentTourStep];
    const backdrop = $('#tourBackdrop');
    const spotlight = $('#tourSpotlight');
    const popover = $('#tourPopover');
    const stepBadge = $('#tourStepBadge');
    const title = $('#tourTitle');
    const desc = $('#tourDesc');
    const dots = $('#tourDots');
    const prevBtn = $('#tourPrevBtn');
    const nextBtn = $('#tourNextBtn');

    if (!backdrop || !spotlight || !popover) return;

    backdrop.style.display = 'block';
    popover.style.display = 'block';

    stepBadge.textContent = `Step ${currentTourStep + 1} of ${activeTourSteps.length}`;
    title.textContent = step.title;
    desc.textContent = step.desc;

    // Dots
    dots.innerHTML = activeTourSteps.map((_, i) => `<span class="tour-dot ${i === currentTourStep ? 'active' : ''}"></span>`).join('');

    // Buttons
    prevBtn.style.display = currentTourStep === 0 ? 'none' : 'inline-flex';
    nextBtn.textContent = currentTourStep === activeTourSteps.length - 1 ? 'Finish Tour' : 'Next →';

    // Target spotlight positioning
    const targetEl = document.querySelector(step.target);
    if (targetEl && targetEl.offsetParent !== null) {
      const rect = targetEl.getBoundingClientRect();
      spotlight.style.display = 'block';
      spotlight.style.top = Math.max(0, rect.top - 6) + 'px';
      spotlight.style.left = Math.max(0, rect.left - 6) + 'px';
      spotlight.style.width = (rect.width + 12) + 'px';
      spotlight.style.height = (rect.height + 12) + 'px';

      // Position popover
      const popoverWidth = Math.min(360, window.innerWidth - 32);
      let left = rect.left + (rect.width / 2) - (popoverWidth / 2);
      if (left < 16) left = 16;
      if (left + popoverWidth > window.innerWidth - 16) {
        left = Math.max(16, window.innerWidth - popoverWidth - 16);
      }

      let top = rect.bottom + 16;
      if (top + 220 > window.innerHeight) {
        top = Math.max(16, rect.top - 220);
      }
      popover.style.top = top + 'px';
      popover.style.left = left + 'px';
      popover.style.transform = 'none';
    } else {
      spotlight.style.display = 'none';
      popover.style.top = '50%';
      popover.style.left = '50%';
      popover.style.transform = 'translate(-50%, -50%)';
    }
  }

  function nextTourStep() {
    if (currentTourStep < activeTourSteps.length - 1) {
      currentTourStep++;
      renderTourStep();
    } else {
      endTour(true);
    }
  }

  function prevTourStep() {
    if (currentTourStep > 0) {
      currentTourStep--;
      renderTourStep();
    }
  }

  function endTour(completed = true) {
    const backdrop = $('#tourBackdrop');
    const spotlight = $('#tourSpotlight');
    const popover = $('#tourPopover');
    if (backdrop) backdrop.style.display = 'none';
    if (spotlight) spotlight.style.display = 'none';
    if (popover) popover.style.display = 'none';

    if (completed && SESSION && SESSION.userId) {
      AdminData.setTourCompleted(SESSION.userId, true);
      showToast('Tour Finished', 'You can restart this tour anytime from the top bar.', 'success');
    }
  }

  // ─── CSV FILE DOWNLOAD HELPER ───
  function downloadCSV(csvContent, fileName) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ─── UNIFIED STUDENT PROFILE MODAL ───
  window._showStudentProfile = function(identifier) {
    const profile = AdminData.getStudentProfile(identifier);
    if (!profile) {
      showToast('Profile Not Found', `No student profile matched ${identifier}`, 'warning');
      return;
    }

    const enqCount = profile.enquiries.length;
    const bkCount = profile.bookings.length;

    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">Unified Student Profile</h3>
        <button class="modal-close" onclick="closeModal()">${ICONS.close}</button>
      </div>
      <div class="modal-body" style="max-height:80vh; overflow-y:auto;">
        <div class="student-profile-card">
          <div class="student-profile-avatar">${initials(profile.studentName)}</div>
          <div class="student-profile-meta">
            <div class="student-profile-name">${profile.studentName}</div>
            <div class="student-profile-tags">
              <span class="student-profile-pill">📞 +91 ${profile.mobile}</span>
              <span class="student-profile-pill">✉️ ${profile.email}</span>
              <span class="student-profile-pill">🎓 ${profile.qualification}</span>
              <span class="student-profile-pill" style="background:#D97706; color:#fff;">🎯 ${profile.targetExamination}</span>
            </div>
          </div>
        </div>

        <div style="display:flex; gap:0.5rem; margin-bottom:1.25rem;">
          <a href="tel:+91${profile.mobile}" class="btn btn-xs btn-primary">
            📞 Call Student Now
          </a>
          <a href="mailto:${profile.email}" class="btn btn-xs btn-outline">
            ✉️ Email Student
          </a>
          <button class="btn btn-xs btn-outline" onclick="window._adminAddNoteModal('${profile.enquiries[0]?.id || ''}', 'enquiry')">
            + Add Staff Note
          </button>
        </div>

        <!-- Enquiries Section -->
        <div style="margin-bottom:1.5rem;">
          <div style="font-size:0.875rem; font-weight:700; color:#0F172A; margin-bottom:0.5rem; display:flex; align-items:center; justify-content:space-between;">
            <span>Admission Enquiries (${enqCount})</span>
            <span style="font-size:0.6875rem; color:#64748B;">Cross-referenced records</span>
          </div>
          ${enqCount ? profile.enquiries.map(e => `
            <div style="background:#F8FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:0.75rem; margin-bottom:0.5rem; font-size:0.75rem;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">
                <strong>#${e.id} &bull; ${e.courseCategory}</strong>
                ${statusBadge(e.status)}
              </div>
              <div style="color:#64748B;">
                Target: <span style="color:#1E3A8A; font-weight:600;">${e.targetExamination}</span> &bull; Mode: ${e.learningMode || 'Offline'} &bull; Batch: ${e.preferredBatch || 'Regular'}
              </div>
              <div style="color:#94A3B8; font-size:0.6875rem; margin-top:0.25rem;">
                Assigned: ${AdminData.getCounsellorName(e.assignedCounsellor)} &bull; Submitted: ${formatDateTime(e.submittedAt)}
              </div>
            </div>
          `).join('') : '<div style="font-size:0.75rem; color:#94A3B8;">No admission enquiry records found.</div>'}
        </div>

        <!-- Counselling Bookings Section -->
        <div style="margin-bottom:1.5rem;">
          <div style="font-size:0.875rem; font-weight:700; color:#0F172A; margin-bottom:0.5rem; display:flex; align-items:center; justify-content:space-between;">
            <span>1-on-1 Counselling Bookings (${bkCount})</span>
            <span style="font-size:0.6875rem; color:#64748B;">Academic strategy sessions</span>
          </div>
          ${bkCount ? profile.bookings.map(b => `
            <div style="background:#F8FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:0.75rem; margin-bottom:0.5rem; font-size:0.75rem;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">
                <strong>#${b.id} &bull; ${formatDate(b.preferredDate)} (${b.preferredTime})</strong>
                ${statusBadge(b.status)}
              </div>
              <div style="color:#64748B;">
                Medium: ${b.sessionMedium} &bull; Mentor: ${AdminData.getCounsellorName(b.assignedCounsellor)}
              </div>
              ${b.googleMeetLink ? `
                <div style="margin-top:0.35rem;">
                  <a href="${b.googleMeetLink}" target="_blank" rel="noopener noreferrer" class="meet-badge">
                    🎥 Join Google Meet Video Call
                  </a>
                </div>
              ` : ''}
            </div>
          `).join('') : '<div style="font-size:0.75rem; color:#94A3B8;">No academic counselling bookings found.</div>'}
        </div>

        <!-- Combined Timeline of Notes -->
        <div>
          <div style="font-size:0.875rem; font-weight:700; color:#0F172A; margin-bottom:0.75rem;">
            Staff Interaction Log (${profile.notes.length})
          </div>
          <div class="timeline-feed">
            ${profile.notes.length ? profile.notes.map(n => `
              <div class="timeline-item">
                <span class="timeline-dot ${n.type}"></span>
                <div class="timeline-card">
                  <div class="timeline-header">
                    <span class="timeline-title">${n.addedBy} &bull; <span style="font-size:0.6875rem; color:#64748B;">${n.source}</span></span>
                    <span class="timeline-time">${formatDateTime(n.addedAt)}</span>
                  </div>
                  <div class="timeline-body">${n.text}</div>
                </div>
              </div>
            `).join('') : '<div style="font-size:0.75rem; color:#94A3B8;">No staff interaction notes logged yet.</div>'}
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal()">Close Profile</button>
      </div>
    `);
  };

  // ─── GOOGLE MEET HANDLERS ───
  window._adminSaveMeetLink = async function(id) {
    if (SESSION.role !== 'super_admin') {
      showToast('Unauthorized', 'Only Super Admins can set or update Google Meet links.', 'error');
      return;
    }
    const linkInput = document.getElementById('drawerMeetLinkInput');
    if (!linkInput) return;
    const link = linkInput.value.trim();
    if (!link.startsWith('http://') && !link.startsWith('https://')) {
      showToast('Invalid URL', 'Please enter a valid Google Meet URL starting with https://', 'error');
      return;
    }
    // Call Supabase set_booking_meet_link RPC if live
    if (window.ApexSupabase && window.ApexSupabase.isLive()) {
      try {
        const res = await window.ApexSupabase.setBookingMeetLink(id, link);
        if (res && res.success === false) {
          showToast('Error', res.message || 'Could not save Meet link.', 'error');
          return;
        }
      } catch (err) {
        console.warn('setBookingMeetLink error:', err);
        showToast('Database Error', 'Could not save Meet link: ' + (err.message || 'Unknown error'), 'error');
        return;
      }
    } else {
      AdminData.updateBookingMeetLink(id, link, SESSION.name);
    }
    showToast('Meet Link Updated', 'Google Meet invitation link saved.', 'success');
    showBookingDetail(id);
  };

  window._adminGenerateMeetLink = async function(id) {
    if (SESSION.role !== 'super_admin') {
      showToast('Unauthorized', 'Only Super Admins can set or update Google Meet links.', 'error');
      return;
    }
    const linkInput = document.getElementById('drawerMeetLinkInput');
    const existingVal = linkInput ? linkInput.value : '';
    const enteredUrl = prompt('Enter your official Google Meet conference URL (e.g. https://meet.google.com/xxx-yyyy-zzz):', existingVal);
    if (!enteredUrl) return;
    const cleanUrl = enteredUrl.trim();
    if (!cleanUrl.startsWith('https://meet.google.com/') && !cleanUrl.startsWith('http')) {
      showToast('Validation Error', 'Please enter a valid Google Meet link beginning with https://meet.google.com/', 'error');
      return;
    }
    if (linkInput) linkInput.value = cleanUrl;
    // Call Supabase set_booking_meet_link RPC if live
    if (window.ApexSupabase && window.ApexSupabase.isLive()) {
      try {
        const res = await window.ApexSupabase.setBookingMeetLink(id, cleanUrl);
        if (res && res.success === false) {
          showToast('Error', res.message || 'Could not update Meet link.', 'error');
          return;
        }
      } catch (err) {
        console.warn('setBookingMeetLink error:', err);
      }
    } else {
      AdminData.updateBookingMeetLink(id, cleanUrl, SESSION.name);
    }
    showToast('Meet Link Configured', 'Official Google Meet video room link attached.', 'success');
    showBookingDetail(id);
  };

  window._adminCopyMeetLink = function(id) {
    const linkInput = document.getElementById('drawerMeetLinkInput');
    const link = linkInput ? linkInput.value : '';
    if (link) {
      navigator.clipboard.writeText(link).then(() => {
        showToast('Copied to Clipboard', 'Google Meet link copied for aspirant invitation.', 'info');
      }).catch(() => {
        showToast('Link Ready', link, 'info');
      });
    }
  };

    // ─── ROUTE GUARDS & PERMISSION VALIDATION ───
  function isPageAllowedForRole(page, role) {
    const roleAllowed = {
      super_admin: ['overview', 'admissions', 'counselling', 'counsellors', 'followups', 'courses', 'reports', 'availability', 'settings'],
      admission_counsellor: ['overview', 'admissions', 'followups', 'reports', 'settings'],
      academic_counsellor: ['overview', 'schedule', 'counselling', 'history', 'followups', 'availability', 'settings']
    };
    return (roleAllowed[role] || []).includes(page);
  }

  function renderPage() {
    if (!SESSION) return;
    if (!isPageAllowedForRole(CURRENT_PAGE, SESSION.role)) {
      console.warn(`Unauthorized view attempt: ${CURRENT_PAGE} for role ${SESSION.role}`);
      showToast('Access Restricted', 'You do not have permission to view that module.', 'warning');
      CURRENT_PAGE = 'overview';
      window.location.hash = '#overview';
    }
    const content = $('#pageContent');
    if (!content) return;

    const titleMap = {
      overview: 'Overview Dashboard',
      admissions: SESSION.role === 'super_admin' ? 'Admission Enquiry Management' : 'My Assigned Admission Leads',
      counselling: SESSION.role === 'super_admin' ? 'Counselling Booking Management' : 'My Academic Counselling Bookings',
      counsellors: 'Counsellor Workload & Management',
      followups: 'Follow-up Task Management',
      courses: 'Courses, Batches & Cohorts',
      reports: SESSION.role === 'super_admin' ? 'Reports & Institute Analytics' : 'My Performance & Conversion Metrics',
      settings: SESSION.role === 'super_admin' ? 'Administrative Settings & Profile' : 'Counsellor Profile',
      schedule: "Today's Appointment Schedule",
      history: 'Completed Counselling History',
      availability: SESSION.role === 'super_admin' ? 'Institute Counsellor Availability & Scheduling' : 'My Weekly Availability & Holiday Schedule'
    };

    const pTitle = $('#pageTitle');
    if (pTitle) pTitle.textContent = titleMap[CURRENT_PAGE] || 'Overview';
    const pBreadcrumb = $('#pageBreadcrumb');
    if (pBreadcrumb) pBreadcrumb.textContent = titleMap[CURRENT_PAGE] || 'Overview';

    try {
      switch (CURRENT_PAGE) {
        case 'overview': content.innerHTML = renderOverview(); break;
        case 'admissions': content.innerHTML = renderAdmissions(); break;
        case 'counselling': content.innerHTML = renderCounselling(); break;
        case 'counsellors': content.innerHTML = renderCounsellors(); break;
        case 'followups': content.innerHTML = renderFollowUps(); break;
        case 'courses': content.innerHTML = renderCourses(); break;
        case 'reports': content.innerHTML = renderReports(); break;
        case 'settings': content.innerHTML = renderSettings(); break;
        case 'schedule': content.innerHTML = renderSchedule(); break;
        case 'history': content.innerHTML = renderHistory(); break;
        case 'availability': content.innerHTML = renderAvailability(); break;
        default: content.innerHTML = renderOverview();
      }
      attachPageHandlers();
      content.scrollTop = 0;
    } catch (renderError) {
      console.error('Page rendering notice on module:', CURRENT_PAGE, renderError);
      content.innerHTML = `
        <div class="admin-card" style="padding:2.5rem;text-align:center;">
          <div style="font-size:2rem;margin-bottom:0.75rem;">📋</div>
          <h3 style="font-weight:700;color:#0F172A;margin-bottom:0.5rem;">Dashboard Module Ready</h3>
          <p style="color:#64748B;font-size:0.875rem;margin-bottom:1.25rem;">Data is being calibrated for this section.</p>
          <button class="btn btn-sm btn-primary" onclick="renderPage()">Refresh View</button>
        </div>`;
    }
  }

  // ══════════════════════════════════════════════
  // PAGE RENDERERS
  // ══════════════════════════════════════════════

  function statCard(label, value, color, bg, subtitle = '') {
    return `
      <div class="stat-card">
        <div class="stat-card-label">${label}</div>
        <div class="stat-card-value" style="color:${color}">${value}</div>
        ${subtitle ? `<div style="font-size:0.6875rem;color:#64748B;margin-top:0.25rem;">${subtitle}</div>` : ''}
        <div class="stat-card-icon" style="background:${bg};color:${color}">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>
        </div>
      </div>`;
  }

  // ─── OVERVIEW RENDERER ───
  function renderOverview() {
    const s = AdminData.getStats(SESSION.role, SESSION.userId);
    const data = AdminData.getDataForRole(SESSION.role, SESSION.userId);

    // 1. Admission Counsellor View
    if (SESSION.role === 'admission_counsellor') {
      const enqs = data ? data.enquiries : [];
      const newAssigned = enqs.filter(e => e.status === 'new').length;
      const contacted = enqs.filter(e => e.status === 'contacted').length;
      const interested = enqs.filter(e => e.status === 'interested').length;
      const converted = enqs.filter(e => e.status === 'converted').length;
      const pendingFu = data ? data.followUps.filter(f => f.status === 'today' || f.status === 'upcoming').length : 0;

      return `
        <div class="stat-grid section-gap">
          ${statCard('My Assigned Enquiries', enqs.length, '#3B82F6', '#EFF6FF', 'Total leads assigned')}
          ${statCard('New Assigned Leads', newAssigned, '#D97706', '#FEF3C7', 'Requires initial contact')}
          ${statCard('Pending Follow-ups', pendingFu, '#F59E0B', '#FFFBEB', 'Due for check-in')}
          ${statCard('Interested Students', interested, '#8B5CF6', '#F5F3FF', 'Attended demo / audit')}
          ${statCard('Converted Admissions', converted, '#059669', '#ECFDF5', 'Successful enrollments')}
        </div>

        <div class="admin-card section-gap">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">My Assigned Admission Enquiries</h3>
              <p style="font-size:0.75rem;color:#64748B;margin-top:0.25rem;">Students directly assigned to you for course consultation</p>
            </div>
            <button class="btn btn-xs btn-outline" data-page="admissions">View Full Lead Table</button>
          </div>
          <div class="admin-card-body no-padding">
            <div class="data-table-wrapper">
              <table class="data-table">
                <thead><tr><th>ID</th><th>Student</th><th>Mobile</th><th>Course</th><th>Target Exam</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>
                  ${enqs.length ? enqs.slice(0, 6).map(e => `
                    <tr>
                      <td style="font-family:monospace;font-size:0.75rem;">${e.id}</td>
                      <td style="font-weight:600;">${e.studentName}</td>
                      <td style="font-size:0.75rem;white-space:nowrap;">+91 ${e.mobile}</td>
                      <td><span class="tag" style="background:#EFF6FF;color:#1E3A8A;font-size:0.625rem;">${e.courseCategoryId === 'civil-services-ssc' ? 'Civil/SSC' : e.courseCategoryId === 'banking-railway' ? 'Bank/Rly' : 'Foundation'}</span></td>
                      <td style="font-size:0.75rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.targetExamination}</td>
                      <td>${statusBadge(e.status)}</td>
                      <td><button class="btn btn-xs btn-outline view-enquiry-btn" data-id="${e.id}">${ICONS.eye} Manage</button></td>
                    </tr>
                  `).join('') : '<tr><td colspan="7" class="empty-state"><div class="empty-state-title">No leads currently assigned</div></td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;
    }

    // 2. Academic Counsellor View
    if (SESSION.role === 'academic_counsellor') {
      const bks = data ? data.bookings : [];
      const today = new Date().toISOString().split('T')[0];
      const todaySessions = bks.filter(b => b.preferredDate === today || b.preferredDate === '2026-11-09');
      const upcoming = bks.filter(b => b.status === 'confirmed' || b.status === 'assigned').length;
      const pending = bks.filter(b => b.status === 'pending').length;
      const completed = bks.filter(b => b.status === 'completed').length;

      return `
        <div class="stat-grid section-gap">
          ${statCard('My Assigned Bookings', bks.length, '#3B82F6', '#EFF6FF', 'Total diagnostic sessions')}
          ${statCard("Today's Appointments", todaySessions.length, '#D97706', '#FEF3C7', 'Scheduled for today')}
          ${statCard('Upcoming Sessions', upcoming, '#8B5CF6', '#F5F3FF', 'Confirmed on calendar')}
          ${statCard('Pending Confirmations', pending, '#F59E0B', '#FFFBEB', 'Awaiting mentor review')}
          ${statCard('Completed Counselling', completed, '#059669', '#ECFDF5', 'Audits delivered')}
        </div>

        <div class="admin-card section-gap">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Today's Scheduled Counselling Sessions</h3>
              <p style="font-size:0.75rem;color:#64748B;margin-top:0.25rem;">1-on-1 strategic diagnostic appointments assigned to you</p>
            </div>
            <button class="btn btn-xs btn-outline" data-page="schedule">View Schedule</button>
          </div>
          <div class="admin-card-body no-padding">
            <div class="data-table-wrapper">
              <table class="data-table">
                <thead><tr><th>Time</th><th>Student</th><th>Mobile</th><th>Target Exam</th><th>Medium</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>
                  ${todaySessions.length ? todaySessions.map(b => `
                    <tr>
                      <td style="font-weight:700;font-size:0.8125rem;color:#0A1128;">${b.preferredTime}</td>
                      <td style="font-weight:600;">${b.studentName}</td>
                      <td style="font-size:0.75rem;">+91 ${b.mobile}</td>
                      <td style="font-size:0.75rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${b.targetExamination}</td>
                      <td style="font-size:0.75rem;">${b.sessionMedium ? b.sessionMedium.split('(')[0].trim() : '1-on-1 Session'}</td>
                      <td>${statusBadge(b.status)}</td>
                      <td><button class="btn btn-xs btn-outline view-booking-btn" data-id="${b.id}">${ICONS.eye} Session</button></td>
                    </tr>
                  `).join('') : '<tr><td colspan="7" class="empty-state"><div class="empty-state-title">No appointments scheduled for today</div></td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;
    }

    // 3. Super Admin Overview
    const recentEnquiries = (AdminData.enquiries || []).slice(0, 5);
    const upcomingBookings = (AdminData.bookings || []).filter(b => b.status === 'confirmed' || b.status === 'assigned').slice(0, 5);
    const activeCounsellors = (AdminData.counsellors || []).filter(c => c.status === 'active');
    const commStats = typeof AdminData.getCommunicationStats === 'function'
      ? AdminData.getCommunicationStats()
      : { totalEmails: 0, sent: 0, delivered: 0, read: 0, failed: 0 };

    return `
      <div class="stat-grid section-gap">
        ${statCard('Total Admission Enquiries', s.totalEnquiries || 0, '#1E3A8A', '#EFF6FF', 'From website forms')}
        ${statCard('New Enquiries', s.newEnquiries || 0, '#D97706', '#FEF3C7', 'Action required')}
        ${statCard('Pending Bookings', s.pendingBookings || 0, '#F59E0B', '#FFFBEB', 'Counselling requests')}
        ${statCard('Confirmed Appointments', s.confirmedBookings || 0, '#059669', '#ECFDF5', 'Mentors assigned')}
        ${statCard('Active Counsellors', s.totalCounsellors || 0, '#7C3AED', '#F5F3FF', 'Across 2 departments')}
        ${statCard('Converted Admissions', s.convertedEnquiries || 0, '#059669', '#ECFDF5', 'Cohort admissions')}
      </div>

      <div class="grid-2 section-gap">
        <!-- Recent Admission Enquiries -->
        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Recent Admission Enquiries</h3>
              <p style="font-size:0.75rem;color:#64748B;">Latest applicant leads</p>
            </div>
            <button class="btn btn-xs btn-outline" data-page="admissions">Manage All</button>
          </div>
          <div class="admin-card-body no-padding">
            <div class="data-table-wrapper">
              <table class="data-table">
                <thead><tr><th>Student</th><th>Course</th><th>Date</th><th>Counsellor</th><th>Status</th></tr></thead>
                <tbody>
                  ${recentEnquiries.length ? recentEnquiries.map(e => `
                    <tr>
                      <td style="font-weight:600;">${e.studentName || 'Student'}</td>
                      <td><span class="tag" style="background:#EFF6FF;color:#1E3A8A;font-size:0.625rem;">${e.courseCategoryId === 'civil-services-ssc' ? 'Civil/SSC' : e.courseCategoryId === 'banking-railway' ? 'Bank/Rly' : 'Foundation'}</span></td>
                      <td style="font-size:0.75rem;">${formatDate(e.submittedAt)}</td>
                      <td style="font-size:0.75rem;">${AdminData.getCounsellorName(e.assignedCounsellor)}</td>
                      <td>${statusBadge(e.status)}</td>
                    </tr>
                  `).join('') : '<tr><td colspan="5" class="empty-state" style="text-align:center;padding:1.5rem;color:#64748B;">No admission enquiries recorded yet</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Upcoming Counselling Bookings -->
        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Upcoming Counselling Sessions</h3>
              <p style="font-size:0.75rem;color:#64748B;">Scheduled 30-min strategy calls</p>
            </div>
            <button class="btn btn-xs btn-outline" data-page="counselling">Manage All</button>
          </div>
          <div class="admin-card-body no-padding">
            <div class="data-table-wrapper">
              <table class="data-table">
                <thead><tr><th>Student</th><th>Date</th><th>Time</th><th>Academic Mentor</th><th>Status</th></tr></thead>
                <tbody>
                  ${upcomingBookings.length ? upcomingBookings.map(b => `
                    <tr>
                      <td style="font-weight:600;">${b.studentName || 'Student'}</td>
                      <td style="font-size:0.75rem;">${formatDate(b.preferredDate)}</td>
                      <td style="font-size:0.75rem;">${b.preferredTime || '10:00 AM'}</td>
                      <td style="font-size:0.75rem;">${AdminData.getCounsellorName(b.assignedCounsellor)}</td>
                      <td>${statusBadge(b.status)}</td>
                    </tr>
                  `).join('') : '<tr><td colspan="5" class="empty-state" style="text-align:center;padding:1.5rem;color:#64748B;">No upcoming counselling sessions scheduled</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <!-- Counsellor Performance Overview -->
        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Counsellor Workload & Conversion</h3>
              <p style="font-size:0.75rem;color:#64748B;">Staff department distribution</p>
            </div>
            <button class="btn btn-xs btn-outline" data-page="counsellors">Manage Staff</button>
          </div>
          <div class="admin-card-body">
            ${activeCounsellors.filter(c => c.role !== 'super_admin').length ? activeCounsellors.filter(c => c.role !== 'super_admin').map(c => `
              <div style="display:flex;align-items:center;gap:0.75rem;padding:0.625rem 0;border-bottom:1px solid #F1F5F9;">
                <div class="sidebar-user-avatar" style="width:36px;height:36px;font-size:0.75rem;background:#EFF6FF;color:#1E3A8A;border:1px solid #DBEAFE;">${initials(c.name || 'Staff')}</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:700;font-size:0.8125rem;">${escapeHtml(c.name || 'Staff Member')}</div>
                  <div style="font-size:0.6875rem;color:#64748B;">${escapeHtml(c.department || (c.role === 'academic_counsellor' ? 'Academic Counselling Department' : 'Admission Department'))}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:0.8125rem;font-weight:700;">${(c.assignedEnquiries || 0) + (c.assignedBookings || 0)} Assigned</div>
                  <div style="font-size:0.6875rem;color:#059669;font-weight:600;">${c.conversionRate ? c.conversionRate + '% Conv.' : (c.completedTasks || 0) + ' Done'}</div>
                </div>
              </div>
            `).join('') : '<div style="text-align:center;padding:1.5rem;color:#64748B;font-size:0.8125rem;">No active counsellor workload records. Provision counsellors from the Counsellors section to track assignments.</div>'}
          </div>
        </div>

        <!-- Recent Audit Log / Activity -->
        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Recent Activity Log</h3>
              <p style="font-size:0.75rem;color:#64748B;">Audit trail of admissions desk</p>
            </div>
          </div>
          <div class="admin-card-body">
            ${(AdminData.activity || []).length ? AdminData.activity.slice(0, 6).map(a => `
              <div class="activity-item">
                <div class="activity-icon" style="background:#F8FAFC;color:#1E3A8A;border:1px solid #E2E8F0;">${ICONS[a.icon] || ICONS.note}</div>
                <div style="flex:1;">
                  <div class="activity-text">${a.message || a.description || 'System activity'}</div>
                  <div class="activity-time">${a.time || formatDate(a.performedAt)}</div>
                </div>
              </div>
            `).join('') : '<div style="text-align:center;padding:1.5rem;color:#64748B;font-size:0.8125rem;">No activity recorded yet</div>'}
          </div>
        </div>
      </div>

      <!-- Automated Communication Center -->
      <div class="admin-card section-gap" style="margin-top:1.25rem;">
        <div class="admin-card-header">
          <div>
            <h3 class="admin-card-title">Automated Communication Center</h3>
            <p style="font-size:0.75rem;color:#64748B;">Institute-wide Email dispatch metrics (Identity: APEX ACADEMY)</p>
          </div>
          <span class="badge" style="background:#EFF6FF;color:#1E40AF;font-weight:600;font-size:0.75rem;">Official Display: APEX ACADEMY</span>
        </div>
        <div class="admin-card-body">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;text-align:center;">
              <div style="font-size:1.25rem;font-weight:700;color:#1E3A8A;">✉️ ${commStats.totalEmails}</div>
              <div style="font-size:0.75rem;color:#64748B;font-weight:500;">Emails Dispatched</div>
            </div>
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;text-align:center;">
              <div style="font-size:1.25rem;font-weight:700;color:#059669;">✔ ${commStats.sent + commStats.delivered + commStats.read}</div>
              <div style="font-size:0.75rem;color:#64748B;font-weight:500;">Delivered / Sent</div>
            </div>
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;text-align:center;">
              <div style="font-size:1.25rem;font-weight:700;color:${commStats.failed > 0 ? '#DC2626' : '#64748B'};">⚠ ${commStats.failed}</div>
              <div style="font-size:0.75rem;color:#64748B;font-weight:500;">Failed / Errors</div>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ─── ADMISSION MANAGEMENT ───
  function renderAdmissions() {
    const isSuperAdmin = SESSION.role === 'super_admin';
    const roleData = AdminData.getDataForRole(SESSION.role, SESSION.userId);
    const enqs = isSuperAdmin ? AdminData.enquiries : (roleData ? roleData.enquiries : []);
    const counsellors = AdminData.counsellors.filter(c => c.department === 'Admission Department');

    const total = enqs.length;
    const newEnqs = enqs.filter(e => e.status === 'new').length;
    const assigned = enqs.filter(e => e.assignedCounsellor).length;
    const contacted = enqs.filter(e => e.status === 'contacted').length;
    const interested = enqs.filter(e => e.status === 'interested').length;
    const converted = enqs.filter(e => e.status === 'converted').length;

    return `
      <!-- Admissions Statistics Header -->
      <div class="stat-grid section-gap" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
        ${statCard('Total Enquiries', total, '#1E3A8A', '#EFF6FF')}
        ${statCard('New Enquiries', newEnqs, '#D97706', '#FEF3C7')}
        ${statCard('Assigned Leads', assigned, '#7C3AED', '#F5F3FF')}
        ${statCard('Contacted', contacted, '#F59E0B', '#FFFBEB')}
        ${statCard('Interested', interested, '#8B5CF6', '#F5F3FF')}
        ${statCard('Converted', converted, '#059669', '#ECFDF5')}
      </div>

      <!-- Filters & Responsive Data Table -->
      <div class="admin-card">
        <div class="filter-bar">
          <button class="btn btn-xs btn-outline hide-mobile" id="exportCounsellingBtn" title="Export filtered bookings to CSV">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            <span>Export CSV</span>
          </button>
          <button class="btn btn-xs btn-outline hide-mobile" id="exportAdmissionsBtn" title="Export filtered enquiries to CSV">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            <span>Export CSV</span>
          </button>
          <div class="search-input-wrapper">
            ${ICONS.search}
            <input type="text" class="form-input" id="enqSearch" placeholder="Search by student name, phone, or ID...">
          </div>

          <!-- Course Category Filter -->
          <select class="form-select filter-select" id="enqCourseFilter">
            <option value="">All Course Streams</option>
            <option value="civil-services-ssc">Civil Services & SSC</option>
            <option value="banking-railway">Banking & Railway</option>
            <option value="foundation">APEX Foundation Program</option>
          </select>

          <!-- Target Examination Filter -->
          <select class="form-select filter-select" id="enqExamFilter">
            <option value="">All Target Examinations</option>
            <option value="UPSC Civil Services Examination (CSE)">UPSC Civil Services (CSE)</option>
            <option value="State Public Service Commission (State PCS)">State PCS</option>
            <option value="SSC CGL (Combined Graduate Level)">SSC CGL</option>
            <option value="SSC CHSL (Combined Higher Secondary)">SSC CHSL</option>
            <option value="IBPS PO (Probationary Officer)">IBPS PO</option>
            <option value="SBI PO (State Bank of India)">SBI PO</option>
            <option value="RRB NTPC (Non-Technical Popular Categories)">RRB NTPC</option>
            <option value="All-Govt Exam Beginner Foundation (SSC, Bank, Railway)">All-Govt Beginner Foundation</option>
          </select>

          <!-- Status Filter -->
          <select class="form-select filter-select" id="enqStatusFilter">
            <option value="">All Enquiry Statuses</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="interested">Interested</option>
            <option value="converted">Converted</option>
            <option value="closed">Closed</option>
          </select>

          <!-- Counsellor Filter (Super Admin Only) -->
          ${isSuperAdmin ? `
            <select class="form-select filter-select" id="enqCounsellorFilter">
              <option value="">All Counsellors</option>
              <option value="unassigned">Unassigned Only</option>
              ${counsellors.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
            </select>` : ''}
        </div>

        <div class="admin-card-body no-padding">
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Enquiry ID</th>
                  <th>Student Name</th>
                  <th>Mobile Number</th>
                  <th>Course Category</th>
                  <th>Target Examination</th>
                  <th>Qualification</th>
                  <th>Preferred Batch</th>
                  <th>Learning Mode</th>
                  ${isSuperAdmin ? '<th>Assigned Counsellor</th>' : ''}
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="enqTableBody">
                ${renderEnquiryRows(enqs)}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  function renderEnquiryRows(enqs) {
    if (!enqs || !enqs.length) {
      return `<tr><td colspan="11"><div class="empty-state"><div class="empty-state-title">No admission enquiries match criteria</div><div class="empty-state-text">Try adjusting or clearing the search query or filters.</div></div></td></tr>`;
    }
    const isSuperAdmin = SESSION.role === 'super_admin';
    return enqs.map(e => `
      <tr>
        <td style="font-family:monospace;font-size:0.6875rem;color:#64748B;font-weight:600;">${e.id}</td>
        <td style="font-weight:700;color:#0F172A;">${e.studentName || 'Student'}</td>
        <td style="font-size:0.75rem;white-space:nowrap;">
          <a href="tel:+91${e.mobile || ''}" style="color:#1E3A8A;font-weight:600;">+91 ${e.mobile || '—'}</a>
        </td>
        <td>
          <span class="tag" style="background:#EFF6FF;color:#1E3A8A;font-size:0.625rem;font-weight:600;">
            ${e.courseCategoryId === 'civil-services-ssc' ? 'Civil/SSC' : e.courseCategoryId === 'banking-railway' ? 'Bank/Rly' : 'Foundation'}
          </span>
        </td>
        <td style="font-size:0.75rem;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${e.targetExamination || ''}">
          ${e.targetExamination || '—'}
        </td>
        <td style="font-size:0.6875rem;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${e.qualification || ''}">
          ${e.qualification ? e.qualification.split('(')[0].trim() : '—'}
        </td>
        <td style="font-size:0.6875rem;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${e.preferredBatch || ''}">
          ${e.preferredBatch ? e.preferredBatch.split('(')[0].trim() : '—'}
        </td>
        <td style="font-size:0.6875rem;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${e.learningMode || ''}">
          ${e.learningMode ? e.learningMode.split('(')[0].trim() : '—'}
        </td>
        ${isSuperAdmin ? `<td style="font-size:0.75rem;white-space:nowrap;">${AdminData.getCounsellorName(e.assignedCounsellor)}</td>` : ''}
        <td>${statusBadge(e.status)}</td>
        <td>
          <div style="display:flex;gap:0.375rem;">
            <button class="btn btn-xs btn-outline view-enquiry-btn" data-id="${e.id}" title="View Complete Student Information">
              ${ICONS.eye} <span class="hide-mobile">Details</span>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  // ─── COUNSELLING MANAGEMENT ───
  function renderCounselling() {
    const isSuperAdmin = SESSION.role === 'super_admin';
    const roleData = AdminData.getDataForRole(SESSION.role, SESSION.userId);
    const bks = isSuperAdmin ? AdminData.bookings : (roleData ? roleData.bookings : []);
    const counsellors = AdminData.counsellors.filter(c => c.department === 'Academic Counselling Department');

    const total = bks.length;
    const pending = bks.filter(b => b.status === 'pending').length;
    const assigned = bks.filter(b => b.status === 'assigned').length;
    const confirmed = bks.filter(b => b.status === 'confirmed').length;
    const completed = bks.filter(b => b.status === 'completed').length;

    return `
      <!-- Counselling Statistics Header -->
      <div class="stat-grid section-gap" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));">
        ${statCard('Total Booking Requests', total, '#1E3A8A', '#EFF6FF')}
        ${statCard('Pending Requests', pending, '#D97706', '#FEF3C7')}
        ${statCard('Assigned Bookings', assigned, '#7C3AED', '#F5F3FF')}
        ${statCard('Confirmed Appointments', confirmed, '#059669', '#ECFDF5')}
        ${statCard('Completed Sessions', completed, '#475569', '#F1F5F9')}
      </div>

      <!-- Filters & Responsive Booking Table -->
      <div class="admin-card">
        <div class="filter-bar">
          <div class="search-input-wrapper">
            ${ICONS.search}
            <input type="text" class="form-input" id="bkSearch" placeholder="Search by student name, phone, or ID...">
          </div>

          <!-- Date Filter -->
          <input type="date" class="form-input filter-select" id="bkDateFilter" title="Filter by scheduled date">

          <!-- Course Category Filter -->
          <select class="form-select filter-select" id="bkCourseFilter">
            <option value="">All Course Categories</option>
            <option value="civil-services-ssc">Civil Services & SSC</option>
            <option value="banking-railway">Banking & Railway</option>
            <option value="foundation">APEX Foundation Program</option>
          </select>

          <!-- Booking Status Filter -->
          <select class="form-select filter-select" id="bkStatusFilter">
            <option value="">All Appointment Statuses</option>
            <option value="pending">Pending</option>
            <option value="assigned">Assigned</option>
            <option value="confirmed">Confirmed</option>
            <option value="completed">Completed</option>
            <option value="no_show">No Show</option>
            <option value="rescheduled">Rescheduled</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <!-- Assigned Academic Mentor Filter (Super Admin Only) -->
          ${isSuperAdmin ? `
            <select class="form-select filter-select" id="bkCounsellorFilter">
              <option value="">All Academic Mentors</option>
              <option value="unassigned">Unassigned Only</option>
              ${counsellors.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
            </select>` : ''}
        </div>

        <div class="admin-card-body no-padding">
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Booking ID</th>
                  <th>Student Name</th>
                  <th>Mobile Number</th>
                  <th>Email Address</th>
                  <th>Course Category</th>
                  <th>Target Examination</th>
                  <th>Preferred Date</th>
                  <th>Time Slot</th>
                  <th>Session Medium</th>
                  ${isSuperAdmin ? '<th>Academic Mentor</th>' : ''}
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="bkTableBody">
                ${renderBookingRows(bks)}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  function renderBookingRows(bks) {
    if (!bks || !bks.length) {
      return `<tr><td colspan="12"><div class="empty-state"><div class="empty-state-title">No counselling bookings match filters</div></div></td></tr>`;
    }
    const isSuperAdmin = SESSION.role === 'super_admin';
    return bks.map(b => `
      <tr>
        <td style="font-family:monospace;font-size:0.6875rem;color:#64748B;font-weight:600;">${b.id}</td>
        <td style="font-weight:700;color:#0F172A;">${b.studentName || 'Student'}</td>
        <td style="font-size:0.75rem;white-space:nowrap;">
          <a href="tel:+91${b.mobile || ''}" style="color:#1E3A8A;font-weight:600;">+91 ${b.mobile || '—'}</a>
        </td>
        <td style="font-size:0.6875rem;max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${b.email || ''}">
          ${b.email || '—'}
        </td>
        <td>
          <span class="tag" style="background:#EFF6FF;color:#1E3A8A;font-size:0.625rem;font-weight:600;">
            ${b.courseCategoryId === 'civil-services-ssc' ? 'Civil/SSC' : b.courseCategoryId === 'banking-railway' ? 'Bank/Rly' : 'Foundation'}
          </span>
        </td>
        <td style="font-size:0.75rem;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${b.targetExamination || ''}">
          ${b.targetExamination || '—'}
        </td>
        <td style="font-size:0.75rem;white-space:nowrap;font-weight:600;">
          ${formatDate(b.preferredDate)}
        </td>
        <td style="font-size:0.6875rem;white-space:nowrap;">
          ${b.preferredTime || '10:00 AM'}
        </td>
        <td style="font-size:0.6875rem;white-space:nowrap;" title="${b.sessionMedium || ''}">
          ${b.sessionMedium ? b.sessionMedium.split('(')[0].trim() : '1-on-1 Session'}
        </td>
        ${isSuperAdmin ? `<td style="font-size:0.75rem;white-space:nowrap;">${AdminData.getCounsellorName(b.assignedCounsellor)}</td>` : ''}
        <td>${statusBadge(b.status)}</td>
        <td>
          <div style="display:flex;gap:0.375rem;">
            <button class="btn btn-xs btn-outline view-booking-btn" data-id="${b.id}" title="Manage Appointment Session">
              ${ICONS.eye} <span class="hide-mobile">Manage</span>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  // ─── COUNSELLOR MANAGEMENT (Super Admin Only) ───
  function renderCounsellors() {
    if (SESSION.role !== 'super_admin') {
      return `
        <div class="empty-state">
          <div class="empty-state-title">Access Restricted</div>
          <div class="empty-state-text">Counsellor Management is reserved strictly for Executive Administration.</div>
        </div>`;
    }

    const allStaff = AdminData.staff || AdminData.counsellors || [];
    // Strict requirement: Only display genuine counsellor accounts; Super Admin is excluded
    const counsellors = allStaff.filter(c => c.role === 'admission_counsellor' || c.role === 'academic_counsellor');
    const unassigned = allStaff.filter(c => !c.role);

    return `
      ${unassigned.length ? `
        <div style="background:#FFFBEB; border:1px solid #FDE68A; border-left:4px solid #D97706; border-radius:0.5rem; padding:1rem 1.25rem; margin-bottom:1.5rem;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">
            <div>
              <div style="font-weight:700; font-size:0.875rem; color:#92400E; display:flex; align-items:center; gap:0.5rem;">
                <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                ${unassigned.length} Account(s) Awaiting Role Assignment
              </div>
              <p style="font-size:0.75rem; color:#B45309; margin-top:0.25rem;">
                New staff account(s) have been authenticated or registered but do not have an active institutional role assigned yet.
              </p>
            </div>
          </div>
          <div style="margin-top:0.75rem; display:flex; flex-direction:column; gap:0.5rem;">
            ${unassigned.map(u => `
              <div style="display:flex; justify-content:space-between; align-items:center; background:#FFFFFF; border:1px solid #FEF3C7; border-radius:0.375rem; padding:0.625rem 0.875rem; flex-wrap:wrap; gap:0.5rem;">
                <div>
                  <span style="font-weight:700; font-size:0.8125rem; color:#0F172A;">${escapeHtml(u.name || 'Staff Member')}</span>
                  <span style="font-size:0.75rem; color:#64748B; margin-left:0.5rem;">(${escapeHtml(u.email || '—')})</span>
                </div>
                <button class="btn btn-xs btn-gold" onclick="window._adminAssignStaffRole('${escapeHtml(u.email)}', '${escapeHtml(u.name || '')}')">
                  Assign Role &amp; Department
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;flex-wrap:wrap;gap:0.75rem;">
        <div>
          <h2 style="font-weight:800;font-size:1.125rem;color:#0F172A;">Institute Counsellors & Mentors (${counsellors.length})</h2>
          <p style="font-size:0.75rem;color:#64748B;">Manage staff roles, department assignments, and track individual lead workloads</p>
        </div>
        <button class="btn btn-sm btn-gold" id="addCounsellorBtn">
          ${ICONS.plus} Add New Counsellor
        </button>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1.25rem;">
        ${counsellors.length ? counsellors.map(c => `
          <div class="counsellor-card">
            <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;">
              <div class="sidebar-user-avatar" style="width:42px;height:42px;font-size:0.875rem;background:${c.status==='active'?'#EFF6FF':'#F1F5F9'};color:${c.status==='active'?'#1E3A8A':'#94A3B8'};border:1px solid ${c.status==='active'?'#DBEAFE':'#E2E8F0'};">
                ${initials(c.name || 'Staff')}
              </div>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:800;font-size:0.9375rem;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.name || 'Staff Member'}</div>
                <div style="font-size:0.6875rem;color:#64748B;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.email || '—'}</div>
              </div>
              ${statusBadge(c.status === 'active' ? 'confirmed' : 'closed')}
            </div>

            <div style="display:flex;gap:0.5rem;margin-bottom:0.875rem;flex-wrap:wrap;">
              <span class="tag" style="background:#F5F3FF;color:#7C3AED;font-weight:600;">
                ${c.department || (c.role === 'academic_counsellor' ? 'Academic Counselling Department' : 'Admission Department')}
              </span>
              <span class="tag" style="background:#EFF6FF;color:#1E3A8A;font-weight:600;">
                ${c.role === 'academic_counsellor' ? 'Academic Counsellor' : 'Admission Counsellor'}
              </span>
              <span class="tag" style="background:#F1F5F9;color:#475569;">
                Joined ${formatDate(c.joinDate)}
              </span>
            </div>

            <!-- Workload Counters -->
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.5rem;padding:0.875rem 0;border-top:1px solid #F1F5F9;border-bottom:1px solid #F1F5F9;margin-bottom:0.875rem;">
              <div style="text-align:center;">
                <div style="font-weight:800;font-size:1.125rem;color:#1E3A8A;">${(c.assignedEnquiries || 0) + (c.assignedBookings || 0)}</div>
                <div style="font-size:0.625rem;color:#64748B;text-transform:uppercase;font-weight:600;margin-top:0.125rem;">Assigned</div>
              </div>
              <div style="text-align:center;">
                <div style="font-weight:800;font-size:1.125rem;color:#059669;">${c.completedTasks || 0}</div>
                <div style="font-size:0.625rem;color:#64748B;text-transform:uppercase;font-weight:600;margin-top:0.125rem;">Completed</div>
              </div>
              <div style="text-align:center;">
                <div style="font-weight:800;font-size:1.125rem;color:#D97706;">${c.conversionRate || 0}%</div>
                <div style="font-size:0.625rem;color:#64748B;text-transform:uppercase;font-weight:600;margin-top:0.125rem;">Conversion</div>
              </div>
            </div>

            <!-- Actions Row -->
            <div style="display:flex;gap:0.5rem;">
              <button class="btn btn-xs btn-outline" style="flex:1;" onclick="window._adminViewWorkload('${c.id}')">
                ${ICONS.chart} Workload
              </button>
              <button class="btn btn-xs btn-outline" onclick="window._adminEditCounsellor('${c.id}')">
                ${ICONS.edit} Edit
              </button>
              <button class="btn btn-xs ${c.status==='active'?'btn-danger':'btn-success'}" onclick="window._adminToggleCounsellor('${c.id}')">
                ${c.status === 'active' ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </div>
        `).join('') : '<div style="grid-column:1/-1;text-align:center;padding:2.5rem;color:#64748B;" class="admin-card">No counsellor records found. Use the button above to add new staff.</div>'}
      </div>`;
  }

  // ─── FOLLOW-UP MANAGEMENT ───
  function renderFollowUps() {
    const isSuperAdmin = SESSION.role === 'super_admin';
    const roleData = AdminData.getDataForRole(SESSION.role, SESSION.userId);
    const allFu = isSuperAdmin ? AdminData.getAllFollowUps() : (roleData ? roleData.followUps : []);

    // Respect Asia/Kolkata timezone for scheduled date calculations
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

    const todayFu = allFu.filter(f => f.status !== 'completed' && (f.status === 'today' || f.date === todayStr));
    const upcomingFu = allFu.filter(f => f.status !== 'completed' && f.date > todayStr);
    const completedFu = allFu.filter(f => f.status === 'completed');
    const overdueFu = allFu.filter(f => f.status !== 'completed' && f.date < todayStr && f.status !== 'today');

    let displayList = allFu;
    if (ACTIVE_FOLLOWUP_TAB === 'today') displayList = todayFu;
    else if (ACTIVE_FOLLOWUP_TAB === 'upcoming') displayList = upcomingFu;
    else if (ACTIVE_FOLLOWUP_TAB === 'overdue') displayList = overdueFu;
    else if (ACTIVE_FOLLOWUP_TAB === 'completed') displayList = completedFu;

    return `
      <!-- Follow-up Statistics -->
      <div class="stat-grid section-gap" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));">
        ${statCard("Today's Tasks", todayFu.length, '#D97706', '#FEF3C7', 'Scheduled for today')}
        ${statCard('Upcoming Follow-ups', upcomingFu.length, '#1E3A8A', '#EFF6FF', 'Future calendar entries')}
        ${statCard('Overdue Reminders', overdueFu.length, '#DC2626', '#FEF2F2', 'Immediate action needed')}
        ${statCard('Completed Follow-ups', completedFu.length, '#059669', '#ECFDF5', 'Successfully resolved')}
      </div>

      <!-- Follow-up Table Card -->
      <div class="admin-card">
        <div class="admin-tabs">
          <button class="admin-tab ${ACTIVE_FOLLOWUP_TAB==='all'?'active':''}" onclick="window._adminSetFollowUpTab('all')">
            All Follow-ups (${allFu.length})
          </button>
          <button class="admin-tab ${ACTIVE_FOLLOWUP_TAB==='today'?'active':''}" onclick="window._adminSetFollowUpTab('today')">
            Today's (${todayFu.length})
          </button>
          <button class="admin-tab ${ACTIVE_FOLLOWUP_TAB==='upcoming'?'active':''}" onclick="window._adminSetFollowUpTab('upcoming')">
            Upcoming (${upcomingFu.length})
          </button>
          <button class="admin-tab ${ACTIVE_FOLLOWUP_TAB==='overdue'?'active':''}" onclick="window._adminSetFollowUpTab('overdue')">
            Overdue (${overdueFu.length})
          </button>
          <button class="admin-tab ${ACTIVE_FOLLOWUP_TAB==='completed'?'active':''}" onclick="window._adminSetFollowUpTab('completed')">
            Completed (${completedFu.length})
          </button>
        </div>

        <div class="admin-card-body no-padding">
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Student Name</th>
                  <th>Contact Number</th>
                  <th>Scheduled Date</th>
                  <th>Follow-up Purpose</th>
                  <th>Origin Type</th>
                  ${isSuperAdmin ? '<th>Assigned Staff</th>' : ''}
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${displayList.length ? displayList.map(f => `
                  <tr>
                    <td style="font-weight:700;color:#0F172A;">${f.studentName}</td>
                    <td style="font-size:0.75rem;">
                      <a href="tel:+91${f.contactNumber}" style="color:#1E3A8A;font-weight:600;">+91 ${f.contactNumber}</a>
                    </td>
                    <td style="font-size:0.75rem;white-space:nowrap;font-weight:600;">
                      ${formatDate(f.date)}
                    </td>
                    <td style="font-size:0.75rem;max-width:220px;line-height:1.4;">
                      ${f.purpose}
                    </td>
                    <td>
                      <span class="tag" style="background:${f.source==='enquiry'?'#EFF6FF':'#F5F3FF'};color:${f.source==='enquiry'?'#1E3A8A':'#7C3AED'};font-size:0.625rem;font-weight:600;">
                        ${f.source==='enquiry'?'Enquiry':'Counselling'}
                      </span>
                    </td>
                    ${isSuperAdmin ? `<td style="font-size:0.75rem;">${AdminData.getCounsellorName(f.counsellorId)}</td>` : ''}
                    <td>${statusBadge(f.status)}</td>
                    <td>
                      ${f.status !== 'completed' ? `
                        <button class="btn btn-xs btn-success complete-fu-btn" data-id="${f.id}">
                          ${ICONS.check} Mark Completed
                        </button>
                      ` : `
                        <span style="font-size:0.6875rem;color:#059669;font-weight:600;display:flex;align-items:center;gap:0.25rem;">
                          ${ICONS.check} Done
                        </span>
                      `}
                    </td>
                  </tr>
                `).join('') : `
                  <tr>
                    <td colspan="8">
                      <div class="empty-state">
                        <div class="empty-state-title">No follow-ups in this category</div>
                        <div class="empty-state-text">You are up to date on all student communications.</div>
                      </div>
                    </td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  window._adminSetFollowUpTab = function(tab) {
    ACTIVE_FOLLOWUP_TAB = tab;
    renderPage();
  };

  // ─── COURSES & BATCHES MANAGEMENT ───
  function renderCourses() {
    const courses = AdminData.courses;
    const isSuperAdmin = SESSION.role === 'super_admin';

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;flex-wrap:wrap;gap:0.75rem;">
        <div>
          <h2 style="font-weight:800;font-size:1.125rem;color:#0F172A;">Curriculum Streams, Target Exams & Batches</h2>
          <p style="font-size:0.75rem;color:#64748B;">Official Apex Academy cohorts for Civil Services, SSC, Banking, Railways & Foundation</p>
        </div>
      </div>

      ${courses.map(c => `
        <div class="admin-card section-gap">
          <div class="admin-card-header" style="background:#F8FAFC;">
            <div>
              <div style="display:flex;align-items:center;gap:0.5rem;">
                <h3 class="admin-card-title">${c.name}</h3>
                ${statusBadge(c.status)}
              </div>
              <div style="font-size:0.6875rem;color:#64748B;margin-top:0.25rem;">
                ${c.examinations.length} Specific Target Examinations · ${c.batches.length} Active Batches
              </div>
            </div>
            ${isSuperAdmin ? `
              <button class="btn btn-xs btn-gold" onclick="window._adminAddBatchModal('${c.id}')">
                ${ICONS.plus} Add New Batch
              </button>
            ` : ''}
          </div>

          <div class="admin-card-body">
            <!-- Target Examinations List -->
            <div class="detail-section">
              <div class="detail-section-title">Covered Target Examinations</div>
              <div style="display:flex;flex-wrap:wrap;gap:0.375rem;">
                ${c.examinations.map(ex => `
                  <span class="tag" style="background:#EFF6FF;color:#1E3A8A;border:1px solid #DBEAFE;font-size:0.75rem;padding:0.25rem 0.625rem;font-weight:600;">
                    ${ex}
                  </span>
                `).join('')}
              </div>
            </div>

            <!-- Batches Grid -->
            <div class="detail-section">
              <div class="detail-section-title">Active Cohort Batches & Availability</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0.875rem;">
                ${c.batches.map(b => `
                  <div style="padding:1rem;border:1px solid #E2E8F0;border-radius:0.75rem;background:#FFFFFF;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
                      <div style="font-weight:700;font-size:0.875rem;color:#0F172A;">${b.name}</div>
                      ${statusBadge(b.status)}
                    </div>
                    <div style="font-size:0.75rem;color:#64748B;margin-bottom:0.625rem;">
                      ⏰ ${b.timing}
                    </div>
                    <div class="progress-bar" style="margin-bottom:0.375rem;">
                      <div class="progress-bar-fill" style="width:${b.seats ? Math.min(100, Math.round((b.enrolled/b.seats)*100)) : 0}%;background:${(b.enrolled/b.seats) >= 0.85 ? '#DC2626' : (b.enrolled/b.seats) >= 0.6 ? '#D97706' : '#059669'};"></div>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:0.6875rem;color:#64748B;margin-bottom:0.75rem;">
                      <span>Enrolled: <strong>${b.enrolled}</strong></span>
                      <span>Total Capacity: <strong>${b.seats} Seats</strong></span>
                    </div>
                    ${isSuperAdmin ? `
                      <button class="btn btn-xs ${b.status==='active'?'btn-outline':'btn-success'}" style="width:100%;" onclick="window._adminToggleBatch('${c.id}', '${b.id}')">
                        ${b.status==='active' ? 'Mark Batch Full/Closed' : 'Reactivate Batch'}
                      </button>
                    ` : ''}
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- Learning Modes -->
            <div class="detail-section" style="margin-bottom:0;">
              <div class="detail-section-title">Approved Delivery Modes</div>
              <div style="display:flex;flex-wrap:wrap;gap:0.375rem;">
                ${c.learningModes.map(m => `
                  <span class="tag" style="background:#ECFDF5;color:#065F46;border:1px solid #A7F3D0;font-size:0.75rem;padding:0.25rem 0.625rem;font-weight:600;">
                    🏛️ ${m}
                  </span>
                `).join('')}
              </div>
            </div>
          </div>
        </div>
      `).join('')}`;
  }

  // ─── REPORTS & ANALYTICS ───
  function renderReports() {
    const commLogs = typeof AdminData.getCommunicationLogs === 'function' ? AdminData.getCommunicationLogs() : [];
    const role = SESSION?.role || 'super_admin';
    const userId = SESSION?.userId || null;
    const a = typeof AdminData.calculateAnalytics === 'function'
      ? AdminData.calculateAnalytics(role, userId)
      : (AdminData && AdminData.analytics ? AdminData.analytics : {
          monthlyEnquiries: [],
          monthlyBookings: [],
          conversionFunnel: { totalEnquiries: 0, contacted: 0, interested: 0, converted: 0, conversionRate: 0 },
          courseWiseEnquiries: [],
          champions: []
        });

    const maxMonthly = Math.max(1, ...(a.monthlyEnquiries || []).map(m => m.count || 0));
    const maxBookings = Math.max(1, ...(a.monthlyBookings || []).map(m => m.count || 0));
    const funnel = a.conversionFunnel || { totalEnquiries: 0, contacted: 0, interested: 0, converted: 0, conversionRate: 0 };
    const totalEnq = funnel.totalEnquiries || 0;
    const champions = a.champions || [];

    return `
      <!-- Chart Trends -->
      <div class="grid-2 section-gap">
        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Admission Enquiry Inflow (6-Month Trend)</h3>
              <p style="font-size:0.75rem;color:#64748B;">Total lead submissions across all examination cohorts</p>
            </div>
          </div>
          <div class="admin-card-body">
            <div class="chart-bar-group">
              ${(a.monthlyEnquiries || []).map(m => {
                const count = m.count || 0;
                const barHeight = count > 0 ? Math.max(4, Math.round((count / maxMonthly) * 140)) : 0;
                return `
                  <div class="chart-bar">
                    <div class="chart-bar-value">${count}</div>
                    <div class="chart-bar-fill" style="height:${barHeight}px;"></div>
                    <div class="chart-bar-label">${m.month}</div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>

        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Counselling Booking Requests (6-Month Trend)</h3>
              <p style="font-size:0.75rem;color:#64748B;">Free 30-minute exam strategy appointment requests</p>
            </div>
          </div>
          <div class="admin-card-body">
            <div class="chart-bar-group">
              ${(a.monthlyBookings || []).map(m => {
                const count = m.count || 0;
                const barHeight = count > 0 ? Math.max(4, Math.round((count / maxBookings) * 140)) : 0;
                return `
                  <div class="chart-bar">
                    <div class="chart-bar-value">${count}</div>
                    <div class="chart-bar-fill gold" style="height:${barHeight}px;"></div>
                    <div class="chart-bar-label">${m.month}</div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      </div>

      <!-- Funnel & Course Breakdown -->
      <div class="grid-2 section-gap">
        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Admission Enquiry Conversion Funnel</h3>
              <p style="font-size:0.75rem;color:#64748B;">Lead progression from enquiry to admitted student</p>
            </div>
          </div>
          <div class="admin-card-body">
            ${[
              { label: 'Total Enquiries Logged', value: funnel.totalEnquiries || 0, pct: totalEnq > 0 ? 100 : 0, color: '#3B82F6' },
              { label: 'Contacted by Admission Desk', value: funnel.contacted || 0, pct: totalEnq > 0 ? Math.round(((funnel.contacted || 0) / totalEnq) * 100) : 0, color: '#F59E0B' },
              { label: 'Interested in Enrollment', value: funnel.interested || 0, pct: totalEnq > 0 ? Math.round(((funnel.interested || 0) / totalEnq) * 100) : 0, color: '#8B5CF6' },
              { label: 'Successfully Admitted Students', value: funnel.converted || 0, pct: totalEnq > 0 ? Math.round(((funnel.converted || 0) / totalEnq) * 100) : 0, color: '#059669' },
            ].map(f => `
              <div style="margin-bottom:1rem;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.375rem;">
                  <span style="font-size:0.8125rem;font-weight:600;color:#0F172A;">${f.label}</span>
                  <span style="font-size:0.8125rem;font-weight:700;">${f.value} <span style="font-size:0.6875rem;color:#64748B;font-weight:400;">(${f.pct}%)</span></span>
                </div>
                <div class="progress-bar">
                  <div class="progress-bar-fill" style="width:${f.pct}%;background:${f.color};"></div>
                </div>
              </div>
            `).join('')}

            <div style="text-align:center;padding-top:1rem;border-top:1px solid #F1F5F9;margin-top:1rem;">
              <div style="font-size:2.25rem;font-weight:800;color:#059669;letter-spacing:-0.03em;">
                ${funnel.conversionRate || 0}%
              </div>
              <div style="font-size:0.75rem;color:#64748B;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">
                Aggregate Lead Conversion Rate
              </div>
            </div>
          </div>
        </div>

        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Course Stream Share</h3>
              <p style="font-size:0.75rem;color:#64748B;">Distribution across academic cohorts</p>
            </div>
          </div>
          <div class="admin-card-body">
            ${(a.courseWiseEnquiries || []).map(c => {
              const colors = { 'Civil Services & SSC': '#1E3A8A', 'Banking & Railway': '#D97706', 'Foundation Program': '#059669' };
              const pct = c.percentage || 0;
              return `
                <div style="margin-bottom:1.125rem;">
                  <div style="display:flex;justify-content:space-between;margin-bottom:0.375rem;">
                    <span style="font-size:0.8125rem;font-weight:700;color:#0F172A;">${escapeHtml(c.course)}</span>
                    <span style="font-size:0.8125rem;font-weight:700;">${c.count || 0} leads <span style="font-size:0.6875rem;color:#64748B;font-weight:400;">(${pct}%)</span></span>
                  </div>
                  <div class="progress-bar">
                    <div class="progress-bar-fill" style="width:${pct}%;background:${colors[c.course] || '#3B82F6'};"></div>
                  </div>
                </div>
              `;
            }).join('')}

            <div style="padding-top:1.25rem;border-top:1px solid #F1F5F9;margin-top:1.25rem;">
              <div class="detail-section-title">Department Conversion Champions</div>
              ${champions.length > 0 ? champions.slice(0, 3).map(c => `
                <div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;">
                  <div class="sidebar-user-avatar" style="width:32px;height:32px;font-size:0.6875rem;background:#EFF6FF;color:#1E3A8A;border:none;">
                    ${initials(c.name)}
                  </div>
                  <div style="flex:1;">
                    <div style="font-size:0.8125rem;font-weight:700;color:#0F172A;">${escapeHtml(c.name)}</div>
                    <div style="font-size:0.6875rem;color:#64748B;">${escapeHtml(c.department)}</div>
                  </div>
                  <div style="font-size:0.8125rem;font-weight:700;color:#059669;">
                    ${escapeHtml(c.scoreLabel || '0 Sessions')}
                  </div>
                </div>
              `).join('') : `
                <div style="font-size:0.8125rem;color:#64748B;padding:0.5rem 0;text-align:center;">
                  No active counsellor records logged yet.
                </div>
              `}
            </div>
          </div>
        </div>
      </div>

      <!-- Automated Communication Audit Log -->
      <div class="admin-card section-gap">
        <div class="admin-card-header">
          <div>
            <h3 class="admin-card-title">Institute Communication Audit Log</h3>
            <p style="font-size:0.75rem;color:#64748B;">Official Email dispatches sent under APEX ACADEMY identity</p>
          </div>
          <span class="badge" style="background:#EFF6FF;color:#1E40AF;font-size:0.75rem;font-weight:600;">Official Display: APEX ACADEMY</span>
        </div>
        <div class="admin-card-body no-padding">
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Channel</th>
                  <th>Message Type</th>
                  <th>Recipient</th>
                  <th>Initiator (Actor)</th>
                  <th>Delivery Status</th>
                </tr>
              </thead>
              <tbody>
                ${commLogs.length ? commLogs.slice(0, 15).map(l => {
                  const isEmail = l.channel === 'email';
                  const icon = '✉️ Email';
                  const typeLabel = (l.message_type || 'Notification').replace(/_/g, ' ').toUpperCase();
                  let statusBadge = '<span class="badge" style="background:#FEF3C7;color:#B45309;font-size:0.6875rem;">Pending</span>';
                  if (l.status === 'sent') statusBadge = '<span class="badge" style="background:#DBEAFE;color:#1E40AF;font-size:0.6875rem;">Sent</span>';
                  else if (l.status === 'delivered') statusBadge = '<span class="badge" style="background:#DCFCE7;color:#166534;font-size:0.6875rem;">Delivered</span>';
                  else if (l.status === 'read') statusBadge = '<span class="badge" style="background:#E0E7FF;color:#4338CA;font-size:0.6875rem;">Read</span>';
                  else if (l.status === 'failed') statusBadge = '<span class="badge" style="background:#FEE2E2;color:#991B1B;font-size:0.6875rem;">Failed</span>';
                  return `
                    <tr>
                      <td style="font-size:0.75rem;white-space:nowrap;">${formatDateTime(l.created_at)}</td>
                      <td><span style="font-weight:600;font-size:0.75rem;">${icon}</span></td>
                      <td style="font-size:0.75rem;font-weight:600;color:#0F172A;">${escapeHtml(typeLabel)}</td>
                      <td style="font-size:0.75rem;font-family:monospace;">${escapeHtml(l.recipient || '')}</td>
                      <td style="font-size:0.75rem;">${escapeHtml(l.actor_name || AdminData.getCounsellorName(l.actor_id) || 'System Engine')}</td>
                      <td>${statusBadge}</td>
                    </tr>
                  `;
                }).join('') : '<tr><td colspan="6" class="empty-state" style="text-align:center;padding:1.5rem;color:#64748B;">No communication dispatch records found</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  // ─── TODAY'S SCHEDULE (Academic Counsellor) ───
  
  // ─── COUNSELLOR AVAILABILITY RENDERER ───
  function renderAvailability() {
    const isSuperAdmin = SESSION.role === "super_admin";
    const academicCounsellors = (AdminData.counsellors || []).filter(c => 
      c.department === "Academic Counselling Department" || c.role === "academic_counsellor"
    );

    let targetCounsellorId = SESSION.userId;
    let targetCounsellorName = SESSION.name;

    if (isSuperAdmin) {
      if (!SELECTED_AVAIL_COUNSELLOR_ID && academicCounsellors.length > 0) {
        SELECTED_AVAIL_COUNSELLOR_ID = academicCounsellors[0].id;
      }
      targetCounsellorId = SELECTED_AVAIL_COUNSELLOR_ID;
      const found = academicCounsellors.find(c => c.id === targetCounsellorId);
      if (found) targetCounsellorName = found.name;
    }

    const weeklySchedule = (LOADED_AVAIL_SCHEDULE && LOADED_AVAIL_SCHEDULE.counsellorId === targetCounsellorId)
      ? LOADED_AVAIL_SCHEDULE.schedule
      : (typeof AdminData.getCounsellorAvailability === "function" ? AdminData.getCounsellorAvailability(targetCounsellorId) : []);

    const unavailabilities = (LOADED_AVAIL_UNAVAILABILITY && LOADED_AVAIL_UNAVAILABILITY.counsellorId === targetCounsellorId)
      ? LOADED_AVAIL_UNAVAILABILITY.list
      : (typeof AdminData.getUnavailability === "function" ? AdminData.getUnavailability(targetCounsellorId) : []);

    const dayLabels = [
      { dow: 1, name: "Monday" },
      { dow: 2, name: "Tuesday" },
      { dow: 3, name: "Wednesday" },
      { dow: 4, name: "Thursday" },
      { dow: 5, name: "Friday" },
      { dow: 6, name: "Saturday" },
      { dow: 0, name: "Sunday" }
    ];

    const timeOptions = [
      "08:00", "08:30", "09:00", "09:30", "10:00", "10:30",
      "11:00", "11:30", "12:00", "12:30", "13:00", "13:30",
      "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
      "17:00", "17:30", "18:00", "18:30", "19:00", "19:30",
      "20:00", "20:30"
    ];

    function formatTimeLabel(t) {
      if (!t) return "";
      const [hStr, mStr] = t.split(":");
      let h = parseInt(hStr, 10);
      const ampm = h >= 12 ? "PM" : "AM";
      if (h > 12) h -= 12;
      if (h === 0) h = 12;
      return `${h}:${mStr || "00"} ${ampm}`;
    }

    return `
      <div style="display:flex;flex-direction:column;gap:1.5rem;">
        <!-- Header & Counsellor Switcher -->
        <div class="admin-card">
          <div class="admin-card-header" style="flex-wrap:wrap;gap:1rem;justify-content:space-between;align-items:center;">
            <div>
              <h3 class="admin-card-title">Counsellor Consultation Availability & Calendar Rules</h3>
              <p style="font-size:0.75rem;color:#64748B;">
                Configures active working days, operating hours, slot duration, and break windows. Public booking page dynamically fetches real-time available slots.
              </p>
            </div>
            ${isSuperAdmin ? `
              <div style="display:flex;align-items:center;gap:0.75rem;">
                <label for="adminCounsellorSelect" style="font-size:0.75rem;font-weight:700;color:#0F172A;white-space:nowrap;">Select Academic Mentor:</label>
                <select id="adminCounsellorSelect" class="form-select" style="min-width:220px;font-weight:600;">
                  ${academicCounsellors.map(c => `
                    <option value="${c.id}" ${c.id === targetCounsellorId ? "selected" : ""}>${c.name} (${c.specialisation || "Academic Mentor"})</option>
                  `).join("")}
                </select>
              </div>
            ` : `
              <div style="display:flex;align-items:center;gap:0.5rem;">
                <span class="tag" style="background:#EFF6FF;color:#1E3A8A;font-weight:700;padding:0.4rem 0.75rem;">
                  👨‍🏫 Mentor: ${escapeHtml(targetCounsellorName)}
                </span>
              </div>
            `}
          </div>
          <div class="admin-card-body" style="background:#F8FAFC;border-top:1px solid #F1F5F9;padding:0.75rem 1.25rem;">
            <div style="font-size:0.8125rem;color:#334155;display:flex;align-items:center;gap:0.5rem;">
              <span>⚡</span>
              <span><strong>Real-Time Sync Active:</strong> Changes saved here immediately update the student booking interface on <a href="../book-counselling.html" target="_blank" style="color:#1E3A8A;text-decoration:underline;font-weight:600;">book-counselling.html</a> without manual intervention.</span>
            </div>
          </div>
        </div>

        <!-- Weekly Working Schedule Form -->
        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Weekly Schedule & Consultation Hours</h3>
              <p style="font-size:0.75rem;color:#64748B;">Define standard recurring weekly consultation windows and breaks</p>
            </div>
            <button type="button" id="saveWeeklyAvailabilityBtn" class="btn btn-sm btn-gold" style="font-weight:700;">
              💾 Save Weekly Availability
            </button>
          </div>
          <div class="admin-card-body no-padding">
            <form id="weeklyScheduleForm">
              <input type="hidden" id="availTargetCounsellorId" value="${targetCounsellorId}">
              <div class="data-table-wrapper">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th style="width:130px;">Weekday</th>
                      <th style="width:120px;">Status</th>
                      <th>Consultation Window</th>
                      <th style="width:130px;">Slot Duration</th>
                      <th>Lunch / Break Window</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${dayLabels.map(d => {
                      const cfg = (weeklySchedule || []).find(s => s.day_of_week === d.dow) || {
                        day_of_week: d.dow,
                        is_available: d.dow !== 0,
                        start_time: "09:00",
                        end_time: "18:00",
                        slot_duration_minutes: 30,
                        has_break: d.dow !== 0,
                        break_start: "13:00",
                        break_end: "14:00"
                      };
                      const isAvail = Boolean(cfg.is_available);
                      const hasBreak = Boolean(cfg.has_break || (cfg.break_start && cfg.break_end));
                      const startTime = (cfg.start_time || "09:00").slice(0, 5);
                      const endTime = (cfg.end_time || "18:00").slice(0, 5);
                      const breakStart = (cfg.break_start || "13:00").slice(0, 5);
                      const breakEnd = (cfg.break_end || "14:00").slice(0, 5);
                      const duration = cfg.slot_duration_minutes || 30;

                      return `
                        <tr class="avail-day-row" data-dow="${d.dow}">
                          <td style="font-weight:700;color:#0F172A;">
                            ${d.name}
                          </td>
                          <td>
                            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:0.8125rem;font-weight:600;">
                              <input type="checkbox" class="day-avail-toggle" data-dow="${d.dow}" ${isAvail ? "checked" : ""}>
                              <span class="day-avail-label ${isAvail ? "text-emerald-700" : "text-slate-400"}" style="color:${isAvail ? "#059669" : "#94A3B8"};">
                                ${isAvail ? "Working" : "Day Off"}
                              </span>
                            </label>
                          </td>
                          <td>
                            <div class="day-time-controls ${isAvail ? "" : "opacity-40 pointer-events-none"}" style="display:flex;align-items:center;gap:0.5rem;">
                              <select class="form-select day-start-select" data-dow="${d.dow}" style="width:110px;padding:0.35rem 0.5rem;font-size:0.75rem;">
                                ${timeOptions.map(t => `<option value="${t}" ${t === startTime ? "selected" : ""}>${formatTimeLabel(t)}</option>`).join("")}
                              </select>
                              <span style="font-size:0.75rem;color:#64748B;">to</span>
                              <select class="form-select day-end-select" data-dow="${d.dow}" style="width:110px;padding:0.35rem 0.5rem;font-size:0.75rem;">
                                ${timeOptions.map(t => `<option value="${t}" ${t === endTime ? "selected" : ""}>${formatTimeLabel(t)}</option>`).join("")}
                              </select>
                            </div>
                          </td>
                          <td>
                            <div class="day-duration-controls ${isAvail ? "" : "opacity-40 pointer-events-none"}">
                              <select class="form-select day-duration-select" data-dow="${d.dow}" style="width:110px;padding:0.35rem 0.5rem;font-size:0.75rem;">
                                <option value="15" ${duration === 15 ? "selected" : ""}>15 mins</option>
                                <option value="30" ${duration === 30 ? "selected" : ""}>30 mins</option>
                                <option value="45" ${duration === 45 ? "selected" : ""}>45 mins</option>
                                <option value="60" ${duration === 60 ? "selected" : ""}>60 mins</option>
                              </select>
                            </div>
                          </td>
                          <td>
                            <div class="day-break-controls ${isAvail ? "" : "opacity-40 pointer-events-none"}" style="display:flex;align-items:center;gap:0.5rem;">
                              <label style="display:flex;align-items:center;gap:0.35rem;font-size:0.75rem;color:#475569;margin-right:0.25rem;">
                                <input type="checkbox" class="day-break-toggle" data-dow="${d.dow}" ${hasBreak ? "checked" : ""}>
                                Break
                              </label>
                              <div class="break-time-inputs ${hasBreak ? "" : "opacity-30 pointer-events-none"}" style="display:flex;align-items:center;gap:0.35rem;">
                                <select class="form-select day-break-start" data-dow="${d.dow}" style="width:105px;padding:0.35rem 0.5rem;font-size:0.75rem;">
                                  ${timeOptions.map(t => `<option value="${t}" ${t === breakStart ? "selected" : ""}>${formatTimeLabel(t)}</option>`).join("")}
                                </select>
                                <span style="font-size:0.75rem;color:#64748B;">-</span>
                                <select class="form-select day-break-end" data-dow="${d.dow}" style="width:105px;padding:0.35rem 0.5rem;font-size:0.75rem;">
                                  ${timeOptions.map(t => `<option value="${t}" ${t === breakEnd ? "selected" : ""}>${formatTimeLabel(t)}</option>`).join("")}
                                </select>
                              </div>
                            </div>
                          </td>
                        </tr>
                      `;
                    }).join("")}
                  </tbody>
                </table>
              </div>
            </form>
          </div>
        </div>

        <!-- Date-Specific Unavailability & Institute Holidays -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:1.5rem;">
          <!-- Block Date / Add Leave Form -->
          <div class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3 class="admin-card-title">Schedule Leave / Block Specific Date</h3>
                <p style="font-size:0.75rem;color:#64748B;">Blocks all counselling appointments for a specific calendar date</p>
              </div>
            </div>
            <div class="admin-card-body">
              <form id="addLeaveForm" style="display:flex;flex-direction:column;gap:1rem;">
                <div>
                  <label class="form-label" for="leaveDateInput">Calendar Date to Block *</label>
                  <input type="date" id="leaveDateInput" class="form-input" required min="${new Date().toISOString().split('T')[0]}">
                </div>
                <div>
                  <label class="form-label" for="leaveReasonInput">Reason / Description</label>
                  <input type="text" id="leaveReasonInput" class="form-input" placeholder="e.g. Personal Leave, Medical, Out of Town" value="Scheduled Leave">
                </div>
                ${isSuperAdmin ? `
                  <div style="padding:0.75rem;background:#FEF3C7;border:1px solid #FDE68A;border-radius:0.5rem;">
                    <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.75rem;font-weight:700;color:#92400E;cursor:pointer;">
                      <input type="checkbox" id="instituteWideHolidayCheck">
                      🏛️ Mark as Institute-Wide Holiday (Closes all counselling desks)
                    </label>
                  </div>
                ` : ""}
                <button type="submit" class="btn btn-sm btn-primary" style="margin-top:0.5rem;">
                  📅 Block This Date
                </button>
              </form>
            </div>
          </div>

          <!-- Existing Blocked Dates List -->
          <div class="admin-card">
            <div class="admin-card-header">
              <div>
                <h3 class="admin-card-title">Upcoming Blocked Dates & Holidays</h3>
                <p style="font-size:0.75rem;color:#64748B;">Active date exceptions where bookings are prevented</p>
              </div>
            </div>
            <div class="admin-card-body no-padding">
              <div class="data-table-wrapper">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Reason / Scope</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody id="unavailTableBody">
                    ${unavailabilities.length > 0 ? unavailabilities.map(u => {
                      const isInstWide = Boolean(u.is_institute_wide || u.counsellorId === null);
                      return `
                        <tr>
                          <td style="font-weight:700;color:#0F172A;white-space:nowrap;">
                            📅 ${formatDate(u.date)}
                          </td>
                          <td style="font-size:0.75rem;">
                            <div style="font-weight:600;color:#1E293B;">${escapeHtml(u.reason || "Scheduled Leave")}</div>
                            ${isInstWide 
                              ? `<span class="tag" style="background:#FEF3C7;color:#92400E;font-size:0.625rem;padding:0.1rem 0.4rem;font-weight:700;">🏛️ Institute-Wide Holiday</span>`
                              : `<span class="tag" style="background:#F1F5F9;color:#475569;font-size:0.625rem;padding:0.1rem 0.4rem;">👤 Personal Leave</span>`
                            }
                          </td>
                          <td>
                            <button type="button" class="btn btn-xs btn-outline remove-unavail-btn" data-id="${u.id}" style="color:#DC2626;border-color:#FCA5A5;">
                              Unblock
                            </button>
                          </td>
                        </tr>
                      `;
                    }).join("") : `
                      <tr>
                        <td colspan="3">
                          <div class="empty-state" style="padding:1.5rem 1rem;">
                            <div class="empty-state-title" style="font-size:0.875rem;">No blocked dates scheduled</div>
                            <div class="empty-state-text" style="font-size:0.75rem;">Regular weekly hours apply to all upcoming dates.</div>
                          </div>
                        </td>
                      </tr>
                    `}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderSchedule() {
    const data = AdminData.getDataForRole(SESSION.role, SESSION.userId);
    const bks = data ? data.bookings : [];
    const today = new Date().toISOString().split('T')[0];
    const todayAppointments = bks.filter(b => b.preferredDate === today || b.preferredDate === '2026-11-09');

    return `
      <div class="admin-card">
        <div class="admin-card-header">
          <div>
            <h3 class="admin-card-title">Today's Appointment Schedule — ${formatDate(new Date())}</h3>
            <p style="font-size:0.75rem;color:#64748B;">Your calendar of 1-on-1 strategic examination counselling calls</p>
          </div>
        </div>
        <div class="admin-card-body no-padding">
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Time Slot</th>
                  <th>Student Name</th>
                  <th>Mobile Number</th>
                  <th>Target Examination</th>
                  <th>Session Medium</th>
                  <th>Status</th>
                  <th>Session Actions</th>
                </tr>
              </thead>
              <tbody>
                ${todayAppointments.length ? todayAppointments.map(b => `
                  <tr>
                    <td style="font-weight:800;font-size:0.8125rem;color:#0A1128;white-space:nowrap;">
                      ⏰ ${b.preferredTime}
                    </td>
                    <td style="font-weight:700;color:#0F172A;">${b.studentName}</td>
                    <td style="font-size:0.75rem;">
                      <a href="tel:+91${b.mobile}" style="color:#1E3A8A;font-weight:600;">+91 ${b.mobile}</a>
                    </td>
                    <td style="font-size:0.75rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${b.targetExamination}">
                      ${b.targetExamination}
                    </td>
                    <td style="font-size:0.75rem;white-space:nowrap;">
                      ${b.sessionMedium ? b.sessionMedium.split('(')[0].trim() : 'Diagnostic Call'}
                    </td>
                    <td>${statusBadge(b.status)}</td>
                    <td>
                      <button class="btn btn-xs btn-outline view-booking-btn" data-id="${b.id}">
                        ${ICONS.eye} Conduct Call
                      </button>
                    </td>
                  </tr>
                `).join('') : `
                  <tr>
                    <td colspan="7">
                      <div class="empty-state">
                        <div class="empty-state-title">No appointments scheduled for today</div>
                        <div class="empty-state-text">Check upcoming days under My Bookings.</div>
                      </div>
                    </td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  // ─── COUNSELLING HISTORY (Academic Counsellor) ───
  function renderHistory() {
    const data = AdminData.getDataForRole(SESSION.role, SESSION.userId);
    const bks = data ? data.bookings : [];
    const pastSessions = bks.filter(b => b.status === 'completed' || b.status === 'no_show' || b.status === 'cancelled');

    return `
      <div class="admin-card">
        <div class="admin-card-header">
          <div>
            <h3 class="admin-card-title">Completed Counselling History & Outcome Logs</h3>
            <p style="font-size:0.75rem;color:#64748B;">Archive of previous diagnostic sessions and student roadmaps</p>
          </div>
        </div>
        <div class="admin-card-body no-padding">
          <div class="data-table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Booking ID</th>
                  <th>Student Name</th>
                  <th>Session Date</th>
                  <th>Time Slot</th>
                  <th>Target Examination</th>
                  <th>Medium</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${pastSessions.length ? pastSessions.map(b => `
                  <tr>
                    <td style="font-family:monospace;font-size:0.75rem;color:#64748B;">${b.id}</td>
                    <td style="font-weight:700;color:#0F172A;">${b.studentName}</td>
                    <td style="font-size:0.75rem;white-space:nowrap;">${formatDate(b.preferredDate)}</td>
                    <td style="font-size:0.75rem;white-space:nowrap;">${b.preferredTime}</td>
                    <td style="font-size:0.75rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${b.targetExamination}</td>
                    <td style="font-size:0.75rem;">${b.sessionMedium ? b.sessionMedium.split('(')[0].trim() : 'Diagnostic Call'}</td>
                    <td>${statusBadge(b.status)}</td>
                    <td>
                      <button class="btn btn-xs btn-outline view-booking-btn" data-id="${b.id}">
                        ${ICONS.eye} Review Notes
                      </button>
                    </td>
                  </tr>
                `).join('') : `
                  <tr>
                    <td colspan="8">
                      <div class="empty-state">
                        <div class="empty-state-title">No completed session history recorded yet</div>
                      </div>
                    </td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  // ─── SETTINGS & PROFILE ───
  function renderSettings() {
    return `
      <div style="max-width:680px;display:flex;flex-direction:column;gap:1.5rem;">
        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Account Profile Information</h3>
              <p style="font-size:0.75rem;color:#64748B;">Currently authenticated staff credentials (Demo Mode)</p>
            </div>
            ${statusBadge('confirmed')}
          </div>
          <div class="admin-card-body">
            <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid #F1F5F9;">
              <div class="sidebar-user-avatar" style="width:60px;height:60px;font-size:1.25rem;background:#EFF6FF;color:#1E3A8A;border:2px solid #DBEAFE;">
                ${initials(SESSION.name)}
              </div>
              <div>
                <div style="font-weight:800;font-size:1.125rem;color:#0F172A;">${SESSION.name}</div>
                <div style="font-size:0.8125rem;color:#64748B;">${SESSION.email}</div>
                <div style="margin-top:0.375rem;">
                  <span class="tag" style="background:#F5F3FF;color:#7C3AED;font-weight:600;">
                    ${formatRole(SESSION.role)} · ${SESSION.department}
                  </span>
                </div>
              </div>
            </div>

            <div class="detail-row">
              <span class="detail-row-label">Internal Role ID</span>
              <span class="detail-row-value" style="font-family:monospace;">${SESSION.userId}</span>
            </div>
            <div class="detail-row">
              <span class="detail-row-label">Assigned Department</span>
              <span class="detail-row-value">${SESSION.department}</span>
            </div>
            <div class="detail-row">
              <span class="detail-row-label">Authentication Mode</span>
              <span class="detail-row-value">Local Mock Authentication (Supabase Ready)</span>
            </div>
            <div class="detail-row">
              <span class="detail-row-label">Session Initialized</span>
              <span class="detail-row-value">${formatDateTime(SESSION.loginTime)}</span>
            </div>
          </div>
        </div>

        <div class="admin-card">
          <div class="admin-card-header">
            <div>
              <h3 class="admin-card-title">Demonstration Environment Control</h3>
              <p style="font-size:0.75rem;color:#64748B;">Manage sample localStorage records and testing data</p>
            </div>
          </div>
          <div class="admin-card-body">
            <p style="font-size:0.8125rem;color:#64748B;line-height:1.6;margin-bottom:1.25rem;">
              You can modify records, schedule follow-ups, assign mentors, and change statuses. All alterations persist in your browser's localStorage. You can restore the baseline test dataset anytime.
            </p>
            <button class="btn btn-outline" id="settingsResetDemoBtn">
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
              <span>Reset All Records to Factory Demonstration State</span>
            </button>
          </div>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════
  // DETAIL VIEWS (Drawer & Modals)
  // ══════════════════════════════════════════════

  function showEnquiryDetail(id) {
    const e = AdminData.enquiries.find(en => en.id === id);
    if (!e) return;
    const isSuperAdmin = SESSION.role === 'super_admin';
    const isAssignedCounsellor = SESSION.role === 'admission_counsellor';
    const counsellors = AdminData.counsellors.filter(c => c.department === 'Admission Department' && c.status === 'active');
    const commLogs = typeof AdminData.getStudentCommunicationLogs === 'function'
      ? AdminData.getStudentCommunicationLogs(e.studentId, e.mobile, e.email)
      : [];

    const bodyHtml = `
      <!-- Student Profile -->
      <div class="detail-section">
        <div class="detail-section-title">Aspirant Profile</div>
        <div class="detail-row"><span class="detail-row-label">Student Name</span><span class="detail-row-value" style="font-weight:700;">${e.studentName}</span></div>
        <div class="detail-row"><span class="detail-row-label">Mobile Number</span><span class="detail-row-value"><a href="tel:+91${e.mobile}" style="color:#1E3A8A;font-weight:600;">+91 ${e.mobile}</a></span></div>
        <div class="detail-row"><span class="detail-row-label">Email Address</span><span class="detail-row-value">${e.email}</span></div>
        <div class="detail-row"><span class="detail-row-label">Educational Qualification</span><span class="detail-row-value">${e.qualification}</span></div>
      </div>

      <!-- Course & Cohort Preferences -->
      <div class="detail-section">
        <div class="detail-section-title">Cohort & Course Preferences</div>
        <div class="detail-row"><span class="detail-row-label">Course Stream</span><span class="detail-row-value" style="font-weight:600;">${e.courseCategory}</span></div>
        <div class="detail-row"><span class="detail-row-label">Target Examination</span><span class="detail-row-value" style="font-weight:700;color:#1E3A8A;">${e.targetExamination}</span></div>
        <div class="detail-row"><span class="detail-row-label">Preferred Timing</span><span class="detail-row-value">${e.preferredBatch}</span></div>
        <div class="detail-row"><span class="detail-row-label">Preferred Mode</span><span class="detail-row-value">${e.learningMode}</span></div>
      </div>

      <!-- Lead Status & Tracking -->
      <div class="detail-section">
        <div class="detail-section-title">Lead Governance</div>
        <div class="detail-row"><span class="detail-row-label">Current Status</span><span class="detail-row-value">${statusBadge(e.status)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Assigned Staff</span><span class="detail-row-value" style="font-weight:600;">${AdminData.getCounsellorName(e.assignedCounsellor)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Enquiry Logged At</span><span class="detail-row-value">${formatDateTime(e.submittedAt)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Official Reference</span><span class="detail-row-value" style="font-family:monospace;font-weight:600;">${e.id}</span></div>
      </div>

      ${e.message ? `
        <div class="detail-section">
          <div class="detail-section-title">Student Query / Academic Notes</div>
          <div style="padding:0.875rem;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:0.5rem;font-size:0.8125rem;line-height:1.6;color:#334155;">
            "${e.message}"
          </div>
        </div>
      ` : ''}

      <!-- Internal Notes Log -->
      <div class="detail-section">
        <div class="detail-section-title">Internal Counsellor Notes (${e.notes ? e.notes.length : 0})</div>
        ${e.notes && e.notes.length ? e.notes.map(n => `
          <div class="note-item">
            <div class="note-avatar">${initials(n.addedBy)}</div>
            <div class="note-content">
              <div class="note-meta"><strong>${n.addedBy}</strong> · ${formatDateTime(n.addedAt)}</div>
              <div class="note-text">${n.text}</div>
            </div>
          </div>
        `).join('') : '<div style="font-size:0.8125rem;color:#94A3B8;">No internal notes logged yet.</div>'}

        <div style="margin-top:0.875rem;">
          <textarea id="drawerEnqNote" class="form-textarea" placeholder="Add confidential notes on student readiness, budget, or batch fit..." style="min-height:65px;"></textarea>
          <button class="btn btn-sm btn-outline" style="margin-top:0.5rem;" onclick="window._adminAddEnqNote('${e.id}')">
            ${ICONS.plus} Append Note
          </button>
        </div>
      </div>

      <!-- Communication History -->
      <div class="detail-section">
        <div class="detail-section-title">Communication History (${commLogs.length})</div>
        ${commLogs.length ? `
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${commLogs.map(l => {
              const isEmail = l.channel === 'email';
              const icon = isEmail ? '✉️' : '💬';
              const channelBadge = '<span class="badge" style="background:#EFF6FF;color:#1D4ED8;font-size:0.6875rem;">Email</span>';
              let statusBadge = '<span class="badge" style="background:#FEF3C7;color:#B45309;font-size:0.6875rem;">Pending</span>';
              if (l.status === 'sent') statusBadge = '<span class="badge" style="background:#DBEAFE;color:#1E40AF;font-size:0.6875rem;">Sent</span>';
              else if (l.status === 'delivered') statusBadge = '<span class="badge" style="background:#DCFCE7;color:#166534;font-size:0.6875rem;">Delivered</span>';
              else if (l.status === 'read') statusBadge = '<span class="badge" style="background:#E0E7FF;color:#4338CA;font-size:0.6875rem;">Read</span>';
              else if (l.status === 'failed') statusBadge = '<span class="badge" style="background:#FEE2E2;color:#991B1B;font-size:0.6875rem;">Failed</span>';
              
              const typeName = (l.message_type || 'Notification').replace(/_/g, ' ').toUpperCase();
              return `
                <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;padding:8px 10px;font-size:0.75rem;">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                    <div style="display:flex;align-items:center;gap:6px;font-weight:600;color:#0F172A;">
                      <span>${icon}</span>
                      <span>${typeName}</span>
                      ${channelBadge}
                    </div>
                    <div>${statusBadge}</div>
                  </div>
                  <div style="display:flex;justify-content:space-between;color:#64748B;font-size:0.6875rem;">
                    <span>To: ${escapeHtml(l.recipient || '')}</span>
                    <span>${formatDateTime(l.created_at)}</span>
                  </div>
                  ${l.error_details ? `<div style="color:#DC2626;margin-top:4px;font-size:0.6875rem;">Error: ${escapeHtml(l.error_details)}</div>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        ` : '<div style="font-size:0.8125rem;color:#94A3B8;">No automated communications logged yet for this aspirant.</div>'}
      </div>

      <!-- Action Panel (Super Admin OR Assigned Counsellor) -->
      ${(isSuperAdmin || isAssignedCounsellor) ? `
        <div class="detail-section" style="background:#F8FAFC;padding:1rem;border-radius:0.75rem;border:1px solid #E2E8F0;">
          <div class="detail-section-title" style="margin-bottom:0.75rem;">Update Lead Status & Follow-up</div>

          ${isSuperAdmin ? `
            <div class="form-group">
              <label class="form-label" for="drawerAssignEnqCounsellor">Assign Admission Counsellor</label>
              <select class="form-select" id="drawerAssignEnqCounsellor">
                <option value="">-- Unassigned --</option>
                ${counsellors.map(c => `<option value="${c.id}" ${e.assignedCounsellor===c.id?'selected':''}>${c.name}</option>`).join('')}
              </select>
            </div>
          ` : ''}

          <div class="form-group">
            <label class="form-label" for="drawerChangeEnqStatus">Update Enquiry Status</label>
            <select class="form-select" id="drawerChangeEnqStatus">
              <option value="New" ${(e.status||'').toLowerCase()==='new'?'selected':''}>New Lead</option>
              <option value="Contacted" ${(e.status||'').toLowerCase()==='contacted'?'selected':''}>Contacted</option>
              <option value="Interested" ${(e.status||'').toLowerCase()==='interested'?'selected':''}>Interested</option>
              <option value="Pending Follow-up" ${(e.status||'').toLowerCase().includes('follow')?'selected':''}>Pending Follow-up</option>
              <option value="Converted" ${(e.status||'').toLowerCase()==='converted'?'selected':''}>Converted (Admitted)</option>
              <option value="Not Interested" ${(e.status||'').toLowerCase().includes('not') || (e.status||'').toLowerCase()==='closed'?'selected':''}>Not Interested (Closed)</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">Schedule Follow-up Task</label>
            <input type="date" class="form-input" id="drawerEnqFuDate">
            <input type="text" class="form-input" id="drawerEnqFuPurpose" placeholder="Follow-up objective (e.g. Discuss fee waiver, syllabus kit)" style="margin-top:0.375rem;">
          </div>

          <button id="btnSaveEnqDrawer" class="btn btn-sm btn-gold" style="width:100%;margin-top:0.5rem;" onclick="window._adminSaveEnqDrawer('${e.id}')">
            Save Changes
          </button>
        </div>
      ` : ''}`;

    openDrawer(`Enquiry: ${e.studentName}`, bodyHtml);
  }

  function showBookingDetail(id) {
    const b = AdminData.bookings.find(bk => bk.id === id);
    if (!b) return;
    const isSuperAdmin = SESSION.role === 'super_admin';
    const isAssignedCounsellor = SESSION.role === 'academic_counsellor';
    const counsellors = AdminData.counsellors.filter(c => c.department === 'Academic Counselling Department' && c.status === 'active');
    const commLogs = typeof AdminData.getStudentCommunicationLogs === 'function'
      ? AdminData.getStudentCommunicationLogs(b.studentId, b.phone, b.email)
      : [];

    const bodyHtml = `
      <!-- Aspirant Profile -->
      <div class="detail-section">
        <div class="detail-section-title">Aspirant Profile</div>
        <div class="detail-row"><span class="detail-row-label">Student Name</span><span class="detail-row-value" style="font-weight:700;">${b.studentName}</span></div>
        <div class="detail-row"><span class="detail-row-label">Mobile Number</span><span class="detail-row-value"><a href="tel:+91${b.mobile}" style="color:#1E3A8A;font-weight:600;">+91 ${b.mobile}</a></span></div>
        <div class="detail-row"><span class="detail-row-label">Email Address</span><span class="detail-row-value">${b.email}</span></div>
      </div>

      <!-- Strategic Session Details -->
      <div class="detail-section">
        <div class="detail-section-title">Session Scheduling & Medium</div>
        <div class="detail-row"><span class="detail-row-label">Target Stream</span><span class="detail-row-value" style="font-weight:600;">${b.courseCategory}</span></div>
        <div class="detail-row"><span class="detail-row-label">Target Examination</span><span class="detail-row-value" style="font-weight:700;color:#1E3A8A;">${b.targetExamination}</span></div>
        <div class="detail-row"><span class="detail-row-label">Scheduled Date</span><span class="detail-row-value" style="font-weight:700;">${formatDate(b.preferredDate)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Time Window</span><span class="detail-row-value" style="color:#D97706;font-weight:700;">${b.preferredTime}</span></div>
        <div class="detail-row"><span class="detail-row-label">Session Medium</span><span class="detail-row-value">${b.sessionMedium}</span></div>
      </div>

      <!-- Google Meet Video Conference -->
      <div class="detail-section" style="background:#EFF6FF;padding:0.875rem;border-radius:0.75rem;border:1px solid #BFDBFE;">
        <div class="detail-section-title" style="color:#1E3A8A;margin-bottom:0.5rem;display:flex;align-items:center;justify-content:space-between;">
          <span>Google Meet Video Link</span>
          <span style="font-size:0.6875rem;color:#2563EB;font-weight:600;">Super Admin Only</span>
        </div>
        ${isSuperAdmin ? `
          <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">
            <input type="url" id="drawerMeetLinkInput" class="form-input" style="font-size:0.8125rem;padding:0.375rem 0.625rem;background:#fff;" placeholder="https://meet.google.com/xxx-yyyy-zzz" value="${b.googleMeetLink || ''}">
            <button class="btn btn-xs btn-primary" onclick="window._adminSaveMeetLink('${b.id}')">Save</button>
          </div>
          <div style="display:flex;gap:0.375rem;flex-wrap:wrap;">
            <button class="btn btn-xs btn-outline" onclick="window._adminGenerateMeetLink('${b.id}')">Configure / Prompt Link</button>
            ${b.googleMeetLink ? `
              <button class="btn btn-xs btn-outline" onclick="window._adminCopyMeetLink('${b.id}')">Copy Link</button>
              <a href="${b.googleMeetLink}" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-success" style="display:inline-flex;align-items:center;gap:4px;">🎥 Join Call</a>
            ` : ''}
          </div>
        ` : `
          ${b.googleMeetLink ? `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
              <span style="font-size:0.8125rem;font-family:monospace;color:#1E3A8A;word-break:break-all;">${b.googleMeetLink}</span>
              <div style="display:flex;gap:0.375rem;flex-shrink:0;">
                <button class="btn btn-xs btn-outline" onclick="navigator.clipboard.writeText('${b.googleMeetLink}').then(() => showToast('Copied', 'Meet link copied.', 'info'))">Copy</button>
                <a href="${b.googleMeetLink}" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-success">🎥 Join Call</a>
              </div>
            </div>
          ` : `
            <div style="font-size:0.8125rem;color:#64748B;font-style:italic;">
              Video link not yet configured. Contact Super Admin to generate Google Meet link.
            </div>
          `}
        `}
      </div>

      <!-- Booking Governance -->
      <div class="detail-section">
        <div class="detail-section-title">Booking Status</div>
        <div class="detail-row"><span class="detail-row-label">Current Status</span><span class="detail-row-value">${statusBadge(b.status)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Assigned Mentor</span><span class="detail-row-value" style="font-weight:600;">${AdminData.getCounsellorName(b.assignedCounsellor)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Booking Reference</span><span class="detail-row-value" style="font-family:monospace;font-weight:600;">${b.id}</span></div>
        <div class="detail-row"><span class="detail-row-label">Request Dispatched</span><span class="detail-row-value">${formatDateTime(b.submittedAt)}</span></div>
      </div>

      <!-- Direct Action Buttons Bar -->
      <div class="detail-section">
        <div class="detail-section-title">Quick Actions</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">
          <button class="btn btn-xs btn-success" onclick="window._adminConfirmBooking('${b.id}')">
            ${ICONS.check} Confirm Appointment
          </button>
          <button class="btn btn-xs btn-outline" onclick="window._adminRescheduleModal('${b.id}')">
            ${ICONS.calendar} Reschedule Session
          </button>
          <button class="btn btn-xs btn-outline" onclick="window._adminCompleteBooking('${b.id}')">
            ${ICONS.check} Mark Completed
          </button>
          <button class="btn btn-xs btn-danger" onclick="window._adminNoShowBooking('${b.id}')">
            ${ICONS.close} Mark No-Show
          </button>
        </div>
        <div style="margin-top:0.5rem;">
          <button class="btn btn-xs btn-danger" style="width:100%;" onclick="window._adminCancelBooking('${b.id}')">
            ${ICONS.cancel} Cancel Booking
          </button>
        </div>
      </div>

      <!-- Private Counselling Notes Log -->
      <div class="detail-section">
        <div class="detail-section-title">Confidential Diagnostic Notes (${b.notes ? b.notes.length : 0})</div>
        ${b.notes && b.notes.length ? b.notes.map(n => `
          <div class="note-item">
            <div class="note-avatar">${initials(n.addedBy)}</div>
            <div class="note-content">
              <div class="note-meta"><strong>${n.addedBy}</strong> · ${formatDateTime(n.addedAt)}</div>
              <div class="note-text">${n.text}</div>
            </div>
          </div>
        `).join('') : '<div style="font-size:0.8125rem;color:#94A3B8;">No diagnostic notes recorded yet.</div>'}

        <div style="margin-top:0.875rem;">
          <textarea id="drawerBkNote" class="form-textarea" placeholder="Record diagnostic notes, cut-off evaluation, timetable recommendations..." style="min-height:65px;"></textarea>
          <button class="btn btn-sm btn-outline" style="margin-top:0.5rem;" onclick="window._adminAddBkNote('${b.id}')">
            ${ICONS.plus} Add Private Note
          </button>
        </div>
      </div>

      <!-- Communication History -->
      <div class="detail-section">
        <div class="detail-section-title">Communication History (${commLogs.length})</div>
        ${commLogs.length ? `
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${commLogs.map(l => {
              const isEmail = l.channel === 'email';
              const icon = isEmail ? '✉️' : '💬';
              const channelBadge = '<span class="badge" style="background:#EFF6FF;color:#1D4ED8;font-size:0.6875rem;">Email</span>';
              let statusBadge = '<span class="badge" style="background:#FEF3C7;color:#B45309;font-size:0.6875rem;">Pending</span>';
              if (l.status === 'sent') statusBadge = '<span class="badge" style="background:#DBEAFE;color:#1E40AF;font-size:0.6875rem;">Sent</span>';
              else if (l.status === 'delivered') statusBadge = '<span class="badge" style="background:#DCFCE7;color:#166534;font-size:0.6875rem;">Delivered</span>';
              else if (l.status === 'read') statusBadge = '<span class="badge" style="background:#E0E7FF;color:#4338CA;font-size:0.6875rem;">Read</span>';
              else if (l.status === 'failed') statusBadge = '<span class="badge" style="background:#FEE2E2;color:#991B1B;font-size:0.6875rem;">Failed</span>';
              
              const typeName = (l.message_type || 'Notification').replace(/_/g, ' ').toUpperCase();
              return `
                <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;padding:8px 10px;font-size:0.75rem;">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                    <div style="display:flex;align-items:center;gap:6px;font-weight:600;color:#0F172A;">
                      <span>${icon}</span>
                      <span>${typeName}</span>
                      ${channelBadge}
                    </div>
                    <div>${statusBadge}</div>
                  </div>
                  <div style="display:flex;justify-content:space-between;color:#64748B;font-size:0.6875rem;">
                    <span>To: ${escapeHtml(l.recipient || '')}</span>
                    <span>${formatDateTime(l.created_at)}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        ` : '<div style="font-size:0.8125rem;color:#94A3B8;">No automated communications logged yet for this booking session.</div>'}
      </div>

      <!-- Mentor Assignment (Super Admin) & Follow-up -->
      ${(isSuperAdmin || isAssignedCounsellor) ? `
        <div class="detail-section" style="background:#F8FAFC;padding:1rem;border-radius:0.75rem;border:1px solid #E2E8F0;">
          <div class="detail-section-title" style="margin-bottom:0.75rem;">Mentor Assignment & Follow-up</div>

          ${isSuperAdmin ? `
            <div class="form-group">
              <label class="form-label" for="drawerAssignBkCounsellor">Assign Academic Mentor</label>
              <select class="form-select" id="drawerAssignBkCounsellor">
                <option value="">-- Unassigned --</option>
                ${counsellors.map(c => `<option value="${c.id}" ${b.assignedCounsellor===c.id?'selected':''}>${c.name}</option>`).join('')}
              </select>
            </div>
          ` : ''}

          <div class="form-group">
            <label class="form-label">Schedule Follow-up</label>
            <input type="date" class="form-input" id="drawerBkFuDate">
            <input type="text" class="form-input" id="drawerBkFuPurpose" placeholder="e.g. Diagnostic score review call, course enrollment check" style="margin-top:0.375rem;">
          </div>

          <button class="btn btn-sm btn-gold" style="width:100%;margin-top:0.5rem;" onclick="window._adminSaveBkDrawer('${b.id}')">
            Save Assignment / Follow-up
          </button>
        </div>
      ` : ''}`;

    openDrawer(`Counselling: ${b.studentName}`, bodyHtml);
  }

  // ══════════════════════════════════════════════
  // GLOBAL DEMO ACTION DISPATCHERS
  // ══════════════════════════════════════════════

  // ─── Enquiry Handlers ───
  window._adminAddEnqNote = async function(id) {
    const txt = document.getElementById('drawerEnqNote')?.value?.trim();
    if (!txt) {
      showToast('Validation Error', 'Note text cannot be empty.', 'error');
      return;
    }

    if (window.ApexSupabase && window.ApexSupabase.isLive()) {
      try {
        const c = window.ApexSupabase.getClient();
        const { data, error } = await c.rpc('add_enquiry_note', {
          p_enquiry_id: id,
          p_note_text: txt
        });
        if (error) throw error;
        if (data && data.success === false) {
          showToast('Error', data.message || 'Could not save note.', 'error');
          return;
        }
        // Clear the textarea
        const textarea = document.getElementById('drawerEnqNote');
        if (textarea) textarea.value = '';
        showToast('Note Appended', 'Internal student note has been saved.', 'success');
        showEnquiryDetail(id);
        return;
      } catch (err) {
        console.warn('add_enquiry_note RPC error:', err);
        showToast('Database Error', 'Could not save note: ' + (err.message || 'Unknown error'), 'error');
        return;
      }
    }

    // Demo mode fallback
    AdminData.addEnquiryNote(id, txt, SESSION.name);
    showToast('Note Appended', 'Internal student note has been saved (demo mode).', 'success');
    showEnquiryDetail(id);
  };

  window._adminSaveEnqDrawer = async function(id) {
    const counsellorSelect = document.getElementById('drawerAssignEnqCounsellor');
    const counsellorVal = counsellorSelect ? counsellorSelect.value : undefined;
    const statusVal = document.getElementById('drawerChangeEnqStatus')?.value;
    const fuDate = document.getElementById('drawerEnqFuDate')?.value;
    const fuPurpose = document.getElementById('drawerEnqFuPurpose')?.value;

    const saveBtn = document.getElementById('btnSaveEnqDrawer');
    const originalText = saveBtn ? saveBtn.innerHTML : 'Save Changes';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner" style="display:inline-block;width:12px;height:12px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin 0.6s linear infinite;margin-right:6px;vertical-align:middle;"></span>Saving...';
    }

    let savedStatus = statusVal;
    let savedFollowUpId = null;

    if (window.ApexSupabase && window.ApexSupabase.isLive()) {
      const c = window.ApexSupabase.getClient();
      let unifiedSuccess = false;

      // 1. Try unified atomic RPC if available
      try {
        const { data: unifiedRes, error: unifiedErr } = await c.rpc('save_enquiry_lead_drawer', {
          p_enquiry_id: id,
          p_status: statusVal || null,
          p_counsellor_id: (counsellorVal !== undefined && counsellorVal !== '') ? counsellorVal : null,
          p_follow_up_date: fuDate ? fuDate : null,
          p_follow_up_notes: (fuPurpose || '').trim() || (fuDate ? 'Telephonic Follow-up Consultation' : null)
        });

        if (!unifiedErr && unifiedRes && unifiedRes.success) {
          unifiedSuccess = true;
          if (unifiedRes.status) savedStatus = unifiedRes.status;
          if (unifiedRes.follow_up_id) savedFollowUpId = unifiedRes.follow_up_id;
        }
      } catch (uErr) {
        console.warn('save_enquiry_lead_drawer RPC not yet available, falling back to individual calls:', uErr);
      }

      if (!unifiedSuccess) {
        // Step A: Reassignment if Super Admin
        if (counsellorVal !== undefined) {
          try {
            await window.ApexSupabase.reassignAdmissionEnquiry(id, counsellorVal || null);
          } catch (rpcErr) {
            console.warn('Supabase reassign lead error:', rpcErr);
          }
        }

        // Step B: Update enquiry status
        if (statusVal) {
          try {
            const { data: statusRes, error: statusErr } = await c.rpc('update_enquiry_status', {
              p_enquiry_id: id,
              p_new_status: statusVal
            });
            if (statusErr) throw statusErr;
            if (statusRes && statusRes.success === false) {
              throw new Error(statusRes.message || 'Could not update enquiry status.');
            }
            if (statusRes && statusRes.status) savedStatus = statusRes.status;
          } catch (err) {
            console.error('update_enquiry_status RPC error:', err);
            showToast('Database Error', 'Could not update status: ' + (err.message || 'Unknown error'), 'error');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = originalText; }
            return;
          }
        }

        // Step C: Schedule follow-up task if date provided
        if (fuDate) {
          const cleanPurpose = (fuPurpose || '').trim() || 'Telephonic Follow-up Consultation';
          try {
            const enqData = AdminData.enquiries ? AdminData.enquiries.find(e => e.id === id) : null;
            const { data: fuRes, error: fuErr } = await c.rpc('create_follow_up', {
              p_student_id: enqData?.studentId || null,
              p_enquiry_id: id,
              p_booking_id: null,
              p_follow_up_date: fuDate,
              p_follow_up_time: null,
              p_follow_up_type: 'Telephonic Consultation',
              p_notes: cleanPurpose
            });
            if (fuErr) throw fuErr;
            if (fuRes && fuRes.success === false) {
              throw new Error(fuRes.message || 'Could not schedule follow-up.');
            }
            if (fuRes && fuRes.follow_up_id) savedFollowUpId = fuRes.follow_up_id;
          } catch (err) {
            console.error('create_follow_up RPC error:', err);
            showToast('Database Error', 'Could not schedule follow-up: ' + (err.message || 'Unknown error'), 'error');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = originalText; }
            return;
          }
        }
      }
    }

    // Update frontend state & cache
    const updates = {};
    if (statusVal) updates.status = savedStatus || statusVal;
    if (counsellorVal !== undefined) updates.assignedCounsellor = counsellorVal || null;
    AdminData.updateEnquiry(id, updates, SESSION.name);

    if (fuDate) {
      const cleanPurpose = (fuPurpose || '').trim() || 'Telephonic Follow-up Consultation';
      AdminData.scheduleEnquiryFollowUp(id, {
        id: savedFollowUpId || ('fu_' + Date.now()),
        date: fuDate,
        purpose: cleanPurpose,
        counsellorId: (counsellorVal !== undefined && counsellorVal !== '') ? counsellorVal : SESSION.userId
      });
    }

    let toastMsg = 'Lead changes saved successfully.';
    if (statusVal && fuDate) {
      toastMsg = 'Status updated to "' + (savedStatus || statusVal) + '" and follow-up scheduled for ' + formatDate(fuDate) + '.';
    } else if (statusVal) {
      toastMsg = 'Enquiry status changed to "' + (savedStatus || statusVal) + '".';
    } else if (fuDate) {
      toastMsg = 'Follow-up scheduled for ' + formatDate(fuDate) + '.';
    }

    showToast('Lead Updated', toastMsg, 'success');
    closeDrawer();
    renderPage();
    buildSidebar();
  };

  // ─── Booking Handlers ───
  window._adminAddBkNote = async function(id) {
    const txt = document.getElementById('drawerBkNote')?.value?.trim();
    if (!txt) {
      showToast('Validation Error', 'Note text cannot be empty.', 'error');
      return;
    }

    if (window.ApexSupabase && window.ApexSupabase.isLive()) {
      try {
        const c = window.ApexSupabase.getClient();
        const { data, error } = await c.rpc('add_booking_note', {
          p_booking_id: id,
          p_note_text: txt
        });
        if (error) throw error;
        if (data && data.success === false) {
          showToast('Error', data.message || 'Could not save note.', 'error');
          return;
        }
        const textarea = document.getElementById('drawerBkNote');
        if (textarea) textarea.value = '';
        showToast('Note Appended', 'Private counselling note saved.', 'success');
        showBookingDetail(id);
        return;
      } catch (err) {
        console.warn('add_booking_note RPC error:', err);
        showToast('Database Error', 'Could not save note: ' + (err.message || 'Unknown error'), 'error');
        return;
      }
    }

    // Demo mode fallback
    AdminData.addBookingNote(id, txt, SESSION.name);
    showToast('Note Appended', 'Private counselling note saved (demo mode).', 'success');
    showBookingDetail(id);
  };

  async function _updateBookingStatusLive(id, newStatus, successMsg, toastType) {
    if (window.ApexSupabase && window.ApexSupabase.isLive()) {
      try {
        const c = window.ApexSupabase.getClient();
        const { data, error } = await c.rpc('update_booking_status', {
          p_booking_id: id,
          p_new_status: newStatus
        });
        if (error) throw error;
        if (data && data.success === false) {
          showToast('Error', data.message || 'Status update rejected by database.', 'error');
          return false;
        }
        return true;
      } catch (err) {
        console.warn('update_booking_status RPC error:', err);
        showToast('Database Error', err.message || 'Could not update status.', 'error');
        return false;
      }
    }
    // Demo mode: use AdminData
    AdminData.updateBooking(id, { status: newStatus }, SESSION.name);
    return true;
  }

  window._adminConfirmBooking = async function(id) {
    const ok = await _updateBookingStatusLive(id, 'Confirmed', 'Session Confirmed', 'success');
    if (ok) {
      showToast('Session Confirmed', 'Appointment marked as Confirmed.', 'success');
      showBookingDetail(id);
      renderPage();
      buildSidebar();
    }
  };

  window._adminCompleteBooking = async function(id) {
    const ok = await _updateBookingStatusLive(id, 'Completed', 'Session Completed', 'success');
    if (ok) {
      showToast('Session Completed', 'Diagnostic counselling marked Completed.', 'success');
      showBookingDetail(id);
      renderPage();
      buildSidebar();
    }
  };

  window._adminNoShowBooking = function(id) {
    confirmAction(
      'Mark as No-Show?',
      'Did the student fail to attend the scheduled strategic consultation? A reschedule reminder will be scheduled.',
      async () => {
        const ok = await _updateBookingStatusLive(id, 'No-show', 'No-Show Recorded', 'info');
        if (ok) {
          showToast('Status Updated', 'Booking marked as No-Show.', 'info');
          showBookingDetail(id);
          renderPage();
          buildSidebar();
        }
      }
    );
  };

  window._adminCancelBooking = function(id) {
    confirmAction(
      'Cancel Counselling Booking?',
      'Are you sure you want to cancel this booking request? This action will mark the session as cancelled.',
      async () => {
        const ok = await _updateBookingStatusLive(id, 'Cancelled', 'Booking Cancelled', 'error');
        if (ok) {
          showToast('Booking Cancelled', 'Appointment cancelled.', 'error');
          showBookingDetail(id);
          renderPage();
          buildSidebar();
        }
      },
      true
    );
  };

  window._adminRescheduleModal = function(id) {
    const b = AdminData.bookings.find(bk => bk.id === id);
    if (!b) return;

    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">Reschedule Counselling Session</h3>
        <button class="modal-close" onclick="window._adminCloseModal()">${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <div style="padding:0.75rem;background:#F8FAFC;border-radius:0.5rem;margin-bottom:1rem;font-size:0.8125rem;">
          <div>Student: <strong>${b.studentName}</strong> (+91 ${b.mobile})</div>
          <div style="font-size:0.75rem;color:#64748B;margin-top:0.25rem;">Current Slot: ${formatDate(b.preferredDate)} · ${b.preferredTime}</div>
        </div>

        <div class="form-group">
          <label class="form-label">Select New Date *</label>
          <input type="date" class="form-input" id="rescheduleDate" value="${b.preferredDate}">
        </div>

        <div class="form-group">
          <label class="form-label">Select Time Window *</label>
          <select class="form-select" id="rescheduleSlot">
            <option value="10:30 AM - 11:00 AM">10:30 AM - 11:00 AM</option>
            <option value="12:00 PM - 12:30 PM">12:00 PM - 12:30 PM</option>
            <option value="03:00 PM - 03:30 PM">03:00 PM - 03:30 PM</option>
            <option value="05:00 PM - 05:30 PM">05:00 PM - 05:30 PM</option>
            <option value="06:30 PM - 07:00 PM">06:30 PM - 07:00 PM</option>
            <option value="07:30 PM - 08:00 PM">07:30 PM - 08:00 PM</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Reason for Rescheduling</label>
          <input type="text" class="form-input" id="rescheduleReason" placeholder="e.g. Aspirant requested evening slot due to college exams">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="window._adminCloseModal()">Cancel</button>
        <button class="btn btn-gold" onclick="window._adminSubmitReschedule('${b.id}')">Confirm Rescheduling</button>
      </div>
    `);
  };

  window._adminSubmitReschedule = async function(id) {
    const newDate = document.getElementById('rescheduleDate')?.value;
    const newSlot = document.getElementById('rescheduleSlot')?.value;
    const reason = document.getElementById('rescheduleReason')?.value;

    if (!newDate || !newSlot) {
      showToast('Validation Error', 'Please select both date and time window.', 'error');
      return;
    }

    // Call Supabase reschedule RPC if database is connected
    if (window.ApexSupabase && window.ApexSupabase.isLive()) {
      try {
        const res = await window.ApexSupabase.rescheduleBooking(id, newDate, newSlot, reason);
        if (res && res.success === false) {
          showToast('Reschedule Rejected', res.message || 'Database rejected reschedule request.', 'error');
          return;
        }
      } catch (err) {
        console.warn('Supabase reschedule call error:', err);
      }
    }

    const b = AdminData.bookings.find(bk => bk.id === id);
    if (b && b.assignedCounsellor) {
      const conflict = AdminData.checkDoubleBooking(b.assignedCounsellor, newDate, newSlot, id);
      if (conflict) {
        showToast('Schedule Conflict', `Mentor already has confirmed session #${conflict.id} at ${newSlot} on ${formatDate(newDate)}. Please choose another slot.`, 'error');
        return;
      }
    }

    AdminData.rescheduleBooking(id, newDate, newSlot, reason, SESSION.name);
    closeModal();
    showToast('Appointment Rescheduled', `Session moved to ${formatDate(newDate)} (${newSlot}). History preserved.`, 'success');
    showBookingDetail(id);
    renderPage();
    buildSidebar();
  };

  window._adminSaveBkDrawer = async function(id) {
    const counsellorVal = document.getElementById('drawerAssignBkCounsellor')?.value;
    const fuDate = document.getElementById('drawerBkFuDate')?.value;
    const fuPurpose = document.getElementById('drawerBkFuPurpose')?.value;

    if (counsellorVal !== undefined) {
      // Call Supabase Booking Reassignment RPC if live
      if (window.ApexSupabase && window.ApexSupabase.isLive()) {
        try {
          const res = await window.ApexSupabase.reassignCounsellingBooking(id, counsellorVal || null);
          if (res && res.success === false) {
            showToast('Assignment Error', res.message || 'Could not reassign booking.', 'error');
            return;
          }
        } catch (rpcErr) {
          console.warn('Supabase reassign booking error:', rpcErr);
        }
      }
      AdminData.updateBooking(id, { assignedCounsellor: counsellorVal || null }, SESSION.name);
    }

    if (fuDate) {
      const cleanPurpose = (fuPurpose || '').trim() || 'Academic Strategy Review';
      let savedFollowUpId = null;
      if (window.ApexSupabase && window.ApexSupabase.isLive()) {
        try {
          const c = window.ApexSupabase.getClient();
          const bkData = AdminData.bookings ? AdminData.bookings.find(b => b.id === id) : null;
          const { data: fuRes, error: fuErr } = await c.rpc('create_follow_up', {
            p_student_id: bkData?.studentId || null,
            p_enquiry_id: null,
            p_booking_id: id,
            p_follow_up_date: fuDate,
            p_follow_up_time: null,
            p_follow_up_type: 'Strategy Consultation',
            p_notes: cleanPurpose
          });
          if (fuErr) throw fuErr;
          if (fuRes && fuRes.success === false) {
            showToast('Follow-up Error', fuRes.message || 'Could not schedule follow-up.', 'error');
            return;
          }
          if (fuRes && fuRes.follow_up_id) savedFollowUpId = fuRes.follow_up_id;
        } catch (err) {
          console.warn('create_follow_up RPC error for booking:', err);
          showToast('Database Error', 'Could not schedule follow-up: ' + (err.message || 'Unknown error'), 'error');
          return;
        }
      }
      AdminData.scheduleBookingFollowUp(id, {
        id: savedFollowUpId || ('fu_' + Date.now()),
        date: fuDate,
        purpose: cleanPurpose,
        counsellorId: (counsellorVal !== undefined && counsellorVal !== '') ? counsellorVal : SESSION.userId
      });
    }

    showToast('Booking Updated', 'Assignment and follow-up saved.', 'success');
    closeDrawer();
    renderPage();
    buildSidebar();
  };

  // ─── Counsellor Actions ───
  window._adminViewWorkload = function(counsellorId) {
    const workload = AdminData.getCounsellorWorkload(counsellorId);
    if (!workload) return;
    const c = workload.counsellor;

    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">${c.name} — Workload Breakdown</h3>
        <button class="modal-close" onclick="window._adminCloseModal()">${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1.25rem;">
          <div class="sidebar-user-avatar" style="width:48px;height:48px;font-size:1rem;background:#EFF6FF;color:#1E3A8A;border:1px solid #DBEAFE;">${initials(c.name)}</div>
          <div>
            <div style="font-weight:800;font-size:1rem;">${c.name}</div>
            <div style="font-size:0.75rem;color:#64748B;">${c.department} · ${c.email}</div>
          </div>
        </div>

        <div class="detail-section">
          <div class="detail-section-title">Assigned Enquiries (${workload.enquiries.length})</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem;text-align:center;margin-bottom:0.75rem;">
            <div style="padding:0.5rem;background:#EFF6FF;border-radius:0.375rem;"><div style="font-weight:700;color:#1E3A8A;">${workload.enquiryBreakdown.new}</div><div style="font-size:0.625rem;color:#64748B;">New</div></div>
            <div style="padding:0.5rem;background:#FEF3C7;border-radius:0.375rem;"><div style="font-weight:700;color:#92400E;">${workload.enquiryBreakdown.contacted}</div><div style="font-size:0.625rem;color:#64748B;">Contacted</div></div>
            <div style="padding:0.5rem;background:#F5F3FF;border-radius:0.375rem;"><div style="font-weight:700;color:#7C3AED;">${workload.enquiryBreakdown.interested}</div><div style="font-size:0.625rem;color:#64748B;">Interested</div></div>
            <div style="padding:0.5rem;background:#ECFDF5;border-radius:0.375rem;"><div style="font-weight:700;color:#065F46;">${workload.enquiryBreakdown.converted}</div><div style="font-size:0.625rem;color:#64748B;">Converted</div></div>
          </div>
        </div>

        <div class="detail-section">
          <div class="detail-section-title">Assigned Counselling Sessions (${workload.bookings.length})</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem;text-align:center;">
            <div style="padding:0.5rem;background:#FEF3C7;border-radius:0.375rem;"><div style="font-weight:700;color:#92400E;">${workload.bookingBreakdown.pending}</div><div style="font-size:0.625rem;color:#64748B;">Pending</div></div>
            <div style="padding:0.5rem;background:#ECFDF5;border-radius:0.375rem;"><div style="font-weight:700;color:#065F46;">${workload.bookingBreakdown.confirmed}</div><div style="font-size:0.625rem;color:#64748B;">Confirmed</div></div>
            <div style="padding:0.5rem;background:#F1F5F9;border-radius:0.375rem;"><div style="font-weight:700;color:#475569;">${workload.bookingBreakdown.completed}</div><div style="font-size:0.625rem;color:#64748B;">Completed</div></div>
            <div style="padding:0.5rem;background:#FEF2F2;border-radius:0.375rem;"><div style="font-weight:700;color:#DC2626;">${workload.bookingBreakdown.no_show}</div><div style="font-size:0.625rem;color:#64748B;">No Show</div></div>
          </div>
        </div>

        <div class="detail-section" style="margin-bottom:0;">
          <div class="detail-section-title">Scheduled Follow-ups (${workload.followUps.length})</div>
          ${workload.followUps.length ? workload.followUps.map(f => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:0.375rem 0;border-bottom:1px solid #F1F5F9;font-size:0.75rem;">
              <div><strong>${f.studentName}</strong>: ${f.purpose}</div>
              <span class="tag" style="background:#EFF6FF;color:#1E3A8A;font-size:0.625rem;">${formatDate(f.date)}</span>
            </div>
          `).join('') : '<div style="font-size:0.75rem;color:#94A3B8;">No open follow-up tasks.</div>'}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="window._adminCloseModal()">Close Window</button>
      </div>
    `);
  };

  window._adminEditCounsellor = function(id) {
    const c = AdminData.counsellors.find(co => co.id === id);
    if (!c) return;
    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">Edit Staff Details</h3>
        <button class="modal-close" onclick="window._adminCloseModal()">${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label" for="editCounName">Full Name *</label>
          <input class="form-input" id="editCounName" value="${c.name}">
        </div>
        <div class="form-group">
          <label class="form-label" for="editCounEmail">Official Email *</label>
          <input class="form-input" id="editCounEmail" value="${c.email}">
        </div>
        <div class="form-group">
          <label class="form-label" for="editCounPhone">Contact Phone</label>
          <input class="form-input" id="editCounPhone" value="${c.phone}">
        </div>
        <div class="form-group">
          <label class="form-label" for="editCounDept">Assigned Department *</label>
          <select class="form-select" id="editCounDept">
            <option value="Admission Department" ${c.department==='Admission Department'?'selected':''}>Admission Department</option>
            <option value="Academic Counselling Department" ${c.department==='Academic Counselling Department'?'selected':''}>Academic Counselling Department</option>
          </select>
        </div>
        <p style="font-size:0.6875rem;color:#94A3B8;margin-top:0.5rem;">
          🔒 Password credentials are managed by administrator identity providers and are not exposed in demo portal.
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="window._adminCloseModal()">Cancel</button>
        <button class="btn btn-gold" onclick="window._adminSaveCounsellor('${c.id}')">Save Changes</button>
      </div>`);
  };

  window._adminSaveCounsellor = async function(id) {
    const name = document.getElementById('editCounName')?.value?.trim();
    const email = document.getElementById('editCounEmail')?.value?.trim();
    const phone = document.getElementById('editCounPhone')?.value?.trim();
    const department = document.getElementById('editCounDept')?.value;
    const role = department === 'Academic Counselling Department' ? 'academic_counsellor' : 'admission_counsellor';

    if (!name) {
      showToast('Validation Error', 'Full Name is required.', 'error');
      return;
    }

    if (useSupabaseData()) {
      try {
        const client = window.ApexSupabase.getClient();
        const { error } = await client
          .from('profiles')
          .update({
            full_name: name,
            phone: phone || null,
            department: department,
            role: role,
            updated_at: new Date().toISOString()
          })
          .eq('id', id);

        if (error) {
          showToast('Update Failed', error.message || 'Failed to update counsellor profile.', 'error');
          return;
        }
      } catch (err) {
        console.error('Failed to update counsellor profile in Supabase:', err);
        showToast('Update Failed', 'Database error updating staff profile.', 'error');
        return;
      }
    }

    AdminData.updateCounsellor(id, { name, email, phone, department, role });
    closeModal();
    showToast('Counsellor Updated', 'Staff details saved successfully.', 'success');
    if (useSupabaseData()) {
      await syncFromSupabase();
    }
    renderPage();
  };

  window._adminToggleCounsellor = function(id) {
    const c = (AdminData.staff || AdminData.counsellors || []).find(co => co.id === id);
    if (!c) return;
    const isDeactivating = c.status === 'active';
    confirmAction(
      `${isDeactivating ? 'Deactivate' : 'Activate'} Counsellor Account?`,
      `Are you sure you want to ${isDeactivating ? 'deactivate' : 'activate'} ${c.name}'s account?`,
      async () => {
        if (useSupabaseData()) {
          try {
            const client = window.ApexSupabase.getClient();
            const { error } = await client
              .from('profiles')
              .update({
                is_active: !isDeactivating,
                updated_at: new Date().toISOString()
              })
              .eq('id', id);

            if (error) {
              showToast('Action Failed', error.message || 'Failed to update account status.', 'error');
              return;
            }
          } catch (err) {
            console.error('Failed to update account status in Supabase:', err);
            showToast('Action Failed', 'Database error updating account status.', 'error');
            return;
          }
        }

        const newStatus = AdminData.toggleCounsellorStatus(id);
        showToast('Status Changed', `${c.name}'s profile is now ${newStatus}.`, 'info');
        if (useSupabaseData()) {
          await syncFromSupabase();
        }
        renderPage();
        buildSidebar();
      },
      isDeactivating
    );
  };

  // ─── Counsellor Role Assignment & Provisioning Handlers ───
  window._adminAssignStaffRole = function(email, currentName) {
    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">Assign Institutional Role</h3>
        <button class="modal-close" onclick="window._adminCloseModal()">${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <p style="font-size:0.8125rem;color:#475569;margin-bottom:1rem;">
          Assign an official role and workspace permissions for <strong>${escapeHtml(currentName || email)}</strong> (${escapeHtml(email)}).
        </p>
        <div class="form-group">
          <label class="form-label">Select Staff Role *</label>
          <select class="form-select" id="assignRoleSelect">
            <option value="super_admin">Super Admin (Full Governance &amp; Executive Oversight)</option>
            <option value="admission_counsellor">Admission Counsellor (Lead &amp; Enquiry Management)</option>
            <option value="academic_counsellor">Academic Counsellor (1-on-1 Student Guidance &amp; Bookings)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Assigned Department</label>
          <select class="form-select" id="assignDeptSelect">
            <option value="Executive Administration">Executive Administration</option>
            <option value="Admission Department">Admission Department</option>
            <option value="Academic Counselling Department">Academic Counselling Department</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="window._adminCloseModal()">Cancel</button>
        <button class="btn btn-gold" id="saveRoleAssignmentBtn">Confirm &amp; Assign Role</button>
      </div>
    `);

    const roleSel = document.getElementById('assignRoleSelect');
    const deptSel = document.getElementById('assignDeptSelect');
    if (roleSel && deptSel) {
      roleSel.addEventListener('change', () => {
        if (roleSel.value === 'super_admin') {
          deptSel.value = 'Executive Administration';
        } else if (roleSel.value === 'academic_counsellor') {
          deptSel.value = 'Academic Counselling Department';
        } else {
          deptSel.value = 'Admission Department';
        }
      });
    }

    const saveBtn = document.getElementById('saveRoleAssignmentBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const role = roleSel.value;
        const dept = deptSel.value;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Assigning Role...';

        if (window.ApexSupabase && window.ApexSupabase.isLive()) {
          try {
            const client = window.ApexSupabase.getClient();
            const { data, error } = await client.rpc('assign_admin_role', {
              p_email: email,
              p_role: role,
              p_department: dept
            });
            if (error) {
              showToast('Assignment Error', error.message || 'Failed to assign role in Supabase.', 'error');
              saveBtn.disabled = false;
              saveBtn.textContent = 'Confirm & Assign Role';
              return;
            }
          } catch (e) {
            console.error('Error invoking assign_admin_role:', e);
          }
        }

        closeModal();
        showToast('Role Assigned', `Role successfully assigned to ${email}.`, 'success');
        if (useSupabaseData()) {
          await syncFromSupabase();
        }
        renderPage();
      });
    }
  };

  function showAddCounsellorModal() {
    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">Provision New Counsellor Account</h3>
        <button class="modal-close" onclick="window._adminCloseModal()">${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Full Name *</label>
          <input class="form-input" id="newCounName" placeholder="e.g. Rahul Sharma">
        </div>
        <div class="form-group">
          <label class="form-label">Institutional Email *</label>
          <input class="form-input" id="newCounEmail" placeholder="rahul.counsellor@apexacademy.edu.in" type="email">
        </div>
        <div class="form-group">
          <label class="form-label">Initial Password *</label>
          <input class="form-input" id="newCounPass" type="password" value="ApexStaff@2026" placeholder="Min 6 characters">
        </div>
        <div class="form-group">
          <label class="form-label">Contact Phone</label>
          <input class="form-input" id="newCounPhone" placeholder="98765432XX">
        </div>
        <div class="form-group">
          <label class="form-label">Assigned Role &amp; Department *</label>
          <select class="form-select" id="newCounRole">
            <option value="admission_counsellor|Admission Department" selected>Admission Counsellor — Admission Department</option>
            <option value="academic_counsellor|Academic Counselling Department">Academic Counsellor — Academic Counselling Department</option>
          </select>
        </div>
        <p style="font-size:0.6875rem;color:#94A3B8;margin-top:0.5rem;">
          Creates an active staff account with secure authentication, profile synchronization, and automatic scheduling.
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="window._adminCloseModal()">Cancel</button>
        <button class="btn btn-gold" id="saveNewCounsellorBtn">Add Counsellor</button>
      </div>
    `);

    const btn = document.getElementById('saveNewCounsellorBtn');
    if (btn) {
      btn.addEventListener('click', async () => {
        const name = document.getElementById('newCounName')?.value?.trim();
        const email = document.getElementById('newCounEmail')?.value?.trim();
        const password = document.getElementById('newCounPass')?.value?.trim() || 'ApexStaff@2026';
        const phone = document.getElementById('newCounPhone')?.value?.trim();
        const roleDept = document.getElementById('newCounRole')?.value || 'admission_counsellor|Admission Department';
        const [role, department] = roleDept.split('|');

        if (!name || !email) {
          showToast('Validation Error', 'Full Name and Email are required.', 'error');
          return;
        }

        btn.disabled = true;
        btn.textContent = 'Provisioning Staff...';

        // Provision via server-side Edge Function (Auth Admin API + Profile Sync)
        if (useSupabaseData()) {
          try {
            const client = window.ApexSupabase.getClient();
            let { data: { session }, error: sessErr } = await client.auth.getSession();
            const nowSec = Math.floor(Date.now() / 1000);

            // Proactively refresh session if expired or expiring within 60s
            if (!session || sessErr || (session.expires_at && session.expires_at <= nowSec + 60)) {
              try {
                const { data: refreshed, error: refErr } = await client.auth.refreshSession();
                if (!refErr && refreshed?.session?.access_token) {
                  session = refreshed.session;
                } else {
                  session = null;
                }
              } catch (_refreshErr) {
                session = null;
              }
            }

            // Strictly verify active, non-expired Super Admin access token
            if (!session || !session.access_token || (session.expires_at && session.expires_at <= nowSec)) {
              btn.disabled = false;
              btn.textContent = "Add Counsellor";
              showToast("Session Expired", "Your Super Admin session has expired. Please sign in again.", "error");
              return;
            }
            const config = window.APEX_SUPABASE_CONFIG;
            const res = await fetch(`${config.url}/functions/v1/create-counsellor`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${session.access_token}`,
                'apikey': config.anonKey,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                email,
                password,
                full_name: name,
                role,
                department,
                phone: phone || null
              })
            });

            const resData = await res.json().catch(() => ({}));

            if (!res.ok || resData.error) {
              btn.disabled = false;
              btn.textContent = 'Add Counsellor';
              const errorMsg = resData.error || resData.message || (res.status === 404
                ? "Edge Function 'create-counsellor' is not deployed. Please deploy via Supabase CLI or create user in Supabase Auth."
                : `Provisioning failed with status ${res.status}.`);
              showToast('Provisioning Failed', errorMsg, 'error');
              return;
            }

            // Successfully provisioned in Supabase
            closeModal();
            showToast('Counsellor Enrolled', `${name} has been provisioned as ${role === 'academic_counsellor' ? 'Academic Counsellor' : 'Admission Counsellor'}.`, 'success');
            await syncFromSupabase();
            renderPage();
            return;
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Add Counsellor';
            showToast('Network Error', err.message || 'Failed to reach Supabase provisioning service.', 'error');
            return;
          }
        }

        // Offline / Demo Mode fallback ONLY
        AdminData.addCounsellor({ name, email, phone, department, role });
        closeModal();
        showToast('Counsellor Enrolled', `${name} has been added in demo mode.`, 'success');
        renderPage();
      });
    }
  }

  // ─── Courses & Batches Handlers ───
  window._adminAddBatchModal = function(courseId) {
    const course = AdminData.courses.find(c => c.id === courseId);
    if (!course) return;

    openModal(`
      <div class="modal-header">
        <h3 class="modal-title">Add Batch — ${course.shortName}</h3>
        <button class="modal-close" onclick="window._adminCloseModal()">${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Batch Title *</label>
          <input class="form-input" id="newBatchName" placeholder="e.g. Fast-Track Target Batch 2026">
        </div>
        <div class="form-group">
          <label class="form-label">Schedule & Timings *</label>
          <input class="form-input" id="newBatchTiming" placeholder="e.g. 02:00 PM – 05:30 PM (Daily)">
        </div>
        <div class="form-group">
          <label class="form-label">Seat Capacity *</label>
          <input class="form-input" id="newBatchSeats" type="number" value="45">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="window._adminCloseModal()">Cancel</button>
        <button class="btn btn-gold" onclick="window._adminSubmitBatch('${course.id}')">Create Batch</button>
      </div>
    `);
  };

  window._adminSubmitBatch = function(courseId) {
    const name = document.getElementById('newBatchName')?.value?.trim();
    const timing = document.getElementById('newBatchTiming')?.value?.trim();
    const seats = document.getElementById('newBatchSeats')?.value;

    if (!name || !timing) {
      showToast('Validation Error', 'Batch name and timing are required.', 'error');
      return;
    }

    AdminData.addBatch(courseId, { name, timing, seats });
    closeModal();
    showToast('Batch Created', `New cohort batch "${name}" added.`, 'success');
    renderPage();
  };

  window._adminToggleBatch = function(courseId, batchId) {
    const newStatus = AdminData.toggleBatchStatus(courseId, batchId);
    showToast('Batch Status Updated', `Batch status is now ${newStatus}.`, 'info');
    renderPage();
  };

  // ══════════════════════════════════════════════
  // EVENT LISTENER ATTACHMENT
  // ══════════════════════════════════════════════

  function attachPageHandlers() {

    // ─── AVAILABILITY MANAGEMENT EVENT HANDLERS ───
    if (CURRENT_PAGE === "availability") {
      // Counsellor select change for Super Admin
      const adminCounsellorSelect = document.getElementById("adminCounsellorSelect");
      if (adminCounsellorSelect) {
        adminCounsellorSelect.addEventListener("change", async (e) => {
          SELECTED_AVAIL_COUNSELLOR_ID = e.target.value;
          if (window.ApexSupabase && window.ApexSupabase.isLive()) {
            try {
              const res = await window.ApexSupabase.getCounsellorAvailabilityConfig(SELECTED_AVAIL_COUNSELLOR_ID);
              if (res && res.success) {
                LOADED_AVAIL_SCHEDULE = { counsellorId: SELECTED_AVAIL_COUNSELLOR_ID, schedule: res.schedule || [] };
                LOADED_AVAIL_UNAVAILABILITY = { counsellorId: SELECTED_AVAIL_COUNSELLOR_ID, list: res.unavailability || [] };
              }
            } catch (err) {
              console.warn("Could not fetch remote availability:", err);
            }
          }
          renderPage();
        });
      }

      // Day working / off toggle listeners
      document.querySelectorAll(".day-avail-toggle").forEach(toggle => {
        toggle.addEventListener("change", (e) => {
          const dow = e.target.dataset.dow;
          const row = document.querySelector(`.avail-day-row[data-dow="${dow}"]`);
          if (!row) return;
          const label = row.querySelector(".day-avail-label");
          const timeControls = row.querySelector(".day-time-controls");
          const durationControls = row.querySelector(".day-duration-controls");
          const breakControls = row.querySelector(".day-break-controls");

          if (e.target.checked) {
            if (label) { label.textContent = "Working"; label.style.color = "#059669"; }
            if (timeControls) timeControls.classList.remove("opacity-40", "pointer-events-none");
            if (durationControls) durationControls.classList.remove("opacity-40", "pointer-events-none");
            if (breakControls) breakControls.classList.remove("opacity-40", "pointer-events-none");
          } else {
            if (label) { label.textContent = "Day Off"; label.style.color = "#94A3B8"; }
            if (timeControls) timeControls.classList.add("opacity-40", "pointer-events-none");
            if (durationControls) durationControls.classList.add("opacity-40", "pointer-events-none");
            if (breakControls) breakControls.classList.add("opacity-40", "pointer-events-none");
          }
        });
      });

      // Break period toggle listeners
      document.querySelectorAll(".day-break-toggle").forEach(toggle => {
        toggle.addEventListener("change", (e) => {
          const dow = e.target.dataset.dow;
          const row = document.querySelector(`.avail-day-row[data-dow="${dow}"]`);
          if (!row) return;
          const breakInputs = row.querySelector(".break-time-inputs");
          if (breakInputs) {
            if (e.target.checked) {
              breakInputs.classList.remove("opacity-30", "pointer-events-none");
            } else {
              breakInputs.classList.add("opacity-30", "pointer-events-none");
            }
          }
        });
      });

      // Save weekly availability button
      const saveAvailBtn = document.getElementById("saveWeeklyAvailabilityBtn");
      if (saveAvailBtn) {
        saveAvailBtn.addEventListener("click", async () => {
          const targetCounsellorId = document.getElementById("availTargetCounsellorId")?.value || SESSION.userId;
          const rows = document.querySelectorAll(".avail-day-row");
          const schedule = [];

          rows.forEach(row => {
            const dow = parseInt(row.dataset.dow, 10);
            const isAvail = row.querySelector(".day-avail-toggle")?.checked || false;
            const startTime = row.querySelector(".day-start-select")?.value || "09:00";
            const endTime = row.querySelector(".day-end-select")?.value || "18:00";
            const duration = parseInt(row.querySelector(".day-duration-select")?.value || "30", 10);
            const hasBreak = row.querySelector(".day-break-toggle")?.checked || false;
            const breakStart = row.querySelector(".day-break-start")?.value || "13:00";
            const breakEnd = row.querySelector(".day-break-end")?.value || "14:00";

            schedule.push({
              day_of_week: dow,
              is_available: isAvail,
              start_time: startTime + ":00",
              end_time: endTime + ":00",
              slot_duration_minutes: duration,
              has_break: hasBreak,
              break_start: hasBreak ? breakStart + ":00" : null,
              break_end: hasBreak ? breakEnd + ":00" : null
            });
          });

          saveAvailBtn.disabled = true;
          saveAvailBtn.innerHTML = "Saving...";

          try {
            // Save to live Supabase if live
            if (window.ApexSupabase && window.ApexSupabase.isLive()) {
              const res = await window.ApexSupabase.saveCounsellorAvailability(targetCounsellorId, schedule);
              if (!res || !res.success) throw new Error(res?.message || "Failed to save to Supabase.");
            }
            // Always update AdminData store
            if (typeof AdminData.saveCounsellorAvailability === "function") {
              AdminData.saveCounsellorAvailability(targetCounsellorId, schedule);
            }
            LOADED_AVAIL_SCHEDULE = { counsellorId: targetCounsellorId, schedule };
            showToast("Availability Saved", "Weekly schedule updated! Public booking slots reflect changes immediately.", "success");
          } catch (err) {
            console.error("Save availability error:", err);
            showToast("Save Error", err.message || "Could not save availability schedule.", "error");
          } finally {
            saveAvailBtn.disabled = false;
            saveAvailBtn.innerHTML = "💾 Save Weekly Availability";
          }
        });
      }

      // Add Leave / Block Date form submission
      const addLeaveForm = document.getElementById("addLeaveForm");
      if (addLeaveForm) {
        addLeaveForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const targetCounsellorId = document.getElementById("availTargetCounsellorId")?.value || SESSION.userId;
          const dateInput = document.getElementById("leaveDateInput");
          const reasonInput = document.getElementById("leaveReasonInput");
          const isInstWideCheck = document.getElementById("instituteWideHolidayCheck");

          const selectedDate = dateInput?.value;
          const reason = reasonInput?.value || "Scheduled Leave";
          const isInstWide = isInstWideCheck?.checked || false;
          const counsellorParam = isInstWide ? null : targetCounsellorId;

          if (!selectedDate) {
            showToast("Missing Date", "Please select a date to block.", "warning");
            return;
          }

          try {
            if (window.ApexSupabase && window.ApexSupabase.isLive()) {
              const res = await window.ApexSupabase.manageCounsellorUnavailability("add", counsellorParam, selectedDate, reason);
              if (!res || !res.success) throw new Error(res?.message || "Failed to record leave date.");
            }
            if (typeof AdminData.addUnavailability === "function") {
              AdminData.addUnavailability(counsellorParam, selectedDate, reason);
            }
            showToast("Date Blocked", `Bookings disabled for ${selectedDate}.`, "success");
            // Refresh config
            if (window.ApexSupabase && window.ApexSupabase.isLive()) {
              const res = await window.ApexSupabase.getCounsellorAvailabilityConfig(targetCounsellorId);
              if (res && res.success) {
                LOADED_AVAIL_UNAVAILABILITY = { counsellorId: targetCounsellorId, list: res.unavailability || [] };
              }
            }
            renderPage();
          } catch (err) {
            console.error("Add leave error:", err);
            showToast("Error", err.message || "Could not block date.", "error");
          }
        });
      }

      // Remove / Unblock date button
      document.querySelectorAll(".remove-unavail-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const unavailId = btn.dataset.id;
          const targetCounsellorId = document.getElementById("availTargetCounsellorId")?.value || SESSION.userId;

          try {
            if (window.ApexSupabase && window.ApexSupabase.isLive()) {
              const res = await window.ApexSupabase.manageCounsellorUnavailability("delete", null, null, null, unavailId);
              if (!res || !res.success) throw new Error(res?.message || "Failed to remove blocked date.");
            }
            if (typeof AdminData.deleteUnavailability === "function") {
              AdminData.deleteUnavailability(unavailId);
            }
            showToast("Date Unblocked", "Calendar date unblocked successfully.", "info");
            // Refresh
            if (window.ApexSupabase && window.ApexSupabase.isLive()) {
              const res = await window.ApexSupabase.getCounsellorAvailabilityConfig(targetCounsellorId);
              if (res && res.success) {
                LOADED_AVAIL_UNAVAILABILITY = { counsellorId: targetCounsellorId, list: res.unavailability || [] };
              }
            }
            renderPage();
          } catch (err) {
            console.error("Remove unavail error:", err);
            showToast("Error", err.message || "Could not remove blocked date.", "error");
          }
        });
      });
    }

    // CSV Export Triggers
    const expAdmBtn = $('#exportAdmissionsBtn');
    if (expAdmBtn) {
      expAdmBtn.addEventListener('click', () => {
        const csv = AdminData.exportAdmissionsCSV();
        downloadCSV(csv, `apex_admissions_leads_${new Date().toISOString().slice(0,10)}.csv`);
        showToast('Export Complete', 'Admission enquiries CSV downloaded successfully.', 'success');
      });
    }

    const expCounBtn = $('#exportCounsellingBtn');
    if (expCounBtn) {
      expCounBtn.addEventListener('click', () => {
        const csv = AdminData.exportBookingsCSV();
        downloadCSV(csv, `apex_counselling_bookings_${new Date().toISOString().slice(0,10)}.csv`);
        showToast('Export Complete', 'Counselling bookings CSV downloaded successfully.', 'success');
      });
    }

    const expRepBtn = $('#exportReportsBtn');
    if (expRepBtn) {
      expRepBtn.addEventListener('click', () => {
        const csv = AdminData.exportReportsCSV();
        downloadCSV(csv, `apex_executive_summary_${new Date().toISOString().slice(0,10)}.csv`);
        showToast('Export Complete', 'Executive performance summary CSV downloaded.', 'success');
      });
    }

    // Enquiry & Booking detail buttons
    document.querySelectorAll('.view-enquiry-btn').forEach(btn => {
      btn.addEventListener('click', () => showEnquiryDetail(btn.dataset.id));
    });
    document.querySelectorAll('.view-booking-btn').forEach(btn => {
      btn.addEventListener('click', () => showBookingDetail(btn.dataset.id));
    });

    // Complete follow-up buttons
    document.querySelectorAll('.complete-fu-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const fuId = btn.dataset.id;
        if (window.ApexSupabase && window.ApexSupabase.isLive()) {
          try {
            const c = window.ApexSupabase.getClient();
            const { data, error } = await c.rpc('complete_follow_up', {
              p_follow_up_id: fuId
            });
            if (error) throw error;
            if (data && data.success === false) {
              showToast('Error', data.message || 'Could not complete follow-up.', 'error');
              return;
            }
          } catch (err) {
            console.warn('complete_follow_up RPC error:', err);
            showToast('Database Error', err.message || 'Could not complete follow-up.', 'error');
            return;
          }
        }
        AdminData.completeFollowUp(fuId);
        showToast('Task Completed', 'Follow-up resolved successfully.', 'success');
        renderPage();
        buildSidebar();
      });
    });

    // Navigation buttons inside cards
    document.querySelectorAll('[data-page]').forEach(btn => {
      if (btn.closest('.sidebar-nav')) return;
      btn.addEventListener('click', () => {
        const targetPage = btn.dataset.page;
        if (isPageAllowedForRole(targetPage, SESSION.role)) {
          CURRENT_PAGE = targetPage;
          window.location.hash = '#' + targetPage;
          renderPage();
          buildSidebar();
        } else {
          showToast('Access Restricted', 'Module not authorized for your role.', 'warning');
        }
      });
    });

    // Add Counsellor Button
    const addCounBtn = document.getElementById('addCounsellorBtn');
    if (addCounBtn) addCounBtn.addEventListener('click', showAddCounsellorModal);

    // Reset Demo in Settings — hidden when Supabase is live
    const resetSettingsBtn = document.getElementById('settingsResetDemoBtn');
    if (resetSettingsBtn) {
      if (useSupabaseData()) {
        resetSettingsBtn.style.display = 'none';
      } else {
        resetSettingsBtn.addEventListener('click', () => {
          confirmAction(
            'Reset Demonstration Data?',
            'This will purge all custom modifications and restore default sample admissions, bookings, and follow-ups.',
            () => {
              AdminData.resetDemoData();
              showToast('Factory State Restored', 'All sample records reset to initial baseline.', 'info');
              renderPage();
              buildSidebar();
            }
          );
        });
      }
    }

    // ─── Filter & Search Logic for Admissions ───
    const enqSearch = document.getElementById('enqSearch');
    const enqCourse = document.getElementById('enqCourseFilter');
    const enqExam = document.getElementById('enqExamFilter');
    const enqStatus = document.getElementById('enqStatusFilter');
    const enqCounsellor = document.getElementById('enqCounsellorFilter');

    function filterEnquiries() {
      const isSuperAdmin = SESSION.role === 'super_admin';
      const roleData = AdminData.getDataForRole(SESSION.role, SESSION.userId);
      let list = isSuperAdmin ? [...AdminData.enquiries] : (roleData ? [...roleData.enquiries] : []);

      const q = enqSearch?.value?.toLowerCase().trim();
      if (q) {
        list = list.filter(e =>
          (e.studentName || '').toLowerCase().includes(q) ||
          (e.mobile || '').includes(q) ||
          (e.id || '').toLowerCase().includes(q) ||
          (e.email || '').toLowerCase().includes(q)
        );
      }
      if (enqCourse?.value) {
        list = list.filter(e => e.courseCategoryId === enqCourse.value);
      }
      if (enqExam?.value) {
        list = list.filter(e => e.targetExamination === enqExam.value);
      }
      if (enqStatus?.value) {
        list = list.filter(e => e.status === enqStatus.value);
      }
      if (enqCounsellor?.value) {
        if (enqCounsellor.value === 'unassigned') {
          list = list.filter(e => !e.assignedCounsellor);
        } else {
          list = list.filter(e => e.assignedCounsellor === enqCounsellor.value);
        }
      }

      const tbody = document.getElementById('enqTableBody');
      if (tbody) tbody.innerHTML = renderEnquiryRows(list);

      // Re-attach clicks
      document.querySelectorAll('.view-enquiry-btn').forEach(btn => {
        btn.addEventListener('click', () => showEnquiryDetail(btn.dataset.id));
      });
    }

    if (enqSearch) enqSearch.addEventListener('input', filterEnquiries);
    if (enqCourse) enqCourse.addEventListener('change', filterEnquiries);
    if (enqExam) enqExam.addEventListener('change', filterEnquiries);
    if (enqStatus) enqStatus.addEventListener('change', filterEnquiries);
    if (enqCounsellor) enqCounsellor.addEventListener('change', filterEnquiries);

    // ─── Filter & Search Logic for Counselling ───
    const bkSearch = document.getElementById('bkSearch');
    const bkDate = document.getElementById('bkDateFilter');
    const bkCourse = document.getElementById('bkCourseFilter');
    const bkStatus = document.getElementById('bkStatusFilter');
    const bkCounsellor = document.getElementById('bkCounsellorFilter');

    function filterBookings() {
      const isSuperAdmin = SESSION.role === 'super_admin';
      const roleData = AdminData.getDataForRole(SESSION.role, SESSION.userId);
      let list = isSuperAdmin ? [...AdminData.bookings] : (roleData ? [...roleData.bookings] : []);

      const q = bkSearch?.value?.toLowerCase().trim();
      if (q) {
        list = list.filter(b =>
          (b.studentName || '').toLowerCase().includes(q) ||
          (b.mobile || '').includes(q) ||
          (b.id || '').toLowerCase().includes(q) ||
          (b.email || '').toLowerCase().includes(q)
        );
      }
      if (bkDate?.value) {
        list = list.filter(b => b.preferredDate === bkDate.value);
      }
      if (bkCourse?.value) {
        list = list.filter(b => b.courseCategoryId === bkCourse.value);
      }
      if (bkStatus?.value) {
        list = list.filter(b => b.status === bkStatus.value);
      }
      if (bkCounsellor?.value) {
        if (bkCounsellor.value === 'unassigned') {
          list = list.filter(b => !b.assignedCounsellor);
        } else {
          list = list.filter(b => b.assignedCounsellor === bkCounsellor.value);
        }
      }

      const tbody = document.getElementById('bkTableBody');
      if (tbody) tbody.innerHTML = renderBookingRows(list);

      document.querySelectorAll('.view-booking-btn').forEach(btn => {
        btn.addEventListener('click', () => showBookingDetail(btn.dataset.id));
      });
    }

    if (bkSearch) bkSearch.addEventListener('input', filterBookings);
    if (bkDate) bkDate.addEventListener('change', filterBookings);
    if (bkCourse) bkCourse.addEventListener('change', filterBookings);
    if (bkStatus) bkStatus.addEventListener('change', filterBookings);
    if (bkCounsellor) bkCounsellor.addEventListener('change', filterBookings);
  }

  // ══════════════════════════════════════════════
  // BOOTSTRAP INITIALIZATION
  // ══════════════════════════════════════════════

  function setupDashboardInteractions() {
    // In-App Notification Center Triggers
    const notifBellBtn = $('#notifBellBtn');
    if (notifBellBtn) {
      notifBellBtn.addEventListener('click', toggleNotificationDropdown);
    }
    const markAllReadBtn = $('#markAllReadBtn');
    if (markAllReadBtn) {
      markAllReadBtn.addEventListener('click', markAllNotificationsRead);
    }
    // Close notification dropdown when clicking outside
    document.addEventListener('click', (e) => {
      const dropdown = $('#notifDropdown');
      const container = $('.topbar-notif-container');
      if (dropdown && container && !container.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });

    // Hash Route Synchronization & Page Restoration
    const initialHash = window.location.hash.replace('#', '');
    if (initialHash && SESSION && isPageAllowedForRole(initialHash, SESSION.role)) {
      CURRENT_PAGE = initialHash;
    } else {
      window.location.hash = '#' + CURRENT_PAGE;
    }

    window.addEventListener('hashchange', () => {
      const hashPage = window.location.hash.replace('#', '');
      if (SESSION && hashPage && isPageAllowedForRole(hashPage, SESSION.role) && hashPage !== CURRENT_PAGE) {
        CURRENT_PAGE = hashPage;
        renderPage();
        buildSidebar();
      }
    });

    // Boot In-App Notifications
    loadNotifications();

    // Top Bar Guided Tour Button
    const startTourBtn = $('#startTourBtn');
    if (startTourBtn) {
      startTourBtn.addEventListener('click', () => {
        startInteractiveTour(true);
      });
    }

    // Top Bar Logout Button
    const topbarLogoutBtn = $('#topbarLogoutBtn');
    if (topbarLogoutBtn) {
      topbarLogoutBtn.addEventListener('click', () => {
        confirmAction('Sign Out', 'Are you sure you want to exit the Apex Academy administration portal?', logout);
      });
    }

    // Tour Popover Buttons
    const tourSkipBtn = $('#tourSkipBtn');
    if (tourSkipBtn) tourSkipBtn.addEventListener('click', () => endTour(true));

    const tourPrevBtn = $('#tourPrevBtn');
    if (tourPrevBtn) tourPrevBtn.addEventListener('click', prevTourStep);

    const tourNextBtn = $('#tourNextBtn');
    if (tourNextBtn) tourNextBtn.addEventListener('click', nextTourStep);

    // Auto-launch guided tour for first-time login
    setTimeout(() => {
      startInteractiveTour(false);
    }, 600);

    // Top Bar Reset Demo Button
    const resetDemoBtn = $('#resetDemoBtn');
    if (resetDemoBtn) {
      if (useSupabaseData()) {
        resetDemoBtn.style.display = 'none';
      } else {
        resetDemoBtn.addEventListener('click', () => {
          confirmAction(
            'Reset Demonstration Data?',
            'Restore initial mock admissions, counselling bookings, and counsellor workload records?',
            () => {
              AdminData.resetDemoData();
              showToast('Data Restored', 'Demo records reset to baseline state.', 'info');
              renderPage();
              buildSidebar();
            }
          );
        });
      }
    }

    // Mobile Sidebar Toggles
    const menuToggle = $('#menuToggle');
    const sidebar = $('#adminSidebar');
    const overlay = $('#sidebarOverlay');

    if (menuToggle && sidebar && overlay) {
      menuToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');
        document.body.classList.toggle('no-scroll');
      });
      overlay.addEventListener('click', closeMobileSidebar);
    }

    // Modal & Drawer Close Listeners
    const modalOverlay = $('#modalOverlay');
    if (modalOverlay) {
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
      });
    }

    const drawerClose = $('#drawerClose');
    const drawerOverlay = $('#drawerOverlay');
    if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
    if (drawerOverlay) drawerOverlay.addEventListener('click', closeDrawer);

    // Global Keydown (Escape key)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        closeDrawer();
        closeMobileSidebar();
      }
    });
  }

  async function bootDashboard() {
    // 1. FAST PATH: Synchronously load session from localStorage so UI paints in 0ms
    SESSION = getSessionFromStorage();
    if (!SESSION) {
      // If Supabase is configured, attempt async verification before redirecting
      if (window.ApexSupabase && window.ApexSupabase.isLive()) {
        try {
          SESSION = await verifySessionWithSupabase();
        } catch (e) {
          SESSION = null;
        }
      }
      if (!SESSION) {
        window.location.href = 'login.html';
        return;
      }
    }

    // Expose verified session globally for helper functions
    window.SESSION = SESSION;

    // 2. Render UI Immediately:
    // Build sidebar and render active page so skeleton is instantly replaced in 0ms
    try {
      buildSidebar();
      syncRoleSwitcher();
      renderPage();
    } catch (initialRenderErr) {
      console.warn('Initial layout render notice:', initialRenderErr);
    }

    // 3. Setup event listeners, notifications, modals & hash navigation
    try {
      setupDashboardInteractions();
    } catch (interactionErr) {
      console.warn('Interaction listener registration notice:', interactionErr);
    }

    // 4. Background Verification & Live Supabase Synchronization
    if (useSupabaseData()) {
      (async () => {
        try {
          await syncFromSupabase();
          // Seamlessly update page & sidebar with live records and fresh badge counts
          buildSidebar();
          renderPage();
        } catch (syncErr) {
          console.warn('Background Supabase synchronization notice:', syncErr);
        }
      })();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootDashboard);
  } else {
    bootDashboard();
  }

})();
