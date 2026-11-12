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
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY on Edge Function environment.");
    }

    // 3. Authenticate the caller using the incoming JWT Bearer token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid Authorization header. Super Admin session required." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Client using caller's JWT to verify identity and get user profile
    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || serviceRoleKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user: callerUser }, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !callerUser) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session token.", details: callerError?.message }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initialize privileged admin client for server-side operations
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

    // 5. Parse and validate request body
    const body = await req.json();
    const {
      email,
      password,
      full_name,
      role,
      department,
      specialisation,
      phone,
      daily_capacity,
    } = body;

    // Validate Required Fields
    if (!email || !password || !full_name || !role) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: email, password, full_name, and role are mandatory.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!emailRegex.test(cleanEmail)) {
      return new Response(
        JSON.stringify({ error: "Invalid email address format." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (typeof password !== "string" || password.length < 8) {
      return new Response(
        JSON.stringify({ error: "Password must be at least 8 characters long." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cleanFullName = full_name.trim();
    if (cleanFullName.length < 2) {
      return new Response(
        JSON.stringify({ error: "Full name must be at least 2 characters long." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Restrict staff creation to permitted counsellor roles
    // (Prevents unauthorized creation of additional Super Admins via this endpoint)
    const allowedRoles = ["admission_counsellor", "academic_counsellor"];
    if (!allowedRoles.includes(role)) {
      return new Response(
        JSON.stringify({
          error: `Invalid role specified. Only counsellors can be provisioned via this function (${allowedRoles.join(", ")}).`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Determine consistent department default
    const cleanDepartment = department && department.trim().length > 0
      ? department.trim()
      : (role === "admission_counsellor" ? "Admissions" : "Academic Counselling");

    // Clean phone number (optional)
    let cleanPhone = null;
    if (phone && phone.trim().length > 0) {
      const digits = phone.replace(/\D/g, "");
      cleanPhone = digits.length > 10 ? digits.slice(-10) : digits;
      if (cleanPhone.length !== 10) {
        return new Response(
          JSON.stringify({ error: "Staff phone number must be a valid 10-digit number." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Capacity validation
    let capacity = 10;
    if (daily_capacity !== undefined && daily_capacity !== null) {
      const parsedCapacity = parseInt(daily_capacity, 10);
      if (isNaN(parsedCapacity) || parsedCapacity < 1 || parsedCapacity > 50) {
        return new Response(
          JSON.stringify({ error: "Daily capacity must be an integer between 1 and 50." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      capacity = parsedCapacity;
    }

    // 6. Step A: Create Auth User via Supabase Admin API
    const { data: newUserData, error: createAuthError } = await adminClient.auth.admin.createUser({
      email: cleanEmail,
      password: password,
      email_confirm: true, // Pre-confirm email so staff can log in immediately
      user_metadata: {
        full_name: cleanFullName,
        role: role,
        department: cleanDepartment,
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

    // 7. Step B: Insert Profile into public.profiles
    const profilePayload = {
      id: createdUserId,
      full_name: cleanFullName,
      email: cleanEmail,
      role: role,
      department: cleanDepartment,
      specialisation: specialisation ? specialisation.trim() : null,
      daily_capacity: capacity,
      phone: cleanPhone,
      is_active: true,
      updated_at: new Date().toISOString(),
    };

    const { data: newProfile, error: profileInsertError } = await adminClient
      .from("profiles")
      .upsert(profilePayload)
      .select("id, full_name, email, role, department, specialisation, daily_capacity, phone, is_active, created_at")
      .single();

    if (profileInsertError) {
      // Rollback: Delete the newly created auth user to avoid orphan accounts
      console.error("Profile configuration failed. Compensating rollback triggered:", profileInsertError);
      await adminClient.auth.admin.deleteUser(createdUserId);
      return new Response(
        JSON.stringify({
          error: "Failed to configure staff profile: " + profileInsertError.message,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 8. Step C: Initialize Counsellor Availability Schedule (Mon-Sat, 09:00 - 20:30)
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
      // Rollback: Delete profile and delete auth user
      console.error("Availability setup failed. Compensating rollback triggered:", availabilityError);
      await adminClient.from("profiles").delete().eq("id", createdUserId);
      await adminClient.auth.admin.deleteUser(createdUserId);
      return new Response(
        JSON.stringify({
          error: "Failed to initialize counsellor schedule: " + availabilityError.message,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 9. Step D: Record Server-Side Trusted Audit Log
    const { error: logError } = await adminClient.from("activity_logs").insert({
      actor_id: callerUser.id,
      actor_name: callerProfile.full_name || "Super Admin",
      actor_role: "super_admin",
      action_type: "counsellor_provisioned",
      description: `Staff member ${cleanFullName} (${role}) provisioned by Super Admin.`,
      target_entity_type: "profile",
      target_entity_id: createdUserId,
      metadata: {
        provisioned_email: cleanEmail,
        provisioned_role: role,
        department: cleanDepartment,
        daily_capacity: capacity,
      },
    });

    if (logError) {
      console.warn("Audit logging notice (non-fatal):", logError.message);
    }

    // 10. Return success response
    return new Response(
      JSON.stringify({
        success: true,
        message: `Staff member ${cleanFullName} (${role}) provisioned successfully.`,
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
    console.error("Unexpected Edge Function Exception:", err);

    // If an error occurred after user creation, attempt compensation cleanup
    if (createdUserId && adminClient) {
      try {
        console.warn("Attempting emergency compensation cleanup for user:", createdUserId);
        await adminClient.from("counsellor_availability").delete().eq("counsellor_id", createdUserId);
        await adminClient.from("profiles").delete().eq("id", createdUserId);
        await adminClient.auth.admin.deleteUser(createdUserId);
      } catch (cleanupErr) {
        console.error("Compensation cleanup error:", cleanupErr);
      }
    }

    return new Response(
      JSON.stringify({ error: err.message || "An unexpected internal server error occurred." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
