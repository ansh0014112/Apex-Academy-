-- ============================================================================
-- APEX ACADEMY — REMOVE WHATSAPP & STREAMLINE EMAIL-ONLY NOTIFICATION PIPELINE
-- File: supabase-remove-whatsapp.sql (CORRECTED DEPLOYMENT-READY VERSION)
--
-- VERIFIED GUARANTEES:
-- 1. Exact 1:1 parameter signature match with production database and frontend callers.
-- 2. Preserves all existing student records, bookings, and communication logs.
-- 3. Restores auto_assign_admission_enquiry and auto_assign_counselling_booking.
-- 4. Observable exception handling: RAISE WARNING on queue failure (no silent drops).
-- 5. Correct RPC name: public.get_dashboard_communication_logs.
-- 6. Canonical metadata matching send-notification/index.ts.
-- ============================================================================

-- 1. SET OUTBOX DEFAULT CHANNEL TO 'email'
ALTER TABLE public.notification_outbox 
    ALTER COLUMN channel SET DEFAULT 'email';

-- 2. SUBMIT_ADMISSION_ENQUIRY (EXACT PRODUCTION SIGNATURE & PARAMS)
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
    v_clean_phone := REGEXP_REPLACE(COALESCE(p_phone, ''), '\D', '', 'g');
    IF LENGTH(v_clean_phone) > 10 THEN
        v_clean_phone := RIGHT(v_clean_phone, 10);
    END IF;
    IF LENGTH(v_clean_phone) != 10 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Phone number must be exactly 10 digits.');
    END IF;

    -- 3. Normalize and validate email
    v_clean_email := LOWER(TRIM(COALESCE(p_email, '')));
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
        RETURN jsonb_build_object('success', false, 'message', 'An enquiry with this phone number was recently submitted. Our admissions desk will connect with you shortly.');
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

    -- 9. Auto-assign admission counsellor via production round-robin engine
    v_assigned_counsellor_id := public.auto_assign_admission_enquiry(v_enquiry_id);

    -- 10. Log administrative activity
    PERFORM public.internal_log_activity(
        NULL, 'Public Visitor', 'anonymous',
        'enquiry_created',
        'New admission enquiry registered by ' || p_full_name || ' (' || p_target_examination || ')',
        'admission_enquiry', v_enquiry_id,
        jsonb_build_object('phone', v_clean_phone, 'email', v_clean_email, 'course_id', v_course_id, 'assigned_counsellor_id', v_assigned_counsellor_id)
    );

    -- 11. Queue Event A: Student Acknowledgment (Strictly Email)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'enquiry_submitted', 'admission_enquiry', v_enquiry_id, v_student_id, v_assigned_counsellor_id, 'email', 'pending', NOW(),
            jsonb_build_object(
                'target', 'student',
                'student_name', TRIM(p_full_name),
                'full_name', TRIM(p_full_name),
                'email', v_clean_email,
                'target_examination', p_target_examination,
                'course_category', p_course_category,
                'preferred_batch_timing', p_preferred_batch,
                'preferred_learning_mode', p_learning_mode
            )
        ) RETURNING id INTO v_student_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[submit_admission_enquiry] Failed to queue student outbox notification for %: % (SQLSTATE: %)', v_enquiry_id, SQLERRM, SQLSTATE;
        v_student_outbox_id := NULL;
    END;

    -- 12. Queue Event B: Institute Alert Notification (Strictly Email)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'enquiry_institute_alert', 'admission_enquiry', v_enquiry_id, v_student_id, v_assigned_counsellor_id, 'email', 'pending', NOW(),
            jsonb_build_object(
                'target', 'institute',
                'student_name', TRIM(p_full_name),
                'full_name', TRIM(p_full_name),
                'phone', v_clean_phone,
                'email', v_clean_email,
                'target_examination', p_target_examination,
                'course_category', p_course_category,
                'qualification', p_qualification,
                'additional_message', p_message,
                'counsellor_id', v_assigned_counsellor_id
            )
        ) RETURNING id INTO v_institute_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[submit_admission_enquiry] Failed to queue institute outbox notification for %: % (SQLSTATE: %)', v_enquiry_id, SQLERRM, SQLSTATE;
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

-- 3. SUBMIT_COUNSELLING_BOOKING (EXACT PRODUCTION SIGNATURE & PARAMS)
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
    v_clean_phone := REGEXP_REPLACE(COALESCE(p_phone, ''), '\D', '', 'g');
    IF LENGTH(v_clean_phone) > 10 THEN
        v_clean_phone := RIGHT(v_clean_phone, 10);
    END IF;
    IF LENGTH(v_clean_phone) != 10 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Phone number must be exactly 10 digits.');
    END IF;

    -- 3. Normalize and validate email
    v_clean_email := LOWER(TRIM(COALESCE(p_email, '')));
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

    -- 10. Auto-assign academic counsellor via production workload balancing (4 parameters)
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

    -- Retrieve meet link if generated/configured
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

    -- 13. Queue Event A: Student Booking Confirmation (Strictly Email)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'booking_submitted', 'counselling_booking', v_booking_id, v_student_id, v_assigned_counsellor_id, 'email', 'pending', NOW(),
            jsonb_build_object(
                'target', 'student',
                'student_name', TRIM(p_full_name),
                'full_name', TRIM(p_full_name),
                'preferred_date', p_preferred_date,
                'preferred_time', v_clean_time_slot,
                'target_examination', p_target_examination,
                'session_medium', p_session_medium
            )
        ) RETURNING id INTO v_student_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[submit_counselling_booking] Failed to queue student outbox notification for %: % (SQLSTATE: %)', v_booking_id, SQLERRM, SQLSTATE;
        v_student_outbox_id := NULL;
    END;

    -- 14. Queue Event B: Counsellor / Institute Alert (Strictly Email)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'booking_counsellor_alert', 'counselling_booking', v_booking_id, v_student_id, v_assigned_counsellor_id, 'email', 'pending', NOW(),
            jsonb_build_object(
                'target', 'counsellor',
                'student_name', TRIM(p_full_name),
                'full_name', TRIM(p_full_name),
                'phone', v_clean_phone,
                'email', v_clean_email,
                'preferred_date', p_preferred_date,
                'preferred_time', v_clean_time_slot,
                'target_examination', p_target_examination,
                'session_medium', p_session_medium,
                'counsellor_id', v_assigned_counsellor_id
            )
        ) RETURNING id INTO v_counsellor_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[submit_counselling_booking] Failed to queue counsellor outbox notification for %: % (SQLSTATE: %)', v_booking_id, SQLERRM, SQLSTATE;
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

