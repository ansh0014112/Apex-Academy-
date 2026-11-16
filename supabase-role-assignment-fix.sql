-- =============================================================================
-- APEX ACADEMY — SAFE ROLE ASSIGNMENT & PERMISSION RECONCILIATION MIGRATION
-- Run this migration in Supabase SQL Editor to fix role assignment and Table Editor permissions.
-- Safe to execute: Does not delete tables, users, or data.
-- =============================================================================

-- 1. Remove the automatic default of 'admission_counsellor' on public.profiles.role
-- Allows new profiles to be created with explicit role or unassigned (NULL) instead of silently forcing 'admission_counsellor'.
ALTER TABLE public.profiles ALTER COLUMN role DROP DEFAULT;
ALTER TABLE public.profiles ALTER COLUMN role DROP NOT NULL;

-- 2. Update trigger function protect_profile_privileged_fields()
-- Allow service_role, database administrators (where auth.uid() is NULL in Supabase Table/SQL Editor),
-- and Super Admins to freely update profile roles, status, and capacity.
-- Strictly prevent ordinary non-Super-Admin authenticated users from altering roles.
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

-- 3. Update handle_new_auth_user() trigger function on auth.users
-- When a user is manually created via Supabase Authentication (Users -> Add User):
-- Check raw_user_meta_data->>'role'. If not provided, do NOT silently assign 'admission_counsellor'!
-- Leave role as NULL until explicitly assigned by the administrator.
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

-- 4. Update get_or_sync_current_profile() RPC
-- Ensure self-healing profile sync never silently forces 'admission_counsellor'.
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

    -- If profile does not exist, provision using auth.users details without defaulting role
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

-- 5. Safe Helper Function for Assigning Admin Roles
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
