-- =============================================================================
-- APEX ACADEMY — COUNSELLING BOOKING & NOTIFICATION OUTBOX REPAIR MIGRATION
-- Fixes: "column 'recipient' of relation 'notification_outbox' does not exist"
-- Enforces:
-- 1. Correct canonical columns in public.notification_outbox.
-- 2. Backward-compatible optional recipient column in public.notification_outbox.
-- 3. Production submit_counselling_booking RPC with pg_advisory_xact_lock concurrency lock.
-- 4. Dual email queuing (Student Confirmation + Counsellor/Institute Alert) via notification_outbox.
-- 5. Safe exception handling around outbox queueing to prevent rolling back valid bookings.
-- =============================================================================

-- ── STEP 1: ENSURE ALL REQUIRED COLUMNS EXIST ON notification_outbox ─────────
DO $$
BEGIN
    -- 1. actor_id (references staff profile who triggered or is assigned)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'actor_id'
    ) THEN
        ALTER TABLE public.notification_outbox ADD COLUMN actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;

    -- 2. student_id (references student record)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'student_id'
    ) THEN
        ALTER TABLE public.notification_outbox ADD COLUMN student_id UUID REFERENCES public.students(id) ON DELETE SET NULL;
    END IF;

    -- 3. recipient_override (stores direct target email if different from student profile)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'recipient_override'
    ) THEN
        ALTER TABLE public.notification_outbox ADD COLUMN recipient_override TEXT;
    END IF;

    -- 4. recipient (backward-compatibility column so any legacy query touching 'recipient' succeeds)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'recipient'
    ) THEN
        ALTER TABLE public.notification_outbox ADD COLUMN recipient TEXT;
    END IF;

    -- 5. metadata (stores booking/enquiry payload for email rendering)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'metadata'
    ) THEN
        ALTER TABLE public.notification_outbox ADD COLUMN metadata JSONB DEFAULT '{}'::jsonb;
    END IF;

    -- 6. updated_at timestamp
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'notification_outbox' AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE public.notification_outbox ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
    END IF;
END $$;

-- ── STEP 1B: ENSURE notification_type ENUM SUPPORTS 'booking' ────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        WHERE t.typname = 'notification_type' AND e.enumlabel = 'booking'
    ) THEN
        ALTER TYPE public.notification_type ADD VALUE 'booking';
    END IF;
EXCEPTION WHEN OTHERS THEN
    -- In older PG or certain transaction modes, ALTER TYPE ADD VALUE may raise notice; ignore safely
    RAISE NOTICE 'Skipping or handled ALTER TYPE public.notification_type ADD VALUE: %', SQLERRM;
END $$;

-- ── STEP 1C: ENSURE counselling_bookings HAS student_name COLUMN ─────────────
ALTER TABLE public.counselling_bookings ADD COLUMN IF NOT EXISTS student_name TEXT;

-- ── STEP 2: EXPAND event_type CONSTRAINT ON notification_outbox ──────────────
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

-- Ensure channel constraint allows 'email', 'both', 'whatsapp' (for historical rows)
ALTER TABLE public.notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_channel_check;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_channel_check CHECK (
    channel IN ('email', 'whatsapp', 'both')
);

-- ── STEP 3: REINFORCE submit_counselling_booking RPC ─────────────────────────
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
    v_booking_id TEXT;
    v_course_id TEXT;
    v_today_ist DATE;
    v_now_time_ist TIME;
    v_dow INTEGER;
    v_start_match TEXT[];
    v_slot_start TIME;
    v_slot_end TIME;
    v_configured_avail_count INTEGER;
    v_total_avail_counsellors INTEGER;
    v_booked_counsellors INTEGER;
    v_assigned_counsellor_id UUID;
    v_holiday_reason TEXT;
    v_generated_meet_link TEXT;
    v_clean_time_slot TEXT;
    v_student_outbox_id UUID;
    v_counsellor_outbox_id UUID;