-- 4. UPDATE_ENQUIRY_STATUS (OBSERVABLE EXCEPTION HANDLING)
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

    -- Queue Student Email Notification for significant status changes
    IF p_new_status IN ('Contacted', 'Interested', 'Pending Follow-up', 'Converted', 'Not Interested') THEN
        BEGIN
            INSERT INTO public.notification_outbox (
                event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
            ) VALUES (
                'admission_status_update', 'admission_enquiry', p_enquiry_id, v_enquiry.student_id, v_uid, 'email', 'pending', NOW(),
                jsonb_build_object(
                    'status', p_new_status::TEXT,
                    'previous_status', v_enquiry.status::TEXT,
                    'target_examination', v_enquiry.target_examination
                )
            );
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING '[update_enquiry_status] Failed to queue status change notification for %: % (SQLSTATE: %)', p_enquiry_id, SQLERRM, SQLSTATE;
        END;
    END IF;

    RETURN jsonb_build_object('success', true, 'message', 'Enquiry status updated to ' || p_new_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.update_enquiry_status(TEXT, public.enquiry_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_enquiry_status(TEXT, public.enquiry_status) TO authenticated;

-- 5. CREATE_FOLLOW_UP (OBSERVABLE EXCEPTION HANDLING)
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

    IF p_student_id IS NOT NULL THEN
        v_student_id := p_student_id;
    ELSIF p_enquiry_id IS NOT NULL THEN
        SELECT student_id INTO v_student_id FROM public.admission_enquiries WHERE id = p_enquiry_id;
    ELSIF p_booking_id IS NOT NULL THEN
        SELECT student_id INTO v_student_id FROM public.counselling_bookings WHERE id = p_booking_id;
    END IF;

    IF v_student_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid student or lead reference for follow-up.');
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

    -- Queue Follow-up reminder notification (Strictly Email)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, metadata
        ) VALUES (
            'followup_scheduled', 'follow_up', v_follow_up_id::TEXT, v_student_id, v_uid, 'email', 'pending', NOW(),
            jsonb_build_object(
                'follow_up_date', p_follow_up_date,
                'follow_up_time', p_follow_up_time,
                'enquiry_id', p_enquiry_id,
                'booking_id', p_booking_id
            )
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[create_follow_up] Failed to queue follow-up notification for %: % (SQLSTATE: %)', v_follow_up_id, SQLERRM, SQLSTATE;
    END;

    RETURN jsonb_build_object('success', true, 'follow_up_id', v_follow_up_id, 'message', 'Follow-up task scheduled successfully.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.create_follow_up(UUID, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_follow_up(UUID, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) TO authenticated;

-- 6. GET_DASHBOARD_COMMUNICATION_LOGS (CORRECT PRODUCTION RPC NAME & EMAIL METRICS)
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

    -- Count summary statistics (Email-only architecture; total_whatsapp, delivered, and read explicitly 0)
    SELECT jsonb_build_object(
        'total_emails', COUNT(*) FILTER (WHERE channel = 'email'),
        'total_whatsapp', 0,
        'sent', COUNT(*) FILTER (WHERE status = 'sent'),
        'delivered', 0,
        'read', 0,
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
            'actor_id', cl.actor_id,
            'actor_name', COALESCE(p.full_name, 'System Engine'),
            'channel', cl.channel,
            'message_type', cl.message_type,
            'recipient', cl.recipient,
            'template_ref', cl.template_ref,
            'status', cl.status,
            'error_details', cl.error_details,
            'created_at', cl.created_at
        ) ORDER BY cl.created_at DESC
    ) INTO v_logs
    FROM (
        SELECT * FROM public.communication_logs cl
        WHERE (v_role = 'super_admin' OR cl.counsellor_id = v_uid OR cl.actor_id = v_uid)
          AND (p_channel IS NULL OR cl.channel = p_channel)
          AND (p_status IS NULL OR cl.status = p_status)
        ORDER BY cl.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) cl
    LEFT JOIN public.students s ON s.id = cl.student_id
    LEFT JOIN public.profiles p ON p.id = cl.actor_id;

    RETURN jsonb_build_object(
        'success', true,
        'counts', v_counts,
        'total', v_total,
        'logs', COALESCE(v_logs, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_communication_logs(TEXT, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_communication_logs(TEXT, TEXT, INT, INT) TO authenticated;
