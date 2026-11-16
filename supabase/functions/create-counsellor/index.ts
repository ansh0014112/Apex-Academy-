// Apex Academy — Production Staff Provisioning Edge Function
// Location: supabase/functions/create-counsellor/index.ts
//
// Purpose: Allows active Super Admins to provision Counsellor accounts
// securely using the server-side service_role key with complete transactional
// compensation (rollback) if any step fails.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  // 1. Handle CORS Preflight request
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only allow POST requests
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST." }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let createdUserId: string | null = null;
  let adminClient: any = null;

  try {
    // 2. Validate server environment secrets
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY on Edge Function environment.");
    }
    if (!anonKey) {
      throw new Error("Missing SUPABASE_ANON_KEY on Edge Function environment.");
    }

    // 3. Authenticate caller using incoming JWT Bearer token with public/anon key
    // STRICT: Never use serviceRoleKey as a fallback for caller authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid Authorization header. Super Admin session required." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract raw JWT token
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Empty Bearer token provided. Super Admin session required." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const effectiveAnonKey = anonKey || "sb_publishable_eO75hkRFASOuX6qQz1QVqg__Vf7wYWK";
    const callerClient = createClient(supabaseUrl, effectiveAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Pass token explicitly to getUser(token) to authenticate statelessly in Edge Function environment
    const { data: { user: callerUser }, error: callerError } = await callerClient.auth.getUser(token);
    if (callerError || !callerUser) {
      console.warn("[create-counsellor] Auth failed:", callerError?.message);
      return new Response(
        JSON.stringify({
          error: "Invalid or expired session token.",
          details: callerError?.message || "Token verification failed.",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initialize privileged admin client strictly for internal database operations
    adminClient = createClient(supabaseUrl, serviceRoleKey);

    // 4. Verify that caller has an ACTIVE SUPER ADMIN profile in public.profiles
    const { data: callerProfile, error: profileCheckError } = await adminClient
      .from("profiles")
      .select("id, full_name, role, is_active")
      .eq("id", callerUser.id)
      .single();

    if (
      profileCheckError ||
      !callerProfile ||
      callerProfile.role !== "super_admin" ||
      callerProfile.is_active !== true
    ) {
      return new Response(
        JSON.stringify({
          error: "Forbidden: Only active Super Admins are authorized to provision staff accounts.",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Parse and strictly validate request payload
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON request body." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const {
      email,
      password,
      full_name,
      role,
      specialisation,
      phone,
      daily_capacity,
    } = body;

    // Type validation before invoking any string methods
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof full_name !== "string" ||
      typeof role !== "string"
    ) {
      return new Response(
        JSON.stringify({
          error: "Invalid input types: email, password, full_name, and role must be strings.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Email validation
    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!cleanEmail || !emailRegex.test(cleanEmail)) {
      return new Response(
        JSON.stringify({ error: "Invalid email address format." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Password validation (never logged)
    if (password.length < 8) {
      return new Response(
        JSON.stringify({ error: "Password must be at least 8 characters long." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Full name validation
    const cleanFullName = full_name.trim();
    if (cleanFullName.length < 2 || cleanFullName.length > 100) {
      return new Response(
        JSON.stringify({ error: "Full name must be between 2 and 100 characters long." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Role validation: Restrict strictly to counsellor roles
    // Prohibit super_admin creation through this ordinary counsellor endpoint
    const cleanRole = role.trim();
    const allowedRoles = ["admission_counsellor", "academic_counsellor"];
    if (!allowedRoles.includes(cleanRole)) {
      return new Response(
        JSON.stringify({
          error: `Invalid role specified. Only counsellors can be provisioned via this function (${allowedRoles.join(", ")}).`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Derive canonical department strictly server-side (never trust frontend department input)
    const cleanDepartment = cleanRole === "admission_counsellor"
      ? "Admission Department"
      : "Academic Counselling Department";

    // Optional phone validation: strict 10 digits
    let cleanPhone: string | null = null;
    if (phone !== undefined && phone !== null && phone !== "") {
      let rawPhoneStr: string;
      if (typeof phone === "string") {
        rawPhoneStr = phone.trim();
      } else if (typeof phone === "number" && Number.isInteger(phone)) {
        rawPhoneStr = phone.toString();
      } else {
        return new Response(
          JSON.stringify({ error: "Phone number must be a valid string or whole integer." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const digits = rawPhoneStr.replace(/\D/g, "");
      if (digits.length !== 10) {
        return new Response(
          JSON.stringify({ error: "Staff phone number must contain exactly 10 digits." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      cleanPhone = digits;
    }

    // Daily capacity validation: strict integer between 1 and 50
    let capacity = 10;
    if (daily_capacity !== undefined && daily_capacity !== null && daily_capacity !== "") {
      let parsedCapacity: number;
      if (typeof daily_capacity === "number") {
        if (!Number.isInteger(daily_capacity)) {
          return new Response(
            JSON.stringify({ error: "Daily capacity must be a whole integer; decimal numbers are not permitted." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        parsedCapacity = daily_capacity;
      } else if (typeof daily_capacity === "string") {
        const trimmedCap = daily_capacity.trim();
        if (!/^\d+$/.test(trimmedCap)) {
          return new Response(
            JSON.stringify({ error: "Daily capacity must be a strict integer between 1 and 50." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        parsedCapacity = parseInt(trimmedCap, 10);
      } else {
        return new Response(
          JSON.stringify({ error: "Daily capacity must be a valid number or numeric string." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (isNaN(parsedCapacity) || parsedCapacity < 1 || parsedCapacity > 50) {
        return new Response(
          JSON.stringify({ error: "Daily capacity must be an integer between 1 and 50." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      capacity = parsedCapacity;
    }

    // Optional specialisation string
    let cleanSpecialisation: string | null = null;
    if (typeof specialisation === "string" && specialisation.trim().length > 0) {
      cleanSpecialisation = specialisation.trim().slice(0, 150);
    }

    // 6. Step A: Create Auth User via Supabase Admin API
    const { data: newUserData, error: createAuthError } = await adminClient.auth.admin.createUser({
      email: cleanEmail,
      password: password,
      email_confirm: true, // Pre-confirm email so staff can log in immediately
      user_metadata: {
        full_name: cleanFullName,
      },
    });

    if (createAuthError || !newUserData?.user) {
      return new Response(
        JSON.stringify({
          error: createAuthError?.message || "Failed to create authentication user account.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    createdUserId = newUserData.user.id;

    // 7. Step B: Configure Profile in public.profiles
    // Inspect whether base profile was created by the Auth trigger
    const { data: existingProfile } = await adminClient
      .from("profiles")
      .select("id, role, department")
      .eq("id", createdUserId)
      .maybeSingle();

    let newProfile = null;

    if (existingProfile) {
      // Base profile exists from trigger; update it with validated role and canonical department
      const { data: updatedProfile, error: profileUpdateError } = await adminClient
        .from("profiles")
        .update({
          full_name: cleanFullName,
          email: cleanEmail,
          role: cleanRole,
          department: cleanDepartment,
          specialisation: cleanSpecialisation,
          daily_capacity: capacity,
          phone: cleanPhone,
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", createdUserId)
        .select("id, full_name, email, role, department, specialisation, daily_capacity, phone, is_active, created_at")
        .single();

      if (profileUpdateError) {
        console.error("Profile configuration failed. Compensating rollback triggered:", profileUpdateError.message);
        await adminClient.auth.admin.deleteUser(createdUserId);
        createdUserId = null;
        return new Response(
          JSON.stringify({
            error: "Failed to configure staff profile: " + profileUpdateError.message,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      newProfile = updatedProfile;
    } else {
      // In case trigger was bypassed, insert matching createdUserId exactly
      const { data: insertedProfile, error: profileInsertError } = await adminClient
        .from("profiles")
        .insert({
          id: createdUserId,
          full_name: cleanFullName,
          email: cleanEmail,
          role: cleanRole,
          department: cleanDepartment,
          specialisation: cleanSpecialisation,
          daily_capacity: capacity,
          phone: cleanPhone,
          is_active: true,
        })
        .select("id, full_name, email, role, department, specialisation, daily_capacity, phone, is_active, created_at")
        .single();

      if (profileInsertError) {
        console.error("Profile insertion failed. Compensating rollback triggered:", profileInsertError.message);
        await adminClient.auth.admin.deleteUser(createdUserId);
        createdUserId = null;
        return new Response(
          JSON.stringify({
            error: "Failed to configure staff profile: " + profileInsertError.message,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      newProfile = insertedProfile;
    }

    // 8. Step C: Initialize Academic Availability Schedule (Authoritative Location)
    // Seeding is performed exactly once; existing availability is never duplicated
    if (cleanRole === "academic_counsellor") {
      const { data: existingSlots } = await adminClient
        .from("counsellor_availability")
        .select("id")
        .eq("counsellor_id", createdUserId);

      if (!existingSlots || existingSlots.length === 0) {
        const workingDays = [1, 2, 3, 4, 5, 6]; // Monday to Saturday
        const availabilitySlots = workingDays.map((dow) => ({
          counsellor_id: createdUserId,
          day_of_week: dow,
          start_time: "09:00:00",
          end_time: "20:30:00",
          slot_duration_minutes: 30,
          is_available: true,
          is_active: true,
        }));

        const { error: availabilityError } = await adminClient
          .from("counsellor_availability")
          .insert(availabilitySlots);

        if (availabilityError) {
          console.error("Availability setup failed. Compensating rollback triggered:", availabilityError.message);
          // Rollback newly created user records only
          await adminClient.from("counsellor_availability").delete().eq("counsellor_id", createdUserId);
          await adminClient.from("profiles").delete().eq("id", createdUserId);
          await adminClient.auth.admin.deleteUser(createdUserId);
          createdUserId = null;
          return new Response(
            JSON.stringify({
              error: "Failed to initialize counsellor schedule: " + availabilityError.message,
            }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    // 9. Step D: Record Server-Side Trusted Audit Log
    const { error: logError } = await adminClient.from("activity_logs").insert({
      actor_id: callerUser.id,
      actor_name: callerProfile.full_name || "Super Admin",
      actor_role: "super_admin",
      action_type: "counsellor_provisioned",
      description: `Staff member ${cleanFullName} (${cleanRole}) provisioned by Super Admin.`,
      target_entity_type: "profile",
      target_entity_id: createdUserId,
      metadata: {
        provisioned_email: cleanEmail,
        provisioned_role: cleanRole,
        department: cleanDepartment,
        daily_capacity: capacity,
      },
    });

    if (logError) {
      console.warn("Audit logging notice (non-fatal):", logError.message);
    }

    // 10. Return success response
    const successUserId = createdUserId;
    createdUserId = null; // Mark completed successfully

    return new Response(
      JSON.stringify({
        success: true,
        message: `Staff member ${cleanFullName} (${cleanRole}) provisioned successfully.`,
        user: {
          id: newProfile.id,
          full_name: newProfile.full_name,
          email: newProfile.email,
          role: newProfile.role,
          department: newProfile.department,
          specialisation: newProfile.specialisation,
          daily_capacity: newProfile.daily_capacity,
          is_active: newProfile.is_active,
        },
      }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("Unexpected Edge Function Exception:", err?.message || err);

    // If an error occurred mid-process after user creation, rollback only the newly created user
    if (createdUserId && adminClient) {
      try {
        console.warn("Emergency rollback triggered for user:", createdUserId);
        await adminClient.from("counsellor_availability").delete().eq("counsellor_id", createdUserId);
        await adminClient.from("profiles").delete().eq("id", createdUserId);
        await adminClient.auth.admin.deleteUser(createdUserId);
      } catch (cleanupErr: any) {
        console.error("Emergency rollback cleanup failure:", cleanupErr?.message || cleanupErr);
      }
    }

    return new Response(
      JSON.stringify({ error: err?.message || "An unexpected internal server error occurred." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
