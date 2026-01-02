import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// Supabase project configuration
const supabaseUrl = env.SUPABASE_URL || 'https://vnbauggmguyyyqpndwgn.supabase.co';

// Service role key for backend operations (bypasses RLS)
const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';

// Anon key for client-like operations
const supabaseAnonKey = env.SUPABASE_ANON_KEY || '';

// Create Supabase admin client (uses service_role key, bypasses RLS)
// Use this for backend operations that need full access
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  global: {
    headers: {
      'x-application-name': 'vocaid-backend',
    },
  },
});

// Create Supabase client with anon key (respects RLS)
// Use this when you want to simulate client-side access
export const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Storage bucket names
export const STORAGE_BUCKETS = {
  RESUMES: 'resumes',
  FEEDBACK_PDFS: 'feedback-pdfs',
  DOCS: 'docs',
  IMAGES: 'images',
} as const;

// ========================================
// STORAGE HELPERS
// ========================================

/**
 * Upload a file to Supabase Storage
 * Uses admin client to bypass RLS for backend operations
 */
export const uploadFile = async (
  bucket: string,
  path: string,
  file: Buffer | Blob,
  options?: {
    contentType?: string;
    upsert?: boolean;
  }
): Promise<string> => {
  const { data, error } = await supabaseAdmin.storage.from(bucket).upload(path, file, {
    contentType: options?.contentType,
    upsert: options?.upsert ?? false,
  });

  if (error) {
    console.error(`[Supabase Storage] Upload failed for ${bucket}/${path}:`, error);
    throw error;
  }

  return data.path;
};

/**
 * Upload a base64-encoded file to Supabase Storage
 * Converts base64 to Buffer before uploading
 */
export const uploadBase64File = async (
  bucket: string,
  path: string,
  base64Data: string,
  mimeType: string,
  options?: { upsert?: boolean }
): Promise<string> => {
  // Remove data URL prefix if present
  const base64Clean = base64Data.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64Clean, 'base64');

  return uploadFile(bucket, path, buffer, {
    contentType: mimeType,
    upsert: options?.upsert,
  });
};

/**
 * Generate a signed URL for private file access
 */
export const getSignedUrl = async (
  bucket: string,
  path: string,
  expiresIn: number = 3600 // 1 hour default
): Promise<string> => {
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);

  if (error) {
    console.error(`[Supabase Storage] Signed URL failed for ${bucket}/${path}:`, error);
    throw error;
  }

  return data.signedUrl;
};

/**
 * Get public URL for a file (only works for public buckets)
 */
export const getPublicUrl = (bucket: string, path: string): string => {
  const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
};

/**
 * Delete files from storage
 */
export const deleteFiles = async (bucket: string, paths: string[]): Promise<void> => {
  const { error } = await supabaseAdmin.storage.from(bucket).remove(paths);

  if (error) {
    console.error(`[Supabase Storage] Delete failed for ${bucket}:`, error);
    throw error;
  }
};

/**
 * Download a file from storage
 */
export const downloadFile = async (bucket: string, path: string): Promise<Blob> => {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);

  if (error) {
    console.error(`[Supabase Storage] Download failed for ${bucket}/${path}:`, error);
    throw error;
  }

  return data;
};

/**
 * List files in a storage path
 */
export const listFiles = async (
  bucket: string,
  path?: string,
  options?: { limit?: number; offset?: number }
) => {
  const { data, error } = await supabaseAdmin.storage.from(bucket).list(path, {
    limit: options?.limit || 100,
    offset: options?.offset || 0,
  });

  if (error) {
    console.error(`[Supabase Storage] List failed for ${bucket}/${path}:`, error);
    throw error;
  }

  return data;
};

// ========================================
// AUTH HELPERS (for verifying Supabase Auth tokens)
// ========================================

/**
 * Verify a Supabase Auth JWT and return the user
 * Use this in middleware to validate frontend requests
 */
export const verifySupabaseToken = async (token: string) => {
  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error) {
    console.error('[Supabase Auth] Token verification failed:', error);
    throw error;
  }

  return data.user;
};

/**
 * Get user by Supabase user ID
 */
export const getUserBySupabaseId = async (supabaseUserId: string) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('supabase_user_id', supabaseUserId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('[Supabase] Get user failed:', error);
    throw error;
  }

  return data;
};

/**
 * Generate storage path for user files
 * Convention: {userId}/{type}/{filename}
 */
export const generateStoragePath = (
  userId: string,
  fileType: 'resume' | 'feedback-pdf' | 'doc' | 'image',
  filename: string
): string => {
  const timestamp = Date.now();
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${userId}/${fileType}/${timestamp}_${sanitizedFilename}`;
};

export default supabaseAdmin;
