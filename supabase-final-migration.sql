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
    student_name TEXT,
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
