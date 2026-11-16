-- ====================================================================
-- APEX ACADEMY — ENQUIRY STATUS & FOLLOW-UP TASK PERSISTENCE REPAIR
-- File: supabase-enquiry-status-followup-fix.sql
-- Description:
--   Permanently resolves:
--     1. ENUM mismatch error on enquiry_status: "invalid input value for enum enquiry_status: 'interested'"
--        by accepting TEXT in update_enquiry_status and canonicalizing case-insensitively
--        to the exact public.enquiry_status labels ('New', 'Assigned', 'Contacted', 'Interested',
--        'Pending Follow-up', 'Converted', 'Not Interested').
--     2. Follow-up task creation & parent validation trigger issues
--        by resolving student_id directly from the parent record and enforcing strict role rules.
--     3. Provides an atomic transaction RPC `save_enquiry_lead_drawer` for simultaneous status + follow-up saves.
--
-- Deployment:
--   Execute this script in Supabase Dashboard -> SQL Editor.
-- ====================================================================

-- ── 1. DROP EXISTING OVERLOADS OF UPDATE_ENQUIRY_STATUS ─────────────────────
DROP FUNCTION IF EXISTS public.update_enquiry_status(TEXT, public.enquiry_status);
DROP FUNCTION IF EXISTS public.update_enquiry_status(TEXT, TEXT);

