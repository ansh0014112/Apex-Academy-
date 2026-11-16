-- =============================================================================
-- APEX ACADEMY — COUNSELLOR AVAILABILITY, SCHEDULING & DOUBLE-BOOKING PREVENTION
-- File: supabase-counsellor-availability-fix.sql
-- 
-- 1. Table public.counsellor_unavailability (Date-specific leave & institute holidays)
-- 2. Base seeding for active academic counsellors in counsellor_availability
-- 3. Dynamic RPC public.get_available_booking_slots(p_date DATE)
-- 4. RPC public.save_counsellor_availability(p_counsellor_id UUID, p_schedule JSONB)
-- 5. RPC public.get_counsellor_availability_config(p_counsellor_id UUID)
-- 6. RPC public.manage_counsellor_unavailability(...)
-- 7. Atomic concurrency lock & double-booking prevention in submit_counselling_booking
-- =============================================================================

-- ── 1. DATE-SPECIFIC UNAVAILABILITY & INSTITUTE HOLIDAYS TABLE ────────────────
CREATE TABLE IF NOT EXISTS public.counsellor_unavailability (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counsellor_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE, -- NULL means institute-wide holiday / day off
    unavailable_date DATE NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_counsellor_unavail_specific 
ON public.counsellor_unavailability(counsellor_id, unavailable_date) 
WHERE counsellor_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_counsellor_unavail_all 
ON public.counsellor_unavailability(unavailable_date) 
WHERE counsellor_id IS NULL;

ALTER TABLE public.counsellor_unavailability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read counsellor unavailability" ON public.counsellor_unavailability;
CREATE POLICY "Public read counsellor unavailability"
ON public.counsellor_unavailability FOR SELECT
USING (true);

DROP POLICY IF EXISTS "Counsellors manage own unavailability" ON public.counsellor_unavailability;
CREATE POLICY "Counsellors manage own unavailability"
ON public.counsellor_unavailability FOR ALL
TO authenticated
USING (
    counsellor_id = auth.uid() 
    OR public.current_user_role() = 'super_admin'
)
WITH CHECK (
    (counsellor_id = auth.uid() AND counsellor_id IS NOT NULL) 
    OR public.current_user_role() = 'super_admin'
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.counsellor_unavailability TO authenticated;
GRANT SELECT ON public.counsellor_unavailability TO anon;

-- ── 2. SEED DEFAULT AVAILABILITY FOR EXISTING ACTIVE ACADEMIC COUNSELLORS ────
-- Clear legacy placeholder unconstrained rows
DELETE FROM public.counsellor_availability WHERE start_time = '09:00:00' AND end_time = '20:30:00';

-- Seed realistic, distinct weekly windows respecting lunch breaks and max 08:00 PM end time
INSERT INTO public.counsellor_availability (
    counsellor_id, day_of_week, start_time, end_time, slot_duration_minutes, is_available, is_active
)
SELECT p.id, s.dow, s.start_t::TIME, s.end_t::TIME, 30, true, true
FROM public.profiles p
CROSS JOIN (
    VALUES
        (1, '09:30:00', '13:00:00'), -- Monday morning
        (1, '14:00:00', '17:30:00'), -- Monday afternoon (Lunch break 13:00-14:00)
        (2, '10:00:00', '13:30:00'), -- Tuesday morning
        (2, '15:00:00', '19:00:00'), -- Tuesday afternoon (Break 13:30-15:00)
        (3, '11:00:00', '14:00:00'), -- Wednesday morning
        (3, '15:30:00', '19:30:00'), -- Wednesday afternoon (Break 14:00-15:30)
        (4, '09:00:00', '12:30:00'), -- Thursday morning
        (4, '14:00:00', '18:00:00'), -- Thursday afternoon (Break 12:30-14:00)
        (5, '10:00:00', '14:00:00'), -- Friday morning
        (5, '15:30:00', '20:00:00'), -- Friday afternoon (Break 14:00-15:30, final slot 19:30-20:00)
        (6, '09:00:00', '13:30:00')  -- Saturday half-day morning only
) AS s(dow, start_t, end_t)
WHERE p.role = 'academic_counsellor'
  AND p.is_active = true
ON CONFLICT (counsellor_id, day_of_week, start_time, end_time) DO NOTHING;

-- ── 3. DYNAMIC RPC: get_available_booking_slots ──────────────────────────────
CREATE OR REPLACE FUNCTION public.get_available_booking_slots(p_date DATE)
RETURNS JSONB AS $$
DECLARE
    v_dow INTEGER;
    v_today_ist DATE;
    v_now_time_ist TIME;
    v_avail_count INTEGER;
    v_total_system_avail INTEGER;
    v_holiday_reason TEXT;
    v_slots JSONB;
BEGIN
    -- Strict evaluation in Asia/Kolkata timezone
    v_today_ist := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;
    v_now_time_ist := (NOW() AT TIME ZONE 'Asia/Kolkata')::TIME;

    -- 1. Date cannot be in the past
    IF p_date < v_today_ist THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Date cannot be in the past.',
            'slots', '[]'::jsonb
        );
    END IF;

    -- 2. Check for institute-wide holiday / day off
    SELECT reason INTO v_holiday_reason
    FROM public.counsellor_unavailability
    WHERE counsellor_id IS NULL AND unavailable_date = p_date
    LIMIT 1;

    IF v_holiday_reason IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', true,
            'date', p_date,
            'day_available', false,
            'holiday', true,
            'message', 'Institute Holiday: ' || COALESCE(v_holiday_reason, 'Scheduled closure'),
            'slots', '[]'::jsonb
        );
    END IF;

    v_dow := EXTRACT(DOW FROM p_date)::INTEGER; -- 0=Sunday, 6=Saturday

    -- 3. Check active academic counsellor availability on this weekday (excluding counsellors on leave)
    SELECT COUNT(DISTINCT ca.counsellor_id) INTO v_avail_count
    FROM public.counsellor_availability ca
    JOIN public.profiles p ON p.id = ca.counsellor_id
    WHERE ca.day_of_week = v_dow
      AND ca.is_available = true
      AND ca.is_active = true
      AND p.is_active = true
      AND p.role = 'academic_counsellor'
      AND NOT EXISTS (
          SELECT 1 FROM public.counsellor_unavailability cu
          WHERE cu.counsellor_id = p.id AND cu.unavailable_date = p_date
      );

    -- Check if system has any configured counsellor availability records at all
    SELECT COUNT(*) INTO v_total_system_avail
    FROM public.counsellor_availability ca
    JOIN public.profiles p ON p.id = ca.counsellor_id
    WHERE ca.is_available = true 
      AND ca.is_active = true 
      AND p.is_active = true 
      AND p.role = 'academic_counsellor';

    -- Sunday handling
    IF v_dow = 0 AND v_avail_count = 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'date', p_date,
            'day_available', false,
            'message', 'Counselling sessions are unavailable on Sundays. Please select a Monday to Saturday date.',
            'slots', '[]'::jsonb
        );
    END IF;

    -- Weekday with no active counsellors available
    IF v_avail_count = 0 THEN
        -- If counsellors are configured but none work this day
        IF v_total_system_avail > 0 THEN
            RETURN jsonb_build_object(
                'success', true,
                'date', p_date,
                'day_available', false,
                'message', 'No academic counsellors are available on this date. Please select another date.',
                'slots', '[]'::jsonb
            );
        END IF;

        -- Fallback: If no counsellor schedule records exist yet, generate baseline institute operating hours (Mon-Sat 09:00 - 20:30)
        SELECT jsonb_agg(slot_label ORDER BY slot_start) INTO v_slots
        FROM (
            SELECT
                TO_CHAR(gs.slot_start, 'HH12:MI AM') || ' - ' || TO_CHAR(gs.slot_start + INTERVAL '30 minutes', 'HH12:MI AM') AS slot_label,
                gs.slot_start
            FROM generate_series(
                (p_date + '09:00:00'::TIME),
                (p_date + '19:30:00'::TIME),
                INTERVAL '30 minutes'
            ) AS gs_ts(slot_timestamp)
            CROSS JOIN LATERAL (SELECT slot_timestamp::TIME AS slot_start) AS gs
            WHERE (p_date > v_today_ist OR gs.slot_start > (v_now_time_ist + INTERVAL '30 minutes'))
              AND NOT EXISTS (
                  SELECT 1 FROM public.counselling_bookings cb
                  WHERE cb.preferred_date = p_date
                    AND cb.preferred_time = TO_CHAR(gs.slot_start, 'HH12:MI AM') || ' - ' || TO_CHAR(gs.slot_start + INTERVAL '30 minutes', 'HH12:MI AM')
                    AND cb.status IN ('Confirmed', 'Assigned')
              )
        ) fallback_slots;

        IF v_slots IS NULL OR jsonb_array_length(v_slots) = 0 THEN
            RETURN jsonb_build_object(
                'success', true,
                'date', p_date,
                'day_available', true,
                'fully_booked', true,
                'message', 'All strategy consultation sessions are fully booked for this date.',
                'slots', '[]'::jsonb
            );
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'date', p_date,
            'day_available', true,
            'fully_booked', false,
            'slots', v_slots
        );
    END IF;

    -- 4. Generate individual slots from configured counsellor availability windows
    -- Respecting slot duration, break periods, counsellor leave dates, and past times for today
    SELECT jsonb_agg(slot_label ORDER BY slot_start) INTO v_slots
    FROM (
        SELECT DISTINCT
            TO_CHAR(gs.slot_start, 'HH12:MI AM') || ' - ' || TO_CHAR(gs.slot_start + (ca.slot_duration_minutes || ' minutes')::INTERVAL, 'HH12:MI AM') AS slot_label,
            gs.slot_start
        FROM public.counsellor_availability ca
        JOIN public.profiles p ON p.id = ca.counsellor_id
        CROSS JOIN LATERAL generate_series(
            (p_date + GREATEST(ca.start_time, '09:00:00'::TIME)),
            (p_date + LEAST(ca.end_time - INTERVAL '30 minutes', '19:30:00'::TIME)),
            INTERVAL '30 minutes'
        ) AS gsts(slot_timestamp)
        CROSS JOIN LATERAL (SELECT slot_timestamp::TIME AS slot_start) AS gs
        WHERE ca.day_of_week = v_dow
          AND ca.is_available = true
          AND ca.is_active = true
          AND p.is_active = true
          AND p.role = 'academic_counsellor'
          -- Exclude counsellors on leave on this specific date
          AND NOT EXISTS (
              SELECT 1 FROM public.counsellor_unavailability cu
              WHERE cu.counsellor_id = p.id AND cu.unavailable_date = p_date
          )
          -- Filter out slots that have already passed if date is today in IST
          AND gs.slot_start >= '09:00:00'::TIME
          AND gs.slot_start <= '19:30:00'::TIME
          AND gs.slot_start + INTERVAL '30 minutes' <= '20:00:00'::TIME
          AND (p_date > v_today_ist OR gs.slot_start > (v_now_time_ist + INTERVAL '30 minutes'))
          -- Keep slot only if at least ONE eligible counsellor covering it is NOT booked
          AND EXISTS (
              SELECT 1
              FROM public.profiles p2
              JOIN public.counsellor_availability ca2 ON ca2.counsellor_id = p2.id
              WHERE p2.is_active = true
                AND p2.role = 'academic_counsellor'
                AND ca2.day_of_week = v_dow
                AND ca2.is_available = true
                AND ca2.is_active = true
                AND gs.slot_start >= ca2.start_time
                AND gs.slot_start + (ca2.slot_duration_minutes || ' minutes')::INTERVAL <= ca2.end_time
                AND NOT EXISTS (
                    SELECT 1 FROM public.counsellor_unavailability cu2
                    WHERE cu2.counsellor_id = p2.id AND cu2.unavailable_date = p_date
                )
                AND NOT EXISTS (
                    SELECT 1 FROM public.counselling_bookings cb
                    WHERE cb.assigned_counsellor_id = p2.id
                      AND cb.preferred_date = p_date
                      AND cb.preferred_time = TO_CHAR(gs.slot_start, 'HH12:MI AM') || ' - ' || TO_CHAR(gs.slot_start + (ca2.slot_duration_minutes || ' minutes')::INTERVAL, 'HH12:MI AM')
                      AND cb.status IN ('Confirmed', 'Assigned')
                )
          )
    ) available_slots;

    IF v_slots IS NULL OR jsonb_array_length(v_slots) = 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'date', p_date,
            'day_available', true,
            'fully_booked', true,
            'message', 'All strategy consultation sessions are fully booked for this date.',
            'slots', '[]'::jsonb
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'date', p_date,
        'day_available', true,
        'fully_booked', false,
        'slots', v_slots
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_available_booking_slots(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_available_booking_slots(DATE) TO anon, authenticated;

-- ── 4. RPC: save_counsellor_availability ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_counsellor_availability(
    p_counsellor_id UUID,
    p_schedule JSONB
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID;
    v_caller_role public.app_role;
    v_item JSONB;
    v_dow INTEGER;
    v_avail BOOLEAN;
    v_start TIME;
    v_end TIME;
    v_duration INTEGER;
    v_has_break BOOLEAN;
    v_break_start TIME;
    v_break_end TIME;
BEGIN
    v_caller_id := auth.uid();
    v_caller_role := public.current_user_role();

    IF v_caller_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Authentication required.');
    END IF;

    -- Only Super Admin or the counsellor themselves can update availability
    IF v_caller_role IS DISTINCT FROM 'super_admin' AND v_caller_id IS DISTINCT FROM p_counsellor_id THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access denied: You can only update your own availability.');
    END IF;

    -- Verify target counsellor exists and is academic_counsellor
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE id = p_counsellor_id AND role = 'academic_counsellor' AND is_active = true
    ) THEN
        RETURN jsonb_build_object('success', false, 'message', 'Specified academic counsellor profile not found or inactive.');
    END IF;

    -- Atomic update: Delete existing availability windows for this counsellor
    DELETE FROM public.counsellor_availability WHERE counsellor_id = p_counsellor_id;

    -- Iterate and insert configured schedule windows
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_schedule)
    LOOP
        v_dow := (v_item->>'day_of_week')::INTEGER;
        v_avail := COALESCE((v_item->>'is_available')::BOOLEAN, false);
        v_start := COALESCE((v_item->>'start_time')::TIME, '09:00:00'::TIME);
        v_end := COALESCE((v_item->>'end_time')::TIME, '18:00:00'::TIME);
        v_duration := COALESCE((v_item->>'slot_duration_minutes')::INTEGER, 30);
        v_has_break := COALESCE((v_item->>'has_break')::BOOLEAN, false);
        v_break_start := (v_item->>'break_start')::TIME;
        v_break_end := (v_item->>'break_end')::TIME;

        IF v_avail AND v_dow BETWEEN 0 AND 6 THEN
            -- Validate time range
            IF v_end <= v_start THEN
                CONTINUE;
            END IF;

            -- Handle break period by creating two distinct availability windows
            IF v_has_break AND v_break_start IS NOT NULL AND v_break_end IS NOT NULL 
               AND v_break_start > v_start AND v_break_end < v_end AND v_break_end > v_break_start THEN
                -- Morning window before break
                INSERT INTO public.counsellor_availability (
                    counsellor_id, day_of_week, start_time, end_time, slot_duration_minutes, is_available, is_active
                ) VALUES (
                    p_counsellor_id, v_dow, v_start, v_break_start, v_duration, true, true
                ) ON CONFLICT DO NOTHING;

                -- Afternoon window after break
                INSERT INTO public.counsellor_availability (
                    counsellor_id, day_of_week, start_time, end_time, slot_duration_minutes, is_available, is_active
                ) VALUES (
                    p_counsellor_id, v_dow, v_break_end, v_end, v_duration, true, true
                ) ON CONFLICT DO NOTHING;
            ELSE
                -- Continuous window without break
                INSERT INTO public.counsellor_availability (
                    counsellor_id, day_of_week, start_time, end_time, slot_duration_minutes, is_available, is_active
                ) VALUES (
                    p_counsellor_id, v_dow, v_start, v_end, v_duration, true, true
                ) ON CONFLICT DO NOTHING;
            END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'message', 'Availability schedule saved successfully.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.save_counsellor_availability(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_counsellor_availability(UUID, JSONB) TO authenticated;

