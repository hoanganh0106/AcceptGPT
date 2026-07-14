import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from './config';
import type { Database } from './supabase-types';
export type AppSupabaseClient = SupabaseClient<Database>;
export function createSupabaseClient(config: Pick<AppConfig, 'supabaseUrl' | 'supabaseSecretKey'>): AppSupabaseClient {
  return createClient<Database>(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
