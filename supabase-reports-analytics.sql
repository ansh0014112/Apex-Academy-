-- ====================================================================
-- APEX ACADEMY — REAL DATABASE-DRIVEN REPORTS & ANALYTICS RPC
-- File: supabase-reports-analytics.sql
-- Description:
--   Computes real-time dynamic analytics for APEX ACADEMY:
--   1. Admission Enquiry Inflow (6-Month Trend) in Asia/Kolkata timezone
--   2. Counselling Booking Requests (6-Month Trend) in Asia/Kolkata timezone
--   3. Admission Enquiry Conversion Funnel (Total, Contacted, Interested, Converted, Rate)
--   4. Course Stream Share (Civil Services & SSC, Banking & Railway, Foundation Program)
--   5. Department Conversion Champions (Top active counsellors, strictly excluding Super Admin)
--   Role-aware: Super Admin views institute-wide analytics; Counsellors view their assigned scope.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.get_dashboard_analytics()
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_now TIMESTAMP WITH TIME ZONE;
    v_cur_date DATE;
    v_months JSONB := '[]'::JSONB;
    v_month_start DATE;
    v_month_end DATE;
    v_m_key TEXT;
    v_m_label TEXT;
    v_enq_count INT;
    v_bk_count INT;
    v_funnel JSONB;
    v_course_share JSONB;
    v_champions JSONB;
    v_result JSONB;
    v_total_enq INT;
    v_contacted INT;
    v_interested INT;
    v_converted INT;
    v_conv_rate NUMERIC;
    v_civil_count INT;
    v_bank_count INT;
    v_found_count INT;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    -- Standardize current time in Asia/Kolkata
    v_now := NOW() AT TIME ZONE 'Asia/Kolkata';
    v_cur_date := v_now::DATE;

    -- ================================================================
    -- 1. 6-MONTH ROLLING WINDOW (Enquiry Inflow & Booking Requests)
    -- ================================================================
    -- Generate last 6 calendar months ending at current month
    FOR i IN REVERSE 0..5 LOOP
        v_month_start := (date_trunc('month', v_cur_date) - (i || ' months')::INTERVAL)::DATE;
        v_month_end   := (date_trunc('month', v_month_start) + INTERVAL '1 month')::DATE;
        v_m_key       := to_char(v_month_start, 'YYYY-MM');
        v_m_label     := to_char(v_month_start, 'Mon');

        IF v_role = 'super_admin' THEN
            SELECT COUNT(*) INTO v_enq_count
            FROM public.admission_enquiries
            WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::DATE >= v_month_start
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::DATE < v_month_end;

            SELECT COUNT(*) INTO v_bk_count
            FROM public.counselling_bookings
            WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::DATE >= v_month_start
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::DATE < v_month_end;
        ELSE
            SELECT COUNT(*) INTO v_enq_count
            FROM public.admission_enquiries
            WHERE assigned_counsellor_id = v_uid
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::DATE >= v_month_start
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::DATE < v_month_end;

            SELECT COUNT(*) INTO v_bk_count
            FROM public.counselling_bookings
            WHERE assigned_counsellor_id = v_uid
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::DATE >= v_month_start
              AND (created_at AT TIME ZONE 'Asia/Kolkata')::DATE < v_month_end;
        END IF;

        v_months := v_months || jsonb_build_object(
            'key', v_m_key,
            'month', v_m_label,
            'enquiries', COALESCE(v_enq_count, 0),
            'bookings', COALESCE(v_bk_count, 0)
        );
    END LOOP;

    -- ================================================================
    -- 2. ADMISSION ENQUIRY CONVERSION FUNNEL
    -- ================================================================
    IF v_role = 'super_admin' THEN
        SELECT
            COUNT(*),
            COUNT(*) FILTER (WHERE status IN ('Contacted', 'Interested', 'Pending Follow-up', 'Converted', 'Not Interested')),
            COUNT(*) FILTER (WHERE status IN ('Interested', 'Pending Follow-up', 'Converted')),
            COUNT(*) FILTER (WHERE status = 'Converted')
        INTO v_total_enq, v_contacted, v_interested, v_converted
        FROM public.admission_enquiries;
    ELSE
        SELECT
            COUNT(*),
            COUNT(*) FILTER (WHERE status IN ('Contacted', 'Interested', 'Pending Follow-up', 'Converted', 'Not Interested')),
            COUNT(*) FILTER (WHERE status IN ('Interested', 'Pending Follow-up', 'Converted')),
            COUNT(*) FILTER (WHERE status = 'Converted')
        INTO v_total_enq, v_contacted, v_interested, v_converted
        FROM public.admission_enquiries
        WHERE assigned_counsellor_id = v_uid;
    END IF;

    IF v_total_enq > 0 THEN
        v_conv_rate := ROUND((v_converted::NUMERIC / v_total_enq::NUMERIC) * 100, 1);
    ELSE
        v_conv_rate := 0.0;
    END IF;

    v_funnel := jsonb_build_object(
        'totalEnquiries', COALESCE(v_total_enq, 0),
        'contacted', COALESCE(v_contacted, 0),
        'interested', COALESCE(v_interested, 0),
        'converted', COALESCE(v_converted, 0),
        'conversionRate', v_conv_rate
    );

    -- ================================================================
    -- 3. COURSE STREAM SHARE
    -- ================================================================
    IF v_role = 'super_admin' THEN
        SELECT
            COUNT(*) FILTER (WHERE course_category ILIKE '%civil%' OR course_category ILIKE '%ssc%' OR target_examination ILIKE '%upsc%' OR target_examination ILIKE '%ssc%'),
            COUNT(*) FILTER (WHERE course_category ILIKE '%bank%' OR course_category ILIKE '%railway%' OR target_examination ILIKE '%ibps%' OR target_examination ILIKE '%rrb%'),
            COUNT(*) FILTER (WHERE course_category ILIKE '%foundation%' OR target_examination ILIKE '%foundation%')
        INTO v_civil_count, v_bank_count, v_found_count
        FROM public.admission_enquiries;
    ELSE
        SELECT
            COUNT(*) FILTER (WHERE course_category ILIKE '%civil%' OR course_category ILIKE '%ssc%' OR target_examination ILIKE '%upsc%' OR target_examination ILIKE '%ssc%'),
            COUNT(*) FILTER (WHERE course_category ILIKE '%bank%' OR course_category ILIKE '%railway%' OR target_examination ILIKE '%ibps%' OR target_examination ILIKE '%rrb%'),
            COUNT(*) FILTER (WHERE course_category ILIKE '%foundation%' OR target_examination ILIKE '%foundation%')
        INTO v_civil_count, v_bank_count, v_found_count
        FROM public.admission_enquiries
        WHERE assigned_counsellor_id = v_uid;
    END IF;

    v_course_share := jsonb_build_array(
        jsonb_build_object(
            'course', 'Civil Services & SSC',
            'count', COALESCE(v_civil_count, 0),
            'percentage', CASE WHEN v_total_enq > 0 THEN ROUND((COALESCE(v_civil_count, 0)::NUMERIC / v_total_enq::NUMERIC) * 100) ELSE 0 END
        ),
        jsonb_build_object(
            'course', 'Banking & Railway',
            'count', COALESCE(v_bank_count, 0),
            'percentage', CASE WHEN v_total_enq > 0 THEN ROUND((COALESCE(v_bank_count, 0)::NUMERIC / v_total_enq::NUMERIC) * 100) ELSE 0 END
        ),
        jsonb_build_object(
            'course', 'Foundation Program',
            'count', COALESCE(v_found_count, 0),
            'percentage', CASE WHEN v_total_enq > 0 THEN ROUND((COALESCE(v_found_count, 0)::NUMERIC / v_total_enq::NUMERIC) * 100) ELSE 0 END
        )
    );

    -- ================================================================
    -- 4. DEPARTMENT CONVERSION CHAMPIONS (Strictly excluding Super Admin)
    -- ================================================================
    SELECT COALESCE(jsonb_agg(c_row), '[]'::JSONB) INTO v_champions
    FROM (
        SELECT
            p.id,
            p.full_name AS name,
            COALESCE(p.department, CASE WHEN p.role = 'admission_counsellor' THEN 'Admission Department' ELSE 'Academic Counselling Department' END) AS department,
            p.role,
            CASE
                WHEN p.role = 'academic_counsellor' THEN
                    COUNT(b.id) FILTER (WHERE b.status = 'Completed') || ' Sessions'
                WHEN COUNT(e.id) > 0 THEN
                    ROUND((COUNT(e.id) FILTER (WHERE e.status = 'Converted')::NUMERIC / COUNT(e.id)::NUMERIC) * 100) || '% Conv.'
                WHEN COUNT(b.id) FILTER (WHERE b.status = 'Completed') > 0 THEN
                    COUNT(b.id) FILTER (WHERE b.status = 'Completed') || ' Sessions'
                ELSE
                    '0% Conv.'
            END AS score_label,
            CASE
                WHEN p.role = 'academic_counsellor' THEN
                    (COUNT(b.id) FILTER (WHERE b.status = 'Completed') * 100) + COUNT(b.id)
                WHEN COUNT(e.id) > 0 THEN
                    (ROUND((COUNT(e.id) FILTER (WHERE e.status = 'Converted')::NUMERIC / COUNT(e.id)::NUMERIC) * 100) * 100) + COUNT(e.id) FILTER (WHERE e.status = 'Converted')
                ELSE 0
            END AS sort_score
        FROM public.profiles p
        LEFT JOIN public.admission_enquiries e ON e.assigned_counsellor_id = p.id
        LEFT JOIN public.counselling_bookings b ON b.assigned_counsellor_id = p.id
        WHERE p.is_active = true
          AND p.role IN ('admission_counsellor', 'academic_counsellor')
        GROUP BY p.id, p.full_name, p.department, p.role
        ORDER BY sort_score DESC, p.full_name ASC
        LIMIT 3
    ) c_row;

    v_result := jsonb_build_object(
        'success', true,
        'monthsWindow', v_months,
        'conversionFunnel', v_funnel,
        'courseWiseEnquiries', v_course_share,
        'champions', v_champions
    );

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_analytics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_analytics() TO authenticated;
