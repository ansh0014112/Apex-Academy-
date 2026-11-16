-- =============================================================================
-- APEX ACADEMY — COMPLETE EMAIL & WHATSAPP COMMUNICATION SYSTEM MIGRATION
-- File: supabase-communication-system.sql
--
-- Features:
-- 1. Centralized communication_logs table with student_id, counsellor_id, actor_id,
--    channel, message_type, recipient, provider_message_id, and delivery statuses.
-- 2. Enhanced notification_outbox table supporting dual student & institute alerts.
-- 3. Automatic event triggers on Enquiry, Booking, Follow-up, and Admission status changes.
-- 4. Role-Based Access Control (RLS) ensuring strict counsellor data isolation.
-- 5. RPC get_dashboard_communication_logs for admin portal visibility.
-- =============================================================================

-- ── 1. CENTRALIZED COMMUNICATION LOGS TABLE ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.communication_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    counsellor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
    message_type TEXT NOT NULL,
    recipient TEXT NOT NULL,
    template_ref TEXT,
    provider_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'delivered', 'read', 'failed')),
    error_details TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for lightning-fast dashboard queries & webhook lookups
CREATE INDEX IF NOT EXISTS idx_comm_logs_student_id ON public.communication_logs(student_id);
CREATE INDEX IF NOT EXISTS idx_comm_logs_counsellor_id ON public.communication_logs(counsellor_id);
CREATE INDEX IF NOT EXISTS idx_comm_logs_actor_id ON public.communication_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_comm_logs_channel ON public.communication_logs(channel);
CREATE INDEX IF NOT EXISTS idx_comm_logs_status ON public.communication_logs(status);
CREATE INDEX IF NOT EXISTS idx_comm_logs_provider_msg_id ON public.communication_logs(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_comm_logs_created_at ON public.communication_logs(created_at DESC);

-- Automatic updated_at trigger for communication_logs
DROP TRIGGER IF EXISTS trg_comm_logs_updated_at ON public.communication_logs;
CREATE TRIGGER trg_comm_logs_updated_at
BEFORE UPDATE ON public.communication_logs
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ── 2. ENHANCE NOTIFICATION OUTBOX TABLE ──────────────────────────────────────
-- Add actor_id, student_id, recipient_override, metadata, and updated_at if not already present
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'actor_id') THEN
        ALTER TABLE public.notification_outbox ADD COLUMN actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'student_id') THEN
        ALTER TABLE public.notification_outbox ADD COLUMN student_id UUID REFERENCES public.students(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'recipient_override') THEN
        ALTER TABLE public.notification_outbox ADD COLUMN recipient_override TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'metadata') THEN
        ALTER TABLE public.notification_outbox ADD COLUMN metadata JSONB DEFAULT '{}'::jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'updated_at') THEN
        ALTER TABLE public.notification_outbox ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
    END IF;
END $$;

-- Expand event_type constraint to support institute alerts and status updates
ALTER TABLE public.notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_event_type_check;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_event_type_check CHECK (
    event_type IN (
        'enquiry_submitted',
        'enquiry_institute_alert',
        'enquiry_assigned',
        'booking_submitted',
        'booking_counsellor_alert',
        'booking_assigned',
        'booking_confirmed',
        'booking_rescheduled',
        'booking_cancelled',
        'followup_scheduled',
        'followup_due',
        'admission_status_update',
        'system_alert'
    )
);

