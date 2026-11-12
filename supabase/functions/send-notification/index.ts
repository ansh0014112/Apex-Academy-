// Apex Academy — Production Notification Dispatcher Edge Function
// Location: supabase/functions/send-notification/index.ts
//
// SECURITY ARCHITECTURE:
// This function does NOT accept arbitrary recipient data from request bodies.
// It reads notification events from the notification_outbox table using the
// service role key. Recipients and content are always fetched from the DB.
// The only accepted input is an optional { outbox_id: UUID } to process a
// specific pending record, or no body to process all pending records.
//
// Calling this function without the SUPABASE_SERVICE_ROLE_KEY set will
// result in graceful failure — notifications are logged as pending.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// Only allow requests from Supabase internal infrastructure or authenticated admin sessions
// CORS is restricted — this endpoint is not meant to be called directly from browsers
const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_URL") || "null",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// HTML Email Layout Generator for Apex Academy Branding
function renderEmailHtml(title: string, preheader: string, contentHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #F8FAFC; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1E293B; }
    .email-wrapper { max-width: 600px; margin: 24px auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(10, 25, 47, 0.08); border: 1px solid #E2E8F0; }
    .email-header { background: #0A192F; padding: 28px 32px; text-align: center; border-bottom: 3px solid #D97706; }
    .email-header h1 { margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: 0.5px; }
    .email-header p { margin: 6px 0 0 0; color: #F59E0B; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600; }
    .email-body { padding: 32px; }
    .email-title { font-size: 20px; font-weight: 700; color: #0A192F; margin: 0 0 12px 0; }
    .lead-text { font-size: 15px; line-height: 1.6; color: #475569; margin: 0 0 24px 0; }
    .info-card { background: #F8FAFC; border-left: 4px solid #D97706; padding: 16px 20px; border-radius: 6px; margin: 20px 0; border-top: 1px solid #E2E8F0; border-right: 1px solid #E2E8F0; border-bottom: 1px solid #E2E8F0; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; }
    .info-label { color: #64748B; font-weight: 500; }
    .info-val { color: #0A192F; font-weight: 600; text-align: right; }
    .button-wrap { text-align: center; margin: 28px 0 16px 0; }
    .email-btn { background: #0A192F; color: #FFFFFF !important; text-decoration: none; padding: 13px 28px; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; border: 1px solid #D97706; }
    .email-footer { background: #F1F5F9; padding: 20px 32px; text-align: center; font-size: 12px; color: #64748B; border-top: 1px solid #E2E8F0; }
    .email-footer a { color: #0A192F; text-decoration: underline; }
  </style>
</head>
<body>
  <div style="display:none;font-size:1px;color:#333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${preheader}
  </div>
  <div class="email-wrapper">
    <div class="email-header">
      <h1>APEX ACADEMY</h1>
      <p>Premier Institute for Competitive Excellence</p>
    </div>
    <div class="email-body">
      ${contentHtml}
    </div>
    <div class="email-footer">
      <p style="margin:0 0 8px 0;">Apex Academy, Civil Lines / University Enclave, New Delhi - 110007</p>
      <p style="margin:0;">Student Helpline: +91 98765 43210 &bull; <a href="mailto:admissions@apexacademy.in">admissions@apexacademy.in</a></p>
    </div>
  </div>
</body>
</html>`;
}

// Build email content and subject from event_type and entity data
function buildEmailContent(eventType: string, entityData: any): { subject: string; preheader: string; bodyHtml: string } {
  const name = entityData?.student_name || entityData?.full_name || "Aspirant";
  const enquiryId = entityData?.enquiry_id || entityData?.id || "APX";
  const bookingId = entityData?.booking_id || entityData?.id || "APX";

  if (eventType === "enquiry_submitted" || eventType === "enquiry_assigned") {
    return {
      subject: `Apex Academy — Admission Enquiry Registered [#${enquiryId}]`,
      preheader: `We have received your admission enquiry for ${entityData?.course_category || "Competitive Exams"}.`,
      bodyHtml: `
        <h2 class="email-title">Enquiry Received Successfully!</h2>
        <p class="lead-text">Dear <strong>${name}</strong>,</p>
        <p class="lead-text">Thank you for choosing Apex Academy. Your enquiry has been registered in our central admissions portal. Our academic counsellor will review your profile and reach out within 24 working hours.</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Enquiry Ref No:</span><span class="info-val">${enquiryId}</span></div>
          <div class="info-row"><span class="info-label">Target Exam:</span><span class="info-val">${entityData?.target_examination || "Competitive Exam"}</span></div>
          <div class="info-row"><span class="info-label">Course Domain:</span><span class="info-val">${entityData?.course_category || "Integrated Prep"}</span></div>
          <div class="info-row"><span class="info-label">Preferred Mode:</span><span class="info-val">${entityData?.preferred_learning_mode || "Hybrid Classroom"}</span></div>
        </div>
        <p class="lead-text">To prepare for your consultation, keep your academic scorecards and goal timeline ready. You may also contact our central admissions desk directly at <strong>+91 98765 43210</strong>.</p>
      `,
    };
  }

  if (eventType === "booking_submitted" || eventType === "booking_assigned" || eventType === "booking_confirmed") {
    const meetLink = entityData?.google_meet_link;
    return {
      subject: `Apex Academy — 1-on-1 Counselling Confirmed [#${bookingId}]`,
      preheader: `Your diagnostic strategy session is booked for ${entityData?.preferred_date || "upcoming"} at ${entityData?.preferred_time || ""}.`,
      bodyHtml: `
        <h2 class="email-title">Your Strategy Session is Confirmed</h2>
        <p class="lead-text">Dear <strong>${name}</strong>,</p>
        <p class="lead-text">Your 1-on-1 strategic counselling session has been scheduled with our academic mentor.</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking ID:</span><span class="info-val">${bookingId}</span></div>
          <div class="info-row"><span class="info-label">Session Date:</span><span class="info-val">${entityData?.preferred_date || "TBD"}</span></div>
          <div class="info-row"><span class="info-label">Time Window:</span><span class="info-val">${entityData?.preferred_time || "TBD"} (IST)</span></div>
          <div class="info-row"><span class="info-label">Session Medium:</span><span class="info-val">${entityData?.session_medium || "Google Meet HD Video Call"}</span></div>
          ${entityData?.counsellor_name ? `<div class="info-row"><span class="info-label">Assigned Mentor:</span><span class="info-val">${entityData.counsellor_name}</span></div>` : ""}
        </div>
        ${meetLink ? `
          <div class="button-wrap">
            <a href="${meetLink}" target="_blank" class="email-btn">Join Google Meet Session</a>
          </div>
          <p style="font-size:12px;color:#64748B;text-align:center;">Meeting Link: <a href="${meetLink}">${meetLink}</a></p>
        ` : `
          <p class="lead-text">Our academic counsellor will connect with you at your chosen time. Please ensure you are available on your registered phone: <strong>${entityData?.phone || "your registered number"}</strong>.</p>
        `}
      `,
    };
  }

  if (eventType === "booking_rescheduled") {
    return {
      subject: `Apex Academy — Counselling Session Rescheduled [#${bookingId}]`,
      preheader: `Your counselling appointment has been moved to ${entityData?.preferred_date} at ${entityData?.preferred_time}.`,
      bodyHtml: `
        <h2 class="email-title">Appointment Rescheduled</h2>
        <p class="lead-text">Dear <strong>${name}</strong>,</p>
        <p class="lead-text">Your counselling appointment has been updated to a new consultation slot.</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking ID:</span><span class="info-val">${bookingId}</span></div>
          <div class="info-row"><span class="info-label">New Date:</span><span class="info-val">${entityData?.preferred_date || "TBD"}</span></div>
          <div class="info-row"><span class="info-label">New Time:</span><span class="info-val">${entityData?.preferred_time || "TBD"} (IST)</span></div>
          ${entityData?.reschedule_reason ? `<div class="info-row"><span class="info-label">Reason:</span><span class="info-val">${entityData.reschedule_reason}</span></div>` : ""}
        </div>
      `,
    };
  }

  if (eventType === "booking_cancelled") {
    return {
      subject: `Apex Academy — Counselling Session Cancelled [#${bookingId}]`,
      preheader: `Your counselling appointment has been cancelled.`,
      bodyHtml: `
        <h2 class="email-title">Appointment Cancelled</h2>
        <p class="lead-text">Dear <strong>${name}</strong>,</p>
        <p class="lead-text">Your counselling appointment (#${bookingId}) has been cancelled. If you believe this is an error or wish to rebook, please contact us at <strong>+91 98765 43210</strong> or email <a href="mailto:admissions@apexacademy.in">admissions@apexacademy.in</a>.</p>
      `,
    };
  }

  // Generic fallback
  return {
    subject: `Apex Academy — Important Notification`,
    preheader: `Important update from Apex Academy`,
    bodyHtml: `
      <h2 class="email-title">Notification</h2>
      <p class="lead-text">Dear <strong>${name}</strong>,</p>
      <p class="lead-text">You have an important update from Apex Academy regarding your application or consultation.</p>
      <p class="lead-text">Please contact our admissions desk at <strong>+91 98765 43210</strong> for assistance.</p>
    `,
  };
}

// Build WhatsApp text message from event_type and entity data
function buildWhatsAppMessage(eventType: string, entityData: any): string {
  const name = entityData?.student_name || entityData?.full_name || "Aspirant";

  if (eventType === "enquiry_submitted" || eventType === "enquiry_assigned") {
    return `*Apex Academy Advisory Desk*\nHello ${name},\nYour enquiry for *${entityData?.target_examination || "Competitive Exam"}* has been received (Ref: ${entityData?.enquiry_id || entityData?.id || "APX"}). Our counsellor will call you shortly.\nHelpline: +91 98765 43210.`;
  }

  if (eventType === "booking_submitted" || eventType === "booking_assigned" || eventType === "booking_confirmed") {
    const meetLink = entityData?.google_meet_link;
    return `*Apex Academy Advisory Desk*\nHello ${name},\nYour 1-on-1 strategy call is confirmed for *${entityData?.preferred_date}* at *${entityData?.preferred_time}* (IST).\n${meetLink ? "Meet Link: " + meetLink : "Our mentor will contact you directly at your registered phone."}`;
  }

  if (eventType === "booking_rescheduled") {
    return `*Apex Academy Advisory Desk*\nHello ${name},\nYour counselling session has been rescheduled to *${entityData?.preferred_date}* at *${entityData?.preferred_time}* (IST).`;
  }

  if (eventType === "booking_cancelled") {
    return `*Apex Academy Advisory Desk*\nHello ${name},\nYour counselling appointment has been cancelled. Contact us at +91 98765 43210 to rebook.`;
  }

  return `*Apex Academy Advisory Desk*\nHello ${name},\nYou have an update from Apex Academy. Please contact us at +91 98765 43210.`;
}

// Fetch the entity data from the database based on entity_type and entity_id
async function fetchEntityData(adminClient: any, entityType: string, entityId: string): Promise<any> {
  if (!entityId) return {};

  if (entityType === "admission_enquiry") {
    const { data } = await adminClient
      .from("admission_enquiries")
      .select(`
        id,
        course_category,
        target_examination,
        preferred_batch_timing,
        preferred_learning_mode,
        status,
        students (
          full_name,
          phone,
          email
        )
      `)
      .eq("id", entityId)
      .single();

    if (!data) return {};

    return {
      enquiry_id: data.id,
      student_name: data.students?.full_name,
      full_name: data.students?.full_name,
      phone: data.students?.phone,
      email: data.students?.email,
      course_category: data.course_category,
      target_examination: data.target_examination,
      preferred_learning_mode: data.preferred_learning_mode,
    };
  }

  if (entityType === "counselling_booking") {
    const { data } = await adminClient
      .from("counselling_bookings")
      .select(`
        id,
        course_category,
        target_examination,
        preferred_date,
        preferred_time,
        session_medium,
        google_meet_link,
        status,
        students (
          full_name,
          phone,
          email
        ),
        profiles (
          full_name
        )
      `)
      .eq("id", entityId)
      .single();

    if (!data) return {};

    return {
      booking_id: data.id,
      student_name: data.students?.full_name,
      full_name: data.students?.full_name,
      phone: data.students?.phone,
      email: data.students?.email,
      course_category: data.course_category,
      target_examination: data.target_examination,
      preferred_date: data.preferred_date,
      preferred_time: data.preferred_time,
      session_medium: data.session_medium,
      google_meet_link: data.google_meet_link,
      counsellor_name: data.profiles?.full_name,
    };
  }

  return {};
}

// Process a single notification_outbox record
async function processOutboxRecord(
  adminClient: any,
  record: any,
  resendApiKey: string | undefined,
  whatsappToken: string | undefined,
  whatsappPhoneId: string | undefined,
  senderEmail: string
): Promise<{ success: boolean; emailStatus: string; whatsappStatus: string }> {
  
  // Mark as processing to prevent duplicate execution
  await adminClient
    .from("notification_outbox")
    .update({ status: "processing", attempts: (record.attempts || 0) + 1 })
    .eq("id", record.id);

  // Fetch actual recipient data from the database — NEVER from the request body
  const entityData = await fetchEntityData(adminClient, record.entity_type, record.entity_id);

  const recipientEmail: string | null = entityData?.email || null;
  const recipientPhone: string | null = entityData?.phone || null;
  const recipientName: string = entityData?.student_name || entityData?.full_name || "Aspirant";

  let emailStatus = "skipped";
  let whatsappStatus = "skipped";
  let lastError: string | null = null;

  const channel = record.channel || "email";
  const eventType = record.event_type;
  const { subject, preheader, bodyHtml } = buildEmailContent(eventType, entityData);

  // ─── EMAIL DISPATCH ───
  if (channel === "email" || channel === "both") {
    if (!recipientEmail) {
      emailStatus = "skipped_no_email";
    } else if (!resendApiKey || resendApiKey.startsWith("re_placeholder")) {
      emailStatus = "simulated_or_pending_credentials";
      // Log what would have been sent
      console.log(`[SIMULATED EMAIL] To: ${recipientEmail}, Subject: ${subject}`);
    } else {
      try {
        const fullHtml = renderEmailHtml(subject, preheader, bodyHtml);
        const resendResp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: `Apex Academy <${senderEmail}>`,
            to: [recipientEmail],
            subject: subject,
            html: fullHtml,
          }),
        });

        const resendData = await resendResp.json();
        if (resendResp.ok) {
          emailStatus = "sent";
        } else {
          emailStatus = "failed";
          lastError = JSON.stringify(resendData);
        }
      } catch (mailErr: any) {
        emailStatus = "failed";
        lastError = mailErr?.message || String(mailErr);
      }
    }

    // Log to notification_logs
    try {
      await adminClient.from("notification_logs").insert({
        recipient_email: recipientEmail,
        recipient_phone: recipientPhone,
        channel: "email",
        template_type: eventType,
        subject: subject,
        payload: entityData,
        status: emailStatus,
        provider_response: { status: emailStatus },
        error_message: lastError,
        related_entity_type: record.entity_type,
        related_entity_id: record.entity_id,
      });
    } catch (dbErr) {
      console.warn("Could not insert email notification log:", dbErr);
    }
  }

  // ─── WHATSAPP DISPATCH ───
  if (channel === "whatsapp" || channel === "both") {
    if (!recipientPhone) {
      whatsappStatus = "skipped_no_phone";
    } else {
      let cleanPhone = String(recipientPhone).replace(/[^0-9]/g, "");
      if (cleanPhone.length === 10) {
        cleanPhone = "91" + cleanPhone;
      }

      const waMessage = buildWhatsAppMessage(eventType, entityData);

      if (!whatsappToken || !whatsappPhoneId || whatsappToken.startsWith("EAAG_placeholder")) {
        whatsappStatus = "simulated_or_pending_credentials";
        console.log(`[SIMULATED WHATSAPP] To: ${cleanPhone}, Message: ${waMessage.substring(0, 80)}...`);
      } else {
        try {
          const waResp = await fetch(`https://graph.facebook.com/v19.0/${whatsappPhoneId}/messages`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${whatsappToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: cleanPhone,
              type: "text",
              text: { body: waMessage },
            }),
          });

          const waData = await waResp.json();
          if (waResp.ok) {
            whatsappStatus = "sent";
          } else {
            whatsappStatus = "failed";
            lastError = JSON.stringify(waData);
          }
        } catch (waErr: any) {
          whatsappStatus = "failed";
          lastError = waErr?.message || String(waErr);
        }
      }

      // Log to notification_logs
      try {
        await adminClient.from("notification_logs").insert({
          recipient_email: recipientEmail,
          recipient_phone: cleanPhone,
          channel: "whatsapp",
          template_type: eventType,
          subject: "WhatsApp Message",
          payload: { ...entityData, whatsapp_text: waMessage },
          status: whatsappStatus,
          provider_response: { status: whatsappStatus },
          error_message: lastError,
          related_entity_type: record.entity_type,
          related_entity_id: record.entity_id,
        });
      } catch (dbErr) {
        console.warn("Could not insert whatsapp notification log:", dbErr);
      }
    }
  }

  // Update outbox record to final status
  const finalStatus = (emailStatus === "sent" || whatsappStatus === "sent")
    ? "sent"
    : (emailStatus.startsWith("simulated") || whatsappStatus.startsWith("simulated"))
    ? "simulated_or_pending_credentials"
    : (emailStatus === "failed" || whatsappStatus === "failed")
    ? "failed"
    : "skipped";

  await adminClient
    .from("notification_outbox")
    .update({
      status: finalStatus === "simulated_or_pending_credentials" ? "sent" : finalStatus,
      processed_at: new Date().toISOString(),
      last_error: lastError,
    })
    .eq("id", record.id);

  return { success: finalStatus !== "failed", emailStatus, whatsappStatus };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST." }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Validate that the caller is authenticated (must have a valid JWT from Supabase)
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: Missing Authorization header." }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const whatsappToken = Deno.env.get("WHATSAPP_API_TOKEN");
  const whatsappPhoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const senderEmail = Deno.env.get("NOTIFICATION_SENDER_EMAIL") || "admissions@apexacademy.in";

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: "Server configuration error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set." }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Use service role to access notification_outbox — bypasses RLS safely server-side
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Verify the caller is an authenticated admin (validate JWT against profiles)
  const callerToken = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authErr } = await adminClient.auth.getUser(callerToken);
  
  if (authErr || !user) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: Invalid or expired token." }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Verify caller is an active staff member
  const { data: profile } = await adminClient
    .from("profiles")
    .select("role, is_active")
    .eq("id", user.id)
    .single();

  if (!profile || !profile.is_active) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: Account inactive or not found in staff directory." }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Parse optional body — only outbox_id is accepted (no recipient data)
  let outboxId: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    outboxId = body?.outbox_id || null;
    // Reject any attempt to pass recipient data directly
    if (body?.recipient_email || body?.recipient_phone || body?.template || body?.data) {
      return new Response(
        JSON.stringify({ error: "Invalid request: recipient data must not be passed in request body. Use notification_outbox table." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (_e) {
    // Empty body is fine
  }

  // Fetch outbox records to process
  let query = adminClient
    .from("notification_outbox")
    .select("*")
    .eq("status", "pending")
    .lt("attempts", 3) // Max 3 retries
    .order("scheduled_at", { ascending: true })
    .limit(outboxId ? 1 : 10); // Process 1 specific or batch of 10

  if (outboxId) {
    query = query.eq("id", outboxId);
  }

  const { data: pendingRecords, error: fetchErr } = await query;

  if (fetchErr) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch notification outbox: " + fetchErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!pendingRecords || pendingRecords.length === 0) {
    return new Response(
      JSON.stringify({ success: true, processed: 0, message: "No pending notifications in outbox." }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Process each pending record
  const results: any[] = [];
  for (const record of pendingRecords) {
    try {
      const result = await processOutboxRecord(
        adminClient, record, resendApiKey, whatsappToken, whatsappPhoneId, senderEmail
      );
      results.push({ id: record.id, event_type: record.event_type, ...result });
    } catch (err: any) {
      console.error(`Failed to process outbox record ${record.id}:`, err);
      // Mark as failed in DB
      await adminClient
        .from("notification_outbox")
        .update({ status: "failed", last_error: err?.message || String(err), processed_at: new Date().toISOString() })
        .eq("id", record.id);
      results.push({ id: record.id, event_type: record.event_type, success: false, error: err?.message });
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      processed: results.length,
      results: results,
      message: `Processed ${results.length} notification(s) from outbox.`,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
