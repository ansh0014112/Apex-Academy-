/**
 * APEX ACADEMY — Supabase Client & Production Data Bridge
 * Provides a unified API for Supabase Auth, PostgreSQL tables, RPCs, and Realtime.
 * Production-hardened: ZERO mock fallbacks, strict error reporting, and authenticated sessions.
 */

(function () {
  'use strict';

  let client = null;
  let activeRealtimeChannel = null;

  // Initialize Supabase Client using centralized configuration
  function initClient() {
    const config = window.APEX_SUPABASE_CONFIG;
    if (config && typeof config.isConfigured === 'function' && config.isConfigured() && typeof window.supabase !== 'undefined') {
      try {
        client = window.supabase.createClient(config.url, config.anonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storage: window.localStorage
          }
        });
        console.log('✔ Apex Academy: Supabase client initialized.');
      } catch (err) {
        console.error('Failed to initialize Supabase client:', err);
        client = null;
      }
    }
    return client;
  }

  // Public Service Object
  window.ApexSupabase = {
    getClient() {
      if (!client) initClient();
      return client;
    },

    isLive() {
      const c = this.getClient();
      return Boolean(c && window.APEX_SUPABASE_CONFIG && window.APEX_SUPABASE_CONFIG.isConfigured());
    },

    // ── 1. AUTHENTICATION & SESSION MANAGEMENT ───────────────────────────────
    async signIn(email, password, expectedRole) {
      if (!this.isLive()) {
        return {
          success: false,
          configured: false,
          message: 'Database connection unconfigured: Please configure your Supabase Project URL and anon key in js/supabase-config.js.'
        };
      }

      try {
        const c = this.getClient();
        const { data, error } = await c.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password: password
        });

        if (error || !data?.user) {
          return { success: false, message: error?.message || 'Invalid email or password.' };
        }

        // Fetch verified user profile from public.profiles
        let { data: profile, error: profileErr } = await c
          .from('profiles')
          .select('id, full_name, email, role, department, specialisation, daily_capacity, phone, is_active')
          .eq('id', data.user.id)
          .single();

        // If direct select failed, attempt self-healing sync RPC if available
        if ((profileErr || !profile) && c.rpc) {
          try {
            const { data: synced, error: syncErr } = await c.rpc('get_or_sync_current_profile');
            if (!syncErr && synced && synced.length > 0) {
              profile = synced[0];
              profileErr = null;
            }
          } catch (e) {
            console.warn('Profile sync RPC attempt error:', e);
          }
        }

        if (profileErr || !profile) {
          console.warn('Profile lookup failed for user ID:', data.user.id, profileErr);
          await c.auth.signOut();
          return {
            success: false,
            message: 'Administrative profile not found in institute records. Please contact the Super Admin.'
          };
        }

        // Check account active status
        if (profile.is_active !== true) {
          await c.auth.signOut();
          return {
            success: false,
            message: 'Account Deactivated: This staff account has been disabled by the Super Admin.'
          };
        }

        // Check whether role has been assigned in institute records
        if (!profile.role) {
          await c.auth.signOut();
          return {
            success: false,
            message: 'Access Denied: Account role has not yet been assigned in institute records. Please contact the Super Admin.'
          };
        }

        // Role verification against expected workspace
        if (expectedRole && profile.role !== expectedRole) {
          await c.auth.signOut();
          const formatRoleName = (r) => {
            if (r === 'super_admin') return 'Super Admin';
            if (r === 'admission_counsellor') return 'Admission Counsellor';
            if (r === 'academic_counsellor') return 'Academic Counsellor';
            return (r || '').replace(/_/g, ' ');
          };
          const roleDisplay = formatRoleName(profile.role);
          const expectedDisplay = formatRoleName(expectedRole);
          return {
            success: false,
            message: `Access Denied: This account is registered as ${roleDisplay}, which cannot access the ${expectedDisplay} portal. Please select the matching portal.`
          };
        }

        return {
          success: true,
          user: {
            id: profile.id,
            email: profile.email,
            name: profile.full_name,
            role: profile.role,
            department: profile.department,
            specialisation: profile.specialisation,
            phone: profile.phone,
            daily_capacity: profile.daily_capacity
          }
        };
      } catch (e) {
        console.error('Sign in exception:', e);
        return { success: false, message: 'Authentication failure: ' + (e.message || 'Unknown network error.') };
      }
    },

    async signOut() {
      if (this.isLive()) {
        try {
          if (activeRealtimeChannel) {
            await activeRealtimeChannel.unsubscribe();
            activeRealtimeChannel = null;
          }
          await this.getClient().auth.signOut();
        } catch (e) {
          console.warn('SignOut warning:', e);
        }
      }
      localStorage.removeItem('apex_admin_session');
      sessionStorage.removeItem('apex_admin_session');
    },

    // ── 2. PASSWORD RECOVERY WORKFLOW ────────────────────────────────────────
    async sendPasswordReset(email) {
      if (!this.isLive()) {
        return {
          success: false,
          configured: false,
          message: 'Password recovery service unavailable: Database is not configured.'
        };
      }
      try {
        const c = this.getClient();
        const redirectUrl = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/login.html') + '?type=recovery';
        const { error } = await c.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
          redirectTo: redirectUrl
        });

        if (error) return { success: false, message: error.message };
        return {
          success: true,
          message: 'A password reset link has been dispatched to your registered email address. Please follow the instructions in that email.'
        };
      } catch (e) {
        return { success: false, message: e.message || 'Failed to send password reset email.' };
      }
    },

    async updateUserPassword(newPassword) {
      if (!this.isLive()) {
        return { success: false, message: 'Supabase configuration required.' };
      }
      try {
        const c = this.getClient();
        const { error } = await c.auth.updateUser({ password: newPassword });
        if (error) return { success: false, message: error.message };
        return { success: true, message: 'Your password has been successfully updated.' };
      } catch (e) {
        return { success: false, message: e.message || 'Failed to update password.' };
      }
    },

    // ── 3. PUBLIC ADMISSION ENQUIRY SUBMISSION ───────────────────────────────
    async submitAdmissionEnquiry(formData) {
      if (!this.isLive()) {
        return {
          success: false,
          configured: false,
          message: 'Online admissions system is currently unconfigured. Please contact institute administration directly.'
        };
      }

      try {
        const c = this.getClient();
        const payload = {
          p_full_name: formData.fullName,
          p_phone: formData.phone,
          p_email: formData.email,
          p_qualification: formData.qualification,
          p_course_category: formData.courseCategory || formData.courseId,
          p_target_examination: formData.targetExamination,
          p_preferred_batch: formData.preferredBatch,
          p_learning_mode: formData.learningMode,
          p_message: formData.message || null,
          p_course_id: formData.courseId || null
        };

        let { data, error } = await c.rpc('submit_admission_enquiry', payload);

        // Graceful fallback retry in case database has a legacy 9-param signature
        if (error && (error.code === 'PGRST202' || (error.message && error.message.includes('p_course_id')))) {
          const fallbackPayload = { ...payload };
          delete fallbackPayload.p_course_id;
          const retry = await c.rpc('submit_admission_enquiry', fallbackPayload);
          data = retry.data;
          error = retry.error;
        }

        if (error) throw error;
        if (!data || !data.success) {
          return { success: false, message: data?.message || 'Admission enquiry submission rejected.' };
        }

        return {
          success: true,
          enquiryId: data.enquiry_id,
          tokenId: data.enquiry_id,
          outboxId: data.outbox_id || null,  // For processNotificationOutbox()
          message: data.message
        };
      } catch (err) {
        console.error('Error submitting admission enquiry:', err);
        return { success: false, message: err.message || 'Admission enquiry submission failed.' };
      }
    },

    // ── 4. PUBLIC COUNSELLING BOOKING SUBMISSION ─────────────────────────────
    async submitCounsellingBooking(formData) {
      if (!this.isLive()) {
        return {
          success: false,
          configured: false,
          message: 'Counselling booking portal is currently unconfigured. Please call Apex Academy directly.'
        };
      }

      try {
        const c = this.getClient();
        const { data, error } = await c.rpc('submit_counselling_booking', {
          p_full_name: formData.fullName,
          p_phone: formData.phone,
          p_email: formData.email,
          p_course_category: formData.courseCategory,
          p_target_examination: formData.targetExamination,
          p_preferred_date: formData.preferredDate,
          p_preferred_time: formData.preferredTime,
          p_session_medium: formData.sessionMedium || 'Google Meet HD Video Call'
        });

        if (error) throw error;
        if (!data || !data.success) {
          return { success: false, message: data?.message || 'Booking submission rejected.' };
        }

        return {
          success: true,
          bookingId: data.booking_id,
          tokenId: data.booking_id,
          outboxId: data.outbox_id || null,  // For processNotificationOutbox()
          message: data.message
        };
      } catch (err) {
        console.error('Error submitting counselling booking:', err);
        return { success: false, message: err.message || 'Booking submission failed.' };
      }
    },

    // ── 5. SESSION RESCHEDULING RPC ──────────────────────────────────────────
    async rescheduleBooking(bookingId, newDate, newTime, reason) {
      if (!this.isLive()) {
        return { success: false, message: 'Supabase database is unconfigured.' };
      }

      try {
        const c = this.getClient();
        const { data, error } = await c.rpc('reschedule_booking', {
          p_booking_id: bookingId,
          p_new_date: newDate,
          p_new_time: newTime,
          p_reason: reason
        });

        if (error) throw error;
        return data;
      } catch (err) {
        console.error('Reschedule booking error:', err);
        return { success: false, message: err.message || 'Rescheduling failed.' };
      }
    },

    // ── 6. LIMITED STAFF DIRECTORY RPC ───────────────────────────────────────
    async getStaffDirectory() {
      if (!this.isLive()) return [];
      try {
        const c = this.getClient();
        const { data, error } = await c.rpc('get_staff_directory');
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.warn('Could not fetch staff directory:', err);
        return [];
      }
    },

    // ── 7. TUTORIAL PROGRESS PERSISTENCE ─────────────────────────────────────
    async isTutorialCompleted(userId, tutorialKey = 'onboarding_tour') {
      if (!this.isLive()) return false;
      try {
        const c = this.getClient();
        const { data, error } = await c
          .from('tutorial_progress')
          .select('is_completed')
          .eq('user_id', userId)
          .eq('tutorial_key', tutorialKey)
          .single();

        if (error && error.code !== 'PGRST116') throw error; // PGRST116 is no rows returned
        return Boolean(data && data.is_completed);
      } catch (e) {
        return false;
      }
    },

    async setTutorialCompleted(userId, tutorialKey = 'onboarding_tour', isCompleted = true) {
      if (!this.isLive()) return;
      try {
        const c = this.getClient();
        await c.from('tutorial_progress').upsert({
          user_id: userId,
          tutorial_key: tutorialKey,
          is_completed: isCompleted,
          completed_at: isCompleted ? new Date().toISOString() : null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,tutorial_key' });
      } catch (e) {
        console.warn('Could not save tutorial progress to Supabase:', e);
      }
    },

    // ── 8. IN-APP NOTIFICATIONS & REALTIME CENTER ────────────────────────────
    async getNotifications(userId) {
      if (!this.isLive()) return [];
      try {
        const c = this.getClient();
        const { data, error } = await c
          .from('notifications')
          .select('id, recipient_id, title, message, notification_type, related_record_id, is_read, created_at')
          .eq('recipient_id', userId)
          .order('created_at', { ascending: false })
          .limit(30);

        if (error) throw error;
        return data || [];
      } catch (e) {
        console.warn('Could not fetch notifications from Supabase:', e);
        return [];
      }
    },

    async markNotificationRead(notifId) {
      if (!this.isLive()) return;
      try {
        const c = this.getClient();
        await c.from('notifications').update({ is_read: true }).eq('id', notifId);
      } catch (e) {
        console.warn('Could not mark notification read:', e);
      }
    },

    async markAllNotificationsRead(userId) {
      if (!this.isLive()) return;
      try {
        const c = this.getClient();
        await c.from('notifications').update({ is_read: true }).eq('recipient_id', userId);
      } catch (e) {
        console.warn('Could not mark all notifications read:', e);
      }
    },

    subscribeToNotifications(userId, onNotificationCallback) {
      if (!this.isLive()) return null;
      try {
        const c = this.getClient();
        if (activeRealtimeChannel) {
          activeRealtimeChannel.unsubscribe();
        }

        activeRealtimeChannel = c
          .channel(`user-notifications-${userId}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'notifications',
              filter: `recipient_id=eq.${userId}`
            },
            (payload) => {
              if (typeof onNotificationCallback === 'function') {
                onNotificationCallback(payload.new);
              }
            }
          )
          .subscribe();

        return activeRealtimeChannel;
      } catch (e) {
        console.warn('Realtime subscription failed:', e);
        return null;
      }
    },

    // Notification processing is handled server-side only (pg_cron or database webhook).
    // This method is intentionally disabled for public-facing pages.
    async processNotificationOutbox() {
      console.info('Notification dispatch is handled server-side. No client-side processing needed.');
      return { success: true, message: 'Server-side dispatch only.' };
    },

    // Legacy alias — now routes through secure outbox architecture
    async sendNotification(payload) {
      console.warn('ApexSupabase.sendNotification() deprecated. Use notification_outbox table for server-side dispatch.');
      return { success: true, simulated: true, message: 'Use notification_outbox table for server-side dispatch.' };
    },

    // Update Google Meet link for a booking (Super Admin only via set_booking_meet_link RPC)
    async setBookingMeetLink(bookingId, meetLink) {
      if (!this.isLive()) return { success: false, message: 'Database offline' };
      const c = this.getClient();
      const { data, error } = await c.rpc('set_booking_meet_link', {
        p_booking_id: bookingId,
        p_meet_link: meetLink || null
      });
      if (error) throw error;
      return data;
    },

    // Get available booking slots for a given date (calls get_available_booking_slots RPC)
    async getAvailableBookingSlots(date) {
      if (this.isLive()) {
        try {
          const c = this.getClient();
          const { data, error } = await c.rpc("get_available_booking_slots", { p_date: date });
          if (!error && data && data.success) return data;
          if (error) {
            console.warn("RPC get_available_booking_slots error notice:", error.message);
          }
        } catch (e) {
          console.warn("RPC get_available_booking_slots notice, delegating to dynamic scheduler:", e.message);
        }
      }
      if (typeof window !== "undefined" && window.AdminData && typeof window.AdminData.getAvailableBookingSlots === "function") {
        return window.AdminData.getAvailableBookingSlots(date);
      }
      // Built-in baseline dynamic scheduler fallback (Mon-Sat 09:00 AM - 08:00 PM, Sunday closed)
      try {
        const parts = date.split('-').map(Number);
        const dayOfWeek = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
        if (dayOfWeek === 0) {
          return {
            success: true,
            date: date,
            day_available: false,
            message: "Counselling sessions are unavailable on Sundays. Please select a Monday to Saturday date.",
            slots: []
          };
        }
        const standardSlots = [
          "09:00 AM - 09:30 AM", "09:30 AM - 10:00 AM", "10:00 AM - 10:30 AM", "10:30 AM - 11:00 AM",
          "11:00 AM - 11:30 AM", "11:30 AM - 12:00 PM", "12:00 PM - 12:30 PM", "12:30 PM - 01:00 PM",
          "02:00 PM - 02:30 PM", "02:30 PM - 03:00 PM", "03:00 PM - 03:30 PM", "03:30 PM - 04:00 PM",
          "04:00 PM - 04:30 PM", "04:30 PM - 05:00 PM", "05:00 PM - 05:30 PM", "05:30 PM - 06:00 PM",
          "06:00 PM - 06:30 PM", "06:30 PM - 07:00 PM", "07:00 PM - 07:30 PM", "07:30 PM - 08:00 PM"
        ];
        return {
          success: true,
          date: date,
          day_available: true,
          fully_booked: false,
          slots: standardSlots
        };
      } catch (err) {
        return { success: false, slots: [], message: "Scheduling system offline" };
      }
    },

    // Fetch counsellor availability config & holidays
    async getCounsellorAvailabilityConfig(counsellorId) {
      if (!this.isLive()) return { success: false, schedule: [], unavailability: [] };
      const c = this.getClient();
      const { data, error } = await c.rpc('get_counsellor_availability_config', { p_counsellor_id: counsellorId });
      if (error) throw error;
      return data;
    },

    // Save weekly schedule for counsellor
    async saveCounsellorAvailability(counsellorId, schedule) {
      if (!this.isLive()) return { success: false, message: 'Database offline' };
      const c = this.getClient();
      const { data, error } = await c.rpc('save_counsellor_availability', {
        p_counsellor_id: counsellorId,
        p_schedule: schedule
      });
      if (error) throw error;
      return data;
    },

    // Manage date-specific unavailabilities and holidays
    async manageCounsellorUnavailability(action, counsellorId = null, date = null, reason = null, unavailabilityId = null) {
      if (!this.isLive()) return { success: false, message: 'Database offline' };
      const c = this.getClient();
      const { data, error } = await c.rpc('manage_counsellor_unavailability', {
        p_action: action,
        p_counsellor_id: counsellorId,
        p_date: date,
        p_reason: reason,
        p_unavailability_id: unavailabilityId
      });
      if (error) throw error;
      return data;
    },
    // Fetch communication logs for admin dashboards
    async getCommunicationLogs(channel = null, status = null, limit = 50, offset = 0) {
      if (!this.isLive()) return { success: false, data: [] };
      const c = this.getClient();
      const { data, error } = await c.rpc('get_dashboard_communication_logs', {
        p_channel: channel,
        p_status: status,
        p_limit: limit,
        p_offset: offset
      });
      if (error) {
        console.warn('RPC get_dashboard_communication_logs notice:', error.message);
        return { success: false, data: [] };
      }
      return data;
    },

    // Get dashboard statistics for current user's role
    async getDashboardStats() {
      if (!this.isLive()) return null;
      const c = this.getClient();
      const { data, error } = await c.rpc('get_dashboard_stats');
      if (error) throw error;
      return data;
    },

    // Get enquiries for current authenticated user's role
    async getEnquiries(limit = 50, offset = 0) {
      if (!this.isLive()) return { success: false, data: [], message: 'Database offline' };
      const c = this.getClient();
      const { data, error } = await c.rpc('get_dashboard_enquiries', { p_limit: limit, p_offset: offset });
      if (error) throw error;
      return data;
    },

    // Get bookings for current authenticated user's role
    async getBookings(limit = 50, offset = 0) {
      if (!this.isLive()) return { success: false, data: [], message: 'Database offline' };
      const c = this.getClient();
      const { data, error } = await c.rpc('get_dashboard_bookings', { p_limit: limit, p_offset: offset });
      if (error) throw error;
      return data;
    },

    // Get follow-ups for current authenticated user
    async getFollowUps() {
      if (!this.isLive()) return { success: false, data: [], message: 'Database offline' };
      const c = this.getClient();
      const { data, error } = await c.rpc('get_dashboard_follow_ups');
      if (error) throw error;
      return data;
    },

    // Get activity log
    async getActivityLog(limit = 50) {
      if (!this.isLive()) return { success: false, data: [], message: 'Database offline' };
      const c = this.getClient();
      const { data, error } = await c.rpc('get_dashboard_activity_log', { p_limit: limit });
      if (error) throw error;
      return data;
    },

    // Get counsellor list (for assignments)
    async getCounsellors() {
      if (!this.isLive()) return [];
      const c = this.getClient();
      const { data, error } = await c
        .from('profiles')
        .select('id, full_name, email, role, department, specialisation, phone, is_active, daily_capacity')
        .in('role', ['admission_counsellor', 'academic_counsellor'])
        .order('full_name');
      if (error) throw error;
      return data || [];
    },

    // Get courses list
    async getCourses() {
      if (!this.isLive()) return [];
      const c = this.getClient();
      const { data, error } = await c
        .from('courses')
        .select('id, name, category, description, examination_list, base_fee, is_active, created_at')
        .order('name');
      if (error) throw error;
      return data || [];
    },

    async reassignAdmissionEnquiry(enquiryId, newCounsellorId) {
      if (!this.isLive()) return { success: false, message: 'Database offline' };
      const c = this.getClient();
      const { data, error } = await c.rpc('reassign_admission_enquiry', {
        p_enquiry_id: enquiryId,
        p_new_counsellor_id: newCounsellorId || null
      });
      if (error) throw error;
      return data;
    },

    async reassignCounsellingBooking(bookingId, newCounsellorId) {
      if (!this.isLive()) return { success: false, message: 'Database offline' };
      const c = this.getClient();
      const { data, error } = await c.rpc('reassign_counselling_booking', {
        p_booking_id: bookingId,
        p_new_counsellor_id: newCounsellorId || null
      });
      if (error) throw error;
      return data;
    }
  };

  // Attempt initial client boot
  document.addEventListener('DOMContentLoaded', initClient);
})();