-- ── 3. UPDATE PUBLIC ADMISSION ENQUIRY SUBMISSION RPC ─────────────────────────
-- Generates dual notifications:
-- 1. Student Acknowledgment (Email & WhatsApp)
-- 2. Institute Notification (Email to configured inbox & WhatsApp to institute number)
DROP FUNCTION IF EXISTS public.submit_admission_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.submit_admission_enquiry(
    p_full_name TEXT,
    p_phone TEXT,
    p_email TEXT,
    p_qualification TEXT,
    p_course_category TEXT,
    p_target_examination TEXT,
    p_preferred_batch TEXT,
    p_learning_mode TEXT,
    p_message TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_clean_phone TEXT;
    v_clean_email TEXT;
    v_student_id UUID;
    v_course_id TEXT;
    v_enquiry_id TEXT;
    v_assigned_counsellor_id UUID;
    v_student_outbox_id UUID;
    v_institute_outbox_id UUID;
    v_enquiry_count INT;
BEGIN
    -- 1. Validate mandatory fields
    IF TRIM(COALESCE(p_full_name, '')) = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Full name is required.');
    END IF;

    -- 2. Normalize and validate 10-digit phone
    v_clean_phone := REGEXP_REPLACE(p_phone, '\D', '', 'g');
    IF LENGTH(v_clean_phone) > 10 THEN
        v_clean_phone := RIGHT(v_clean_phone, 10);
    END IF;
    IF LENGTH(v_clean_phone) != 10 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Phone number must be exactly 10 digits.');
    END IF;

    -- 3. Normalize and validate email
    v_clean_email := LOWER(TRIM(p_email));
    IF v_clean_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid email address format.');
    END IF;

    -- 4. Rate-limiting check: Prevent duplicate submissions within 5 minutes
    SELECT COUNT(*) INTO v_enquiry_count
    FROM public.admission_enquiries ae
    JOIN public.students s ON s.id = ae.student_id
    WHERE s.phone = v_clean_phone
      AND ae.created_at > (NOW() - INTERVAL '5 minutes');

    IF v_enquiry_count > 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'An enquiry with this phone number was recently submitted. Our team will contact you shortly.');
    END IF;

    -- 5. Find or create student record
    SELECT id INTO v_student_id FROM public.students WHERE phone = v_clean_phone;
    IF v_student_id IS NULL THEN
        INSERT INTO public.students (full_name, phone, email, qualification)
        VALUES (TRIM(p_full_name), v_clean_phone, v_clean_email, p_qualification)
        RETURNING id INTO v_student_id;
    ELSE
        UPDATE public.students
        SET full_name = TRIM(p_full_name),
            email = v_clean_email,
            qualification = COALESCE(p_qualification, qualification),
            updated_at = NOW()
        WHERE id = v_student_id;
    END IF;

    -- 6. Derive canonical course_id from category
    v_course_id := CASE 
        WHEN p_course_category ILIKE '%Civil%' OR p_course_category ILIKE '%SSC%' THEN 'civil-services-ssc'
        WHEN p_course_category ILIKE '%Bank%' OR p_course_category ILIKE '%Railway%' THEN 'banking-railway'
        ELSE 'foundation'
    END;

    -- 7. Generate sequential human-readable enquiry ID
    SELECT 'ENQ-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD((COUNT(*) + 1)::TEXT, 4, '0')
    INTO v_enquiry_id
    FROM public.admission_enquiries
    WHERE created_at >= DATE_TRUNC('day', NOW());

    -- 8. Insert admission enquiry record with canonical 'New' status
    INSERT INTO public.admission_enquiries (
        id, student_id, course_id, course_category, target_examination,
        preferred_batch_timing, preferred_learning_mode, additional_message, status
    ) VALUES (
        v_enquiry_id, v_student_id, v_course_id, p_course_category, p_target_examination,
        p_preferred_batch, p_learning_mode, p_message, 'New'
    );

    -- 9. Auto-assign admission counsellor via round-robin engine
    v_assigned_counsellor_id := public.auto_assign_admission_enquiry(v_enquiry_id);

    -- 10. Log administrative activity
    PERFORM public.internal_log_activity(
        NULL, 'Public Visitor', 'anonymous',
        'enquiry_created',
        'New admission enquiry registered by ' || p_full_name || ' (' || p_target_examination || ')',
        'admission_enquiry', v_enquiry_id,
        jsonb_build_object('phone', v_clean_phone, 'email', v_clean_email, 'course_id', v_course_id, 'assigned_counsellor_id', v_assigned_counsellor_id)
    );

    -- 11. Queue Event A: Student Acknowledgment (Email & WhatsApp)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'enquiry_submitted', 'admission_enquiry', v_enquiry_id, v_student_id, v_assigned_counsellor_id, 'both', 'pending', NOW(),
            jsonb_build_object('target', 'student', 'full_name', p_full_name, 'exam', p_target_examination)
        ) RETURNING id INTO v_student_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        v_student_outbox_id := NULL;
    END;

    -- 12. Queue Event B: Institute Alert Notification (Institute Inbox & WhatsApp)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'enquiry_institute_alert', 'admission_enquiry', v_enquiry_id, v_student_id, v_assigned_counsellor_id, 'both', 'pending', NOW(),
            jsonb_build_object('target', 'institute', 'full_name', p_full_name, 'phone', v_clean_phone, 'email', v_clean_email, 'exam', p_target_examination, 'counsellor_id', v_assigned_counsellor_id)
        ) RETURNING id INTO v_institute_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        v_institute_outbox_id := NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'enquiry_id', v_enquiry_id,
        'assigned', (v_assigned_counsellor_id IS NOT NULL),
        'outbox_id', v_student_outbox_id,
        'student_outbox_id', v_student_outbox_id,
        'institute_outbox_id', v_institute_outbox_id,
        'message', 'Admission enquiry registered successfully.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.submit_admission_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_admission_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- ── 4. UPDATE PUBLIC COUNSELLING BOOKING SUBMISSION RPC ───────────────────────