BEGIN
    -- 1. Validate mandatory student name
    IF TRIM(COALESCE(p_full_name, '')) = '' OR LENGTH(TRIM(p_full_name)) < 2 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Full name must contain at least 2 characters.');
    END IF;

    -- 2. Normalize and validate 10-digit Indian phone number
    v_clean_phone := REGEXP_REPLACE(COALESCE(p_phone, ''), '\D', '', 'g');
    IF LENGTH(v_clean_phone) > 10 THEN
        v_clean_phone := RIGHT(v_clean_phone, 10);
    END IF;
    IF LENGTH(v_clean_phone) != 10 OR v_clean_phone !~ '^[6-9]\d{9}$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Please provide a valid 10-digit Indian mobile number.');
    END IF;

    -- 3. Normalize and validate email address
    v_clean_email := LOWER(TRIM(COALESCE(p_email, '')));
    IF v_clean_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Please enter a valid email address.');
    END IF;

    -- 4. Standardize slot time string
    v_clean_time_slot := TRIM(REPLACE(REPLACE(p_preferred_time, '–', '-'), '—', '-'));
    IF v_clean_time_slot = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Preferred time slot is required.');
    END IF;

    -- 5. Evaluate date strictly in Asia/Kolkata timezone
    v_today_ist := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;
    v_now_time_ist := (NOW() AT TIME ZONE 'Asia/Kolkata')::TIME;

    IF p_preferred_date < v_today_ist THEN
        RETURN jsonb_build_object('success', false, 'message', 'Preferred appointment date cannot be in the past.');
    END IF;

    IF p_preferred_date > (v_today_ist + INTERVAL '60 days')::DATE THEN
        RETURN jsonb_build_object('success', false, 'message', 'Appointments cannot be scheduled more than 60 days in advance.');
    END IF;

    -- 6. Check for institute-wide holiday / closure
    SELECT reason INTO v_holiday_reason
    FROM public.counsellor_unavailability
    WHERE counsellor_id IS NULL AND unavailable_date = p_preferred_date
    LIMIT 1;

    IF v_holiday_reason IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'The institute is closed on ' || p_preferred_date || ' (' || COALESCE(v_holiday_reason, 'Scheduled closure') || '). Please select an alternate date.'
        );
    END IF;

    -- 7. Validate session medium
    IF p_session_medium NOT IN ('Google Meet HD Video Call', 'Direct Telephonic Call (Audio)', 'Campus In-Person Counselling') THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid session medium specified.');
    END IF;

    -- 8. Parse preferred time window (e.g. '10:00 AM - 10:30 AM')
    v_start_match := regexp_match(v_clean_time_slot, '([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))', 'i');
    IF v_start_match IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid time slot format provided: ' || COALESCE(v_clean_time_slot, 'empty'));
    END IF;

    BEGIN
        v_slot_start := TO_TIMESTAMP(v_start_match[1], 'HH12:MI AM')::TIME;
    EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'message', 'Could not parse start time from: ' || v_clean_time_slot);
    END;

    -- Parse or derive slot end time
    IF v_clean_time_slot LIKE '%-%' THEN
        DECLARE
            v_second_match TEXT[];
        BEGIN
            v_second_match := regexp_match(SUBSTRING(v_clean_time_slot FROM POSITION('-' IN v_clean_time_slot) + 1), '([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))', 'i');
            IF v_second_match IS NOT NULL THEN
                v_slot_end := TO_TIMESTAMP(v_second_match[1], 'HH12:MI AM')::TIME;
            ELSE
                v_slot_end := v_slot_start + INTERVAL '30 minutes';
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_slot_end := v_slot_start + INTERVAL '30 minutes';
        END;
    ELSE
        v_slot_end := v_slot_start + INTERVAL '30 minutes';
    END IF;

    IF v_slot_end <= v_slot_start THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid slot duration: End time must be after start time.');
    END IF;

    -- Enforce operating hours window: 09:00 AM to 08:00 PM (final slot 07:30 PM - 08:00 PM)
    IF v_slot_start < '09:00:00'::TIME OR v_slot_end > '20:00:00'::TIME THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Requested consultation slot must fall within institute operating hours (09:00 AM to 08:00 PM).'
        );
    END IF;

    -- If booking for today, reject slots that are in the past or within 15 minutes
    IF p_preferred_date = v_today_ist AND v_slot_start <= (v_now_time_ist + INTERVAL '15 minutes') THEN
        RETURN jsonb_build_object('success', false, 'message', 'This time slot has already passed for today. Please select a later time slot.');
    END IF;

    -- 9. ATOMIC CONCURRENCY LOCK: Serializes concurrent booking requests for the exact same date & slot
    PERFORM pg_advisory_xact_lock(hashtext('counselling_booking_' || p_preferred_date::TEXT || '_' || v_clean_time_slot));

    -- 10. Validate working days (Sunday = 0 is closed)
    v_dow := EXTRACT(DOW FROM p_preferred_date)::INTEGER;
    IF v_dow = 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Counselling sessions are unavailable on Sundays. Please select a Monday to Saturday date.'
        );
    END IF;

    -- 11. Validate counsellor availability against configured schedules
    SELECT COUNT(*) INTO v_configured_avail_count
    FROM public.counsellor_availability
    WHERE is_active = true AND is_available = true;

    IF v_configured_avail_count > 0 THEN
        -- Check how many active academic counsellors cover this slot on this day (and not on leave)
        SELECT COUNT(DISTINCT ca.counsellor_id) INTO v_total_avail_counsellors
        FROM public.counsellor_availability ca
        JOIN public.profiles p ON p.id = ca.counsellor_id
        WHERE ca.day_of_week = v_dow
          AND ca.is_available = true
          AND ca.is_active = true
          AND p.is_active = true
          AND p.role = 'academic_counsellor'
          AND ca.start_time <= v_slot_start
          AND ca.end_time >= v_slot_end
          AND NOT EXISTS (
              SELECT 1 FROM public.counsellor_unavailability cu
              WHERE cu.counsellor_id = p.id AND cu.unavailable_date = p_preferred_date
          );

        IF v_total_avail_counsellors = 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'The requested slot (' || v_clean_time_slot || ') is outside academic counsellor consultation hours on ' || p_preferred_date || '.'
            );
        END IF;

        -- Check how many counsellors covering this slot are already booked
        SELECT COUNT(DISTINCT cb.assigned_counsellor_id) INTO v_booked_counsellors
        FROM public.counselling_bookings cb
        WHERE cb.preferred_date = p_preferred_date
          AND cb.preferred_time = v_clean_time_slot
          AND cb.status IN ('Confirmed', 'Assigned')
          AND cb.assigned_counsellor_id IS NOT NULL;

        IF v_booked_counsellors >= v_total_avail_counsellors THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'This time slot was just booked by another student. Please choose an alternate slot.'
            );
        END IF;
    END IF;

    -- 12. Canonical Course ID matching
    IF p_course_category ILIKE '%Civil%' OR p_course_category ILIKE '%SSC%' THEN
        v_course_id := 'civil-services-ssc';
    ELSIF p_course_category ILIKE '%Bank%' OR p_course_category ILIKE '%Railway%' THEN
        v_course_id := 'banking-railway';
    ELSE
        v_course_id := 'foundation';
    END IF;

    -- 13. Deduplicate / retrieve student record
    v_student_id := public.get_or_create_student(TRIM(p_full_name), v_clean_phone, v_clean_email);

    -- 14. Check for duplicate active booking by the same student on the same date
    IF EXISTS (
        SELECT 1 FROM public.counselling_bookings
        WHERE student_id = v_student_id
          AND preferred_date = p_preferred_date
          AND status IN ('Pending', 'Assigned', 'Confirmed')
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'You already have an active counselling appointment scheduled for ' || p_preferred_date || '. Please select another date.'
        );
    END IF;

    -- 15. Generate sequential human-readable booking ID or use sequence
    BEGIN
        v_booking_id := 'BK-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(NEXTVAL('public.seq_counselling_booking_id')::TEXT, 5, '0');
    EXCEPTION WHEN OTHERS THEN
        SELECT 'BKG-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD((COUNT(*) + 1)::TEXT, 4, '0')
        INTO v_booking_id
        FROM public.counselling_bookings
        WHERE created_at >= DATE_TRUNC('day', NOW());
    END;

    -- 16. Insert booking record with canonical 'Pending' status and direct student_name
    INSERT INTO public.counselling_bookings (
        id, student_id, student_name, course_id, course_category, target_examination,
        preferred_date, preferred_time, session_medium, status
    ) VALUES (
        v_booking_id, v_student_id, TRIM(p_full_name), v_course_id, p_course_category, p_target_examination,
        p_preferred_date, v_clean_time_slot, p_session_medium, 'Pending'
    );

    -- 17. Trigger Automatic Academic Counsellor Assignment Engine
    v_assigned_counsellor_id := public.auto_assign_counselling_booking(
        v_booking_id, p_preferred_date, v_clean_time_slot, p_session_medium
    );

    -- Retrieve meet link if set
    SELECT google_meet_link INTO v_generated_meet_link
    FROM public.counselling_bookings
    WHERE id = v_booking_id;

    -- 18. Queue Notification Event A: Student Booking Confirmation (Strictly Email)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, recipient_override, recipient, metadata
        ) VALUES (
            'booking_submitted',
            'counselling_booking',
            v_booking_id,
            v_student_id,
            v_assigned_counsellor_id,
            'email',
            'pending',
            NOW(),
            v_clean_email,
            v_clean_email,
            jsonb_build_object(
                'target', 'student',
                'booking_id', v_booking_id,
                'student_name', TRIM(p_full_name),
                'full_name', TRIM(p_full_name),
                'email', v_clean_email,
                'phone', v_clean_phone,
                'preferred_date', p_preferred_date,
                'preferred_time', v_clean_time_slot,
                'course_category', p_course_category,
                'target_examination', p_target_examination,
                'session_medium', p_session_medium,
                'google_meet_link', v_generated_meet_link
            )
        ) RETURNING id INTO v_student_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[submit_counselling_booking] Failed to queue student outbox notification for %: % (SQLSTATE: %)', v_booking_id, SQLERRM, SQLSTATE;
        v_student_outbox_id := NULL;
    END;

    -- 19. Queue Notification Event B: Counsellor / Institute Alert (Strictly Email)
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, student_id, actor_id, channel, status, scheduled_at, recipient_override, recipient, metadata
        ) VALUES (
            'booking_counsellor_alert',
            'counselling_booking',
            v_booking_id,
            v_student_id,
            v_assigned_counsellor_id,
            'email',
            'pending',
            NOW(),
            v_clean_email,
            v_clean_email,
            jsonb_build_object(
                'target', 'counsellor',
                'booking_id', v_booking_id,
                'student_name', TRIM(p_full_name),
                'full_name', TRIM(p_full_name),
                'phone', v_clean_phone,
                'email', v_clean_email,
                'preferred_date', p_preferred_date,
                'preferred_time', v_clean_time_slot,
                'course_category', p_course_category,
                'target_examination', p_target_examination,
                'session_medium', p_session_medium,
                'counsellor_id', v_assigned_counsellor_id
            )
        ) RETURNING id INTO v_counsellor_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[submit_counselling_booking] Failed to queue counsellor outbox notification for %: % (SQLSTATE: %)', v_booking_id, SQLERRM, SQLSTATE;
        v_counsellor_outbox_id := NULL;
    END;

    -- 20. In-App Notification for Super Admin
    BEGIN
        INSERT INTO public.notifications (
            recipient_id, title, message, notification_type, related_record_id
        )
        SELECT
            p.id,
            'New Counselling Booking Received',
            'Student ' || TRIM(p_full_name) || ' booked 1-on-1 strategy call for ' || p_preferred_date || ' (' || v_clean_time_slot || ').',
            'booking_confirmation'::public.notification_type,
            v_booking_id
        FROM public.profiles p
        WHERE p.role = 'super_admin' AND p.is_active = true;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[submit_counselling_booking] Failed to queue in-app notification for super admin on booking %: % (SQLSTATE: %)', v_booking_id, SQLERRM, SQLSTATE;
    END;

    -- 21. Log Administrative Activity
    BEGIN
        PERFORM public.internal_log_activity(
            NULL, TRIM(p_full_name), 'student',
            'booking_created',
            'Counselling session booking ' || v_booking_id || ' booked for ' || p_preferred_date || ' (' || v_clean_time_slot || ').',
            'counselling_booking', v_booking_id,
            jsonb_build_object(
                'preferred_date', p_preferred_date,
                'preferred_time', v_clean_time_slot,
                'course_category', p_course_category,
                'assigned_counsellor_id', v_assigned_counsellor_id,
                'student_outbox_id', v_student_outbox_id,
                'counsellor_outbox_id', v_counsellor_outbox_id
            )
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[submit_counselling_booking] Failed to log administrative activity for booking %: % (SQLSTATE: %)', v_booking_id, SQLERRM, SQLSTATE;
    END;

    -- 22. Return unified snake_case and camelCase response for all client consumers
    RETURN jsonb_build_object(
        'success', true,
        'booking_id', v_booking_id,
        'bookingId', v_booking_id,
        'student_id', v_student_id,
        'studentId', v_student_id,
        'assigned_counsellor_id', v_assigned_counsellor_id,
        'assignedCounsellorId', v_assigned_counsellor_id,
        'google_meet_link', v_generated_meet_link,
        'googleMeetLink', v_generated_meet_link,
        'outbox_id', v_student_outbox_id,
        'outboxId', v_student_outbox_id,
        'student_outbox_id', v_student_outbox_id,
        'counsellor_outbox_id', v_counsellor_outbox_id,
        'message', 'Counselling booking confirmed successfully.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.submit_counselling_booking(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_counselling_booking(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT) TO anon, authenticated, service_role;

-- ── STEP 4: RECOVER ORIGINAL STUDENT NAMES FOR EXISTING BOOKINGS ─────────────
-- Priority 1: Recover from notification_outbox metadata (contains student_name submitted in form)
UPDATE public.counselling_bookings cb
SET student_name = TRIM(no.metadata->>'student_name')
FROM public.notification_outbox no
WHERE no.entity_id = cb.id 
  AND no.metadata->>'student_name' IS NOT NULL 
  AND TRIM(no.metadata->>'student_name') != ''
  AND (cb.student_name IS NULL OR TRIM(cb.student_name) = '');

-- Priority 2: Recover from notification_outbox metadata->>'full_name'
UPDATE public.counselling_bookings cb
SET student_name = TRIM(no.metadata->>'full_name')
FROM public.notification_outbox no
WHERE no.entity_id = cb.id 
  AND no.metadata->>'full_name' IS NOT NULL 
  AND TRIM(no.metadata->>'full_name') != ''
  AND (cb.student_name IS NULL OR TRIM(cb.student_name) = '');

-- Priority 3: Recover from activity_logs (contains actor_name recorded during booking submission)
UPDATE public.counselling_bookings cb
SET student_name = TRIM(al.actor_name)
FROM public.activity_logs al
WHERE al.target_entity_type = 'counselling_booking'
  AND al.target_entity_id = cb.id
  AND al.action_type = 'booking_created'
  AND al.actor_name IS NOT NULL
  AND al.actor_name NOT IN ('student', 'Public Visitor', 'anonymous', 'system', 'Staff')
  AND (cb.student_name IS NULL OR TRIM(cb.student_name) = '');

-- Priority 4: Recover from in-app notifications title/message (using scalar SUBSTRING)
UPDATE public.counselling_bookings cb
SET student_name = TRIM(SUBSTRING(n.message FROM '^Student\s+(.*?)\s+booked'))
FROM public.notifications n
WHERE n.related_record_id = cb.id
  AND n.message ~ '^Student\s+.*?\s+booked'
  AND (cb.student_name IS NULL OR TRIM(cb.student_name) = '');

-- Priority 5: Fallback to existing associated student record if not yet set
UPDATE public.counselling_bookings cb
SET student_name = (SELECT full_name FROM public.students WHERE id = cb.student_id)
WHERE (cb.student_name IS NULL OR TRIM(cb.student_name) = '');

-- ── STEP 5: REINFORCE get_dashboard_bookings RPC ─────────────────────────────
CREATE OR REPLACE FUNCTION public.get_dashboard_bookings(p_limit INTEGER DEFAULT 50, p_offset INTEGER DEFAULT 0)
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_result JSONB;
BEGIN
    v_uid := auth.uid();
    v_role := public.current_user_role();
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    IF v_role = 'super_admin' OR v_role = 'academic_counsellor' THEN
        SELECT jsonb_build_object(
            'success', true,
            'data', COALESCE(jsonb_agg(row_to_json(bq) ORDER BY bq.created_at DESC), '[]'::jsonb)
        ) INTO v_result
        FROM (
            SELECT b.id,
                   b.student_id,
                   -- Source Student Name directly from Academic Counselling booking record
                   COALESCE(NULLIF(TRIM(b.student_name), ''), s.full_name, 'Student Aspirant') AS student_name,
                   s.phone,
                   s.email,
                   b.course_id,
                   b.course_category,
                   b.target_examination,
                   b.preferred_date,
                   b.preferred_time,
                   b.session_medium,
                   b.google_meet_link,
                   b.status::TEXT,
                   b.counselling_notes,
                   b.assigned_counsellor_id,
                   p.full_name AS counsellor_name,
                   b.created_at,
                   b.updated_at
            FROM public.counselling_bookings b
            JOIN public.students s ON s.id = b.student_id
            LEFT JOIN public.profiles p ON p.id = b.assigned_counsellor_id
            WHERE v_role = 'super_admin' OR b.assigned_counsellor_id = v_uid
            ORDER BY b.created_at DESC
            LIMIT p_limit OFFSET p_offset
        ) bq;
    ELSE
        v_result := jsonb_build_object('success', true, 'data', '[]'::jsonb);
    END IF;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_bookings(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_bookings(INTEGER, INTEGER) TO authenticated;
