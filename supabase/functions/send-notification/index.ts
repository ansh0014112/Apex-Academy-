// Apex Academy — Email Notification Dispatcher (Gmail API OAuth 2.0)
// Location: supabase/functions/send-notification/index.ts
//
// FIXED COMMUNICATION IDENTITY:
// - Display Sender: APEX ACADEMY
// - Email Engine: Gmail API (OAuth 2.0) with Resend fallback
// - Recipient Data: Fetched exclusively from Supabase DB (never from request body)
// - Dual Notifications: Student acknowledgment + Institute inbox alert
// - Deliverability: RFC 5322 & RFC 2046 multipart/alternative (text/plain + text/html)
// - Reliability: Idempotent batch processing, atomic claiming (FOR UPDATE SKIP LOCKED),
//   exponential backoff retries, and stale processing record recovery.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Safe HTML escaping
function escapeHtml(text: string): string {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Convert UTF-8 string to Base64 safely without deprecated unescape
function encodeUtf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Fold Base64 string into RFC 2045 compliant 76-character lines
function chunkBase64(b64: string, chunkSize = 76): string {
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += chunkSize) {
    chunks.push(b64.slice(i, i + chunkSize));
  }
  return chunks.join("\r\n");
}

// RFC 5322 Compliant Recipient Email Syntax Validation
function isValidEmail(email: string | null | undefined): boolean {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(trimmed);
}

// Plain Text Email Layout for Multipart/Alternative Fallback
function renderEmailText(title: string, contentText: string): string {
  return [
    "============================================================",
    "APEX ACADEMY — Premier Institute for Competitive Excellence",
    "============================================================",
    "",
    title.toUpperCase(),
    "",
    contentText.trim(),
    "",
    "------------------------------------------------------------",
    "Apex Academy, Civil Lines / University Enclave, New Delhi - 110007",
    "Official Desk: APEX ACADEMY • Student Helpline: +91 98765 43210",
    "Portal: https://apexacademy.in • Email: admissions@apexacademy.in",
    "",
    "TRANSACTIONAL NOTICE: You are receiving this official message because an",
    "enquiry or 1-on-1 strategy session was initiated with APEX ACADEMY.",
    "If you did not request this communication, please contact admissions@apexacademy.in.",
    "============================================================",
  ].join("\r\n");
}