-- Generates dual notifications:
-- 1. Student Booking Confirmation (Email & WhatsApp)
-- 2. Counsellor / Institute Booking Alert (Email & WhatsApp)
DROP FUNCTION IF EXISTS public.submit_counselling_booking(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.submit_counselling_booking(
    p_full_name TEXT,
    p_phone TEXT,
    p_email TEXT,
    p_course_category TEXT,
    p_target_examination TEXT,
    p_preferred_date DATE,
    p_preferred_time TEXT,
    p_session_medium TEXT DEFAULT 'Google Meet HD Video Call'
)
RETURNS JSONB AS $$
DECLARE
    v_clean_phone TEXT;
    v_clean_email TEXT;
    v_student_id UUID;
    v_course_id TEXT;
    v_booking_id TEXT;
    v_assigned_counsellor_id UUID;
    v_student_outbox_id UUID;
    v_counsellor_outbox_id UUID;
    v_generated_meet_link TEXT;
    v_active_bookings_count INT;
    v_clean_time_slot TEXT;
BEGIN
    -- 1. Validate mandatory fields
    IF TRIM(COALESCE(p_full_name, '')) = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Full name is required.');
    END IF;

    -- 2. Normalize and validate 10-digit phone
    v_clean_phone := REGEXP_REPLACE(p_phone, '\D', '', 'g');
    IF LENGTH(v_clean_phone) > 10 THEN
        v_clean_phone := RIGHT(v_clean_phone, 10);
    END IF;
    IF LENGTH(v_clean_phone) != 10 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Phone number must be exactly 10 digits.');
    END IF;

    -- 3. Normalize and validate email
    v_clean_email := LOWER(TRIM(p_email));
    IF v_clean_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid email address format.');
    END IF;

    -- 4. Date validation: Cannot book in past (Asia/Kolkata timezone)
    IF p_preferred_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE THEN
        RETURN jsonb_build_object('success', false, 'message', 'Counselling session date cannot be in the past.');
    END IF;

    -- 5. Standardize time slot string
    v_clean_time_slot := TRIM(REPLACE(p_preferred_time, '–', '-'));
    IF v_clean_time_slot = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Preferred time slot is required.');
    END IF;

    -- 6. Find or create student record
    SELECT id INTO v_student_id FROM public.students WHERE phone = v_clean_phone;
    IF v_student_id IS NULL THEN
        INSERT INTO public.students (full_name, phone, email)
        VALUES (TRIM(p_full_name), v_clean_phone, v_clean_email)
        RETURNING id INTO v_student_id;
    ELSE
        UPDATE public.students
        SET full_name = TRIM(p_full_name),
            email = v_clean_email,
            updated_at = NOW()
        WHERE id = v_student_id;
    END IF;

    -- 7. Prevent duplicate active bookings on the same date
    SELECT COUNT(*) INTO v_active_bookings_count
    FROM public.counselling_bookings
    WHERE student_id = v_student_id
      AND preferred_date = p_preferred_date
      AND status IN ('Pending', 'Assigned', 'Confirmed');

    IF v_active_bookings_count > 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'You already have an active counselling appointment on this date.');
    END IF;

    -- 8. Derive canonical course_id
    v_course_id := CASE 
        WHEN p_course_category ILIKE '%Civil%' OR p_course_category ILIKE '%SSC%' THEN 'civil-services-ssc'
        WHEN p_course_category ILIKE '%Bank%' OR p_course_category ILIKE '%Railway%' THEN 'banking-railway'
        ELSE 'foundation'
    END;

    -- 9. Generate sequential human-readable booking ID
    SELECT 'BKG-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD((COUNT(*) + 1)::TEXT, 4, '0')
    INTO v_booking_id
    FROM public.counselling_bookings
    WHERE created_at >= DATE_TRUNC('day', NOW());

    -- 10. Auto-assign academic counsellor via workload balancing (4 parameters)
    v_assigned_counsellor_id := public.auto_assign_counselling_booking(
        v_booking_id, p_preferred_date, v_clean_time_slot, p_session_medium
    );

    -- 11. Insert booking record with canonical 'Pending' status
    INSERT INTO public.counselling_bookings (
        id, student_id, course_id, course_category, target_examination,
        preferred_date, preferred_time, session_medium, assigned_counsellor_id, status
    ) VALUES (
        v_booking_id, v_student_id, v_course_id, p_course_category, p_target_examination,
        p_preferred_date, v_clean_time_slot, p_session_medium, v_assigned_counsellor_id, 'Pending'
    );

    -- Retrieve meet link if pre-configured
    SELECT google_meet_link INTO v_generated_meet_link
    FROM public.counselling_bookings
    WHERE id = v_booking_id;

    -- 12. Log administrative activity
    PERFORM public.internal_log_activity(
        NULL, 'Public Visitor', 'anonymous',
        'booking_requested',
        '1-on-1 strategy call requested by ' || p_full_name || ' for ' || p_preferred_date || ' (' || v_clean_time_slot || ')',
        'counselling_booking', v_booking_id,
        jsonb_build_object('session_medium', p_session_medium, 'course_id', v_course_id, 'assigned_counsellor_id', v_assigned_counsellor_id)
    );

    -- 13. Queue Event A: Student Booking Confirmation (Email & WhatsApp)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'booking_submitted', 'counselling_booking', v_booking_id, v_student_id, v_assigned_counsellor_id, 'both', 'pending', NOW(),
            jsonb_build_object('target', 'student', 'full_name', p_full_name, 'date', p_preferred_date, 'time', v_clean_time_slot, 'medium', p_session_medium)
        ) RETURNING id INTO v_student_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        v_student_outbox_id := NULL;
    END;

    -- 14. Queue Event B: Counsellor / Institute Alert (Email & WhatsApp)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'booking_counsellor_alert', 'counselling_booking', v_booking_id, v_student_id, v_assigned_counsellor_id, 'both', 'pending', NOW(),
            jsonb_build_object('target', 'counsellor', 'full_name', p_full_name, 'phone', v_clean_phone, 'email', v_clean_email, 'date', p_preferred_date, 'time', v_clean_time_slot, 'counsellor_id', v_assigned_counsellor_id)
        ) RETURNING id INTO v_counsellor_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        v_counsellor_outbox_id := NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'booking_id', v_booking_id,
        'assigned', (v_assigned_counsellor_id IS NOT NULL),
        'google_meet_link', v_generated_meet_link,
        'outbox_id', v_student_outbox_id,
        'student_outbox_id', v_student_outbox_id,
        'counsellor_outbox_id', v_counsellor_outbox_id,
        'message', 'Counselling appointment requested successfully.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.submit_counselling_booking(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_counselling_booking(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT) TO anon, authenticated;