-- ── 2. CREATE ROBUST, CASE-INSENSITIVE UPDATE_ENQUIRY_STATUS RPC ─────────────
CREATE OR REPLACE FUNCTION public.update_enquiry_status(
    p_enquiry_id TEXT,
    p_new_status TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_enquiry RECORD;
    v_canonical_status public.enquiry_status;
    v_status_clean TEXT;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized: Authentication required.');
    END IF;

    IF p_enquiry_id IS NULL OR TRIM(p_enquiry_id) = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Enquiry ID is required.');
    END IF;

    -- Canonicalize input status to existing public.enquiry_status ENUM labels
    v_status_clean := LOWER(TRIM(COALESCE(p_new_status, '')));
    IF v_status_clean = 'new' THEN
        v_canonical_status := 'New'::public.enquiry_status;
    ELSIF v_status_clean = 'assigned' THEN
        v_canonical_status := 'Assigned'::public.enquiry_status;
    ELSIF v_status_clean = 'contacted' THEN
        v_canonical_status := 'Contacted'::public.enquiry_status;
    ELSIF v_status_clean = 'interested' THEN
        v_canonical_status := 'Interested'::public.enquiry_status;
    ELSIF v_status_clean IN ('pending follow-up', 'pending follow up', 'pending_followup', 'pending', 'follow-up', 'follow up') THEN
        v_canonical_status := 'Pending Follow-up'::public.enquiry_status;
    ELSIF v_status_clean = 'converted' THEN
        v_canonical_status := 'Converted'::public.enquiry_status;
    ELSIF v_status_clean IN ('not interested', 'not_interested', 'closed', 'rejected', 'archived') THEN
        v_canonical_status := 'Not Interested'::public.enquiry_status;
    ELSE
        RETURN jsonb_build_object(
            'success', false,
            'message', 'Invalid enquiry status: "' || p_new_status || '". Permitted values: New, Assigned, Contacted, Interested, Pending Follow-up, Converted, Not Interested'
        );
    END IF;

    -- Fetch enquiry record
    SELECT * INTO v_enquiry FROM public.admission_enquiries WHERE id = TRIM(p_enquiry_id);
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Admission enquiry not found.');
    END IF;

    -- Role-based access control
    IF v_role = 'admission_counsellor' THEN
        IF v_enquiry.assigned_counsellor_id IS NULL THEN
            -- Auto-assign unassigned enquiry to the active counsellor updating it
            UPDATE public.admission_enquiries
            SET assigned_counsellor_id = v_uid, updated_at = NOW()
            WHERE id = v_enquiry.id;
            v_enquiry.assigned_counsellor_id := v_uid;
        ELSIF v_enquiry.assigned_counsellor_id IS DISTINCT FROM v_uid THEN
            RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only update enquiries assigned to you.');
        END IF;
    ELSIF v_role = 'academic_counsellor' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: Academic counsellors cannot update admission enquiry status.');
    END IF;

    -- Update enquiry status
    UPDATE public.admission_enquiries
    SET status = v_canonical_status,
        updated_at = NOW()
    WHERE id = v_enquiry.id;

    -- Internal activity log
    PERFORM public.internal_log_activity(
        v_uid, (SELECT full_name FROM public.profiles WHERE id = v_uid), v_role::TEXT,
        'enquiry_status_updated',
        'Enquiry ' || v_enquiry.id || ' status updated to ' || v_canonical_status::TEXT,
        'admission_enquiry', v_enquiry.id,
        jsonb_build_object('new_status', v_canonical_status::TEXT, 'previous_status', v_enquiry.status::TEXT)
    );

    RETURN jsonb_build_object(
        'success', true,
        'enquiry_id', v_enquiry.id,
        'status', v_canonical_status::TEXT,
        'message', 'Enquiry status updated to ' || v_canonical_status::TEXT
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.update_enquiry_status(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_enquiry_status(TEXT, TEXT) TO authenticated;


-- ── 3. ROBUST CREATE_FOLLOW_UP RPC (WITH PARENT VALIDATION & AUTO-LOOKUP) ─────
CREATE OR REPLACE FUNCTION public.create_follow_up(
    p_student_id UUID DEFAULT NULL,
    p_enquiry_id TEXT DEFAULT NULL,
    p_booking_id TEXT DEFAULT NULL,
    p_follow_up_date DATE DEFAULT NULL,
    p_follow_up_time TEXT DEFAULT NULL,
    p_follow_up_type TEXT DEFAULT 'Telephonic Consultation',
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_student_id UUID;
    v_assigned_to UUID;
    v_follow_up_id UUID;
    v_enq RECORD;
    v_bk RECORD;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized: Authentication required.');
    END IF;

    IF p_follow_up_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Follow-up date is required.');
    END IF;

    -- 1. Resolve parent from Admission Enquiry
    IF p_enquiry_id IS NOT NULL AND TRIM(p_enquiry_id) <> '' THEN
        SELECT * INTO v_enq FROM public.admission_enquiries WHERE id = TRIM(p_enquiry_id);
        IF NOT FOUND THEN
            RETURN jsonb_build_object('success', false, 'message', 'Referenced admission enquiry does not exist.');
        END IF;
        v_student_id := v_enq.student_id;

        IF v_role = 'admission_counsellor' THEN
            IF v_enq.assigned_counsellor_id IS NULL THEN
                UPDATE public.admission_enquiries SET assigned_counsellor_id = v_uid, updated_at = NOW() WHERE id = v_enq.id;
                v_assigned_to := v_uid;
            ELSIF v_enq.assigned_counsellor_id IS DISTINCT FROM v_uid THEN
                RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only schedule follow-ups for enquiries assigned to you.');
            ELSE
                v_assigned_to := v_uid;
            END IF;
        ELSIF v_role = 'super_admin' THEN
            v_assigned_to := COALESCE(v_enq.assigned_counsellor_id, v_uid);
        ELSE
            RETURN jsonb_build_object('success', false, 'message', 'Access Denied: Academic counsellors cannot schedule follow-ups for admission enquiries.');
        END IF;

    -- 2. Resolve parent from Counselling Booking
    ELSIF p_booking_id IS NOT NULL AND TRIM(p_booking_id) <> '' THEN
        SELECT * INTO v_bk FROM public.counselling_bookings WHERE id = TRIM(p_booking_id);
        IF NOT FOUND THEN
            RETURN jsonb_build_object('success', false, 'message', 'Referenced counselling booking does not exist.');
        END IF;
        v_student_id := v_bk.student_id;

        IF v_role = 'academic_counsellor' THEN
            IF v_bk.assigned_counsellor_id IS NULL THEN
                UPDATE public.counselling_bookings SET assigned_counsellor_id = v_uid, updated_at = NOW() WHERE id = v_bk.id;
                v_assigned_to := v_uid;
            ELSIF v_bk.assigned_counsellor_id IS DISTINCT FROM v_uid THEN
                RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only schedule follow-ups for bookings assigned to you.');
            ELSE
                v_assigned_to := v_uid;
            END IF;
        ELSIF v_role = 'super_admin' THEN
            v_assigned_to := COALESCE(v_bk.assigned_counsellor_id, v_uid);
        ELSE
            RETURN jsonb_build_object('success', false, 'message', 'Access Denied: Admission counsellors cannot schedule follow-ups for academic counselling bookings.');
        END IF;

    -- 3. Fallback direct student reference (must provide either enquiry or booking for chk_followup_parent)
    ELSIF p_student_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Follow-up must be linked to either an Admission Enquiry or a Counselling Booking.');
    ELSE
        RETURN jsonb_build_object('success', false, 'message', 'Follow-up must specify an Admission Enquiry ID or Booking ID.');
    END IF;

    IF v_student_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unable to resolve student record for this lead.');
    END IF;

    -- Insert follow-up record
    INSERT INTO public.follow_ups (
        student_id, enquiry_id, booking_id, assigned_to,
        follow_up_date, follow_up_time, follow_up_type, notes, status
    ) VALUES (
        v_student_id,
        NULLIF(TRIM(p_enquiry_id), ''),
        NULLIF(TRIM(p_booking_id), ''),
        v_assigned_to,
        p_follow_up_date,
        p_follow_up_time,
        COALESCE(NULLIF(TRIM(p_follow_up_type), ''), 'Telephonic Consultation'),
        p_notes,
        'pending'
    ) RETURNING id INTO v_follow_up_id;

    -- Log activity
    PERFORM public.internal_log_activity(
        v_uid, (SELECT full_name FROM public.profiles WHERE id = v_uid), v_role::TEXT,
        'followup_scheduled',
        'Follow-up scheduled for ' || p_follow_up_date::TEXT || COALESCE(' (' || p_notes || ')', ''),
        CASE WHEN p_enquiry_id IS NOT NULL THEN 'admission_enquiry' ELSE 'counselling_booking' END,
        COALESCE(p_enquiry_id, p_booking_id),
        jsonb_build_object(
            'follow_up_id', v_follow_up_id,
            'follow_up_date', p_follow_up_date,
            'assigned_to', v_assigned_to
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'follow_up_id', v_follow_up_id,
        'assigned_to', v_assigned_to,
        'message', 'Follow-up task scheduled successfully.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.create_follow_up(UUID, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_follow_up(UUID, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) TO authenticated;


-- ── 4. ATOMIC RPC FOR LEAD STATUS & FOLLOW-UP DRAWER SAVE ───────────────────
CREATE OR REPLACE FUNCTION public.save_enquiry_lead_drawer(
    p_enquiry_id TEXT,
    p_status TEXT DEFAULT NULL,
    p_counsellor_id UUID DEFAULT NULL,
    p_follow_up_date DATE DEFAULT NULL,
    p_follow_up_notes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_status_res JSONB;
    v_fu_res JSONB;
    v_reassign_res JSONB;
    v_role public.app_role;
    v_follow_up_id UUID := NULL;
    v_updated_status TEXT := NULL;
BEGIN
    v_role := public.current_user_role();
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized: Authentication required.');
    END IF;

    -- 1. Reassign counsellor if requested (Super Admin only)
    IF p_counsellor_id IS NOT NULL THEN
        IF v_role <> 'super_admin' THEN
            RETURN jsonb_build_object('success', false, 'message', 'Unauthorized: Only Super Admins can reassign admission enquiries.');
        END IF;
        v_reassign_res := public.reassign_admission_enquiry(p_enquiry_id, p_counsellor_id);
        IF NOT (v_reassign_res->>'success')::BOOLEAN THEN
            RETURN v_reassign_res;
        END IF;
    END IF;

    -- 2. Update status if requested
    IF p_status IS NOT NULL AND TRIM(p_status) <> '' THEN
        v_status_res := public.update_enquiry_status(p_enquiry_id, p_status);
        IF NOT (v_status_res->>'success')::BOOLEAN THEN
            RETURN v_status_res;
        END IF;
        v_updated_status := v_status_res->>'status';
    END IF;

    -- 3. Create follow-up task if date is provided
    IF p_follow_up_date IS NOT NULL THEN
        v_fu_res := public.create_follow_up(
            NULL,
            p_enquiry_id,
            NULL,
            p_follow_up_date,
            NULL,
            'Telephonic Consultation',
            COALESCE(NULLIF(TRIM(p_follow_up_notes), ''), 'Telephonic Follow-up Consultation')
        );
        IF NOT (v_fu_res->>'success')::BOOLEAN THEN
            RETURN v_fu_res;
        END IF;
        v_follow_up_id := (v_fu_res->>'follow_up_id')::UUID;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'enquiry_id', p_enquiry_id,
        'status', v_updated_status,
        'follow_up_id', v_follow_up_id,
        'message', 'Lead changes saved successfully.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.save_enquiry_lead_drawer(TEXT, TEXT, UUID, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_enquiry_lead_drawer(TEXT, TEXT, UUID, DATE, TEXT) TO authenticated;


-- ── 5. GET_DASHBOARD_FOLLOW_UPS RPC (WITH FULL JOIN METADATA) ───────────────
CREATE OR REPLACE FUNCTION public.get_dashboard_follow_ups()
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_result JSONB;
BEGIN
    v_uid := auth.uid();
    v_role := public.current_user_role();
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized: Authentication required.');
    END IF;

    SELECT jsonb_build_object(
        'success', true,
        'data', COALESCE(jsonb_agg(row_to_json(fq) ORDER BY fq.follow_up_date ASC), '[]'::jsonb)
    ) INTO v_result
    FROM (
        SELECT f.id, f.student_id, s.full_name AS student_name, s.phone AS student_phone,
               f.enquiry_id, f.booking_id, f.assigned_to,
               p.full_name AS counsellor_name, f.follow_up_date, f.follow_up_time,
               f.follow_up_type, f.notes, f.status::TEXT, f.completed_at, f.created_at
        FROM public.follow_ups f
        JOIN public.students s ON s.id = f.student_id
        LEFT JOIN public.profiles p ON p.id = f.assigned_to
        WHERE v_role = 'super_admin' OR f.assigned_to = v_uid
        ORDER BY f.follow_up_date ASC
        LIMIT 250
    ) fq;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_follow_ups() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_follow_ups() TO authenticated;
