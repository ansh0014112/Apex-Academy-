-- ====================================================================
-- APEX ACADEMY — DEFINITIVE ADMISSION ENQUIRY RPC REPAIR
-- File: supabase-admission-enquiry-course-fix.sql
-- Description:
--   Permanently resolves:
--     1. PGRST203 "Could not choose the best candidate function between..."
--        by dropping duplicate function overloads and deploying a single canonical RPC.
--     2. Foreign key violation "admission_enquiries_course_id_fkey"
--        by dynamically verifying and mapping courses to canonical primary keys
--        in public.courses ('foundation', 'civil-services-ssc', 'banking-railway').
--
-- Deployment:
--   Execute this entire script once in the Supabase Dashboard SQL Editor.
-- ====================================================================

-- 1. DROP ALL EXISTING OVERLOADS TO ELIMINATE FUNCTION AMBIGUITY
DROP FUNCTION IF EXISTS public.submit_admission_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.submit_admission_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

-- 2. CREATE THE SINGLE CANONICAL SUBMIT_ADMISSION_ENQUIRY RPC (NO OVERLOADS)
CREATE OR REPLACE FUNCTION public.submit_admission_enquiry(
    p_full_name TEXT,
    p_phone TEXT,
    p_email TEXT,
    p_qualification TEXT,
    p_course_category TEXT,
    p_target_examination TEXT,
    p_preferred_batch TEXT,
    p_learning_mode TEXT,
    p_message TEXT DEFAULT NULL,
    p_course_id TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_clean_phone TEXT;
    v_clean_email TEXT;
    v_student_id UUID;
    v_course_id TEXT;
    v_course_name TEXT;
    v_course_category TEXT;
    v_course_active BOOLEAN;
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

    -- 2. Normalize and validate 10-digit Indian phone number
    v_clean_phone := REGEXP_REPLACE(COALESCE(p_phone, ''), '\D', '', 'g');
    IF LENGTH(v_clean_phone) > 10 THEN
        v_clean_phone := RIGHT(v_clean_phone, 10);
    END IF;
    IF LENGTH(v_clean_phone) != 10 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Phone number must be exactly 10 digits.');
    END IF;

    -- 3. Normalize and validate email address
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
        RETURN jsonb_build_object(
            'success', false,
            'message', 'An enquiry with this phone number was recently submitted. Our admissions desk will connect with you shortly.'
        );
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

    -- 6. STRICT & DYNAMIC COURSE VERIFICATION AGAINST public.courses
    -- Check Priority 1: Match p_course_id directly in public.courses if supplied
    IF p_course_id IS NOT NULL AND TRIM(p_course_id) <> '' THEN
        SELECT id, name, is_active INTO v_course_id, v_course_name, v_course_active
        FROM public.courses
        WHERE id = LOWER(TRIM(p_course_id))
        LIMIT 1;
    END IF;

    -- Check Priority 2: Match p_course_category as an exact primary key in public.courses
    IF v_course_id IS NULL AND p_course_category IS NOT NULL AND TRIM(p_course_category) <> '' THEN
        SELECT id, name, is_active INTO v_course_id, v_course_name, v_course_active
        FROM public.courses
        WHERE id = LOWER(TRIM(p_course_category))
        LIMIT 1;
    END IF;

    -- Check Priority 3: Match p_course_category against course name in public.courses
    IF v_course_id IS NULL AND p_course_category IS NOT NULL AND TRIM(p_course_category) <> '' THEN
        SELECT id, name, is_active INTO v_course_id, v_course_name, v_course_active
        FROM public.courses
        WHERE (name ILIKE '%' || TRIM(p_course_category) || '%' OR TRIM(p_course_category) ILIKE '%' || name || '%')
        LIMIT 1;
    END IF;

    -- Check Priority 4: Standard pattern matching to canonical courses in public.courses
    IF v_course_id IS NULL THEN
        IF COALESCE(p_course_id, p_course_category) ILIKE '%Civil%' OR COALESCE(p_course_id, p_course_category) ILIKE '%SSC%' THEN
            SELECT id, name, is_active INTO v_course_id, v_course_name, v_course_active
            FROM public.courses WHERE id = 'civil-services-ssc';
        ELSIF COALESCE(p_course_id, p_course_category) ILIKE '%Bank%' OR COALESCE(p_course_id, p_course_category) ILIKE '%Railway%' THEN
            SELECT id, name, is_active INTO v_course_id, v_course_name, v_course_active
            FROM public.courses WHERE id = 'banking-railway';
        ELSIF COALESCE(p_course_id, p_course_category) ILIKE '%Foundation%' THEN
            SELECT id, name, is_active INTO v_course_id, v_course_name, v_course_active
            FROM public.courses WHERE id = 'foundation';
        END IF;
    END IF;

    -- Check Priority 5: Reject unresolvable courses (never insert non-existent keys like 'apex-foundation')
    IF v_course_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Invalid course selection: The selected course does not exist in the institute course catalog.'
        );
    END IF;

    -- Check Priority 6: Reject inactive courses
    IF v_course_active = false THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Selected course is currently inactive and not accepting new admission enquiries.'
        );
    END IF;

    -- Use canonical display name if available, otherwise original category text
    v_course_category := COALESCE(v_course_name, p_course_category);

    -- 7. Generate sequential human-readable enquiry ID
    SELECT 'ENQ-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD((COUNT(*) + 1)::TEXT, 4, '0')
    INTO v_enquiry_id
    FROM public.admission_enquiries
    WHERE created_at >= DATE_TRUNC('day', NOW());

    -- 8. Insert admission enquiry record with validated course_id (satisfies admission_enquiries_course_id_fkey)
    INSERT INTO public.admission_enquiries (
        id, student_id, course_id, course_category, target_examination,
        preferred_batch_timing, preferred_learning_mode, additional_message, status
    ) VALUES (
        v_enquiry_id, v_student_id, v_course_id, v_course_category, p_target_examination,
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
        jsonb_build_object(
            'phone', v_clean_phone,
            'email', v_clean_email,
            'course_id', v_course_id,
            'course_category', v_course_category,
            'assigned_counsellor_id', v_assigned_counsellor_id
        )
    );

    -- 11. Queue Event A: Student Acknowledgment Notification (Strictly Email)
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
                'course_id', v_course_id,
                'course_category', v_course_category,
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
                'course_id', v_course_id,
                'course_category', v_course_category,
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
        'course_id', v_course_id,
        'course_category', v_course_category,
        'outbox_id', v_student_outbox_id,
        'student_outbox_id', v_student_outbox_id,
        'institute_outbox_id', v_institute_outbox_id,
        'message', 'Admission enquiry registered successfully.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

-- 3. PERMISSIONS: REVOKE PUBLIC AND GRANT TO ANON, AUTHENTICATED, SERVICE_ROLE
REVOKE EXECUTE ON FUNCTION public.submit_admission_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_admission_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