-- ── 5. RPC: get_counsellor_availability_config ───────────────────────────────
CREATE OR REPLACE FUNCTION public.get_counsellor_availability_config(p_counsellor_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID;
    v_caller_role public.app_role;
    v_schedule JSONB;
    v_unavailability JSONB;
BEGIN
    v_caller_id := auth.uid();
    v_caller_role := public.current_user_role();

    IF v_caller_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Authentication required.');
    END IF;

    -- Academic counsellors can view their own; Super Admin can view any
    IF v_caller_role IS DISTINCT FROM 'super_admin' AND v_caller_id IS DISTINCT FROM p_counsellor_id THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access denied.');
    END IF;

    -- Fetch weekly availability rows
    SELECT jsonb_agg(
        jsonb_build_object(
            'id', ca.id,
            'day_of_week', ca.day_of_week,
            'start_time', TO_CHAR(ca.start_time, 'HH24:MI'),
            'end_time', TO_CHAR(ca.end_time, 'HH24:MI'),
            'slot_duration_minutes', ca.slot_duration_minutes,
            'is_available', ca.is_available
        ) ORDER BY ca.day_of_week, ca.start_time
    ) INTO v_schedule
    FROM public.counsellor_availability ca
    WHERE ca.counsellor_id = p_counsellor_id AND ca.is_active = true;

    -- Fetch upcoming date unavailabilities & institute holidays
    SELECT jsonb_agg(
        jsonb_build_object(
            'id', cu.id,
            'date', cu.unavailable_date,
            'reason', cu.reason,
            'is_institute_wide', (cu.counsellor_id IS NULL)
        ) ORDER BY cu.unavailable_date
    ) INTO v_unavailability
    FROM public.counsellor_unavailability cu
    WHERE (cu.counsellor_id = p_counsellor_id OR cu.counsellor_id IS NULL)
      AND cu.unavailable_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;

    RETURN jsonb_build_object(
        'success', true,
        'counsellor_id', p_counsellor_id,
        'schedule', COALESCE(v_schedule, '[]'::jsonb),
        'unavailability', COALESCE(v_unavailability, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_counsellor_availability_config(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_counsellor_availability_config(UUID) TO authenticated;

-- ── 6. RPC: manage_counsellor_unavailability ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.manage_counsellor_unavailability(
    p_action TEXT,
    p_counsellor_id UUID DEFAULT NULL,
    p_date DATE DEFAULT NULL,
    p_reason TEXT DEFAULT NULL,
    p_unavailability_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_caller_id UUID;
    v_caller_role public.app_role;
    v_target_counsellor UUID;
    v_new_id UUID;
BEGIN
    v_caller_id := auth.uid();
    v_caller_role := public.current_user_role();

    IF v_caller_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Authentication required.');
    END IF;

    -- Add a date-specific block / holiday
    IF p_action = 'add' THEN
        IF p_date IS NULL THEN
            RETURN jsonb_build_object('success', false, 'message', 'Date is required.');
        END IF;

        IF p_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE THEN
            RETURN jsonb_build_object('success', false, 'message', 'Cannot add unavailability for past dates.');
        END IF;

        -- If counsellor_id is NULL, only Super Admin can set an institute-wide holiday
        IF p_counsellor_id IS NULL THEN
            IF v_caller_role IS DISTINCT FROM 'super_admin' THEN
                RETURN jsonb_build_object('success', false, 'message', 'Only Super Admin can declare institute-wide holidays.');
            END IF;
            v_target_counsellor := NULL;
        ELSE
            -- Counsellors can only add for themselves
            IF v_caller_role IS DISTINCT FROM 'super_admin' AND v_caller_id IS DISTINCT FROM p_counsellor_id THEN
                RETURN jsonb_build_object('success', false, 'message', 'Access denied.');
            END IF;
            v_target_counsellor := p_counsellor_id;
        END IF;

        INSERT INTO public.counsellor_unavailability (
            counsellor_id, unavailable_date, reason
        ) VALUES (
            v_target_counsellor, p_date, TRIM(p_reason)
        )
        ON CONFLICT DO NOTHING
        RETURNING id INTO v_new_id;

        RETURN jsonb_build_object('success', true, 'id', v_new_id, 'message', 'Unavailability date recorded.');

    -- Delete a date block
    ELSIF p_action = 'delete' THEN
        IF p_unavailability_id IS NULL THEN
            RETURN jsonb_build_object('success', false, 'message', 'Unavailability ID is required for deletion.');
        END IF;

        -- Check permissions
        IF v_caller_role IS DISTINCT FROM 'super_admin' THEN
            DELETE FROM public.counsellor_unavailability 
            WHERE id = p_unavailability_id AND counsellor_id = v_caller_id;
        ELSE
            DELETE FROM public.counsellor_unavailability 
            WHERE id = p_unavailability_id;
        END IF;

        RETURN jsonb_build_object('success', true, 'message', 'Unavailability date removed.');
    ELSE
        RETURN jsonb_build_object('success', false, 'message', 'Unknown action: ' || COALESCE(p_action, 'empty'));
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.manage_counsellor_unavailability(TEXT, UUID, DATE, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manage_counsellor_unavailability(TEXT, UUID, DATE, TEXT, UUID) TO authenticated;

-- ── 7. REINFORCE submit_counselling_booking CONCURRENCY LOCK ────────────────
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


-- ── DASHBOARD BOOKINGS RPC ───────────────────────────────────────────────────
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
