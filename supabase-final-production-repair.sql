-- =============================================================================
-- APEX ACADEMY — PRODUCTION DATABASE INTEGRITY & STRICT RBAC REPAIR
-- File: supabase-final-production-repair.sql
-- 
-- Comprehensive, safe, idempotent production repair addressing:
-- 1. Eliminates role inference from untrusted user metadata in Auth trigger.
-- 2. Every newly created Auth account receives role = NULL and department = 'Unassigned'.
-- 3. Ensures on_auth_user_created trigger is safely and cleanly attached to auth.users.
-- 4. Corrects Superadmin2342 to super_admin and Executive Administration.
-- 5. Does not reactivate accounts automatically (preserves existing is_active states).
-- 6. Enforces canonical departments server-side (no arbitrary department overrides).
-- 7. Fixes audit logging so SQL Editor execution does not falsely identify target as actor.
-- 8. Resolves availability schedule duplication (single authoritative seeding path).
-- 9. Preserves profiles.role as non-unique (supports multiple counsellors and admins).
-- 10. Drops direct SQL user insertion functions (staff provisioning via Edge Function).
-- =============================================================================

-- ── 1. VERIFY ENUM & MULTI-ACCOUNT ROLE SUPPORT ──────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
        CREATE TYPE public.app_role AS ENUM (
            'super_admin',
            'admission_counsellor',
            'academic_counsellor'
        );
    END IF;
END $$;

-- Verify and remove any erroneous unique constraint on profiles.role
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'public.profiles'::regclass 
          AND contype = 'u' 
          AND array_to_string(conkey, ',') = (
              SELECT attnum::text FROM pg_attribute 
              WHERE attrelid = 'public.profiles'::regclass AND attname = 'role'
          )
    ) THEN
        EXECUTE 'ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_key';
    END IF;
END $$;

-- Ensure regular non-unique index exists on role
DROP INDEX IF EXISTS public.idx_profiles_role;
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);

-- Remove hardcoded column-level default to eliminate silent role assignment
ALTER TABLE public.profiles ALTER COLUMN role DROP DEFAULT;

-- ── 2. AUDIT & REPAIR ALL EXISTING ACCOUNTS ───────────────────────────────────
-- Correct only established accounts without forcibly modifying is_active status

-- Superadmin2342: Correct to intended super_admin
UPDATE public.profiles
SET 
    role = 'super_admin'::public.app_role,
    department = 'Executive Administration',
    updated_at = NOW()
WHERE LOWER(TRIM(email)) = 'superadmin2342@gmail.com';

-- Superadmin23: Verify super_admin
UPDATE public.profiles
SET 
    role = 'super_admin'::public.app_role,
    department = 'Executive Administration',
    updated_at = NOW()
WHERE LOWER(TRIM(email)) = 'superadmin23@gmail.com';

-- Admission24: Verify admission_counsellor
UPDATE public.profiles
SET 
    role = 'admission_counsellor'::public.app_role,
    department = 'Admission Department',
    updated_at = NOW()
WHERE LOWER(TRIM(email)) = 'admission24@gmail.com';

-- Academic25: Verify academic_counsellor
UPDATE public.profiles
SET 
    role = 'academic_counsellor'::public.app_role,
    department = 'Academic Counselling Department',
    updated_at = NOW()
WHERE LOWER(TRIM(email)) = 'academic25@gmail.com';

-- Academic3421: Verify academic_counsellor
UPDATE public.profiles
SET 
    role = 'academic_counsellor'::public.app_role,
    department = 'Academic Counselling Department',
    updated_at = NOW()
WHERE LOWER(TRIM(email)) = 'academic3421@gmail.com';

-- ── 3. IDEMPOTENT AVAILABILITY SCHEDULE FOR EXISTING ACADEMIC COUNSELLORS ─────
-- Monday to Saturday consultation slots (09:00 - 20:30, 30 min duration)
INSERT INTO public.counsellor_availability (
    counsellor_id, day_of_week, start_time, end_time, slot_duration_minutes, is_available, is_active
)
SELECT 
    p.id, d.day_of_week, '09:00:00'::TIME, '20:30:00'::TIME, 30, true, true
