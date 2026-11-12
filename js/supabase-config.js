/**
 * APEX ACADEMY – Supabase Configuration
 * To connect to your Supabase project:
 * 1. Open your Supabase Dashboard: https://supabase.com/dashboard/project/_/settings/api
 * 2. Copy "Project URL" and paste into SUPABASE_URL below.
 * 3. Copy "anon public" API Key and paste into SUPABASE_ANON_KEY below.
 */

window.APEX_SUPABASE_CONFIG = {
  // Replace with your real Supabase Project URL and anon public key:
  url: window.APEX_SUPABASE_URL || 'https://YOUR_SUPABASE_PROJECT_ID.supabase.co',
  anonKey: window.APEX_SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY',

  isConfigured() {
    return Boolean(
      this.url &&
      this.anonKey &&
      !this.url.includes('YOUR_SUPABASE_PROJECT_ID') &&
      !this.anonKey.includes('YOUR_SUPABASE_ANON_KEY')
    );
  }
};