-- ── 5. UPDATE ENQUIRY STATUS RPC WITH NOTIFICATION TRIGGER ────────────────────
CREATE OR REPLACE FUNCTION public.update_enquiry_status(
    p_enquiry_id TEXT,
    p_new_status public.enquiry_status
)
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_enquiry RECORD;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    SELECT * INTO v_enquiry FROM public.admission_enquiries WHERE id = p_enquiry_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Enquiry not found');
    END IF;

    IF v_role = 'admission_counsellor' AND v_enquiry.assigned_counsellor_id IS DISTINCT FROM v_uid THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only update enquiries assigned to you.');
    END IF;

    IF v_role = 'academic_counsellor' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: Academic counsellors cannot update admission enquiry status.');
    END IF;

    UPDATE public.admission_enquiries
    SET status = p_new_status, updated_at = NOW()
    WHERE id = p_enquiry_id;

    PERFORM public.internal_log_activity(
        v_uid, (SELECT full_name FROM public.profiles WHERE id = v_uid), v_role::TEXT,
        'enquiry_status_updated',
        'Enquiry ' || p_enquiry_id || ' status updated to ' || p_new_status,
        'admission_enquiry', p_enquiry_id,
        jsonb_build_object('new_status', p_new_status, 'previous_status', v_enquiry.status)
    );

    -- Queue Student Notification for significant status changes
    IF p_new_status IN ('Contacted', 'Interested', 'Pending Follow-up', 'Converted', 'Not Interested') THEN
        BEGIN
            INSERT INTO public.notification_outbox (
                event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
            ) VALUES (
                'admission_status_update', 'admission_enquiry', p_enquiry_id, v_enquiry.student_id, v_uid, 'both', 'pending', NOW(),
                jsonb_build_object('status', p_new_status::TEXT, 'previous_status', v_enquiry.status::TEXT)
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;

    RETURN jsonb_build_object('success', true, 'message', 'Enquiry status updated to ' || p_new_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.update_enquiry_status(TEXT, public.enquiry_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_enquiry_status(TEXT, public.enquiry_status) TO authenticated;

-- ── 6. UPDATE FOLLOW-UP RPC WITH NOTIFICATION TRIGGER ─────────────────────────
DROP FUNCTION IF EXISTS public.create_follow_up(TEXT, DATE, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.create_follow_up(UUID, TEXT, TEXT, DATE, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.create_follow_up(
    p_student_id UUID DEFAULT NULL,
    p_enquiry_id TEXT DEFAULT NULL,
    p_booking_id TEXT DEFAULT NULL,
    p_follow_up_date DATE DEFAULT NULL,
    p_follow_up_time TEXT DEFAULT NULL,
    p_follow_up_type TEXT DEFAULT 'phone_call',
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_student_id UUID;
    v_follow_up_id UUID;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    IF p_follow_up_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Follow-up date is required.');
    END IF;

    -- Resolve student_id if not explicitly provided
    v_student_id := p_student_id;
    IF v_student_id IS NULL AND p_enquiry_id IS NOT NULL THEN
        SELECT student_id INTO v_student_id FROM public.admission_enquiries WHERE id = p_enquiry_id;
    END IF;
    IF v_student_id IS NULL AND p_booking_id IS NOT NULL THEN
        SELECT student_id INTO v_student_id FROM public.counselling_bookings WHERE id = p_booking_id;
    END IF;

    IF v_student_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Student ID is required to schedule a follow-up.');
    END IF;

    IF p_enquiry_id IS NOT NULL AND v_role = 'admission_counsellor' THEN
        IF NOT EXISTS (SELECT 1 FROM public.admission_enquiries WHERE id = p_enquiry_id AND assigned_counsellor_id = v_uid) THEN
            RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only create follow-ups for enquiries assigned to you.');
        END IF;
    END IF;

    IF p_booking_id IS NOT NULL AND v_role = 'academic_counsellor' THEN
        IF NOT EXISTS (SELECT 1 FROM public.counselling_bookings WHERE id = p_booking_id AND assigned_counsellor_id = v_uid) THEN
            RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only create follow-ups for bookings assigned to you.');
        END IF;
    END IF;

    INSERT INTO public.follow_ups (
        student_id, enquiry_id, booking_id, assigned_to,
        follow_up_date, follow_up_time, follow_up_type, notes, status
    ) VALUES (
        v_student_id, p_enquiry_id, p_booking_id, v_uid,
        p_follow_up_date, p_follow_up_time, COALESCE(p_follow_up_type, 'phone_call'), p_notes, 'pending'
    ) RETURNING id INTO v_follow_up_id;

    -- Queue Follow-up reminder notification
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'followup_scheduled', 'follow_up', v_follow_up_id::TEXT, v_student_id, v_uid, 'both', 'pending', NOW(),
            jsonb_build_object('follow_up_date', p_follow_up_date, 'follow_up_time', p_follow_up_time, 'enquiry_id', p_enquiry_id, 'booking_id', p_booking_id)
        );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object('success', true, 'follow_up_id', v_follow_up_id, 'message', 'Follow-up task scheduled successfully.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.create_follow_up(UUID, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_follow_up(UUID, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) TO authenticated;

-- ── 6b. ATOMIC OUTBOX CLAIMING & STALE RECOVERY RPCS ───────────────────────────
CREATE OR REPLACE FUNCTION public.claim_outbox_records(p_batch_size INTEGER DEFAULT 15)
RETURNS SETOF UUID AS $$
BEGIN
  RETURN QUERY
  UPDATE public.notification_outbox
  SET status = 'processing', processed_at = NOW()
  WHERE id IN (
    SELECT id FROM public.notification_outbox
    WHERE status = 'pending' AND scheduled_at <= NOW()
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.claim_outbox_records(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_outbox_records(INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.reset_stale_outbox_records()
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.notification_outbox
  SET status = 'pending', processed_at = NULL, attempts = attempts + 1
  WHERE status = 'processing' AND processed_at < NOW() - INTERVAL '15 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.reset_stale_outbox_records() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_stale_outbox_records() TO service_role, authenticated;

-- ── 7. DASHBOARD RPC: GET COMMUNICATION LOGS ──────────────────────────────────
-- Enforces strict role-based access:
-- Super Admin: can view all communications.
-- Counsellors: can view only communications for their assigned students or where they are the actor.
CREATE OR REPLACE FUNCTION public.get_dashboard_communication_logs(
    p_channel TEXT DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_logs JSONB;
    v_total INT;
    v_counts JSONB;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    -- Count summary statistics
    SELECT jsonb_build_object(
        'total_emails', COUNT(*) FILTER (WHERE channel = 'email'),
        'total_whatsapp', COUNT(*) FILTER (WHERE channel = 'whatsapp'),
        'sent', COUNT(*) FILTER (WHERE status = 'sent'),
        'delivered', COUNT(*) FILTER (WHERE status = 'delivered'),
        'read', COUNT(*) FILTER (WHERE status = 'read'),
        'failed', COUNT(*) FILTER (WHERE status = 'failed')
    ) INTO v_counts
    FROM public.communication_logs cl
    WHERE (v_role = 'super_admin' OR cl.counsellor_id = v_uid OR cl.actor_id = v_uid);

    -- Count total matching filter
    SELECT COUNT(*) INTO v_total
    FROM public.communication_logs cl
    WHERE (v_role = 'super_admin' OR cl.counsellor_id = v_uid OR cl.actor_id = v_uid)
      AND (p_channel IS NULL OR cl.channel = p_channel)
      AND (p_status IS NULL OR cl.status = p_status);

    -- Fetch paginated logs
    SELECT jsonb_agg(
        jsonb_build_object(
            'id', cl.id,
            'student_id', cl.student_id,
            'student_name', s.full_name,
            'counsellor_id', cl.counsellor_id,
            'counsellor_name', cp.full_name,
            'actor_id', cl.actor_id,
            'actor_name', ap.full_name,
            'channel', cl.channel,
            'message_type', cl.message_type,
            'recipient', cl.recipient,
            'template_ref', cl.template_ref,
            'provider_message_id', cl.provider_message_id,
            'status', cl.status,
            'error_details', cl.error_details,
            'metadata', cl.metadata,
            'created_at', cl.created_at,
            'updated_at', cl.updated_at
        ) ORDER BY cl.created_at DESC
    ) INTO v_logs
    FROM (
        SELECT * FROM public.communication_logs cl_sub
        WHERE (v_role = 'super_admin' OR cl_sub.counsellor_id = v_uid OR cl_sub.actor_id = v_uid)
          AND (p_channel IS NULL OR cl_sub.channel = p_channel)
          AND (p_status IS NULL OR cl_sub.status = p_status)
        ORDER BY cl_sub.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) cl
    LEFT JOIN public.students s ON s.id = cl.student_id
    LEFT JOIN public.profiles cp ON cp.id = cl.counsellor_id
    LEFT JOIN public.profiles ap ON ap.id = cl.actor_id;

    RETURN jsonb_build_object(
        'success', true,
        'summary', v_counts,
        'total', v_total,
        'data', COALESCE(v_logs, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.get_dashboard_communication_logs(TEXT, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_communication_logs(TEXT, TEXT, INT, INT) TO authenticated;

-- ── 8. ROW LEVEL SECURITY ON COMMUNICATION LOGS ───────────────────────────────
ALTER TABLE public.communication_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "communication_logs_service_role" ON public.communication_logs;
CREATE POLICY "communication_logs_service_role"
    ON public.communication_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "communication_logs_super_admin" ON public.communication_logs;
CREATE POLICY "communication_logs_super_admin"
    ON public.communication_logs
    FOR SELECT
    TO authenticated
    USING (public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "communication_logs_counsellor" ON public.communication_logs;
CREATE POLICY "communication_logs_counsellor"
    ON public.communication_logs
    FOR SELECT
    TO authenticated
    USING (
        public.current_user_role() IN ('admission_counsellor', 'academic_counsellor')
        AND (counsellor_id = auth.uid() OR actor_id = auth.uid())
    );