// Responsive Branded Email Layout for APEX ACADEMY (Spam-Optimized)
function renderEmailHtml(title: string, preheader: string, contentHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #F8FAFC; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1E293B; -webkit-font-smoothing: antialiased; }
    table { border-collapse: collapse; }
    .email-container { max-width: 600px; margin: 24px auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(10, 25, 47, 0.08); border: 1px solid #E2E8F0; }
    .email-header { background: #0A192F; padding: 30px 32px; text-align: center; border-bottom: 3px solid #D97706; }
    .email-header h1 { margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: 0.5px; font-family: 'Segoe UI', Arial, sans-serif; }
    .email-header p { margin: 6px 0 0 0; color: #F59E0B; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600; }
    .email-body { padding: 32px; }
    .email-title { font-size: 20px; font-weight: 700; color: #0A192F; margin: 0 0 14px 0; font-family: 'Segoe UI', Arial, sans-serif; }
    .lead-text { font-size: 15px; line-height: 1.6; color: #475569; margin: 0 0 18px 0; }
    .info-card { background: #F8FAFC; border-left: 4px solid #D97706; padding: 18px 20px; border-radius: 6px; margin: 22px 0; border-top: 1px solid #E2E8F0; border-right: 1px solid #E2E8F0; border-bottom: 1px solid #E2E8F0; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14px; }
    .info-row:last-child { margin-bottom: 0; }
    .info-label { color: #64748B; font-weight: 500; }
    .info-val { color: #0A192F; font-weight: 600; text-align: right; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; background: #FEF3C7; color: #B45309; }
    .button-wrap { text-align: center; margin: 28px 0 20px 0; }
    .email-btn { background: #0A192F; color: #FFFFFF !important; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; border: 1px solid #D97706; }
    .email-footer { background: #F1F5F9; padding: 24px 32px; text-align: center; font-size: 12px; line-height: 1.6; color: #64748B; border-top: 1px solid #E2E8F0; }
    .email-footer a { color: #0A192F; font-weight: 600; text-decoration: underline; }
    .email-permission-notice { font-size: 11px; color: #94A3B8; margin-top: 14px; padding-top: 12px; border-top: 1px dashed #CBD5E1; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #F8FAFC;">
  <!-- Accessible Preheader (Hidden from display, accessible to screen readers, compliant with email client heuristics) -->
  <div style="display:none;font-size:1px;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all;font-family:sans-serif;">
    ${escapeHtml(preheader)}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #F8FAFC;">
    <tr>
      <td align="center" style="padding: 24px 12px;">
        <div class="email-container">
          <div class="email-header">
            <h1>APEX ACADEMY</h1>
            <p>Premier Institute for Competitive Excellence</p>
          </div>
          <div class="email-body">
            ${contentHtml}
          </div>
          <div class="email-footer">
            <p style="margin:0 0 6px 0; font-weight: 600; color: #334155;">Apex Academy, Civil Lines / University Enclave, New Delhi - 110007</p>
            <p style="margin:0 0 10px 0;">Official Desk: APEX ACADEMY &bull; Student Helpline: +91 98765 43210 &bull; <a href="https://apexacademy.in">apexacademy.in</a></p>
            <div class="email-permission-notice">
              <strong>Transactional Notice:</strong> You received this email because an admission enquiry or counselling consultation was initiated with APEX ACADEMY. If you believe you received this in error, please notify our admissions desk at <a href="mailto:admissions@apexacademy.in">admissions@apexacademy.in</a>.
            </div>
          </div>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Build email content and subject based on event_type and entity data (Dual HTML + Plain Text for 100% RFC Compliance)
function buildEmailContent(eventType: string, entityData: any): {
  subject: string;
  preheader: string;
  bodyHtml: string;
  bodyText: string;
  templateRef: string;
} {
  const name = entityData?.student_name || entityData?.full_name || "Aspirant";
  const enquiryId = entityData?.enquiry_id || entityData?.id || "APX";
  const bookingId = entityData?.booking_id || entityData?.id || "APX";

  // 1. Student Inquiry Acknowledgment
  if (eventType === "enquiry_submitted") {
    const exam = entityData?.target_examination || "Competitive Exam";
    const course = entityData?.course_category || "Integrated Prep";
    const mode = entityData?.preferred_learning_mode || "Hybrid Classroom";
    const timing = entityData?.preferred_batch_timing || "Morning / Evening";

    return {
      templateRef: "tpl_enquiry_student_ack",
      subject: `APEX ACADEMY — Admission Enquiry Registered [#${enquiryId}]`,
      preheader: `Thank you for your enquiry for ${exam}. Our academic team will contact you shortly.`,
      bodyHtml: `
        <h2 class="email-title">Admission Enquiry Received</h2>
        <p class="lead-text">Dear <strong>${escapeHtml(name)}</strong>,</p>
        <p class="lead-text">Thank you for reaching out to <strong>APEX ACADEMY</strong>. Your admission enquiry has been successfully logged into our institute records. An academic counsellor has been assigned to assist you with your career roadmap.</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Enquiry Ref No:</span><span class="info-val">${escapeHtml(enquiryId)}</span></div>
          <div class="info-row"><span class="info-label">Target Examination:</span><span class="info-val">${escapeHtml(exam)}</span></div>
          <div class="info-row"><span class="info-label">Course Stream:</span><span class="info-val">${escapeHtml(course)}</span></div>
          <div class="info-row"><span class="info-label">Learning Mode:</span><span class="info-val">${escapeHtml(mode)}</span></div>
          <div class="info-row"><span class="info-label">Preferred Timing:</span><span class="info-val">${escapeHtml(timing)}</span></div>
        </div>
        <p class="lead-text">Our admissions team will call you within 24 working hours. Please keep your academic questions and previous scorecards ready for a productive advisory session.</p>
      `,
      bodyText: [
        `Dear ${name},`,
        "",
        `Thank you for reaching out to APEX ACADEMY. Your admission enquiry has been successfully logged into our institute records. An academic counsellor has been assigned to assist you with your career roadmap.`,
        "",
        `ENQUIRY DETAILS:`,
        `• Enquiry Ref No: ${enquiryId}`,
        `• Target Examination: ${exam}`,
        `• Course Stream: ${course}`,
        `• Learning Mode: ${mode}`,
        `• Preferred Timing: ${timing}`,
        "",
        `Our admissions team will call you within 24 working hours. Please keep your academic questions and previous scorecards ready for a productive advisory session.`,
      ].join("\r\n"),
    };
  }

  // 2. Institute Inbox Alert: New Student Inquiry
  if (eventType === "enquiry_institute_alert") {
    const exam = entityData?.target_examination || "General";
    const phone = entityData?.phone || "N/A";
    const email = entityData?.email || "N/A";
    const course = entityData?.course_category || "N/A";
    const qual = entityData?.qualification || "N/A";
    const counsellor = entityData?.counsellor_name || "Auto-Assigned";
    const msg = entityData?.additional_message || "";

    return {
      templateRef: "tpl_enquiry_institute_alert",
      subject: `[NEW INQUIRY] ${escapeHtml(name)} - ${escapeHtml(exam)} [#${enquiryId}]`,
      preheader: `New admission enquiry received from ${name} (${phone}).`,
      bodyHtml: `
        <h2 class="email-title">New Student Admission Enquiry</h2>
        <p class="lead-text">A new candidate has submitted an admission enquiry on the APEX ACADEMY portal.</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Enquiry ID:</span><span class="info-val">${escapeHtml(enquiryId)}</span></div>
          <div class="info-row"><span class="info-label">Candidate Name:</span><span class="info-val">${escapeHtml(name)}</span></div>
          <div class="info-row"><span class="info-label">Mobile Number:</span><span class="info-val">+91 ${escapeHtml(phone)}</span></div>
          <div class="info-row"><span class="info-label">Email Address:</span><span class="info-val">${escapeHtml(email)}</span></div>
          <div class="info-row"><span class="info-label">Target Exam:</span><span class="info-val">${escapeHtml(exam)}</span></div>
          <div class="info-row"><span class="info-label">Course Stream:</span><span class="info-val">${escapeHtml(course)}</span></div>
          <div class="info-row"><span class="info-label">Qualification:</span><span class="info-val">${escapeHtml(qual)}</span></div>
          <div class="info-row"><span class="info-label">Assigned Counsellor:</span><span class="info-val">${escapeHtml(counsellor)}</span></div>
        </div>
        ${msg ? `<p class="lead-text"><strong>Candidate Query:</strong> ${escapeHtml(msg)}</p>` : ""}
      `,
      bodyText: [
        `NEW STUDENT ADMISSION ENQUIRY`,
        "",
        `A new candidate has submitted an admission enquiry on the APEX ACADEMY portal.`,
        "",
        `CANDIDATE DETAILS:`,
        `• Enquiry ID: ${enquiryId}`,
        `• Candidate Name: ${name}`,
        `• Mobile Number: +91 ${phone}`,
        `• Email Address: ${email}`,
        `• Target Examination: ${exam}`,
        `• Course Stream: ${course}`,
        `• Qualification: ${qual}`,
        `• Assigned Counsellor: ${counsellor}`,
        ...(msg ? ["", `Candidate Query: ${msg}`] : []),
      ].join("\r\n"),
    };
  }

  // 3. Student Counselling Booking Confirmation
  if (eventType === "booking_submitted") {
    const sDate = entityData?.preferred_date || "Upcoming";
    const sTime = entityData?.preferred_time || "TBD";
    const exam = entityData?.target_examination || "Competitive Exam";
    const medium = entityData?.session_medium || "Online Video Meeting";
    const phone = entityData?.phone || "";

    return {
      templateRef: "tpl_booking_student_ack",
      subject: `APEX ACADEMY — 1-on-1 Counselling Session Requested [#${bookingId}]`,
      preheader: `We have received your counselling booking request for ${sDate} at ${sTime}.`,
      bodyHtml: `
        <h2 class="email-title">Counselling Session Scheduled</h2>
        <p class="lead-text">Dear <strong>${escapeHtml(name)}</strong>,</p>
        <p class="lead-text">Your 1-on-1 diagnostic strategy session has been scheduled with APEX ACADEMY's expert academic counselling team.</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking Ref No:</span><span class="info-val">${escapeHtml(bookingId)}</span></div>
          <div class="info-row"><span class="info-label">Session Date:</span><span class="info-val">${escapeHtml(sDate)}</span></div>
          <div class="info-row"><span class="info-label">Time Window:</span><span class="info-val">${escapeHtml(sTime)} (IST)</span></div>
          <div class="info-row"><span class="info-label">Target Examination:</span><span class="info-val">${escapeHtml(exam)}</span></div>
          <div class="info-row"><span class="info-label">Session Medium:</span><span class="info-val">${escapeHtml(medium)}</span></div>
        </div>
        <p class="lead-text">Please ensure you are available on your registered mobile number <strong>+91 ${escapeHtml(phone)}</strong>. Our counsellor will verify your slot and connect with you.</p>
      `,
      bodyText: [
        `Dear ${name},`,
        "",
        `Your 1-on-1 diagnostic strategy session has been scheduled with APEX ACADEMY's expert academic counselling team.`,
        "",
        `SESSION RESERVATION DETAILS:`,
        `• Booking Ref No: ${bookingId}`,
        `• Session Date: ${sDate}`,
        `• Time Window: ${sTime} (IST)`,
        `• Target Examination: ${exam}`,
        `• Session Medium: ${medium}`,
        "",
        `Please ensure you are available on your registered mobile number +91 ${phone}. Our counsellor will verify your slot and connect with you.`,
      ].join("\r\n"),
    };
  }

  // 4. Counsellor / Institute Alert: New Counselling Booking
  if (eventType === "booking_counsellor_alert") {
    const sDate = entityData?.preferred_date || "Upcoming";
    const sTime = entityData?.preferred_time || "TBD";
    const exam = entityData?.target_examination || "N/A";
    const medium = entityData?.session_medium || "Online Meeting";
    const phone = entityData?.phone || "N/A";
    const email = entityData?.email || "N/A";

    return {
      templateRef: "tpl_booking_counsellor_alert",
      subject: `[NEW BOOKING] Strategy Call with ${escapeHtml(name)} on ${escapeHtml(sDate)} [#${bookingId}]`,
      preheader: `Counselling booking scheduled for ${sDate} at ${sTime}.`,
      bodyHtml: `
        <h2 class="email-title">New Counselling Appointment</h2>
        <p class="lead-text">A student has reserved a 1-on-1 counselling session with APEX ACADEMY.</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking ID:</span><span class="info-val">${escapeHtml(bookingId)}</span></div>
          <div class="info-row"><span class="info-label">Student Name:</span><span class="info-val">${escapeHtml(name)}</span></div>
          <div class="info-row"><span class="info-label">Phone:</span><span class="info-val">+91 ${escapeHtml(phone)}</span></div>
          <div class="info-row"><span class="info-label">Email:</span><span class="info-val">${escapeHtml(email)}</span></div>
          <div class="info-row"><span class="info-label">Date & Time:</span><span class="info-val">${escapeHtml(sDate)} @ ${escapeHtml(sTime)} (IST)</span></div>
          <div class="info-row"><span class="info-label">Exam Focus:</span><span class="info-val">${escapeHtml(exam)}</span></div>
          <div class="info-row"><span class="info-label">Medium:</span><span class="info-val">${escapeHtml(medium)}</span></div>
        </div>
      `,
      bodyText: [
        `NEW COUNSELLING APPOINTMENT`,
        "",
        `A student has reserved a 1-on-1 counselling session with APEX ACADEMY.`,
        "",
        `APPOINTMENT DETAILS:`,
        `• Booking ID: ${bookingId}`,
        `• Student Name: ${name}`,
        `• Mobile Phone: +91 ${phone}`,
        `• Email Address: ${email}`,
        `• Session Date & Time: ${sDate} @ ${sTime} (IST)`,
        `• Examination Focus: ${exam}`,
        `• Session Medium: ${medium}`,
      ].join("\r\n"),
    };
  }

  // 5. Booking Confirmed (with Google Meet Link)
  if (eventType === "booking_confirmed" || eventType === "booking_assigned") {
    const meetLink = entityData?.google_meet_link;
    const sDate = entityData?.preferred_date || "Upcoming";
    const sTime = entityData?.preferred_time || "TBD";
    const mentor = entityData?.counsellor_name || "Academic Mentor";
    const phone = entityData?.phone || "";

    return {
      templateRef: "tpl_booking_confirmed",
      subject: `APEX ACADEMY — 1-on-1 Strategy Session Confirmed [#${bookingId}]`,
      preheader: `Your strategy session is confirmed for ${sDate} at ${sTime}.`,
      bodyHtml: `
        <h2 class="email-title">Your Strategy Session is Confirmed</h2>
        <p class="lead-text">Dear <strong>${escapeHtml(name)}</strong>,</p>
        <p class="lead-text">Your 1-on-1 strategy call with APEX ACADEMY is confirmed. Please review your session details below:</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Booking ID:</span><span class="info-val">${escapeHtml(bookingId)}</span></div>
          <div class="info-row"><span class="info-label">Session Date:</span><span class="info-val">${escapeHtml(sDate)}</span></div>
          <div class="info-row"><span class="info-label">Time Window:</span><span class="info-val">${escapeHtml(sTime)} (IST)</span></div>
          <div class="info-row"><span class="info-label">Assigned Mentor:</span><span class="info-val">${escapeHtml(mentor)}</span></div>
        </div>
        ${meetLink ? `
          <div class="button-wrap">
            <a href="${meetLink}" target="_blank" class="email-btn">Join Google Meet Session</a>
          </div>
          <p style="font-size:12px;color:#64748B;text-align:center;">Direct Link: <a href="${meetLink}">${meetLink}</a></p>
        ` : `
          <p class="lead-text">Your counsellor will connect with you directly at your registered phone: <strong>+91 ${escapeHtml(phone)}</strong>.</p>
        `}
      `,
      bodyText: [
        `Dear ${name},`,
        "",
        `Your 1-on-1 strategy call with APEX ACADEMY is confirmed. Please review your session details below:`,
        "",
        `CONFIRMED SESSION DETAILS:`,
        `• Booking ID: ${bookingId}`,
        `• Session Date: ${sDate}`,
        `• Time Window: ${sTime} (IST)`,
        `• Assigned Mentor: ${mentor}`,
        "",
        meetLink
          ? `Join Google Meet Session: ${meetLink}`
          : `Your counsellor will connect with you directly at your registered phone: +91 ${phone}.`,
      ].join("\r\n"),
    };
  }

  // 6. Follow-up Scheduled
  if (eventType === "followup_scheduled") {
    const fDate = entityData?.follow_up_date || "Upcoming";
    const fTime = entityData?.follow_up_time || "Morning / Afternoon";
    const advisor = entityData?.counsellor_name || "Senior Counsellor";

    return {
      templateRef: "tpl_followup_scheduled",
      subject: `APEX ACADEMY — Academic Advisory Follow-up Reminder`,
      preheader: `Your academic advisor has scheduled a follow-up consultation.`,
      bodyHtml: `
        <h2 class="email-title">Advisory Follow-up Scheduled</h2>
        <p class="lead-text">Dear <strong>${escapeHtml(name)}</strong>,</p>
        <p class="lead-text">An academic follow-up consultation has been scheduled regarding your admission enquiry with APEX ACADEMY.</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Follow-up Date:</span><span class="info-val">${escapeHtml(fDate)}</span></div>
          <div class="info-row"><span class="info-label">Scheduled Time:</span><span class="info-val">${escapeHtml(fTime)}</span></div>
          <div class="info-row"><span class="info-label">Advisor:</span><span class="info-val">${escapeHtml(advisor)}</span></div>
        </div>
      `,
      bodyText: [
        `Dear ${name},`,
        "",
        `An academic follow-up consultation has been scheduled regarding your admission enquiry with APEX ACADEMY.`,
        "",
        `FOLLOW-UP DETAILS:`,
        `• Follow-up Date: ${fDate}`,
        `• Scheduled Time: ${fTime}`,
        `• Assigned Advisor: ${advisor}`,
      ].join("\r\n"),
    };
  }

  // 7. Admission Status Update
  if (eventType === "admission_status_update") {
    const statusLabel = (entityData?.status || "Updated").replace(/_/g, " ").toUpperCase();
    const exam = entityData?.target_examination || "Competitive Prep";

    return {
      templateRef: "tpl_admission_status_update",
      subject: `APEX ACADEMY — Admission Status Update: ${statusLabel} [#${enquiryId}]`,
      preheader: `Your application status at APEX ACADEMY has been updated to ${statusLabel}.`,
      bodyHtml: `
        <h2 class="email-title">Application Status Updated</h2>
        <p class="lead-text">Dear <strong>${escapeHtml(name)}</strong>,</p>
        <p class="lead-text">Your admission process at <strong>APEX ACADEMY</strong> has progressed. Below is your current status:</p>
        <div class="info-card">
          <div class="info-row"><span class="info-label">Enquiry Ref No:</span><span class="info-val">${escapeHtml(enquiryId)}</span></div>
          <div class="info-row"><span class="info-label">Application Status:</span><span class="info-val"><span class="badge">${escapeHtml(statusLabel)}</span></span></div>
          <div class="info-row"><span class="info-label">Target Examination:</span><span class="info-val">${escapeHtml(exam)}</span></div>
        </div>
        <p class="lead-text">For fee payment links, batch allotment details, or onboarding questions, please contact our administrative desk at <strong>+91 98765 43210</strong>.</p>
      `,
      bodyText: [
        `Dear ${name},`,
        "",
        `Your admission process at APEX ACADEMY has progressed. Below is your current status:`,
        "",
        `APPLICATION DETAILS:`,
        `• Enquiry Ref No: ${enquiryId}`,
        `• Application Status: ${statusLabel}`,
        `• Target Examination: ${exam}`,
        "",
        `For fee payment links, batch allotment details, or onboarding questions, please contact our administrative desk at +91 98765 43210.`,
      ].join("\r\n"),
    };
  }

  // Generic Fallback
  return {
    templateRef: "tpl_generic_notice",
    subject: `APEX ACADEMY — Important Notification`,
    preheader: `Important notification regarding your academic application.`,
    bodyHtml: `
      <h2 class="email-title">Institute Notification</h2>
      <p class="lead-text">Dear <strong>${escapeHtml(name)}</strong>,</p>
      <p class="lead-text">You have an update regarding your admission application or counselling session at APEX ACADEMY.</p>
      <p class="lead-text">Helpline: +91 98765 43210 &bull; Email: admissions@apexacademy.in</p>
    `,
    bodyText: [
      `Dear ${name},`,
      "",
      `You have an update regarding your admission application or counselling session at APEX ACADEMY.`,
      "",
      `Student Helpline: +91 98765 43210 • Email: admissions@apexacademy.in`,
    ].join("\r\n"),
  };
}



// ─── GMAIL API OAUTH 2.0 TOKEN EXCHANGE & SENDING (RFC 5322 & RFC 2046 MULTIPART/ALTERNATIVE) ───
async function sendViaGmailApi(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  htmlContent: string;
  textContent: string;
}): Promise<{ id: string }> {
  // 1. Refresh OAuth Access Token
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    let advice = "";
    if (errText.includes("invalid_grant")) {
      advice = " [Root Cause: Google OAuth Refresh Token has expired or been revoked. Note: When a Google Cloud OAuth consent screen is left in 'Testing' mode, refresh tokens expire automatically after 7 days. Change the publishing status to 'In Production' in Google Cloud Console to obtain non-expiring refresh tokens].";
    }
    throw new Error(`Gmail OAuth token refresh failed (${tokenResp.status}): ${errText}${advice}`);
  }

  const tokenData = await tokenResp.json();
  const accessToken = tokenData.access_token;

  // 2. Extract sender domain for RFC 5322 Message-ID construction
  const senderDomain = options.senderEmail.includes("@")
    ? options.senderEmail.split("@")[1]
    : "apexacademy.in";

  // Unique boundary for multipart/alternative
  const boundary = `----=_Part_${Date.now()}_${crypto.randomUUID().replace(/-/g, "")}`;
  const utf8Subject = `=?UTF-8?B?${encodeUtf8ToBase64(options.subject)}?=`;
  const messageId = `<msg.${Date.now()}.${crypto.randomUUID().slice(0, 12)}@${senderDomain}>`;
  const dateHeader = new Date().toUTCString();

  // 3. Build RFC 5322 / RFC 2046 MIME message with multipart/alternative (text/plain + text/html)
  // Base64-encoded body parts folded strictly at 76 characters per line
  const textBase64Chunked = chunkBase64(encodeUtf8ToBase64(options.textContent || ""));
  const htmlBase64Chunked = chunkBase64(encodeUtf8ToBase64(options.htmlContent || ""));

  const mimeLines = [
    `From: APEX ACADEMY <${options.senderEmail}>`,
    `To: ${options.recipientEmail}`,
    `Reply-To: APEX ACADEMY <${options.senderEmail}>`,
    `Subject: ${utf8Subject}`,
    `Date: ${dateHeader}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `X-Mailer: APEX-Academy-Notifier/2.0`,
    `X-Auto-Response-Suppress: All`,
    `Auto-Submitted: auto-generated`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    textBase64Chunked,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    htmlBase64Chunked,
    ``,
    `--${boundary}--`,
  ];

  // 4. Base64url encode the entire MIME message for the Gmail REST API
  const rawMime = mimeLines.join("\r\n");
  const encodedMime = encodeUtf8ToBase64(rawMime)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // 5. Send message via Gmail REST API
  const sendResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encodedMime }),
  });

  if (!sendResp.ok) {
    const errData = await sendResp.text();
    throw new Error(`Gmail API send failed (${sendResp.status}): ${errData}`);
  }

  const result = await sendResp.json();
  return { id: result.id };
}



// Fetch complete entity record from database
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
        additional_message,
        status,
        student_id,
        assigned_counsellor_id,
        students (
          id,
          full_name,
          phone,
          email,
          qualification
        ),
        profiles (
          full_name
        )
      `)
      .eq("id", entityId)
      .maybeSingle();

    if (!data) return {};

    return {
      enquiry_id: data.id,
      student_id: data.student_id,
      student_name: data.students?.full_name,
      full_name: data.students?.full_name,
      phone: data.students?.phone,
      email: data.students?.email,
      qualification: data.students?.qualification,
      course_category: data.course_category,
      target_examination: data.target_examination,
      preferred_batch_timing: data.preferred_batch_timing,
      preferred_learning_mode: data.preferred_learning_mode,
      additional_message: data.additional_message,
      counsellor_id: data.assigned_counsellor_id,
      counsellor_name: data.profiles?.full_name,
      status: data.status,
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
        student_id,
        assigned_counsellor_id,
        students (
          id,
          full_name,
          phone,
          email
        ),
        profiles (
          full_name
        )
      `)
      .eq("id", entityId)
      .maybeSingle();

    if (!data) return {};

    return {
      booking_id: data.id,
      student_id: data.student_id,
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
      counsellor_id: data.assigned_counsellor_id,
      counsellor_name: data.profiles?.full_name,
      status: data.status,
    };
  }

  if (entityType === "follow_up") {
    const { data } = await adminClient
      .from("follow_ups")
      .select(`
        id,
        enquiry_id,
        assigned_to,
        follow_up_date,
        follow_up_time,
        priority,
        notes,
        status,
        profiles (
          full_name
        ),
        admission_enquiries (
          student_id,
          target_examination,
          students (
            id,
            full_name,
            phone,
            email
          )
        )
      `)
      .eq("id", entityId)
      .maybeSingle();

    if (!data) return {};

    return {
      follow_up_id: data.id,
      enquiry_id: data.enquiry_id,
      student_id: data.admission_enquiries?.student_id,
      student_name: data.admission_enquiries?.students?.full_name,
      phone: data.admission_enquiries?.students?.phone,
      email: data.admission_enquiries?.students?.email,
      target_examination: data.admission_enquiries?.target_examination,
      follow_up_date: data.follow_up_date,
      follow_up_time: data.follow_up_time,
      counsellor_id: data.assigned_to,
      counsellor_name: data.profiles?.full_name,
    };
  }

  return {};
}

// Process a single notification outbox event (Email-Only Architecture)
async function processOutboxRecord(
  adminClient: any,
  record: any,
  config: {
    gmailClientId?: string;
    gmailClientSecret?: string;
    gmailRefreshToken?: string;
    gmailSenderEmail?: string;
    resendApiKey?: string;
    instituteAlertEmail: string;
  }
): Promise<{ success: boolean; emailStatus: string }> {
  // Fetch full entity data from database
  const entityData = await fetchEntityData(adminClient, record.entity_type, record.entity_id);

  // Merge any metadata stored on outbox record
  const mergedData = { ...entityData, ...(record.metadata || {}) };

  const isInstituteAlert = record.event_type.includes("institute_alert") || record.event_type.includes("counsellor_alert");

  // Determine recipient email
  const targetEmail = isInstituteAlert
    ? config.instituteAlertEmail
    : (record.recipient_override || entityData?.email || null);

  const studentId = record.student_id || entityData?.student_id || null;
  const counsellorId = entityData?.counsellor_id || null;
  const actorId = record.actor_id || counsellorId || null;

  let emailStatus = "skipped";
  let emailProviderId: string | null = null;
  let emailError: string | null = null;

  const eventType = record.event_type;
  const { subject, preheader, bodyHtml, bodyText, templateRef } = buildEmailContent(eventType, mergedData);

  // ─── 1. EMAIL DISPATCH (RFC 5322 & RFC 2046 MULTIPART/ALTERNATIVE) ───
  if (!targetEmail) {
    emailStatus = "skipped_no_email";
  } else if (!isValidEmail(targetEmail)) {
    emailStatus = "failed_invalid_recipient";
    emailError = `Invalid recipient email address format: "${targetEmail}"`;
    console.warn(`[send-notification] Rejected malformed email address: ${targetEmail}`);
  } else {
    const fullHtml = renderEmailHtml(subject, preheader, bodyHtml);
    const fullText = renderEmailText(subject, bodyText);

    // Path A: Gmail API (OAuth 2.0 with RFC Multipart/Alternative)
    if (
      config.gmailClientId &&
      config.gmailClientSecret &&
      config.gmailRefreshToken &&
      config.gmailSenderEmail &&
      !config.gmailRefreshToken.startsWith("placeholder")
    ) {
      try {
        const res = await sendViaGmailApi({
          clientId: config.gmailClientId,
          clientSecret: config.gmailClientSecret,
          refreshToken: config.gmailRefreshToken,
          senderEmail: config.gmailSenderEmail,
          recipientEmail: targetEmail,
          subject: subject,
          htmlContent: fullHtml,
          textContent: fullText,
        });
        emailStatus = "sent";
        emailProviderId = res.id;
      } catch (mailErr: any) {
        emailStatus = "failed";
        emailError = mailErr?.message || String(mailErr);
        console.error(`Gmail API send failed to ${targetEmail}:`, emailError);
      }
    }
    // Path B: Resend Fallback (with dual text & html parts)
    else if (config.resendApiKey && !config.resendApiKey.startsWith("re_placeholder")) {
      try {
        const resendResp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: `APEX ACADEMY <${config.gmailSenderEmail || "admissions@apexacademy.in"}>`,
            to: [targetEmail],
            reply_to: `APEX ACADEMY <${config.gmailSenderEmail || "admissions@apexacademy.in"}>`,
            subject: subject,
            html: fullHtml,
            text: fullText,
          }),
        });
        const resendData = await resendResp.json();
        if (resendResp.ok) {
          emailStatus = "sent";
          emailProviderId = resendData?.id || "resend_msg";
        } else {
          emailStatus = "failed";
          emailError = JSON.stringify(resendData);
        }
      } catch (resendErr: any) {
        emailStatus = "failed";
        emailError = resendErr?.message || String(resendErr);
      }
    }
    // Path C: Simulation / Pending Credentials
    else {
      emailStatus = "pending";
      emailProviderId = `sim_gmail_${Date.now()}`;
      console.log(`[SIMULATED EMAIL via Gmail API] From: APEX ACADEMY -> To: ${targetEmail} | Subject: ${subject}`);
    }

    // Log to centralized communication_logs
    try {
      await adminClient.from("communication_logs").insert({
        student_id: studentId,
        counsellor_id: counsellorId,
        actor_id: actorId,
        channel: "email",
        message_type: eventType,
        recipient: targetEmail,
        template_ref: templateRef,
        provider_message_id: emailProviderId,
        status: emailStatus === "pending" ? "pending" : (emailStatus === "sent" ? "sent" : "failed"),
        error_details: emailError,
        metadata: {
          subject: subject,
          is_institute_alert: isInstituteAlert,
          provider: config.gmailClientId ? "gmail_api" : (config.resendApiKey ? "resend" : "simulated"),
        },
      });
    } catch (logErr: any) {
      console.warn("Could not insert email communication log:", logErr?.message);
    }
  }

  // ─── 2. RELIABLE RETRY & OUTBOX STATE MACHINE ───
  const isFailed = emailStatus === "failed" || emailStatus === "failed_invalid_recipient";
  const isSent = emailStatus === "sent";

  let finalStatus = "sent";
  let nextScheduledAt = null;
  const currentAttempts = (record.attempts || 0) + 1;

  if (isFailed && !isSent) {
    if (currentAttempts >= 5) {
      finalStatus = "failed"; // Permanently failed after 5 retries
    } else {
      finalStatus = "pending"; // Re-queue for retry with exponential backoff
      const backoffMinutes = Math.pow(2, currentAttempts); // 2m, 4m, 8m, 16m
      nextScheduledAt = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();
    }
  }

  await adminClient
    .from("notification_outbox")
    .update({
      status: finalStatus,
      attempts: currentAttempts,
      processed_at: new Date().toISOString(),
      scheduled_at: nextScheduledAt || record.scheduled_at,
      last_error: emailError || null,
    })
    .eq("id", record.id);

  return { success: !isFailed, emailStatus };
}

// Safe helper to extract and clean tokens from headers or parameters
// Strips quotes, whitespace, optional angle brackets, and optional "Bearer " / "Bearer: " prefixes
function extractCleanToken(raw: string | null | undefined): string {
  if (!raw) return "";
  let t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  if ((t.startsWith("<") && t.endsWith(">")) || (t.startsWith("[") && t.endsWith("]"))) {
    t = t.slice(1, -1).trim();
  }
  if (t.toLowerCase().startsWith("bearer")) {
    t = t.slice(6).trim();
    if (t.startsWith(":") || t.startsWith("=")) {
      t = t.slice(1).trim();
    }
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  if ((t.startsWith("<") && t.endsWith(">")) || (t.startsWith("[") && t.endsWith("]"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

// Determines if a token conforms to standard 3-segment JWT syntax
function isJwtFormat(tok: string): boolean {
  if (!tok) return false;
  const parts = tok.split(".");
  return parts.length === 3 && parts.every(p => p.length > 0);
}

// Returns a high-level descriptor for safe diagnostic logging (NEVER outputs raw token bytes)
function safeTokenPrefix(tok: string): string {
  if (!tok) return "empty";
  if (tok.startsWith("eyJ")) return "jwt_eyJ";
  if (tok.startsWith("sb_secret_")) return "sb_secret";
  if (tok.startsWith("sbp_") || tok.startsWith("sb_publishable_")) return "sb_publishable";
  if (tok.startsWith("sb_")) return "sb_prefix";
  if (tok.includes("<") || tok.includes(">")) return "placeholder_angle_brackets";
  return `opaque_len_${tok.length}`;
}

// In-memory cache for validated server-side secret/service keys across warm function instances
const verifiedServiceKeysCache = new Set<string>();

/**
 * Strict server-side verification of incoming service-role / secret key against Supabase GoTrue Admin.
 * Only genuine service_role or project secret keys are granted 200 with an Array of users.
 * Fails closed on any error, non-200 status, non-JSON response, or missing users array.
 */
async function verifyCandidateServiceKey(supabaseUrl: string, candidateKey: string): Promise<boolean> {
  if (!candidateKey || typeof candidateKey !== "string") return false;
  const cleanKey = candidateKey.trim();
  // Minimum length check for valid Supabase service/secret keys
  if (cleanKey.length < 24) return false;
  if (verifiedServiceKeysCache.has(cleanKey)) return true;

  try {
    const cleanUrl = supabaseUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const resp = await fetch(`${cleanUrl}/auth/v1/admin/users?per_page=1`, {
      method: "GET",
      headers: {
        apikey: cleanKey,
        Authorization: `Bearer ${cleanKey}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    // Cryptographic & authorization verification:
    // 1. Status must be exactly 200 OK
    // 2. Content-Type must be application/json
    // 3. Response body must contain the "users" array (GoTrue admin API contract)
    if (resp.status === 200) {
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = await resp.json().catch(() => null);
        if (body && Array.isArray(body.users)) {
          verifiedServiceKeysCache.add(cleanKey);
          return true;
        }
      }
    }
  } catch (_e) {
    // Network or abort error: fail closed
  }
  return false;
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

  // Load environment variables for communication providers
  const config = {
    gmailClientId: Deno.env.get("GMAIL_CLIENT_ID"),
    gmailClientSecret: Deno.env.get("GMAIL_CLIENT_SECRET"),
    gmailRefreshToken: Deno.env.get("GMAIL_REFRESH_TOKEN"),
    gmailSenderEmail: Deno.env.get("GMAIL_SENDER_EMAIL") || "admissions@apexacademy.in",
    resendApiKey: Deno.env.get("RESEND_API_KEY"),
    instituteAlertEmail: Deno.env.get("INSTITUTE_NOTIFICATION_EMAIL") || Deno.env.get("GMAIL_SENDER_EMAIL") || "admissions@apexacademy.in",
  };

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const primaryServiceKey = (
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    Deno.env.get("SECRET_KEY") ||
    ""
  ).trim();

  if (!supabaseUrl || !primaryServiceKey) {
    return new Response(
      JSON.stringify({ error: "Server configuration error: Missing Supabase credentials." }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Parse optional body & support both direct { outbox_id } and native Database Webhook { record: { id } }
  let outboxId: string | null = null;
  try {
    const rawText = await req.text();
    if (rawText && rawText.trim()) {
      const body = JSON.parse(rawText);
      outboxId = body?.outbox_id || body?.record?.id || body?.id || null;
    }
  } catch (_e) {
    // Empty body is accepted
  }

  // 1. Gather all candidate credentials from request headers and URL parameters
  const rawApiKey = req.headers.get("apikey") || req.headers.get("x-api-key") || "";
  const rawAuth = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const cleanApiKey = extractCleanToken(rawApiKey);
  const cleanAuth = extractCleanToken(rawAuth);

  const headerKeysToCheck = [
    "apikey",
    "x-api-key",
    "authorization",
    "x-supabase-auth",
    "x-supabase-service-role",
    "x-secret-key",
  ];

  const candidateTokens: string[] = [];
  const presentHeaderNames: string[] = [];

  for (const h of headerKeysToCheck) {
    const val = req.headers.get(h);
    if (val) {
      presentHeaderNames.push(h);
      const cleaned = extractCleanToken(val);
      if (cleaned && !candidateTokens.includes(cleaned)) {
        candidateTokens.push(cleaned);
      }
    }
  }

  // Also check URL search parameters as fallback for webhooks/cron
  try {
    const url = new URL(req.url);
    const qKey = url.searchParams.get("apikey") || url.searchParams.get("token");
    if (qKey) {
      presentHeaderNames.push("url_query");
      const cleaned = extractCleanToken(qKey);
      if (cleaned && !candidateTokens.includes(cleaned)) {
        candidateTokens.push(cleaned);
      }
    }
  } catch (_e) {
    // Ignore URL parse errors
  }

  // 2. Resolve configured service role keys and anon keys across all standard environment variables
  const configuredServiceKeys = [
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    Deno.env.get("SERVICE_ROLE_KEY"),
    Deno.env.get("SUPABASE_SECRET_KEY"),
    Deno.env.get("SECRET_KEY"),
    Deno.env.get("WEBHOOK_SECRET"),
    Deno.env.get("DATABASE_WEBHOOK_SECRET"),
  ]
    .filter((k): k is string => Boolean(k && k.trim()))
    .map(k => extractCleanToken(k));

  const configuredAnonKeys = [
    Deno.env.get("SUPABASE_ANON_KEY"),
    Deno.env.get("ANON_KEY"),
    "sb_publishable_eO75hkRFASOuX6qQz1QVqg__Vf7wYWK", // Known project publishable key for jhdzvzqgddkzpnstvdpf
  ]
    .filter((k): k is string => Boolean(k && k.trim()))
    .map(k => extractCleanToken(k));

  // 3. Evaluate caller authentication
  // STRICT SECURITY REQUIREMENT:
  // Only a genuinely verified Supabase server-side secret/service-role key OR an authenticated
  // staff member (Super Admin / Counsellor) can authorize notification dispatch.
  // Anonymous / publishable keys are NEVER authorized to dispatch notifications, even with outbox_id.
  let isServiceRole =
    (cleanApiKey && configuredServiceKeys.includes(cleanApiKey)) ||
    (cleanAuth && configuredServiceKeys.includes(cleanAuth)) ||
    candidateTokens.some(tok => configuredServiceKeys.includes(tok)) ||
    candidateTokens.some(tok => verifiedServiceKeysCache.has(tok));

  // If not matched against static env vars, test candidate tokens dynamically against Supabase Auth Admin
  if (!isServiceRole) {
    for (const tok of candidateTokens) {
      if (await verifyCandidateServiceKey(supabaseUrl, tok)) {
        isServiceRole = true;
        break;
      }
    }
  }

  // Detect if any incoming candidate token is the public publishable/anon key
  const isPublishableKeyCaller = !isServiceRole && (
    (cleanApiKey && configuredAnonKeys.includes(cleanApiKey)) ||
    (cleanAuth && configuredAnonKeys.includes(cleanAuth)) ||
    candidateTokens.some(tok => configuredAnonKeys.includes(tok))
  );

  const adminClient = createClient(supabaseUrl, primaryServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let isStaffUser = false;
  let userAuthErrorMsg: string | null = null;

  // 4. If not Service Role, check if any candidate token is a valid Staff Session JWT
  // STRICT RULE: Only attempt getUser on tokens with valid 3-segment JWT format to prevent malformed segment errors
  if (!isServiceRole && !isPublishableKeyCaller && candidateTokens.length > 0) {
    for (const tok of candidateTokens) {
      if (!isJwtFormat(tok)) {
        continue; // Non-JWT credentials cannot be a user session
      }
      try {
        const { data: { user }, error: authErr } = await adminClient.auth.getUser(tok);
        if (!authErr && user) {
          const { data: profile } = await adminClient
            .from("profiles")
            .select("role, is_active")
            .eq("id", user.id)
            .maybeSingle();

          if (profile && profile.is_active && ["super_admin", "admission_counsellor", "academic_counsellor"].includes(profile.role)) {
            isStaffUser = true;
            break;
          }
        } else if (authErr) {
          userAuthErrorMsg = authErr.message;
        }
      } catch (err: any) {
        userAuthErrorMsg = err?.message || String(err);
      }
    }
  }

  // 5. Enforce security gate: Reject all unauthorized callers, including anonymous/publishable keys
  if (!isServiceRole && !isStaffUser) {
    // Explicit rejection for public publishable/anon key callers
    if (isPublishableKeyCaller) {
      console.warn("[send-notification] Access Denied: Anonymous/publishable key caller rejected from notification dispatch.");
      return new Response(
        JSON.stringify({
          error: "Forbidden: Public publishable keys cannot authorize notification dispatch.",
          detail: "Notification dispatch requires a verified server-side service-role/secret key or authenticated staff session."
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Diagnostic log — strictly non-sensitive indicators (NO SECRETS)
    console.warn(
      `[send-notification] Auth failure (401):\n` +
      `  configured_service_keys_count=${configuredServiceKeys.length}\n` +
      `  apikey_present=${Boolean(cleanApiKey)}\n` +
      `  apikey_prefix=${safeTokenPrefix(cleanApiKey)}\n` +
      `  apikey_length=${cleanApiKey.length}\n` +
      `  authorization_present=${Boolean(cleanAuth)}\n` +
      `  authorization_prefix=${safeTokenPrefix(cleanAuth)}\n` +
      `  authorization_length=${cleanAuth.length}\n` +
      `  candidates_count=${candidateTokens.length}\n` +
      `  user_auth_err=${userAuthErrorMsg || "none"}`
    );

    return new Response(
      JSON.stringify({
        error: "Unauthorized: Missing or invalid authentication credentials.",
        detail: "Provide a valid service_role / secret key via apikey or Authorization header, or staff session token."
      }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 1. Recover stale records stuck in processing for >15 minutes
  try {
    await adminClient.rpc("reset_stale_outbox_records");
  } catch (resetErr: any) {
    console.warn("Notice: reset_stale_outbox_records check:", resetErr?.message);
  }

  // 2. Fetch records to process
  let pendingRecords: any[] = [];
  if (outboxId) {
    // Process specific outbox record - mark as processing atomically
    const { data } = await adminClient
      .from("notification_outbox")
      .update({ status: "processing", processed_at: new Date().toISOString() })
      .eq("id", outboxId)
      .eq("status", "pending")
      .select("*");
    pendingRecords = data || [];
  } else {
    // Batch claim records atomically using FOR UPDATE SKIP LOCKED via RPC
    try {
      const { data: claimedIds, error: claimErr } = await adminClient.rpc("claim_outbox_records", { p_batch_size: 15 });
      if (!claimErr && claimedIds && claimedIds.length > 0) {
        const { data: records } = await adminClient
          .from("notification_outbox")
          .select("*")
          .in("id", claimedIds);
        pendingRecords = records || [];
      }
    } catch (_rpcErr) {
      // Fallback query if RPC claim function is pending migration
      const { data } = await adminClient
        .from("notification_outbox")
        .select("*")
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .order("created_at", { ascending: true })
        .limit(15);
      pendingRecords = data || [];
    }
  }

  if (pendingRecords.length === 0) {
    return new Response(
      JSON.stringify({ success: true, processed: 0, message: "No pending notifications in outbox." }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // 3. Process records with isolation
  const results: any[] = [];
  for (const record of pendingRecords) {
    try {
      const res = await processOutboxRecord(adminClient, record, config);
      results.push({ id: record.id, event_type: record.event_type, ...res });
    } catch (err: any) {
      console.error(`Error processing outbox record ${record.id}:`, err);
      await adminClient
        .from("notification_outbox")
        .update({
          status: "failed",
          last_error: err?.message || String(err),
          processed_at: new Date().toISOString(),
        })
        .eq("id", record.id);
      results.push({ id: record.id, success: false, error: err?.message });
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      processed: results.length,
      results: results,
      message: `Processed ${results.length} notification(s) with APEX ACADEMY communication identity.`,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