FROM public.profiles p
CROSS JOIN (SELECT generate_series(1, 6) AS day_of_week) d
WHERE p.role = 'academic_counsellor'
ON CONFLICT (counsellor_id, day_of_week, start_time, end_time) DO NOTHING;

-- ── 4. TRIGGER: CANONICAL DEPARTMENT SYNCHRONIZATION ON ROLE CHANGE ───────────
CREATE OR REPLACE FUNCTION public.handle_profile_role_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        IF NEW.role = 'super_admin' THEN
            NEW.department := 'Executive Administration';
        ELSIF NEW.role = 'admission_counsellor' THEN
            NEW.department := 'Admission Department';
        ELSIF NEW.role = 'academic_counsellor' THEN
            NEW.department := 'Academic Counselling Department';
        ELSIF NEW.role IS NULL THEN
            NEW.department := 'Unassigned';
        END IF;
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_profile_role_change ON public.profiles;
CREATE TRIGGER trg_profile_role_change
BEFORE UPDATE OF role ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.handle_profile_role_change();

-- ── 5. TRIGGER: PROTECT PRIVILEGED PROFILE FIELDS ─────────────────────────────
-- Blocks ordinary staff from escalating privileges, changing role, or altering status
CREATE OR REPLACE FUNCTION public.protect_profile_privileged_fields()
RETURNS TRIGGER AS $$
BEGIN
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

-- ── 6. TRIGGER: STRICT BASE PROFILE INITIALIZATION (NO UNTRUSTED ROLES) ───────
-- Strict Security: Never infer or assign a role from user-editable metadata.
-- All newly created auth accounts receive role = NULL and department = 'Unassigned'.
-- Roles are assigned strictly via authorized Super Admin processes or Edge Functions.
-- Schedule seeding is NOT done here to avoid duplicate insertion attempts.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER AS $$
BEGIN
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
        NULL,           -- STRICT: Always NULL initially
        'Unassigned',   -- STRICT: Canonical unassigned department
        true,
        10
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        full_name = CASE WHEN LENGTH(public.profiles.full_name) < 2 THEN EXCLUDED.full_name ELSE public.profiles.full_name END,
        updated_at = NOW();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, pg_temp;

-- Cleanly attach trigger to auth.users without disturbing unrelated triggers
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ── 7. SECURE RPC: ASSIGN_ADMIN_ROLE (STRICT CALLER VERIFICATION) ───────────────
-- Drop existing overloads to ensure clean definition
DROP FUNCTION IF EXISTS public.assign_admin_role(TEXT, public.app_role, TEXT);
DROP FUNCTION IF EXISTS public.assign_admin_role(TEXT, public.app_role);

