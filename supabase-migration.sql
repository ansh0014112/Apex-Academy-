-- =============================================================================
-- APEX ACADEMY — PRODUCTION DATABASE ARCHITECTURE & ZERO-TRUST SECURITY
-- Initial Consolidated Migration for Clean/Empty Supabase Project
-- Retry-Safe & Idempotent (Safe to run or rerun without duplicate errors)
-- Generated: 2026-11-10
-- Target: PostgreSQL 15+ / Supabase Engine
-- =============================================================================

-- Ensure required PostgreSQL extensions are active
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 1. ENUMS AND DOMAIN TYPES
-- =============================================================================
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
        CREATE TYPE public.app_role AS ENUM (
            'super_admin',
            'admission_counsellor',
            'academic_counsellor'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enquiry_status') THEN
        CREATE TYPE public.enquiry_status AS ENUM (
            'New',
            'Assigned',
            'Contacted',
            'Interested',
            'Pending Follow-up',
            'Converted',
            'Not Interested'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_status') THEN
        CREATE TYPE public.booking_status AS ENUM (
            'Pending',
            'Assigned',
            'Confirmed',
            'Completed',
            'Cancelled',
            'No-show'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'follow_up_status') THEN
        CREATE TYPE public.follow_up_status AS ENUM (
            'pending',
            'completed',
            'cancelled'
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_type') THEN
        CREATE TYPE public.notification_type AS ENUM (
            'assignment',
            'status_change',
            'booking_confirmation',
            'reschedule',
            'followup_due',
            'system'
        );
    END IF;
END $$;

-- =============================================================================
-- 2. SEQUENCES FOR HUMAN-READABLE CODES
-- =============================================================================
CREATE SEQUENCE IF NOT EXISTS public.seq_admission_enquiry_id START WITH 1001;
CREATE SEQUENCE IF NOT EXISTS public.seq_counselling_booking_id START WITH 1001;

-- =============================================================================
-- 3. PROFILES TABLE (Staff, Counsellors & Administrators)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL CHECK (LENGTH(TRIM(full_name)) >= 2),
    email TEXT UNIQUE NOT NULL CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    role public.app_role,
    department TEXT NOT NULL DEFAULT 'General Administration',
    specialisation TEXT,
    daily_capacity INTEGER NOT NULL DEFAULT 10 CHECK (daily_capacity >= 1 AND daily_capacity <= 50),
    phone TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_active ON public.profiles(is_active);

-- Automatic Profile Provisioning Trigger on auth.users
-- Automatically provisions an administrative profile in public.profiles whenever a new user is created in Supabase Auth.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER AS $$
DECLARE
    v_role public.app_role := NULL;
    v_raw_role TEXT;
BEGIN
    -- Read role explicitly from user metadata if provided
    v_raw_role := LOWER(TRIM(COALESCE(
        NEW.raw_user_meta_data->>'role',
        NEW.raw_app_meta_data->>'role'
    )));
    
    IF v_raw_role IN ('super_admin', 'admission_counsellor', 'academic_counsellor') THEN
        v_role := v_raw_role::public.app_role;
    END IF;

    INSERT INTO public.profiles (
        id,
        email,
        full_name,
        role,
        department,
        is_active,
        daily_capacity
    )
    VALUES (
        NEW.id,
        LOWER(TRIM(NEW.email)),
        COALESCE(
            NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
            NULLIF(TRIM(NEW.raw_user_meta_data->>'name'), ''),
            INITCAP(SPLIT_PART(NEW.email, '@', 1))
        ),
        v_role, -- Explicit role from metadata, or NULL (awaiting admin assignment)
        COALESCE(
            NULLIF(TRIM(NEW.raw_user_meta_data->>'department'), ''),
            CASE 
                WHEN v_role = 'super_admin' THEN 'Executive Administration'
                WHEN v_role = 'academic_counsellor' THEN 'Academic Counselling Department'
                WHEN v_role = 'admission_counsellor' THEN 'Admission Department'
                ELSE 'General Administration'
            END
        ),
        true,
        10
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        updated_at = NOW();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Self-Healing Profile Synchronization RPC
-- Allows authenticated staff to retrieve (and if missing, auto-provision) their administrative profile.
CREATE OR REPLACE FUNCTION public.get_or_sync_current_profile()
RETURNS TABLE (
    id UUID,
    full_name TEXT,
    email TEXT,
    role public.app_role,
    department TEXT,
    specialisation TEXT,
    daily_capacity INTEGER,
    phone TEXT,
    is_active BOOLEAN
) AS $$
DECLARE
    v_uid UUID;
    v_email TEXT;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RETURN;
    END IF;

    -- If profile does not exist, check if user exists in auth.users and provision
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE public.profiles.id = v_uid) THEN
        SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_uid;
        
        IF v_email IS NOT NULL THEN
            INSERT INTO public.profiles (
                id,
                email,
                full_name,
                role,
                department,
                is_active,
                daily_capacity
            )
            VALUES (
                v_uid,
                LOWER(TRIM(v_email)),
                INITCAP(SPLIT_PART(v_email, '@', 1)),
                NULL, -- Explicitly NULL until admin assigns
                'General Administration',
                true,
                10
            )
            ON CONFLICT (id) DO NOTHING;
        END IF;
    END IF;

    RETURN QUERY
    SELECT p.id, p.full_name, p.email, p.role, p.department, p.specialisation, p.daily_capacity, p.phone, p.is_active
    FROM public.profiles p
    WHERE p.id = v_uid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_or_sync_current_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_or_sync_current_profile() TO authenticated;

-- Trusted Role Retrieval Helper Function
-- Returns verified role ONLY if user is authenticated and is_active = true.
-- If account is deactivated (is_active = false) or missing, returns NULL.
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS public.app_role AS $$
DECLARE
    v_role public.app_role;
    v_active BOOLEAN;
BEGIN
    SELECT role, is_active INTO v_role, v_active
    FROM public.profiles
    WHERE id = auth.uid();

    IF v_active IS NOT TRUE THEN
        RETURN NULL;
    END IF;

    RETURN v_role;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;

-- Limited Staff Directory RPC Function
-- Exposes ONLY non-sensitive operational fields (id, full_name, role, department, specialisation, is_active).
-- Protects private personal staff email addresses and phone numbers.
CREATE OR REPLACE FUNCTION public.get_staff_directory()
RETURNS TABLE (
    id UUID,
    full_name TEXT,
    role public.app_role,
    department TEXT,
    specialisation TEXT,
    is_active BOOLEAN
) AS $$
BEGIN
    IF public.current_user_role() IS NULL THEN
        RAISE EXCEPTION 'Access Denied: Active staff authentication required.';
    END IF;

    RETURN QUERY
    SELECT p.id, p.full_name, p.role, p.department, p.specialisation, p.is_active
    FROM public.profiles p
    WHERE p.is_active = true
    ORDER BY p.full_name ASC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_staff_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_staff_directory() TO authenticated;

-- Trigger Function: Protect Privileged Profile Fields
-- Prevents ordinary staff from modifying role, is_active, or daily_capacity.
-- Replaces recursive subqueries in RLS with a direct, reliable BEFORE UPDATE check.
-- Permits service_role and database administrators (where auth.uid() is NULL) and Super Admin to update.
CREATE OR REPLACE FUNCTION public.protect_profile_privileged_fields()
RETURNS TRIGGER AS $$
BEGIN
    -- Only enforce restrictions for ordinary authenticated staff through client APIs (where auth.uid() is not null)
    IF auth.uid() IS NOT NULL AND public.current_user_role() IS DISTINCT FROM 'super_admin' THEN
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'Unauthorized: Ordinary staff cannot alter their assigned role.';
        END IF;
        IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
            RAISE EXCEPTION 'Unauthorized: Ordinary staff cannot alter their account active status.';
        END IF;
        IF NEW.daily_capacity IS DISTINCT FROM OLD.daily_capacity THEN
            RAISE EXCEPTION 'Unauthorized: Ordinary staff cannot alter their daily capacity limit.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_protect_profile_fields ON public.profiles;
CREATE TRIGGER trg_protect_profile_fields
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileged_fields();

-- Safe Helper Function for Assigning Admin Roles
-- Super Admin or database administrator can call this helper to immediately link any email to its correct role.
-- Also auto-provisions default availability slots if role is academic_counsellor.
CREATE OR REPLACE FUNCTION public.assign_admin_role(
    p_email TEXT,
    p_role public.app_role,
    p_department TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_target_id UUID;
    v_dept TEXT;
    v_day INT;
BEGIN
    -- 1. Find profile by email (case-insensitive)
    SELECT id INTO v_target_id 
    FROM public.profiles 
    WHERE LOWER(TRIM(email)) = LOWER(TRIM(p_email));

    -- If profile doesn't exist yet, check auth.users and create matching profile
    IF v_target_id IS NULL THEN
        SELECT id INTO v_target_id 
        FROM auth.users 
        WHERE LOWER(TRIM(email)) = LOWER(TRIM(p_email));
        
        IF v_target_id IS NULL THEN
            RETURN jsonb_build_object(
                'success', false, 
                'message', 'User with email ' || p_email || ' not found in Authentication users. Please create the user first in Supabase Auth.'
            );
        END IF;

        INSERT INTO public.profiles (
            id, email, full_name, role, department, is_active, daily_capacity
        ) VALUES (
            v_target_id,
            LOWER(TRIM(p_email)),
            INITCAP(SPLIT_PART(p_email, '@', 1)),
            p_role,
            COALESCE(p_department, CASE 
                WHEN p_role = 'super_admin' THEN 'Executive Administration'
                WHEN p_role = 'academic_counsellor' THEN 'Academic Counselling Department'
                WHEN p_role = 'admission_counsellor' THEN 'Admission Department'
                ELSE 'General Administration'
            END),
            true,
            10
        );
    ELSE
        -- 2. Update existing profile role & department
        v_dept := COALESCE(p_department, CASE 
            WHEN p_role = 'super_admin' THEN 'Executive Administration'
            WHEN p_role = 'academic_counsellor' THEN 'Academic Counselling Department'
            WHEN p_role = 'admission_counsellor' THEN 'Admission Department'
            ELSE 'General Administration'
        END);

        UPDATE public.profiles
        SET 
            role = p_role,
            department = v_dept,
            is_active = true,
            updated_at = NOW()
        WHERE id = v_target_id;
    END IF;

    -- 3. If role is academic_counsellor, ensure baseline availability slots exist for Monday-Saturday
    IF p_role = 'academic_counsellor' THEN
        FOR v_day IN 1..6 LOOP
            INSERT INTO public.counsellor_availability (
                counsellor_id, day_of_week, start_time, end_time, slot_duration_minutes, is_available, is_active
            ) VALUES (
                v_target_id, v_day, '09:00:00'::TIME, '20:30:00'::TIME, 30, true, true
            ) ON CONFLICT (counsellor_id, day_of_week, start_time, end_time) DO NOTHING;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Role successfully assigned to ' || p_email || ' as ' || p_role::TEXT,
        'profile_id', v_target_id,
        'role', p_role::TEXT
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.assign_admin_role(TEXT, public.app_role, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_admin_role(TEXT, public.app_role, TEXT) TO service_role, postgres;

-- =============================================================================
-- 4. CENTRAL STUDENTS TABLE (Deduplicated Aspirant Repository)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name TEXT NOT NULL CHECK (LENGTH(TRIM(full_name)) >= 2),
    phone TEXT CHECK (phone IS NULL OR (LENGTH(phone) = 10 AND phone ~ '^[0-9]+$')),
    email TEXT CHECK (email IS NULL OR email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    qualification TEXT,
    academic_background TEXT,
    city TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_student_contact CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_students_phone ON public.students(phone);
CREATE INDEX IF NOT EXISTS idx_students_email ON public.students(email);
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_phone ON public.students(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_email ON public.students(email) WHERE email IS NOT NULL;

-- Internal Student Deduplication & Normalization Function
-- Strictly private: Executable ONLY by trusted internal database functions.
-- Direct execution by anon and authenticated users is revoked.
CREATE OR REPLACE FUNCTION public.get_or_create_student(
    p_full_name TEXT,
    p_phone TEXT,
    p_email TEXT,
    p_qualification TEXT DEFAULT NULL,
    p_academic_background TEXT DEFAULT NULL,
    p_city TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_clean_phone TEXT := NULL;
    v_clean_email TEXT := NULL;
    v_student_id UUID;
    v_phone_match_id UUID;
    v_email_match_id UUID;
BEGIN
    -- Input Validation
    IF p_full_name IS NULL OR LENGTH(TRIM(p_full_name)) < 2 THEN
        RAISE EXCEPTION 'Invalid student name provided: Full name must contain at least 2 characters.';
    END IF;

    -- Normalize Phone Number (if provided)
    IF p_phone IS NOT NULL AND LENGTH(TRIM(p_phone)) > 0 THEN
        v_clean_phone := REGEXP_REPLACE(p_phone, '[^0-9]', '', 'g');
        IF LENGTH(v_clean_phone) > 10 THEN
            v_clean_phone := SUBSTRING(v_clean_phone FROM LENGTH(v_clean_phone)-9 FOR 10);
        END IF;
        IF LENGTH(v_clean_phone) != 10 THEN
            RAISE EXCEPTION 'Phone number must contain exactly 10 digits.';
        END IF;
    END IF;

    -- Normalize Email Address (if provided)
    IF p_email IS NOT NULL AND LENGTH(TRIM(p_email)) > 0 THEN
        v_clean_email := LOWER(TRIM(p_email));
        IF v_clean_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
            RAISE EXCEPTION 'Invalid email address format.';
        END IF;
    END IF;

    -- Enforce Contact Requirement
    IF v_clean_phone IS NULL AND v_clean_email IS NULL THEN
        RAISE EXCEPTION 'Either a valid 10-digit mobile phone or email address must be provided.';
    END IF;

    -- Acquire transactional advisory lock to prevent race conditions during concurrent submissions
    PERFORM pg_advisory_xact_lock(hashtext(COALESCE(v_clean_phone, v_clean_email)));

    -- Check match on phone and email
    IF v_clean_phone IS NOT NULL THEN
        SELECT id INTO v_phone_match_id FROM public.students WHERE phone = v_clean_phone LIMIT 1;
    END IF;
    IF v_clean_email IS NOT NULL THEN
        SELECT id INTO v_email_match_id FROM public.students WHERE email = v_clean_email LIMIT 1;
    END IF;

    -- Case A: Both phone and email match the exact same student profile
    IF v_phone_match_id IS NOT NULL AND v_email_match_id IS NOT NULL THEN
        IF v_phone_match_id = v_email_match_id THEN
            UPDATE public.students
            SET qualification = COALESCE(p_qualification, qualification),
                academic_background = COALESCE(p_academic_background, academic_background),
                city = COALESCE(p_city, city),
                updated_at = NOW()
            WHERE id = v_phone_match_id;
            RETURN v_phone_match_id;
        ELSE
            -- Conflict: Phone belongs to Student A, but Email belongs to Student B!
            -- Prevent silent merging. Raise an explicit error.
            RAISE EXCEPTION 'Student identity conflict: Mobile number matches existing student % but email matches student %. Records cannot be merged automatically.', v_phone_match_id, v_email_match_id;
        END IF;
    END IF;

    -- Case B: Only phone matches existing student
    IF v_phone_match_id IS NOT NULL THEN
        UPDATE public.students
        SET email = COALESCE(email, v_clean_email),
            qualification = COALESCE(p_qualification, qualification),
            academic_background = COALESCE(p_academic_background, academic_background),
            city = COALESCE(p_city, city),
            updated_at = NOW()
        WHERE id = v_phone_match_id;
        RETURN v_phone_match_id;
    END IF;

    -- Case C: Only email matches existing student
    IF v_email_match_id IS NOT NULL THEN
        UPDATE public.students
        SET phone = COALESCE(phone, v_clean_phone),
            qualification = COALESCE(p_qualification, qualification),
            academic_background = COALESCE(p_academic_background, academic_background),
            city = COALESCE(p_city, city),
            updated_at = NOW()
        WHERE id = v_email_match_id;
        RETURN v_email_match_id;
    END IF;

    -- Case D: New student record
    INSERT INTO public.students (full_name, phone, email, qualification, academic_background, city)
    VALUES (TRIM(p_full_name), v_clean_phone, v_clean_email, p_qualification, p_academic_background, p_city)
    RETURNING id INTO v_student_id;

    RETURN v_student_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

-- Revoke direct execution from public, anon, and authenticated users
-- (Only trusted internal functions like submit_admission_enquiry can invoke this)
REVOKE EXECUTE ON FUNCTION public.get_or_create_student(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 5. COURSES AND BATCHES TABLES
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.courses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    examination_list TEXT[] DEFAULT '{}',
    base_fee NUMERIC(10, 2) DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    course_id TEXT NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
    batch_name TEXT NOT NULL,
    start_date DATE NOT NULL,
    timing_slot TEXT NOT NULL,
    learning_mode TEXT NOT NULL DEFAULT 'Offline Classroom',
    fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    seat_capacity INTEGER NOT NULL DEFAULT 40 CHECK (seat_capacity > 0),
    enrolled_count INTEGER NOT NULL DEFAULT 0 CHECK (enrolled_count >= 0),
    is_admission_open BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_batches_course_name UNIQUE (course_id, batch_name)
);

CREATE INDEX IF NOT EXISTS idx_batches_course ON public.batches(course_id);
CREATE INDEX IF NOT EXISTS idx_batches_open ON public.batches(is_admission_open);

-- =============================================================================
-- 6. ADMISSION ENQUIRIES TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.admission_enquiries (
    id TEXT PRIMARY KEY DEFAULT ('ENQ-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(NEXTVAL('public.seq_admission_enquiry_id')::TEXT, 5, '0')),
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT,
    course_category TEXT NOT NULL,
    target_examination TEXT NOT NULL,
    preferred_batch_timing TEXT NOT NULL,
    preferred_learning_mode TEXT NOT NULL,
    additional_message TEXT,
    status public.enquiry_status NOT NULL DEFAULT 'New',
    priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
    source TEXT NOT NULL DEFAULT 'Website Enquiry Form',
    assigned_counsellor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enquiries_student ON public.admission_enquiries(student_id);
CREATE INDEX IF NOT EXISTS idx_enquiries_course ON public.admission_enquiries(course_id);
CREATE INDEX IF NOT EXISTS idx_enquiries_counsellor ON public.admission_enquiries(assigned_counsellor_id);
CREATE INDEX IF NOT EXISTS idx_enquiries_status ON public.admission_enquiries(status);
CREATE INDEX IF NOT EXISTS idx_enquiries_created ON public.admission_enquiries(created_at DESC);

-- =============================================================================
-- 7. COUNSELLING BOOKINGS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.counselling_bookings (
    id TEXT PRIMARY KEY DEFAULT ('BK-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(NEXTVAL('public.seq_counselling_booking_id')::TEXT, 5, '0')),
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT,
    course_category TEXT NOT NULL,
    target_examination TEXT NOT NULL,
    preferred_date DATE NOT NULL,
    preferred_time TEXT NOT NULL,
    session_medium TEXT NOT NULL DEFAULT 'Google Meet HD Video Call' CHECK (
        session_medium IN ('Google Meet HD Video Call', 'Direct Telephonic Call (Audio)', 'Campus In-Person Counselling')
    ),
    google_meet_link TEXT CHECK (google_meet_link IS NULL OR google_meet_link ~* '^https?://meet\.google\.com/'),
    assigned_counsellor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    status public.booking_status NOT NULL DEFAULT 'Pending',
    counselling_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_counselling_student ON public.counselling_bookings(student_id);
CREATE INDEX IF NOT EXISTS idx_counselling_course ON public.counselling_bookings(course_id);
CREATE INDEX IF NOT EXISTS idx_counselling_counsellor ON public.counselling_bookings(assigned_counsellor_id);



-- Prevent double-booking: same counsellor, same date, same time slot for active bookings

CREATE UNIQUE INDEX IF NOT EXISTS idx_no_double_booking

ON public.counselling_bookings (assigned_counsellor_id, preferred_date, preferred_time)

WHERE status IN ('Assigned', 'Confirmed') AND assigned_counsellor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_counselling_date ON public.counselling_bookings(preferred_date);
CREATE INDEX IF NOT EXISTS idx_counselling_status ON public.counselling_bookings(status);

-- =============================================================================
-- 8. BOOKING RESCHEDULE HISTORY TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.booking_reschedule_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id TEXT NOT NULL REFERENCES public.counselling_bookings(id) ON DELETE CASCADE,
    rescheduled_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    previous_date DATE NOT NULL,
    previous_time TEXT NOT NULL,
    new_date DATE NOT NULL,
    new_time TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reschedule_booking ON public.booking_reschedule_history(booking_id);

-- =============================================================================
-- 9. INTERNAL NOTES TABLES (Admission Enquiries & Academic Bookings)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.enquiry_notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enquiry_id TEXT NOT NULL REFERENCES public.admission_enquiries(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    note_text TEXT NOT NULL CHECK (LENGTH(TRIM(note_text)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enq_notes_parent ON public.enquiry_notes(enquiry_id);

CREATE TABLE IF NOT EXISTS public.booking_notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id TEXT NOT NULL REFERENCES public.counselling_bookings(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    note_text TEXT NOT NULL CHECK (LENGTH(TRIM(note_text)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bk_notes_parent ON public.booking_notes(booking_id);

-- =============================================================================
-- 10. FOLLOW-UPS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.follow_ups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    enquiry_id TEXT REFERENCES public.admission_enquiries(id) ON DELETE CASCADE,
    booking_id TEXT REFERENCES public.counselling_bookings(id) ON DELETE CASCADE,
    assigned_to UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    follow_up_date DATE NOT NULL,
    follow_up_time TEXT,
    follow_up_type TEXT DEFAULT 'Telephonic Consultation',
    notes TEXT,
    status public.follow_up_status NOT NULL DEFAULT 'pending',
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_followup_parent CHECK (
        (enquiry_id IS NOT NULL AND booking_id IS NULL) OR
        (enquiry_id IS NULL AND booking_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_followups_assigned ON public.follow_ups(assigned_to);
CREATE INDEX IF NOT EXISTS idx_followups_date ON public.follow_ups(follow_up_date);
CREATE INDEX IF NOT EXISTS idx_followups_status ON public.follow_ups(status);

-- Trigger: Validate student and parent record consistency for follow-ups
CREATE OR REPLACE FUNCTION public.validate_follow_up_parent()
RETURNS TRIGGER
SECURITY DEFINER
AS $$
DECLARE
    v_parent_student_id UUID;
BEGIN
    IF NEW.enquiry_id IS NOT NULL THEN
        SELECT student_id INTO v_parent_student_id FROM public.admission_enquiries WHERE id = NEW.enquiry_id;
        IF v_parent_student_id IS NULL THEN
            RAISE EXCEPTION 'Referenced admission enquiry does not exist.';
        END IF;
        IF NEW.student_id IS DISTINCT FROM v_parent_student_id THEN
            RAISE EXCEPTION 'Follow-up student_id (%) does not match enquiry student_id (%).', NEW.student_id, v_parent_student_id;
        END IF;
    ELSIF NEW.booking_id IS NOT NULL THEN
        SELECT student_id INTO v_parent_student_id FROM public.counselling_bookings WHERE id = NEW.booking_id;
        IF v_parent_student_id IS NULL THEN
            RAISE EXCEPTION 'Referenced counselling booking does not exist.';
        END IF;
        IF NEW.student_id IS DISTINCT FROM v_parent_student_id THEN
            RAISE EXCEPTION 'Follow-up student_id (%) does not match booking student_id (%).', NEW.student_id, v_parent_student_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_validate_followup_parent ON public.follow_ups;
CREATE TRIGGER trg_validate_followup_parent
BEFORE INSERT OR UPDATE ON public.follow_ups
FOR EACH ROW EXECUTE FUNCTION public.validate_follow_up_parent();

-- Trigger: Prevent Ordinary Counsellors from Reassigning Follow-Ups
CREATE OR REPLACE FUNCTION public.protect_followup_assignment()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'UPDATE') THEN
        IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND public.current_user_role() IS DISTINCT FROM 'super_admin' THEN
            RAISE EXCEPTION 'Unauthorized: Only Super Admins can reassign follow-ups to another staff member.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_protect_followup_assignment ON public.follow_ups;
CREATE TRIGGER trg_protect_followup_assignment
BEFORE UPDATE ON public.follow_ups
FOR EACH ROW EXECUTE FUNCTION public.protect_followup_assignment();

-- =============================================================================
-- 11. COUNSELLOR AVAILABILITY TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.counsellor_availability (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    counsellor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sunday, 6=Saturday
    start_time TIME NOT NULL DEFAULT '09:00:00',
    end_time TIME NOT NULL DEFAULT '20:30:00',
    slot_duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_duration_minutes BETWEEN 15 AND 180),
    is_available BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_availability_times CHECK (end_time > start_time),
    CONSTRAINT uq_counsellor_slot UNIQUE (counsellor_id, day_of_week, start_time, end_time)
);

CREATE INDEX IF NOT EXISTS idx_availability_counsellor ON public.counsellor_availability(counsellor_id, day_of_week);

-- Trigger: Ensure availability is only configured for active counsellor profiles
CREATE OR REPLACE FUNCTION public.validate_counsellor_availability()
RETURNS TRIGGER
SECURITY DEFINER
AS $$
DECLARE
    v_role public.app_role;
    v_active BOOLEAN;
BEGIN
    SELECT role, is_active INTO v_role, v_active
    FROM public.profiles
    WHERE id = NEW.counsellor_id;

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'Referenced staff profile does not exist.';
    END IF;

    IF v_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Cannot configure availability for a deactivated staff member.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_validate_counsellor_availability ON public.counsellor_availability;
CREATE TRIGGER trg_validate_counsellor_availability
BEFORE INSERT OR UPDATE ON public.counsellor_availability
FOR EACH ROW EXECUTE FUNCTION public.validate_counsellor_availability();

-- =============================================================================
-- 12. IN-APP NOTIFICATIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    notification_type public.notification_type NOT NULL DEFAULT 'system',
    related_record_id TEXT,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON public.notifications(recipient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON public.notifications(recipient_id, is_read) WHERE is_read = false;

-- =============================================================================
-- 13. TUTORIAL PROGRESS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.tutorial_progress (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    tutorial_key TEXT NOT NULL,
    is_completed BOOLEAN NOT NULL DEFAULT true,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_user_tutorial UNIQUE (user_id, tutorial_key)
);

-- =============================================================================
-- 14. IMMUTABLE AUDIT LOGS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.activity_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action_type TEXT NOT NULL,
    description TEXT NOT NULL,
    target_entity_type TEXT,
    target_entity_id TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_created ON public.activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON public.activity_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_activity_action ON public.activity_logs(action_type);

-- Internal audit logger function (Only invoked server-side)
CREATE OR REPLACE FUNCTION public.internal_log_activity(
    p_actor_id UUID,
    p_actor_name TEXT,
    p_actor_role TEXT,
    p_action_type TEXT,
    p_description TEXT,
    p_target_entity_type TEXT DEFAULT NULL,
    p_target_entity_id TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO public.activity_logs (
        actor_id, actor_name, actor_role, action_type, description,
        target_entity_type, target_entity_id, metadata
    )
    VALUES (
        p_actor_id, p_actor_name, p_actor_role, p_action_type, p_description,
        p_target_entity_type, p_target_entity_id, p_metadata
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.internal_log_activity(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;

-- =============================================================================
-- 14B. NOTIFICATION DELIVERY AUDIT LOGS TABLE (Resend & Meta WhatsApp)
-- =============================================================================
-- =============================================================================
-- NOTIFICATION OUTBOX TABLE (Secure Server-Side Event Queue)
-- Public forms insert via SECURITY DEFINER RPCs only. Edge Function reads
-- using service role key — never trusting request-body recipient data.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.notification_outbox (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'enquiry_submitted', 'booking_submitted', 'booking_assigned',
        'booking_confirmed', 'booking_rescheduled', 'booking_cancelled',
        'enquiry_assigned', 'followup_due', 'system_alert'
    )),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('admission_enquiry', 'counselling_booking', 'follow_up', 'system')),
    entity_id TEXT,
    channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp', 'both')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_outbox_status ON public.notification_outbox(status);
CREATE INDEX IF NOT EXISTS idx_notif_outbox_scheduled ON public.notification_outbox(scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notif_outbox_entity ON public.notification_outbox(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS public.notification_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recipient_email TEXT,
    recipient_phone TEXT,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'in_app', 'sms')),
    template_type TEXT NOT NULL,
    subject TEXT,
    payload JSONB DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'simulated_or_pending_credentials', 'failed', 'skipped')),
    provider_response JSONB,
    error_message TEXT,
    related_entity_type TEXT,
    related_entity_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_created ON public.notification_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_logs_channel ON public.notification_logs(channel);
CREATE INDEX IF NOT EXISTS idx_notification_logs_status ON public.notification_logs(status);
CREATE INDEX IF NOT EXISTS idx_notification_logs_entity ON public.notification_logs(related_entity_id);


-- =============================================================================
-- 15. AUTOMATIC NOTIFICATION & AUDIT TRIGGERS
-- =============================================================================

-- Generic Updated-At Trigger Function
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_students_updated_at ON public.students;
CREATE TRIGGER trg_students_updated_at BEFORE UPDATE ON public.students FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_courses_updated_at ON public.courses;
CREATE TRIGGER trg_courses_updated_at BEFORE UPDATE ON public.courses FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_batches_updated_at ON public.batches;
CREATE TRIGGER trg_batches_updated_at BEFORE UPDATE ON public.batches FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_enquiries_updated_at ON public.admission_enquiries;
CREATE TRIGGER trg_enquiries_updated_at BEFORE UPDATE ON public.admission_enquiries FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_bookings_updated_at ON public.counselling_bookings;
CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON public.counselling_bookings FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_followups_updated_at ON public.follow_ups;
CREATE TRIGGER trg_followups_updated_at BEFORE UPDATE ON public.follow_ups FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_tutorial_updated_at ON public.tutorial_progress;
CREATE TRIGGER trg_tutorial_updated_at BEFORE UPDATE ON public.tutorial_progress FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Trigger: Admission Enquiry Mutation Handler
CREATE OR REPLACE FUNCTION public.on_enquiry_mutation()
RETURNS TRIGGER AS $$
DECLARE
    v_actor_id UUID;
    v_actor_name TEXT := 'System Automator';
    v_actor_role TEXT := 'system';
BEGIN
    v_actor_id := auth.uid();
    IF v_actor_id IS NOT NULL THEN
        SELECT full_name, role::TEXT INTO v_actor_name, v_actor_role FROM public.profiles WHERE id = v_actor_id;
    END IF;

    -- Notification on Assignment to Admission Counsellor
    IF (TG_OP = 'UPDATE') AND (OLD.assigned_counsellor_id IS DISTINCT FROM NEW.assigned_counsellor_id) AND (NEW.assigned_counsellor_id IS NOT NULL) THEN
        INSERT INTO public.notifications (recipient_id, title, message, notification_type, related_record_id)
        VALUES (
            NEW.assigned_counsellor_id,
            'New Lead Assigned',
            'Admission enquiry #' || NEW.id || ' (' || NEW.target_examination || ') has been assigned to you.',
            'assignment',
            NEW.id
        );

        PERFORM public.internal_log_activity(
            v_actor_id, v_actor_name, v_actor_role,
            'lead_assigned',
            'Enquiry #' || NEW.id || ' assigned to counsellor ' || NEW.assigned_counsellor_id,
            'admission_enquiry', NEW.id
        );
    END IF;

    -- Notification on Status Transition
    IF (TG_OP = 'UPDATE') AND (OLD.status IS DISTINCT FROM NEW.status) THEN
        IF NEW.assigned_counsellor_id IS NOT NULL AND NEW.assigned_counsellor_id IS DISTINCT FROM COALESCE(v_actor_id, '00000000-0000-0000-0000-000000000000'::uuid) THEN
            INSERT INTO public.notifications (recipient_id, title, message, notification_type, related_record_id)
            VALUES (
                NEW.assigned_counsellor_id,
                'Lead Status Updated',
                'Enquiry #' || NEW.id || ' status changed from ' || OLD.status || ' to ' || NEW.status || '.',
                'status_change',
                NEW.id
            );
        END IF;

        PERFORM public.internal_log_activity(
            v_actor_id, v_actor_name, v_actor_role,
            'lead_status_changed',
            'Enquiry #' || NEW.id || ' status updated to ' || NEW.status,
            'admission_enquiry', NEW.id,
            jsonb_build_object('old_status', OLD.status, 'new_status', NEW.status)
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_enquiry_mutation ON public.admission_enquiries;
CREATE TRIGGER trg_enquiry_mutation
AFTER INSERT OR UPDATE ON public.admission_enquiries
FOR EACH ROW EXECUTE FUNCTION public.on_enquiry_mutation();

-- Trigger: Counselling Booking Mutation Handler
CREATE OR REPLACE FUNCTION public.on_booking_mutation()
RETURNS TRIGGER AS $$
DECLARE
    v_actor_id UUID;
    v_actor_name TEXT := 'System Automator';
    v_actor_role TEXT := 'system';
BEGIN
    v_actor_id := auth.uid();
    IF v_actor_id IS NOT NULL THEN
        SELECT full_name, role::TEXT INTO v_actor_name, v_actor_role FROM public.profiles WHERE id = v_actor_id;
    END IF;

    -- Notification on Academic Counsellor Assignment
    IF (TG_OP = 'UPDATE') AND (OLD.assigned_counsellor_id IS DISTINCT FROM NEW.assigned_counsellor_id) AND (NEW.assigned_counsellor_id IS NOT NULL) THEN
        INSERT INTO public.notifications (recipient_id, title, message, notification_type, related_record_id)
        VALUES (
            NEW.assigned_counsellor_id,
            'Counselling Session Assigned',
            'Session #' || NEW.id || ' on ' || NEW.preferred_date || ' (' || NEW.preferred_time || ') has been assigned to you.',
            'assignment',
            NEW.id
        );

        PERFORM public.internal_log_activity(
            v_actor_id, v_actor_name, v_actor_role,
            'session_assigned',
            'Booking #' || NEW.id || ' assigned to academic counsellor ' || NEW.assigned_counsellor_id,
            'counselling_booking', NEW.id
        );
    END IF;

    -- Notification on Confirmation
    IF (TG_OP = 'UPDATE') AND (OLD.status IS DISTINCT FROM NEW.status) AND (NEW.status = 'Confirmed') THEN
        IF NEW.assigned_counsellor_id IS NOT NULL THEN
            INSERT INTO public.notifications (recipient_id, title, message, notification_type, related_record_id)
            VALUES (
                NEW.assigned_counsellor_id,
                'Session Confirmed',
                'Session #' || NEW.id || ' is now confirmed for ' || NEW.preferred_date || ' at ' || NEW.preferred_time || '.',
                'booking_confirmation',
                NEW.id
            );
        END IF;

        PERFORM public.internal_log_activity(
            v_actor_id, v_actor_name, v_actor_role,
            'session_confirmed',
            'Booking #' || NEW.id || ' confirmed for ' || NEW.preferred_date || ' (' || NEW.preferred_time || ')',
            'counselling_booking', NEW.id
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_booking_mutation ON public.counselling_bookings;
CREATE TRIGGER trg_booking_mutation
AFTER INSERT OR UPDATE ON public.counselling_bookings
FOR EACH ROW EXECUTE FUNCTION public.on_booking_mutation();

-- =============================================================================

-- =============================================================================
-- 15B. AUTOMATIC COUNSELLOR ASSIGNMENT ENGINES
-- =============================================================================

-- Automatic Counsellor Assignment Engine: Admission Enquiries
CREATE OR REPLACE FUNCTION public.auto_assign_admission_enquiry(p_enquiry_id TEXT)
RETURNS UUID AS $$
DECLARE
    v_counsellor_id UUID;
    v_today_ist DATE;
BEGIN
    v_today_ist := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;

    -- Pick active admission counsellor with lowest active workload and capacity remaining today
    SELECT p.id INTO v_counsellor_id
    FROM public.profiles p
    LEFT JOIN public.admission_enquiries ae
      ON ae.assigned_counsellor_id = p.id
      AND ae.status NOT IN ('Converted', 'Not Interested')
    WHERE p.role = 'admission_counsellor'
      AND p.is_active = true
    GROUP BY p.id, p.daily_capacity, p.created_at
    HAVING (
        SELECT COUNT(*)
        FROM public.admission_enquiries ae2
        WHERE ae2.assigned_counsellor_id = p.id
          AND (ae2.created_at AT TIME ZONE 'Asia/Kolkata')::DATE = v_today_ist
    ) < p.daily_capacity
    ORDER BY COUNT(ae.id) ASC, p.created_at ASC
    LIMIT 1;

    IF v_counsellor_id IS NOT NULL THEN
        -- Assign lead to counsellor
        UPDATE public.admission_enquiries
        SET assigned_counsellor_id = v_counsellor_id,
            status = 'Assigned',
            updated_at = NOW()
        WHERE id = p_enquiry_id;

        -- In-app alert to assigned counsellor
        INSERT INTO public.notifications (
            recipient_id, title, message, notification_type, related_record_id
        ) VALUES (
            v_counsellor_id,
            'New Admission Lead Assigned',
            'Enquiry ' || p_enquiry_id || ' has been allocated to your admissions advisory desk.',
            'assignment',
            p_enquiry_id
        );

        -- Activity log
        PERFORM public.internal_log_activity(
            v_counsellor_id, 'System Assignment Engine', 'system',
            'enquiry_assigned',
            'Enquiry ' || p_enquiry_id || ' automatically assigned to counsellor.',
            'admission_enquiry', p_enquiry_id,
            jsonb_build_object('assigned_counsellor_id', v_counsellor_id)
        );

        RETURN v_counsellor_id;
    ELSE
        -- No eligible counsellor or daily capacity exceeded: Leave New / Unassigned & alert Super Admins
        INSERT INTO public.notifications (
            recipient_id, title, message, notification_type, related_record_id
        )
        SELECT p.id,
               'Unassigned Admission Lead Alert',
               'Enquiry ' || p_enquiry_id || ' could not be automatically assigned (staff daily capacity reached or no active counsellors). Manual assignment required.',
               'system',
               p_enquiry_id
        FROM public.profiles p
        WHERE p.role = 'super_admin' AND p.is_active = true;

        PERFORM public.internal_log_activity(
            NULL, 'System Assignment Engine', 'system',
            'enquiry_unassigned',
            'Enquiry ' || p_enquiry_id || ' left unassigned (counsellor capacity reached or none available).',
            'admission_enquiry', p_enquiry_id,
            '{}'::jsonb
        );

        RETURN NULL;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.auto_assign_admission_enquiry(TEXT) FROM PUBLIC;


-- Automatic Counsellor Assignment Engine: Counselling Bookings
CREATE OR REPLACE FUNCTION public.auto_assign_counselling_booking(
    p_booking_id TEXT,
    p_date DATE,
    p_time TEXT,
    p_medium TEXT
)
RETURNS UUID AS $$
DECLARE
    v_counsellor_id UUID;
    v_dow INTEGER;
    v_start_match TEXT[];
    v_end_match TEXT[];
    v_slot_start TIME;
    v_slot_end TIME;
    -- v_meet_link removed: google_meet_link is set manually by Super Admin
BEGIN
    v_dow := EXTRACT(DOW FROM p_date)::INTEGER;

    -- Parse appointment time window using regexp_match() (returns TEXT[] or NULL — safe scalar assignment)
    v_start_match := regexp_match(p_time, '([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))', 'i');
    IF v_start_match IS NOT NULL THEN
        BEGIN
            v_slot_start := TO_TIMESTAMP(v_start_match[1], 'HH12:MI AM')::TIME;
        EXCEPTION WHEN OTHERS THEN
            v_slot_start := '10:00:00'::TIME;
        END;
    ELSE
        v_slot_start := '10:00:00'::TIME;
    END IF;

    v_end_match := regexp_match(p_time, E'[-\u2013\u2014]\\s*([0-9]{1,2}:[0-9]{2}\\s*(?:AM|PM))', 'i');
    IF v_end_match IS NOT NULL THEN
        BEGIN
            v_slot_end := TO_TIMESTAMP(v_end_match[1], 'HH12:MI AM')::TIME;
        EXCEPTION WHEN OTHERS THEN
            v_slot_end := (v_slot_start + INTERVAL '30 minutes')::TIME;
        END;
    ELSE
        v_slot_end := (v_slot_start + INTERVAL '30 minutes')::TIME;
    END IF;

    -- Pick active academic counsellor available on this weekday & slot, not already booked, within capacity
    SELECT p.id INTO v_counsellor_id
    FROM public.profiles p
    JOIN public.counsellor_availability ca
      ON ca.counsellor_id = p.id
     AND ca.day_of_week = v_dow
     AND ca.is_available = true
     AND ca.is_active = true
     AND ca.start_time <= v_slot_start
     AND ca.end_time >= v_slot_end
    WHERE p.role = 'academic_counsellor'
      AND p.is_active = true
      AND NOT EXISTS (
          SELECT 1 FROM public.counselling_bookings cb
          WHERE cb.assigned_counsellor_id = p.id
            AND cb.preferred_date = p_date
            AND cb.preferred_time = p_time
            AND cb.status IN ('Confirmed', 'Assigned')
      )
      AND (
          SELECT COUNT(*) FROM public.counselling_bookings cb2
          WHERE cb2.assigned_counsellor_id = p.id
            AND cb2.preferred_date = p_date
            AND cb2.status IN ('Confirmed', 'Assigned')
      ) < p.daily_capacity
    ORDER BY
      (SELECT COUNT(*) FROM public.counselling_bookings cb3 WHERE cb3.assigned_counsellor_id = p.id AND cb3.preferred_date = p_date AND cb3.status IN ('Confirmed', 'Assigned')) ASC,
      (SELECT COUNT(*) FROM public.counselling_bookings cb4 WHERE cb4.assigned_counsellor_id = p.id AND cb4.status IN ('Confirmed', 'Assigned')) ASC,
      p.created_at ASC
    LIMIT 1;

    IF v_counsellor_id IS NOT NULL THEN
        -- NOTE: google_meet_link is intentionally left NULL.
        -- Super Admin must manually enter a verified Google Meet URL via the admin dashboard.
        UPDATE public.counselling_bookings
        SET assigned_counsellor_id = v_counsellor_id,
            status = 'Assigned',
            updated_at = NOW()
        WHERE id = p_booking_id;

        -- In-app alert to assigned academic mentor
        INSERT INTO public.notifications (
            recipient_id, title, message, notification_type, related_record_id
        ) VALUES (
            v_counsellor_id,
            'New Strategy Consultation Assigned',
            '1-on-1 strategy call ' || p_booking_id || ' on ' || p_date || ' (' || p_time || ') has been scheduled with you.',
            'assignment',
            p_booking_id
        );

        -- Activity log
        PERFORM public.internal_log_activity(
            v_counsellor_id, 'System Assignment Engine', 'system',
            'booking_assigned',
            'Booking ' || p_booking_id || ' automatically assigned to academic counsellor.',
            'counselling_booking', p_booking_id,
            jsonb_build_object('assigned_counsellor_id', v_counsellor_id)
        );

        RETURN v_counsellor_id;
    ELSE
        -- No mentor available or slot full: leave Pending & notify Super Admins
        INSERT INTO public.notifications (
            recipient_id, title, message, notification_type, related_record_id
        )
        SELECT p.id,
               'Unassigned Consultation Alert: Mentor Required',
               'Booking ' || p_booking_id || ' for ' || p_date || ' (' || p_time || ') requires manual academic mentor allocation.',
               'system',
               p_booking_id
        FROM public.profiles p
        WHERE p.role = 'super_admin' AND p.is_active = true;

        PERFORM public.internal_log_activity(
            NULL, 'System Assignment Engine', 'system',
            'booking_unassigned',
            'Booking ' || p_booking_id || ' left unassigned (no mentor available or slot capacity reached).',
            'counselling_booking', p_booking_id,
            '{}'::jsonb
        );

        RETURN NULL;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.auto_assign_counselling_booking(TEXT, DATE, TEXT, TEXT) FROM PUBLIC;


-- Super Admin Manual Lead Reassignment RPC
CREATE OR REPLACE FUNCTION public.reassign_admission_enquiry(
    p_enquiry_id TEXT,
    p_new_counsellor_id UUID
)
RETURNS JSONB AS $$
DECLARE
    v_user_role public.app_role;
    v_user_id UUID;
    v_counsellor_name TEXT;
    v_old_counsellor_id UUID;
BEGIN
    v_user_id := auth.uid();
    v_user_role := public.current_user_role();


    IF v_user_role IS DISTINCT FROM 'super_admin' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized: Only Super Administrators can reassign leads.');
    END IF;

    SELECT assigned_counsellor_id INTO v_old_counsellor_id
    FROM public.admission_enquiries
    WHERE id = p_enquiry_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Admission enquiry not found.');
    END IF;

    IF p_new_counsellor_id IS NOT NULL THEN
        SELECT full_name INTO v_counsellor_name
        FROM public.profiles
        WHERE id = p_new_counsellor_id
          AND role = 'admission_counsellor'
          AND is_active = true;

        IF v_counsellor_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'message', 'Target counsellor is invalid, inactive, or not an admission counsellor.');
        END IF;

        UPDATE public.admission_enquiries
        SET assigned_counsellor_id = p_new_counsellor_id,
            status = CASE WHEN status = 'New' THEN 'Assigned' ELSE status END,
            updated_at = NOW()
        WHERE id = p_enquiry_id;

        -- Notify new counsellor
        INSERT INTO public.notifications (
            recipient_id, title, message, notification_type, related_record_id
        ) VALUES (
            p_new_counsellor_id,
            'Admission Lead Reassigned to You',
            'Enquiry ' || p_enquiry_id || ' has been assigned to your advisory desk by Super Admin.',
            'assignment',
            p_enquiry_id
        );

        PERFORM public.internal_log_activity(
            v_user_id, 'Super Admin', 'super_admin',
            'enquiry_reassigned',
            'Enquiry ' || p_enquiry_id || ' reassigned to counsellor ' || v_counsellor_name || '.',
            'admission_enquiry', p_enquiry_id,
            jsonb_build_object('new_counsellor_id', p_new_counsellor_id, 'previous_counsellor_id', v_old_counsellor_id)
        );

        RETURN jsonb_build_object('success', true, 'message', 'Lead successfully assigned to ' || v_counsellor_name || '.');
    ELSE
        -- Unassign lead
        UPDATE public.admission_enquiries
        SET assigned_counsellor_id = NULL,
            status = 'New',
            updated_at = NOW()
        WHERE id = p_enquiry_id;

        PERFORM public.internal_log_activity(
            v_user_id, 'Super Admin', 'super_admin',
            'enquiry_unassigned',
            'Enquiry ' || p_enquiry_id || ' unassigned by Super Admin.',
            'admission_enquiry', p_enquiry_id,
            jsonb_build_object('previous_counsellor_id', v_old_counsellor_id)
        );

        RETURN jsonb_build_object('success', true, 'message', 'Lead unassigned successfully.');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.reassign_admission_enquiry(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reassign_admission_enquiry(TEXT, UUID) TO authenticated;


-- Super Admin Manual Booking Reassignment RPC
CREATE OR REPLACE FUNCTION public.reassign_counselling_booking(
    p_booking_id TEXT,
    p_new_counsellor_id UUID
)
RETURNS JSONB AS $$
DECLARE
    v_user_role public.app_role;
    v_user_id UUID;
    v_booking RECORD;
    v_counsellor_name TEXT;
    -- v_meet_link removed: google_meet_link managed manually by Super Admin
BEGIN
    v_user_id := auth.uid();
    v_user_role := public.current_user_role();

    IF v_user_role IS DISTINCT FROM 'super_admin' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized: Only Super Administrators can reassign counselling sessions.');
    END IF;

    SELECT * INTO v_booking
    FROM public.counselling_bookings
    WHERE id = p_booking_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Counselling booking not found.');
    END IF;

    IF p_new_counsellor_id IS NOT NULL THEN
        SELECT full_name INTO v_counsellor_name
        FROM public.profiles
        WHERE id = p_new_counsellor_id
          AND role = 'academic_counsellor'
          AND is_active = true;

        IF v_counsellor_name IS NULL THEN
            RETURN jsonb_build_object('success', false, 'message', 'Target mentor is invalid, inactive, or not an academic counsellor.');
        END IF;

        -- Verify no conflicting session at same date & time for new mentor
        IF EXISTS (
            SELECT 1 FROM public.counselling_bookings
            WHERE assigned_counsellor_id = p_new_counsellor_id
              AND preferred_date = v_booking.preferred_date
              AND preferred_time = v_booking.preferred_time
              AND status IN ('Confirmed', 'Assigned')
              AND id != p_booking_id
        ) THEN
            RETURN jsonb_build_object('success', false, 'message', 'Selected mentor already has another confirmed session scheduled at this date and time.');
        END IF;

        -- NOTE: google_meet_link is preserved as-is. Super Admin manages real Google Meet URLs manually.
        UPDATE public.counselling_bookings
        SET assigned_counsellor_id = p_new_counsellor_id,
            status = CASE WHEN status = 'Pending' THEN 'Assigned' ELSE status END,
            updated_at = NOW()
        WHERE id = p_booking_id;

        -- Notify new mentor
        INSERT INTO public.notifications (
            recipient_id, title, message, notification_type, related_record_id
        ) VALUES (
            p_new_counsellor_id,
            'Counselling Appointment Reassigned to You',
            'Booking ' || p_booking_id || ' on ' || v_booking.preferred_date || ' (' || v_booking.preferred_time || ') has been allocated to you by Super Admin.',
            'assignment',
            p_booking_id
        );

        PERFORM public.internal_log_activity(
            v_user_id, 'Super Admin', 'super_admin',
            'booking_reassigned',
            'Booking ' || p_booking_id || ' reassigned to mentor ' || v_counsellor_name || '.',
            'counselling_booking', p_booking_id,
            jsonb_build_object('new_counsellor_id', p_new_counsellor_id, 'previous_counsellor_id', v_booking.assigned_counsellor_id)
        );

        RETURN jsonb_build_object('success', true, 'message', 'Booking successfully assigned to ' || v_counsellor_name || '.');
    ELSE
        -- Unassign booking
        UPDATE public.counselling_bookings
        SET assigned_counsellor_id = NULL,
            status = 'Pending',
            updated_at = NOW()
        WHERE id = p_booking_id;

        PERFORM public.internal_log_activity(
            v_user_id, 'Super Admin', 'super_admin',
            'booking_unassigned',
            'Booking ' || p_booking_id || ' unassigned by Super Admin.',
            'counselling_booking', p_booking_id,
            jsonb_build_object('previous_counsellor_id', v_booking.assigned_counsellor_id)
        );

        RETURN jsonb_build_object('success', true, 'message', 'Booking unassigned successfully.');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.reassign_counselling_booking(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reassign_counselling_booking(TEXT, UUID) TO authenticated;

-- 16. SECURE PUBLIC SUBMISSION & RESCHEDULE RPC FUNCTIONS
-- =============================================================================

-- Public Admission Enquiry Submission RPC
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
    v_student_id UUID;
    v_enquiry_id TEXT;
    v_course_id TEXT;
    v_assigned_counsellor_id UUID;
    v_outbox_id UUID;
BEGIN
    -- Match standard course IDs
    IF p_course_category ILIKE '%Civil%' OR p_course_category ILIKE '%SSC%' THEN
        v_course_id := 'civil-services-ssc';
    ELSIF p_course_category ILIKE '%Bank%' OR p_course_category ILIKE '%Railway%' THEN
        v_course_id := 'banking-railway';
    ELSE
        v_course_id := 'foundation';
    END IF;

    -- Validate or create student via internal procedure
    v_student_id := public.get_or_create_student(p_full_name, p_phone, p_email, p_qualification);

    -- Insert enquiry record
    INSERT INTO public.admission_enquiries (
        student_id, course_id, course_category, target_examination,
        preferred_batch_timing, preferred_learning_mode, additional_message, status
    ) VALUES (
        v_student_id, v_course_id, p_course_category, p_target_examination,
        p_preferred_batch, p_learning_mode, p_message, 'New'
    ) RETURNING id INTO v_enquiry_id;

    -- Trigger Automatic Counsellor Assignment Engine
    v_assigned_counsellor_id := public.auto_assign_admission_enquiry(v_enquiry_id);

    -- Log administrative activity
    PERFORM public.internal_log_activity(
        NULL, 'Public Visitor', 'anonymous',
        'enquiry_created',
        'New admission enquiry registered by ' || p_full_name || ' (' || p_target_examination || ')',
        'admission_enquiry', v_enquiry_id,
        jsonb_build_object('phone', p_phone, 'email', p_email, 'course_id', v_course_id, 'assigned_counsellor_id', v_assigned_counsellor_id)
    );

    -- 11. Create notification outbox entry for async processing
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, channel, status, scheduled_at
        ) VALUES (
            'enquiry_submitted', 'admission_enquiry', v_enquiry_id::TEXT, 'both', 'pending', NOW()
        ) RETURNING id INTO v_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        -- Non-fatal: outbox failure must not fail the enquiry submission
        v_outbox_id := NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'enquiry_id', v_enquiry_id,
        'assigned', (v_assigned_counsellor_id IS NOT NULL),
        'outbox_id', v_outbox_id,
        'message', 'Admission enquiry registered successfully.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.submit_admission_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_admission_enquiry(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- Public Counselling Booking Submission RPC
-- Validates:
-- 1. Date not in past (Asia/Kolkata timezone)
-- 2. Valid slot format & time extraction
-- 3. Working days & availability in counsellor_availability
-- 4. Rejects booked out slots
-- 5. Prevents duplicate active bookings by same student
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
    v_student_id UUID;
    v_booking_id TEXT;
    v_course_id TEXT;
    v_today_ist DATE;
    v_dow INTEGER;
    v_start_match TEXT[];
    v_end_match TEXT[];
    v_slot_start TIME;
    v_slot_end TIME;
    v_configured_avail_count INTEGER;
    v_total_avail_counsellors INTEGER;
    v_booked_counsellors INTEGER;
    v_assigned_counsellor_id UUID;
    v_generated_meet_link TEXT;
    v_outbox_id UUID;
BEGIN
    -- Normalize slot string hyphens
    p_preferred_time := REPLACE(p_preferred_time, '–', '-');

    -- 1. Evaluate current date strictly in Asia/Kolkata timezone
    v_today_ist := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;
    IF p_preferred_date < v_today_ist THEN
        RETURN jsonb_build_object('success', false, 'message', 'Preferred appointment date cannot be in the past.');
    END IF;

    IF p_preferred_date > (v_today_ist + INTERVAL '60 days')::DATE THEN
        RETURN jsonb_build_object('success', false, 'message', 'Appointments cannot be scheduled more than 60 days in advance.');
    END IF;

    -- 2. Validate session medium
    IF p_session_medium NOT IN ('Google Meet HD Video Call', 'Direct Telephonic Call (Audio)', 'Campus In-Person Counselling') THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid session medium specified.');
    END IF;

    -- 3. Parse preferred time window (e.g. '10:30 AM – 11:00 AM' or '10:30 AM')
    v_start_match := regexp_match(p_preferred_time, '([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))', 'i');
    IF v_start_match IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid time slot format provided: ' || COALESCE(p_preferred_time, 'empty'));
    END IF;

    BEGIN
        v_slot_start := TO_TIMESTAMP(v_start_match[1], 'HH12:MI AM')::TIME;
    EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'message', 'Could not parse appointment start time: ' || v_start_match[1]);
    END;

    v_end_match := regexp_match(p_preferred_time, '[-–—]\s*([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM))', 'i');
    IF v_end_match IS NOT NULL THEN
        BEGIN
            v_slot_end := TO_TIMESTAMP(v_end_match[1], 'HH12:MI AM')::TIME;
        EXCEPTION WHEN OTHERS THEN
            v_slot_end := v_slot_start + INTERVAL '30 minutes';
        END;
    ELSE
        v_slot_end := v_slot_start + INTERVAL '30 minutes';
    END IF;

    IF v_slot_end <= v_slot_start THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid slot duration: End time must be after start time.');
    END IF;

    -- 4. Validate working days and counsellor availability
    v_dow := EXTRACT(DOW FROM p_preferred_date)::INTEGER; -- 0=Sunday, 6=Saturday

    SELECT COUNT(*) INTO v_configured_avail_count
    FROM public.counsellor_availability
    WHERE is_active = true AND is_available = true;

    IF v_configured_avail_count > 0 THEN
        -- Check if any active counsellor is scheduled on this day of week
        SELECT COUNT(DISTINCT ca.counsellor_id) INTO v_total_avail_counsellors
        FROM public.counsellor_availability ca
        JOIN public.profiles p ON p.id = ca.counsellor_id
        WHERE ca.day_of_week = v_dow
          AND ca.is_available = true
          AND ca.is_active = true
          AND p.is_active = true;

        IF v_total_avail_counsellors = 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'The institute does not conduct counselling sessions on this day of the week. Please select another date.'
            );
        END IF;

        -- Check if any counsellor has an availability window covering this slot
        SELECT COUNT(DISTINCT ca.counsellor_id) INTO v_total_avail_counsellors
        FROM public.counsellor_availability ca
        JOIN public.profiles p ON p.id = ca.counsellor_id
        WHERE ca.day_of_week = v_dow
          AND ca.is_available = true
          AND ca.is_active = true
          AND p.is_active = true
          AND ca.start_time <= v_slot_start
          AND ca.end_time >= v_slot_end;

        IF v_total_avail_counsellors = 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'The requested slot (' || p_preferred_time || ') is outside academic counsellor consultation hours.'
            );
        END IF;

        -- Check if all eligible counsellors for this slot are already booked
        SELECT COUNT(DISTINCT cb.assigned_counsellor_id) INTO v_booked_counsellors
        FROM public.counselling_bookings cb
        WHERE cb.preferred_date = p_preferred_date
          AND cb.preferred_time = p_preferred_time
          AND cb.status IN ('Confirmed', 'Assigned')
          AND cb.assigned_counsellor_id IS NOT NULL;

        IF v_booked_counsellors >= v_total_avail_counsellors THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'All academic counsellors are fully booked for ' || p_preferred_time || ' on ' || p_preferred_date || '. Please choose another slot.'
            );
        END IF;
    ELSE
        -- Default institute operating schedule fallback (Mon-Sat, 09:00 - 20:30)
        IF v_dow = 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'Counselling sessions are unavailable on Sundays. Please select a Monday to Saturday date.'
            );
        END IF;
        IF v_slot_start < '09:00:00'::TIME OR v_slot_end > '20:30:00'::TIME THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'Requested consultation slot must fall within institute operating hours (09:00 AM to 08:30 PM).'
            );
        END IF;
    END IF;

    -- 5. Course ID matching
    IF p_course_category ILIKE '%Civil%' OR p_course_category ILIKE '%SSC%' THEN
        v_course_id := 'civil-services-ssc';
    ELSIF p_course_category ILIKE '%Bank%' OR p_course_category ILIKE '%Railway%' THEN
        v_course_id := 'banking-railway';
    ELSE
        v_course_id := 'foundation';
    END IF;

    -- 6. Deduplicate / retrieve student record (internal call)
    v_student_id := public.get_or_create_student(p_full_name, p_phone, p_email);

    -- 7. Check for duplicate active booking by the same student for the same date
    IF EXISTS (
        SELECT 1 FROM public.counselling_bookings
        WHERE student_id = v_student_id
          AND preferred_date = p_preferred_date
          AND status IN ('Pending', 'Assigned', 'Confirmed')
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'You already have an active counselling appointment or pending request scheduled for ' || p_preferred_date || '. Please choose a different date.'
        );
    END IF;

    -- 8. Insert new booking with Pending status
    INSERT INTO public.counselling_bookings (
        student_id, course_id, course_category, target_examination,
        preferred_date, preferred_time, session_medium, status
    ) VALUES (
        v_student_id, v_course_id, p_course_category, p_target_examination,
        p_preferred_date, p_preferred_time, p_session_medium, 'Pending'
    ) RETURNING id INTO v_booking_id;

    -- 9. Trigger Automatic Counsellor Assignment Engine (Matching slot availability, capacity, tie-breaker)
    v_assigned_counsellor_id := public.auto_assign_counselling_booking(
        v_booking_id, p_preferred_date, p_preferred_time, p_session_medium
    );

    -- Retrieve google_meet_link (will be NULL until Super Admin sets a verified URL)
    SELECT google_meet_link INTO v_generated_meet_link
    FROM public.counselling_bookings
    WHERE id = v_booking_id;

    -- 10. Log administrative activity
    PERFORM public.internal_log_activity(
        NULL, 'Public Visitor', 'anonymous',
        'booking_requested',
        '1-on-1 strategy call requested by ' || p_full_name || ' for ' || p_preferred_date || ' (' || p_preferred_time || ')',
        'counselling_booking', v_booking_id,
        jsonb_build_object('session_medium', p_session_medium, 'course_id', v_course_id, 'assigned_counsellor_id', v_assigned_counsellor_id)
    );

    -- 11. Create notification outbox entry for async processing
    BEGIN
        INSERT INTO public.notification_outbox (
            event_type, entity_type, entity_id, channel, status, scheduled_at
        ) VALUES (
            'booking_submitted', 'counselling_booking', v_booking_id, 'both', 'pending', NOW()
        ) RETURNING id INTO v_outbox_id;
    EXCEPTION WHEN OTHERS THEN
        -- Non-fatal: outbox failure must not fail the booking submission
        v_outbox_id := NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'booking_id', v_booking_id,
        'assigned', (v_assigned_counsellor_id IS NOT NULL),
        'google_meet_link', v_generated_meet_link,
        'outbox_id', v_outbox_id,
        'message', 'Counselling appointment requested successfully.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.submit_counselling_booking(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_counselling_booking(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT) TO anon, authenticated;

-- Transactional Reschedule RPC with Strict Authorization & Double-Booking Check
CREATE OR REPLACE FUNCTION public.reschedule_booking(
    p_booking_id TEXT,
    p_new_date DATE,
    p_new_time TEXT,
    p_reason TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_booking RECORD;
    v_conflict_id TEXT;
    v_user_id UUID;
    v_user_role public.app_role;
    v_user_name TEXT;
    v_today_ist DATE;
    v_dow INTEGER;
    v_avail_count INTEGER;
BEGIN
    v_user_id := auth.uid();
    v_user_role := public.current_user_role();

    IF v_user_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized: Inactive or unauthenticated session.');
    END IF;

    IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'A valid reason for rescheduling is required.');
    END IF;

    v_today_ist := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;
    IF p_new_date < v_today_ist THEN
        RETURN jsonb_build_object('success', false, 'message', 'New appointment date cannot be in the past.');
    END IF;

    -- Acquire booking row with lock
    SELECT * INTO v_booking 
    FROM public.counselling_bookings 
    WHERE id = p_booking_id
    FOR UPDATE;

    IF v_booking IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Booking record not found.');
    END IF;

    -- Strict Authorization Check: Only Super Admin OR the assigned Academic Counsellor can reschedule
    IF v_user_role IS DISTINCT FROM 'super_admin' AND (v_booking.assigned_counsellor_id IS NULL OR v_booking.assigned_counsellor_id IS DISTINCT FROM v_user_id) THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You are not authorized to reschedule this session.');
    END IF;

    SELECT full_name INTO v_user_name FROM public.profiles WHERE id = v_user_id;

    -- If a counsellor is assigned, verify availability on that day of the week
    IF v_booking.assigned_counsellor_id IS NOT NULL THEN
        v_dow := EXTRACT(DOW FROM p_new_date)::INTEGER; -- 0=Sun, 6=Sat
        SELECT COUNT(*) INTO v_avail_count
        FROM public.counsellor_availability
        WHERE counsellor_id = v_booking.assigned_counsellor_id
          AND day_of_week = v_dow
          AND is_available = true
          AND is_active = true;

        IF v_avail_count = 0 THEN
            RETURN jsonb_build_object('success', false, 'message', 'Selected date falls outside the assigned counsellor''s configured working days.');
        END IF;

        -- Double-Booking Prevention: Check conflict against confirmed/assigned sessions
        SELECT id INTO v_conflict_id
        FROM public.counselling_bookings
        WHERE assigned_counsellor_id = v_booking.assigned_counsellor_id
          AND preferred_date = p_new_date
          AND preferred_time = p_new_time
          AND status IN ('Confirmed', 'Assigned')
          AND id != p_booking_id
        LIMIT 1;

        IF v_conflict_id IS NOT NULL THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'Conflict detected: The assigned counsellor already has an active appointment (' || v_conflict_id || ') scheduled at this time slot.'
            );
        END IF;
    END IF;

    -- Record Audit Trail in Reschedule History
    INSERT INTO public.booking_reschedule_history (
        booking_id, rescheduled_by, previous_date, previous_time, new_date, new_time, reason
    ) VALUES (
        p_booking_id, v_user_id, v_booking.preferred_date, v_booking.preferred_time, p_new_date, p_new_time, TRIM(p_reason)
    );

    -- Update Booking Record
    UPDATE public.counselling_bookings
    SET preferred_date = p_new_date,
        preferred_time = p_new_time,
        updated_at = NOW()
    WHERE id = p_booking_id;

    -- Log Administrative Activity
    PERFORM public.internal_log_activity(
        v_user_id, COALESCE(v_user_name, 'Staff Member'), v_user_role::TEXT,
        'session_rescheduled',
        'Booking #' || p_booking_id || ' moved from ' || v_booking.preferred_date || ' to ' || p_new_date || ' (' || p_new_time || '). Reason: ' || p_reason,
        'counselling_booking', p_booking_id,
        jsonb_build_object('previous_date', v_booking.preferred_date, 'new_date', p_new_date, 'reason', p_reason)
    );

    RETURN jsonb_build_object(
        'success', true,
        'booking_id', p_booking_id,
        'new_date', p_new_date,
        'new_time', p_new_time,
        'message', 'Counselling appointment rescheduled successfully.'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.reschedule_booking(TEXT, DATE, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reschedule_booking(TEXT, DATE, TEXT, TEXT) TO authenticated;


-- =============================================================================
-- 16B. ADMIN DASHBOARD SUPPORT RPCs
-- Role-restricted operations that replace AdminData mock layer
-- =============================================================================

-- Get dashboard statistics filtered by caller role
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_result JSONB;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    IF v_role = 'super_admin' THEN
        SELECT jsonb_build_object(
            'success', true,
            'total_enquiries',    (SELECT COUNT(*) FROM public.admission_enquiries),
            'pending_enquiries',  (SELECT COUNT(*) FROM public.admission_enquiries WHERE status = 'New'),
            'total_bookings',     (SELECT COUNT(*) FROM public.counselling_bookings),
            'pending_bookings',   (SELECT COUNT(*) FROM public.counselling_bookings WHERE status = 'Pending'),
            'confirmed_bookings', (SELECT COUNT(*) FROM public.counselling_bookings WHERE status = 'Confirmed'),
            'active_counsellors', (SELECT COUNT(*) FROM public.profiles WHERE is_active = true AND role IS DISTINCT FROM 'super_admin'),
            'today_followups',    (SELECT COUNT(*) FROM public.follow_ups WHERE status = 'pending' AND follow_up_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE),
            'conversion_rate',    ROUND(
                CASE WHEN (SELECT COUNT(*) FROM public.admission_enquiries) = 0 THEN 0
                     ELSE (SELECT COUNT(*) FROM public.admission_enquiries WHERE status = 'Converted')::NUMERIC * 100 /
                          (SELECT COUNT(*) FROM public.admission_enquiries)::NUMERIC
                END, 1
            )
        ) INTO v_result;
    ELSIF v_role = 'admission_counsellor' THEN
        SELECT jsonb_build_object(
            'success', true,
            'my_enquiries',        (SELECT COUNT(*) FROM public.admission_enquiries WHERE assigned_counsellor_id = v_uid),
            'active_enquiries',    (SELECT COUNT(*) FROM public.admission_enquiries WHERE assigned_counsellor_id = v_uid AND status NOT IN ('Converted', 'Not Interested')),
            'today_followups',     (SELECT COUNT(*) FROM public.follow_ups WHERE assigned_to = v_uid AND status = 'pending' AND follow_up_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE),
            'converted_this_month',(SELECT COUNT(*) FROM public.admission_enquiries WHERE assigned_counsellor_id = v_uid AND status = 'Converted' AND (updated_at AT TIME ZONE 'Asia/Kolkata')::DATE >= date_trunc('month', (NOW() AT TIME ZONE 'Asia/Kolkata'))::DATE)
        ) INTO v_result;
    ELSIF v_role = 'academic_counsellor' THEN
        SELECT jsonb_build_object(
            'success', true,
            'my_bookings',         (SELECT COUNT(*) FROM public.counselling_bookings WHERE assigned_counsellor_id = v_uid),
            'upcoming_sessions',   (SELECT COUNT(*) FROM public.counselling_bookings WHERE assigned_counsellor_id = v_uid AND status IN ('Assigned', 'Confirmed') AND preferred_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE),
            'today_sessions',      (SELECT COUNT(*) FROM public.counselling_bookings WHERE assigned_counsellor_id = v_uid AND preferred_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE AND status IN ('Assigned', 'Confirmed')),
            'completed_sessions',  (SELECT COUNT(*) FROM public.counselling_bookings WHERE assigned_counsellor_id = v_uid AND status = 'Completed'),
            'today_followups',     (SELECT COUNT(*) FROM public.follow_ups WHERE assigned_to = v_uid AND status = 'pending' AND follow_up_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE)
        ) INTO v_result;
    END IF;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;


-- Update enquiry status (role-restricted)
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

    RETURN jsonb_build_object('success', true, 'message', 'Enquiry status updated to ' || p_new_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.update_enquiry_status(TEXT, public.enquiry_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_enquiry_status(TEXT, public.enquiry_status) TO authenticated;


-- Update booking status (role-restricted)
CREATE OR REPLACE FUNCTION public.update_booking_status(
    p_booking_id TEXT,
    p_new_status public.booking_status
)
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
    v_uid UUID;
    v_booking RECORD;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    SELECT * INTO v_booking FROM public.counselling_bookings WHERE id = p_booking_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Booking not found');
    END IF;

    IF v_role = 'academic_counsellor' AND v_booking.assigned_counsellor_id IS DISTINCT FROM v_uid THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only update bookings assigned to you.');
    END IF;

    IF v_role = 'admission_counsellor' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: Admission counsellors cannot update counselling booking status.');
    END IF;

    UPDATE public.counselling_bookings
    SET status = p_new_status, updated_at = NOW()
    WHERE id = p_booking_id;

    PERFORM public.internal_log_activity(
        v_uid, (SELECT full_name FROM public.profiles WHERE id = v_uid), v_role::TEXT,
        'booking_status_updated',
        'Booking ' || p_booking_id || ' status updated to ' || p_new_status,
        'counselling_booking', p_booking_id,
        jsonb_build_object('new_status', p_new_status, 'previous_status', v_booking.status)
    );

    RETURN jsonb_build_object('success', true, 'message', 'Booking status updated to ' || p_new_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.update_booking_status(TEXT, public.booking_status) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_booking_status(TEXT, public.booking_status) TO authenticated;


-- Add an internal note to an enquiry (authenticated staff only)
CREATE OR REPLACE FUNCTION public.add_enquiry_note(
    p_enquiry_id TEXT,
    p_note_text  TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_role      public.app_role;
    v_uid       UUID;
    v_author_name TEXT;
    v_enquiry   RECORD;
    v_note_id   UUID;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    IF p_note_text IS NULL OR LENGTH(TRIM(p_note_text)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Note text cannot be empty.');
    END IF;

    SELECT * INTO v_enquiry FROM public.admission_enquiries WHERE id = p_enquiry_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Enquiry not found.');
    END IF;

    IF v_role = 'admission_counsellor' AND v_enquiry.assigned_counsellor_id IS DISTINCT FROM v_uid THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only add notes to enquiries assigned to you.');
    END IF;

    IF v_role = 'academic_counsellor' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: Academic counsellors cannot add notes to admission enquiries.');
    END IF;

    SELECT full_name INTO v_author_name FROM public.profiles WHERE id = v_uid;

    INSERT INTO public.enquiry_notes (enquiry_id, author_id, author_name, note_text)
    VALUES (p_enquiry_id, v_uid, COALESCE(v_author_name, 'Staff Member'), TRIM(p_note_text))
    RETURNING id INTO v_note_id;

    RETURN jsonb_build_object('success', true, 'note_id', v_note_id, 'message', 'Note added successfully.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.add_enquiry_note(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_enquiry_note(TEXT, TEXT) TO authenticated;


-- Add an internal note to a counselling booking (authenticated staff only)
CREATE OR REPLACE FUNCTION public.add_booking_note(
    p_booking_id TEXT,
    p_note_text  TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_role      public.app_role;
    v_uid       UUID;
    v_author_name TEXT;
    v_booking   RECORD;
    v_note_id   UUID;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    IF p_note_text IS NULL OR LENGTH(TRIM(p_note_text)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Note text cannot be empty.');
    END IF;

    SELECT * INTO v_booking FROM public.counselling_bookings WHERE id = p_booking_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Booking not found.');
    END IF;

    IF v_role = 'academic_counsellor' AND v_booking.assigned_counsellor_id IS DISTINCT FROM v_uid THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only add notes to bookings assigned to you.');
    END IF;

    IF v_role = 'admission_counsellor' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: Admission counsellors cannot add notes to counselling bookings.');
    END IF;

    SELECT full_name INTO v_author_name FROM public.profiles WHERE id = v_uid;

    INSERT INTO public.booking_notes (booking_id, author_id, author_name, note_text)
    VALUES (p_booking_id, v_uid, COALESCE(v_author_name, 'Staff Member'), TRIM(p_note_text))
    RETURNING id INTO v_note_id;

    RETURN jsonb_build_object('success', true, 'note_id', v_note_id, 'message', 'Note added successfully.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.add_booking_note(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_booking_note(TEXT, TEXT) TO authenticated;


-- Create a follow-up task (authenticated staff only)
CREATE OR REPLACE FUNCTION public.create_follow_up(
    p_student_id  UUID,
    p_enquiry_id  TEXT DEFAULT NULL,
    p_booking_id  TEXT DEFAULT NULL,
    p_follow_up_date DATE DEFAULT NULL,
    p_follow_up_time TEXT DEFAULT NULL,
    p_follow_up_type TEXT DEFAULT 'phone_call',
    p_notes       TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_role   public.app_role;
    v_uid    UUID;
    v_fup_id UUID;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    IF p_follow_up_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Follow-up date is required.');
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
        student_id, enquiry_id, booking_id,
        assigned_to, follow_up_date, follow_up_time,
        follow_up_type, notes, status
    ) VALUES (
        p_student_id, p_enquiry_id, p_booking_id,
        v_uid, p_follow_up_date, p_follow_up_time,
        p_follow_up_type, p_notes, 'pending'
    ) RETURNING id INTO v_fup_id;

    RETURN jsonb_build_object('success', true, 'follow_up_id', v_fup_id, 'message', 'Follow-up scheduled successfully.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.create_follow_up(UUID, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_follow_up(UUID, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) TO authenticated;


-- Complete a follow-up (authenticated staff only)
CREATE OR REPLACE FUNCTION public.complete_follow_up(
    p_follow_up_id UUID,
    p_outcome_notes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_role   public.app_role;
    v_uid    UUID;
    v_fup    RECORD;
BEGIN
    v_role := public.current_user_role();
    v_uid  := auth.uid();

    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
    END IF;

    SELECT * INTO v_fup FROM public.follow_ups WHERE id = p_follow_up_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Follow-up not found.');
    END IF;

    IF v_role IS DISTINCT FROM 'super_admin' AND v_fup.assigned_to IS DISTINCT FROM v_uid THEN
        RETURN jsonb_build_object('success', false, 'message', 'Access Denied: You can only complete follow-ups assigned to you.');
    END IF;

    UPDATE public.follow_ups
    SET status = 'completed',
        completed_at = NOW(),
        notes = CASE WHEN p_outcome_notes IS NOT NULL
                     THEN COALESCE(notes, '') || E'\n[Outcome] ' || p_outcome_notes
                     ELSE notes END,
        updated_at = NOW()
    WHERE id = p_follow_up_id;

    RETURN jsonb_build_object('success', true, 'message', 'Follow-up marked as completed.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.complete_follow_up(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_follow_up(UUID, TEXT) TO authenticated;


-- Set Google Meet link for a booking (Super Admin only)
CREATE OR REPLACE FUNCTION public.set_booking_meet_link(
    p_booking_id  TEXT,
    p_meet_link   TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_role public.app_role;
BEGIN
    v_role := public.current_user_role();

    IF v_role IS DISTINCT FROM 'super_admin' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized: Only Super Admins can set Google Meet links.');
    END IF;

    IF p_meet_link IS NOT NULL AND p_meet_link !~* '^https?://meet\.google\.com/' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid Google Meet URL. Must begin with https://meet.google.com/');
    END IF;

    UPDATE public.counselling_bookings
    SET google_meet_link = p_meet_link, updated_at = NOW()
    WHERE id = p_booking_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Booking not found.');
    END IF;

    RETURN jsonb_build_object('success', true, 'message', 'Google Meet link updated successfully.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.set_booking_meet_link(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_booking_meet_link(TEXT, TEXT) TO authenticated;


-- Get available booking slots for a given date (PUBLIC safe — returns slot labels only, no PII)
CREATE OR REPLACE FUNCTION public.get_available_booking_slots(p_date DATE)
RETURNS JSONB AS $$
DECLARE
    v_dow INTEGER;
    v_today_ist DATE;
    v_avail_count INTEGER;
    v_slots JSONB;
    SLOT_DURATION CONSTANT INTERVAL := INTERVAL '30 minutes';
BEGIN
    v_today_ist := (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;

    IF p_date < v_today_ist THEN
        RETURN jsonb_build_object('success', false, 'message', 'Date cannot be in the past.', 'slots', '[]'::jsonb);
    END IF;

    v_dow := EXTRACT(DOW FROM p_date)::INTEGER;

    SELECT COUNT(*) INTO v_avail_count
    FROM public.counsellor_availability ca
    JOIN public.profiles p ON p.id = ca.counsellor_id
    WHERE ca.day_of_week = v_dow
      AND ca.is_available = true
      AND ca.is_active = true
      AND p.is_active = true
      AND p.role = 'academic_counsellor';

    IF v_avail_count = 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'date', p_date,
            'day_available', false,
            'message', 'No counsellor availability configured for this day.',
            'slots', '[]'::jsonb
        );
    END IF;

    -- Generate individual 30-minute slots from counsellor availability windows.
    -- A slot is available if at least one active academic counsellor is free for that slot.
    SELECT jsonb_agg(slot_label ORDER BY slot_start) INTO v_slots
    FROM (
        SELECT DISTINCT
            TO_CHAR(gs.slot_start, 'HH12:MI AM') || ' - ' || TO_CHAR(gs.slot_start + SLOT_DURATION, 'HH12:MI AM') AS slot_label,
            gs.slot_start
        FROM public.counsellor_availability ca
        JOIN public.profiles p ON p.id = ca.counsellor_id
        CROSS JOIN LATERAL generate_series(
            ca.start_time,
            ca.end_time - SLOT_DURATION,
            SLOT_DURATION
        ) AS gs(slot_start)
        WHERE ca.day_of_week = v_dow
          AND ca.is_available = true
          AND ca.is_active = true
          AND p.is_active = true
          AND p.role = 'academic_counsellor'
          -- Keep the slot only if at least one counsellor covering it is not booked
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
                AND gs.slot_start + SLOT_DURATION <= ca2.end_time
                AND NOT EXISTS (
                    SELECT 1 FROM public.counselling_bookings cb
                    WHERE cb.assigned_counsellor_id = p2.id
                      AND cb.preferred_date = p_date
                      AND cb.preferred_time = TO_CHAR(gs.slot_start, 'HH12:MI AM') || ' - ' || TO_CHAR(gs.slot_start + SLOT_DURATION, 'HH12:MI AM')
                      AND cb.status IN ('Confirmed', 'Assigned')
                )
          )
    ) available_slots;

    RETURN jsonb_build_object(
        'success', true,
        'date', p_date,
        'day_available', true,
        'slots', COALESCE(v_slots, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_available_booking_slots(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_available_booking_slots(DATE) TO anon, authenticated;

-- Atomic outbox record claiming for server-side notification dispatch.
-- Uses FOR UPDATE SKIP LOCKED to prevent race conditions between workers.
CREATE OR REPLACE FUNCTION public.claim_outbox_records(p_batch_size INTEGER DEFAULT 5)
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
COMMENT ON FUNCTION public.claim_outbox_records(INTEGER) IS 'Atomically claims pending notification outbox records for processing. Called by pg_cron or Edge Function with service role. Uses FOR UPDATE SKIP LOCKED to prevent duplicate processing.';

-- Reset stale processing records (stuck > 15 minutes) back to pending
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
COMMENT ON FUNCTION public.reset_stale_outbox_records() IS 'Resets notification_outbox records stuck in processing state for >15 minutes. Should be called by pg_cron every 5 minutes.';

-- Dashboard data retrieval RPCs for authenticated admin users
-- These provide role-filtered access to operational data

CREATE OR REPLACE FUNCTION public.get_dashboard_enquiries(p_limit INTEGER DEFAULT 50, p_offset INTEGER DEFAULT 0)
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

    IF v_role = 'super_admin' OR v_role = 'admission_counsellor' THEN
        SELECT jsonb_build_object(
            'success', true,
            'data', COALESCE(jsonb_agg(row_to_json(eq) ORDER BY eq.created_at DESC), '[]'::jsonb)
        ) INTO v_result
        FROM (
            SELECT e.id, e.student_id, s.full_name AS student_name, s.phone, s.email, s.qualification,
                   e.course_id, e.course_category, e.target_examination,
                   e.preferred_batch_timing, e.preferred_learning_mode,
                   e.additional_message, e.status::TEXT, e.priority, e.source,
                   e.assigned_counsellor_id, p.full_name AS counsellor_name,
                   e.created_at, e.updated_at
            FROM public.admission_enquiries e
            JOIN public.students s ON s.id = e.student_id
            LEFT JOIN public.profiles p ON p.id = e.assigned_counsellor_id
            WHERE v_role = 'super_admin' OR e.assigned_counsellor_id = v_uid
            ORDER BY e.created_at DESC
            LIMIT p_limit OFFSET p_offset
        ) eq;
    ELSE
        v_result := jsonb_build_object('success', true, 'data', '[]'::jsonb);
    END IF;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_enquiries(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_enquiries(INTEGER, INTEGER) TO authenticated;

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
            SELECT b.id, b.student_id, s.full_name AS student_name, s.phone, s.email,
                   b.course_id, b.course_category, b.target_examination,
                   b.preferred_date, b.preferred_time, b.session_medium,
                   b.google_meet_link, b.status::TEXT, b.counselling_notes,
                   b.assigned_counsellor_id, p.full_name AS counsellor_name,
                   b.created_at, b.updated_at
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
        RETURN jsonb_build_object('success', false, 'message', 'Unauthorized');
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
        LIMIT 100
    ) fq;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_follow_ups() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_follow_ups() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_dashboard_activity_log(p_limit INTEGER DEFAULT 50)
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

    SELECT jsonb_build_object(
        'success', true,
        'data', COALESCE(jsonb_agg(row_to_json(aq) ORDER BY aq.created_at DESC), '[]'::jsonb)
    ) INTO v_result
    FROM (
        SELECT a.id, a.actor_id, a.actor_name, a.actor_role,
               a.action_type, a.description,
               a.target_entity_type AS entity_type,
               a.target_entity_id AS entity_id,
               a.metadata, a.created_at
        FROM public.activity_logs a
        WHERE v_role = 'super_admin' OR a.actor_id = v_uid
        ORDER BY a.created_at DESC
        LIMIT p_limit
    ) aq;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_activity_log(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_activity_log(INTEGER) TO authenticated;

-- =============================================================================
-- 17. SEED CORE DATA (Courses & Sample Batches)
-- =============================================================================
INSERT INTO public.courses (id, name, category, description, examination_list, base_fee, is_active)
VALUES
(
    'civil-services-ssc',
    'Civil Services & SSC Examination Preparation',
    'Administrative & Civil Services',
    'Comprehensive multi-tier classroom and digital training for UPSC CSE, State PCS, and SSC CGL.',
    ARRAY['UPSC Civil Services Examination (CSE)', 'State Public Service Commission (State PCS)', 'SSC CGL (Combined Graduate Level)', 'SSC CHSL (Combined Higher Secondary)', 'SSC GD (General Duty Constable)', 'SSC MTS (Multi-Tasking Staff)', 'State Subordinate & Administrative Exams'],
    45000.00,
    true
),
(
    'banking-railway',
    'Banking & Railway Examination Preparation',
    'Financial & Railway Services',
    'Rigorous quantitative aptitude, reasoning, and exam simulation for IBPS PO, Clerk, SBI, and RRB NTPC.',
    ARRAY['IBPS PO (Probationary Officer)', 'IBPS Clerk (Clerical Cadre)', 'SBI PO (State Bank of India)', 'SBI Clerk (Junior Associate)', 'IBPS RRB (Gramin Bank Officer & Assistant)', 'RBI Grade B Officer & Assistant', 'RRB NTPC (Non-Technical Popular Categories)', 'RRB Group D & ALP (Assistant Loco Pilot)'],
    32000.00,
    true
),
(
    'foundation',
    'APEX Foundation Program',
    'Integrated Beginner Foundation',
    '360-degree foundational mastery in General Studies, Quantitative Aptitude, Logical Reasoning, and English.',
    ARRAY['All-Govt Exam Beginner Foundation (SSC, Bank, Railway)', 'College Students Long-Term Integrated Foundation (2-Year)', 'NCERT Comprehensive Foundation (UPSC & State PCS)', 'CSAT & General Mental Ability Foundation'],
    28000.00,
    true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.batches (course_id, batch_name, start_date, timing_slot, learning_mode, fee_amount, seat_capacity, enrolled_count, is_admission_open)
VALUES
('civil-services-ssc', 'UPSC CSE 2027 Comprehensive Prelims-cum-Mains Super-50', '2026-11-20', '08:00 AM – 11:00 AM (Morning)', 'Offline Classroom (Delhi Flagship Campus)', 45000.00, 50, 38, true),
('civil-services-ssc', 'SSC CGL Tier-I & II Target Crash Batch', '2026-11-15', '04:00 PM – 07:00 PM (Evening)', 'Hybrid (Classroom + HD Live Stream)', 28000.00, 60, 47, true),
('banking-railway', 'IBPS & SBI PO 2027 High-Velocity Preparation Cohort', '2026-11-18', '09:30 AM – 12:30 PM (Morning)', 'Offline Classroom (Delhi Flagship Campus)', 32000.00, 45, 31, true),
('foundation', 'Apex All-Govt Beginner Foundation Mastermind (Annual)', '2026-11-25', '10:00 AM – 01:00 PM (Regular)', 'Offline Classroom (Delhi Flagship Campus)', 28000.00, 40, 26, true)
ON CONFLICT (course_id, batch_name) DO NOTHING;

-- =============================================================================
-- 18. STRICT ZERO-TRUST ROW LEVEL SECURITY (RLS) POLICIES
-- Retry-Safe: Each policy is preceded by DROP POLICY IF EXISTS
-- =============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counselling_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_reschedule_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiry_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counsellor_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tutorial_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- ── 1. PROFILES POLICIES ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Super Admin manage all profiles" ON public.profiles;
CREATE POLICY "Super Admin manage all profiles"
ON public.profiles FOR ALL
TO authenticated
USING (public.current_user_role() = 'super_admin')
WITH CHECK (public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "Staff view own profile" ON public.profiles;
CREATE POLICY "Staff view own profile"
ON public.profiles FOR SELECT
TO authenticated
USING (id = auth.uid());

DROP POLICY IF EXISTS "Staff update own profile" ON public.profiles;
CREATE POLICY "Staff update own profile"
ON public.profiles FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- ── 2. COURSES & BATCHES POLICIES ───────────────────────────────────────────
DROP POLICY IF EXISTS "Public view active courses" ON public.courses;
CREATE POLICY "Public view active courses"
ON public.courses FOR SELECT
USING (is_active = true OR public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "Super Admin manage courses" ON public.courses;
CREATE POLICY "Super Admin manage courses"
ON public.courses FOR ALL
TO authenticated
USING (public.current_user_role() = 'super_admin')
WITH CHECK (public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "Public view open batches" ON public.batches;
CREATE POLICY "Public view open batches"
ON public.batches FOR SELECT
USING (is_admission_open = true OR public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "Super Admin manage batches" ON public.batches;
CREATE POLICY "Super Admin manage batches"
ON public.batches FOR ALL
TO authenticated
USING (public.current_user_role() = 'super_admin')
WITH CHECK (public.current_user_role() = 'super_admin');

-- ── 3. ADMISSION ENQUIRIES POLICIES ─────────────────────────────────────────
DROP POLICY IF EXISTS "Super Admin manage all enquiries" ON public.admission_enquiries;
CREATE POLICY "Super Admin manage all enquiries"
ON public.admission_enquiries FOR ALL
TO authenticated
USING (public.current_user_role() = 'super_admin')
WITH CHECK (public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "Admission Counsellors view assigned enquiries" ON public.admission_enquiries;
CREATE POLICY "Admission Counsellors view assigned enquiries"
ON public.admission_enquiries FOR SELECT
TO authenticated
USING (
    public.current_user_role() = 'admission_counsellor'
    AND assigned_counsellor_id = auth.uid()
);

DROP POLICY IF EXISTS "Admission Counsellors update assigned enquiries" ON public.admission_enquiries;
CREATE POLICY "Admission Counsellors update assigned enquiries"
ON public.admission_enquiries FOR UPDATE
TO authenticated
USING (
    public.current_user_role() = 'admission_counsellor'
    AND assigned_counsellor_id = auth.uid()
)
WITH CHECK (
    public.current_user_role() = 'admission_counsellor'
    AND assigned_counsellor_id = auth.uid()
);

-- ── 4. COUNSELLING BOOKINGS POLICIES ────────────────────────────────────────
DROP POLICY IF EXISTS "Super Admin manage all bookings" ON public.counselling_bookings;
CREATE POLICY "Super Admin manage all bookings"
ON public.counselling_bookings FOR ALL
TO authenticated
USING (public.current_user_role() = 'super_admin')
WITH CHECK (public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "Academic Counsellors view assigned bookings" ON public.counselling_bookings;
CREATE POLICY "Academic Counsellors view assigned bookings"
ON public.counselling_bookings FOR SELECT
TO authenticated
USING (
    public.current_user_role() = 'academic_counsellor'
    AND assigned_counsellor_id = auth.uid()
);

DROP POLICY IF EXISTS "Academic Counsellors update assigned bookings" ON public.counselling_bookings;
CREATE POLICY "Academic Counsellors update assigned bookings"
ON public.counselling_bookings FOR UPDATE
TO authenticated
USING (
    public.current_user_role() = 'academic_counsellor'
    AND assigned_counsellor_id = auth.uid()
)
WITH CHECK (
    public.current_user_role() = 'academic_counsellor'
    AND assigned_counsellor_id = auth.uid()
);

-- ── 5. STUDENTS TABLE POLICIES ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Super Admin manage all students" ON public.students;
CREATE POLICY "Super Admin manage all students"
ON public.students FOR ALL
TO authenticated
USING (public.current_user_role() = 'super_admin')
WITH CHECK (public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "Counsellors view assigned students" ON public.students;
CREATE POLICY "Counsellors view assigned students"
ON public.students FOR SELECT
TO authenticated
USING (
    (public.current_user_role() = 'admission_counsellor' AND EXISTS (
        SELECT 1 FROM public.admission_enquiries e WHERE e.student_id = students.id AND e.assigned_counsellor_id = auth.uid()
    ))
    OR
    (public.current_user_role() = 'academic_counsellor' AND EXISTS (
        SELECT 1 FROM public.counselling_bookings b WHERE b.student_id = students.id AND b.assigned_counsellor_id = auth.uid()
    ))
);

DROP POLICY IF EXISTS "Counsellors update assigned students" ON public.students;
CREATE POLICY "Counsellors update assigned students"
ON public.students FOR UPDATE
TO authenticated
USING (
    (public.current_user_role() = 'admission_counsellor' AND EXISTS (
        SELECT 1 FROM public.admission_enquiries e WHERE e.student_id = students.id AND e.assigned_counsellor_id = auth.uid()
    ))
    OR
    (public.current_user_role() = 'academic_counsellor' AND EXISTS (
        SELECT 1 FROM public.counselling_bookings b WHERE b.student_id = students.id AND b.assigned_counsellor_id = auth.uid()
    ))
)
WITH CHECK (
    (public.current_user_role() = 'admission_counsellor' AND EXISTS (
        SELECT 1 FROM public.admission_enquiries e WHERE e.student_id = students.id AND e.assigned_counsellor_id = auth.uid()
    ))
    OR
    (public.current_user_role() = 'academic_counsellor' AND EXISTS (
        SELECT 1 FROM public.counselling_bookings b WHERE b.student_id = students.id AND b.assigned_counsellor_id = auth.uid()
    ))
);

-- ── 6. ENQUIRY NOTES POLICIES (Author Spoofing Prevention) ──────────────────
DROP POLICY IF EXISTS "Staff view permitted enquiry notes" ON public.enquiry_notes;
CREATE POLICY "Staff view permitted enquiry notes"
ON public.enquiry_notes FOR SELECT
TO authenticated
USING (
    public.current_user_role() = 'super_admin'
    OR EXISTS (
        SELECT 1 FROM public.admission_enquiries e WHERE e.id = enquiry_notes.enquiry_id AND e.assigned_counsellor_id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Staff insert enquiry notes" ON public.enquiry_notes;
CREATE POLICY "Staff insert enquiry notes"
ON public.enquiry_notes FOR INSERT
TO authenticated
WITH CHECK (
    author_id = auth.uid() 
    AND (
        public.current_user_role() = 'super_admin'
        OR EXISTS (
            SELECT 1 FROM public.admission_enquiries e WHERE e.id = enquiry_id AND e.assigned_counsellor_id = auth.uid()
        )
    )
);

DROP POLICY IF EXISTS "Staff update own enquiry notes" ON public.enquiry_notes;
CREATE POLICY "Staff update own enquiry notes"
ON public.enquiry_notes FOR UPDATE
TO authenticated
USING (
    public.current_user_role() = 'super_admin'
    OR (author_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.admission_enquiries e WHERE e.id = enquiry_notes.enquiry_id AND e.assigned_counsellor_id = auth.uid()
    ))
)
WITH CHECK (
    author_id = auth.uid()
);

-- ── 7. BOOKING NOTES POLICIES (Author Spoofing Prevention) ──────────────────
DROP POLICY IF EXISTS "Staff view permitted booking notes" ON public.booking_notes;
CREATE POLICY "Staff view permitted booking notes"
ON public.booking_notes FOR SELECT
TO authenticated
USING (
    public.current_user_role() = 'super_admin'
    OR EXISTS (
        SELECT 1 FROM public.counselling_bookings b WHERE b.id = booking_notes.booking_id AND b.assigned_counsellor_id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Staff insert booking notes" ON public.booking_notes;
CREATE POLICY "Staff insert booking notes"
ON public.booking_notes FOR INSERT
TO authenticated
WITH CHECK (
    author_id = auth.uid() 
    AND (
        public.current_user_role() = 'super_admin'
        OR EXISTS (
            SELECT 1 FROM public.counselling_bookings b WHERE b.id = booking_id AND b.assigned_counsellor_id = auth.uid()
        )
    )
);

DROP POLICY IF EXISTS "Staff update own booking notes" ON public.booking_notes;
CREATE POLICY "Staff update own booking notes"
ON public.booking_notes FOR UPDATE
TO authenticated
USING (
    public.current_user_role() = 'super_admin'
    OR (author_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.counselling_bookings b WHERE b.id = booking_notes.booking_id AND b.assigned_counsellor_id = auth.uid()
    ))
)
WITH CHECK (
    author_id = auth.uid()
);

-- ── 8. BOOKING RESCHEDULE HISTORY POLICIES ──────────────────────────────────
DROP POLICY IF EXISTS "Staff view permitted reschedule history" ON public.booking_reschedule_history;
CREATE POLICY "Staff view permitted reschedule history"
ON public.booking_reschedule_history FOR SELECT
TO authenticated
USING (
    public.current_user_role() = 'super_admin'
    OR EXISTS (
        SELECT 1 FROM public.counselling_bookings b WHERE b.id = booking_reschedule_history.booking_id AND b.assigned_counsellor_id = auth.uid()
    )
);

-- ── 9. FOLLOW-UPS POLICIES (Ownership & Parent Enforced) ────────────────────
DROP POLICY IF EXISTS "Staff view permitted follow-ups" ON public.follow_ups;
CREATE POLICY "Staff view permitted follow-ups"
ON public.follow_ups FOR SELECT
TO authenticated
USING (
    public.current_user_role() = 'super_admin'
    OR assigned_to = auth.uid()
);

DROP POLICY IF EXISTS "Staff insert follow-ups" ON public.follow_ups;
CREATE POLICY "Staff insert follow-ups"
ON public.follow_ups FOR INSERT
TO authenticated
WITH CHECK (
    (public.current_user_role() = 'super_admin' AND assigned_to IS NOT NULL)
    OR
    (assigned_to = auth.uid() AND (
        (enquiry_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.admission_enquiries WHERE id = enquiry_id AND assigned_counsellor_id = auth.uid()))
        OR
        (booking_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.counselling_bookings WHERE id = booking_id AND assigned_counsellor_id = auth.uid()))
    ))
);

DROP POLICY IF EXISTS "Staff update assigned follow-ups" ON public.follow_ups;
CREATE POLICY "Staff update assigned follow-ups"
ON public.follow_ups FOR UPDATE
TO authenticated
USING (public.current_user_role() = 'super_admin' OR assigned_to = auth.uid())
WITH CHECK (public.current_user_role() = 'super_admin' OR assigned_to = auth.uid());

-- ── 10. COUNSELLOR AVAILABILITY POLICIES ────────────────────────────────────
DROP POLICY IF EXISTS "Public view active available slots" ON public.counsellor_availability;
CREATE POLICY "Public view active available slots"
ON public.counsellor_availability FOR SELECT
USING (is_active = true AND is_available = true);

DROP POLICY IF EXISTS "Staff view all active availability" ON public.counsellor_availability;
CREATE POLICY "Staff view all active availability"
ON public.counsellor_availability FOR SELECT
TO authenticated
USING (public.current_user_role() IS NOT NULL);

DROP POLICY IF EXISTS "Super Admin manage all availability" ON public.counsellor_availability;
CREATE POLICY "Super Admin manage all availability"
ON public.counsellor_availability FOR ALL
TO authenticated
USING (public.current_user_role() = 'super_admin')
WITH CHECK (public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "Counsellors manage own availability" ON public.counsellor_availability;
CREATE POLICY "Counsellors manage own availability"
ON public.counsellor_availability FOR ALL
TO authenticated
USING (counsellor_id = auth.uid() AND public.current_user_role() IS NOT NULL)
WITH CHECK (counsellor_id = auth.uid() AND public.current_user_role() IS NOT NULL);

-- ── 11. IN-APP NOTIFICATIONS POLICIES ───────────────────────────────────────
DROP POLICY IF EXISTS "Users access own notifications" ON public.notifications;
CREATE POLICY "Users access own notifications"
ON public.notifications FOR ALL
TO authenticated
USING (recipient_id = auth.uid())
WITH CHECK (recipient_id = auth.uid());

-- ── 12. TUTORIAL PROGRESS POLICIES ──────────────────────────────────────────
DROP POLICY IF EXISTS "Users access own tutorial progress" ON public.tutorial_progress;
CREATE POLICY "Users access own tutorial progress"
ON public.tutorial_progress FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- ── 13. IMMUTABLE ACTIVITY LOGS POLICIES ────────────────────────────────────
DROP POLICY IF EXISTS "Super Admin view activity logs" ON public.activity_logs;
CREATE POLICY "Super Admin view activity logs"
ON public.activity_logs FOR SELECT
TO authenticated
USING (public.current_user_role() = 'super_admin');

-- (No client-side INSERT/UPDATE/DELETE policy: Activity logs are strictly generated server-side)

-- =============================================================================
-- 19. REALTIME PUBLICATION CONFIGURATION
-- =============================================================================
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'admission_enquiries'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.admission_enquiries;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'counselling_bookings'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.counselling_bookings;
    END IF;
END $$;


-- ── NOTIFICATION OUTBOX POLICIES ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notification_outbox_service_role" ON public.notification_outbox;
CREATE POLICY "notification_outbox_service_role"
    ON public.notification_outbox
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "notification_outbox_super_admin_select" ON public.notification_outbox;
CREATE POLICY "notification_outbox_super_admin_select"
    ON public.notification_outbox
    FOR SELECT
    TO authenticated
    USING (public.current_user_role() = 'super_admin');

-- -----------------------------------------------------------------------------
-- 18L. NOTIFICATION LOGS POLICIES
-- -----------------------------------------------------------------------------
ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notification_logs_super_admin_all" ON public.notification_logs;
CREATE POLICY "notification_logs_super_admin_all"
    ON public.notification_logs
    FOR ALL
    TO authenticated
    USING (public.current_user_role() = 'super_admin')
    WITH CHECK (public.current_user_role() = 'super_admin');

DROP POLICY IF EXISTS "notification_logs_staff_select" ON public.notification_logs;
CREATE POLICY "notification_logs_staff_select"
    ON public.notification_logs
    FOR SELECT
    TO authenticated
    USING (
        public.current_user_role() IN ('admission_counsellor', 'academic_counsellor')
        AND (
            related_entity_id IN (
                SELECT id FROM public.admission_enquiries WHERE assigned_counsellor_id = auth.uid()
                UNION ALL
                SELECT id FROM public.counselling_bookings WHERE assigned_counsellor_id = auth.uid()
            )
        )
    );

DROP POLICY IF EXISTS "notification_logs_service_role" ON public.notification_logs;
CREATE POLICY "notification_logs_service_role"
    ON public.notification_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