CREATE OR REPLACE FUNCTION public.assign_admin_role(
    p_email TEXT,
    p_role public.app_role,
    p_department TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_clean_email TEXT := LOWER(TRIM(p_email));
    v_target_id UUID;
    v_dept TEXT;
    v_day INT;
    v_actor_id UUID;
    v_actor_name TEXT;
BEGIN
    -- Strict Caller Authentication & Authorization
    IF auth.uid() IS NULL THEN
        -- When called without JWT (e.g. Supabase SQL Editor / database console):
        IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
            RAISE EXCEPTION 'Access Denied: Anonymous execution is strictly prohibited.';
        END IF;
        v_actor_id := NULL; -- SQL Editor has no auth.uid(); never falsely record target as actor
        v_actor_name := 'Database Administrator (' || current_user || ')';
    ELSE
        -- When called via client API: Caller must be an active Super Admin
        IF public.current_user_role() IS DISTINCT FROM 'super_admin' THEN
            RAISE EXCEPTION 'Access Denied: Only an active Super Admin is authorized to assign staff roles.';
        END IF;
        v_actor_id := auth.uid();
        SELECT COALESCE(full_name, 'Super Admin') INTO v_actor_name
        FROM public.profiles WHERE id = auth.uid();
    END IF;

    IF v_clean_email IS NULL OR v_clean_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid email address format.');
    END IF;

    IF p_role IS NULL OR p_role NOT IN ('super_admin', 'admission_counsellor', 'academic_counsellor') THEN
        RETURN jsonb_build_object('success', false, 'message', 'Invalid role. Must be super_admin, admission_counsellor, or academic_counsellor.');
    END IF;

    -- Canonical department derived strictly server-side (arbitrary overrides ignored)
    v_dept := CASE 
        WHEN p_role = 'super_admin' THEN 'Executive Administration'
        WHEN p_role = 'academic_counsellor' THEN 'Academic Counselling Department'
        WHEN p_role = 'admission_counsellor' THEN 'Admission Department'
    END;

    -- Find profile by email (case-insensitive and trimmed)
    SELECT id INTO v_target_id 
    FROM public.profiles 
    WHERE LOWER(TRIM(email)) = v_clean_email;

    -- If profile row missing, link from auth.users
    IF v_target_id IS NULL THEN
        SELECT id INTO v_target_id 
        FROM auth.users 
        WHERE LOWER(TRIM(email)) = v_clean_email;
        
        IF v_target_id IS NULL THEN
            RETURN jsonb_build_object(
                'success', false, 
                'message', 'User account ' || p_email || ' not found in Authentication records. Please provision the user first in Supabase Auth.'
            );
        END IF;

        INSERT INTO public.profiles (
            id, email, full_name, role, department, daily_capacity
        ) VALUES (
            v_target_id,
            v_clean_email,
            INITCAP(SPLIT_PART(v_clean_email, '@', 1)),
            p_role,
            v_dept,
            10
        );
    ELSE
        UPDATE public.profiles
        SET 
            role = p_role,
            department = v_dept,
            updated_at = NOW()
        WHERE id = v_target_id;
    END IF;

    -- If academic counsellor, ensure consultation schedule exists (never duplicate)
    IF p_role = 'academic_counsellor' THEN
        FOR v_day IN 1..6 LOOP
            INSERT INTO public.counsellor_availability (
                counsellor_id, day_of_week, start_time, end_time, slot_duration_minutes, is_available, is_active
            ) VALUES (
                v_target_id, v_day, '09:00:00'::TIME, '20:30:00'::TIME, 30, true, true
            ) ON CONFLICT (counsellor_id, day_of_week, start_time, end_time) DO NOTHING;
        END LOOP;
    END IF;

    -- Trusted audit log with true actor identity
    INSERT INTO public.activity_logs (
        actor_id, actor_name, actor_role, action_type, description, target_entity_type, target_entity_id, metadata
    ) VALUES (
        v_actor_id,
        COALESCE(v_actor_name, 'Super Admin'),
        'super_admin',
        'role_assigned',
        'Staff role ' || p_role::TEXT || ' assigned to ' || v_clean_email || ' with department ' || v_dept || '.',
        'profile',
        v_target_id,
        jsonb_build_object('email', v_clean_email, 'role', p_role::TEXT, 'department', v_dept)
    );

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Role successfully assigned to ' || p_email || ' as ' || p_role::TEXT || '.',
        'profile_id', v_target_id,
        'role', p_role::TEXT,
        'department', v_dept
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth, pg_temp;

REVOKE ALL ON FUNCTION public.assign_admin_role(TEXT, public.app_role, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_admin_role(TEXT, public.app_role, TEXT) TO authenticated, service_role;

-- ── 8. DROP INSECURE SQL-LEVEL USER INSERTION FUNCTIONS ────────────────────────
DROP FUNCTION IF EXISTS public.admin_create_counsellor(TEXT, TEXT, TEXT, public.app_role, TEXT, TEXT, INT);
DROP TRIGGER IF EXISTS trg_auto_role_new_profile ON public.profiles;
