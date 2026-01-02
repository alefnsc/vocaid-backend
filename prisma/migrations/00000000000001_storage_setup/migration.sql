-- ========================================
-- VOCAID SUPABASE STORAGE SETUP
-- Storage buckets and policies for B2C Interview Practice
-- ========================================

-- ========================================
-- CREATE STORAGE BUCKETS
-- ========================================

-- Bucket for user resumes (private)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'resumes',
  'resumes',
  false,
  10485760,  -- 10MB limit
  ARRAY['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
) ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

-- Bucket for feedback PDFs (private)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'feedback-pdfs',
  'feedback-pdfs',
  false,
  20971520,  -- 20MB limit
  ARRAY['application/pdf']
) ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 20971520,
  allowed_mime_types = ARRAY['application/pdf'];

-- Bucket for general documents (private)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'docs',
  'docs',
  false,
  10485760,  -- 10MB limit
  ARRAY['application/pdf', 'text/plain', 'application/json']
) ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 10485760;

-- Bucket for user images/avatars (public)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'images',
  'images',
  true,  -- Public for profile images
  5242880,  -- 5MB limit
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
) ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

-- ========================================
-- STORAGE POLICIES
-- Convention: {userId}/{type}/{filename}
-- Users can only access files in their own folder
-- ========================================

-- ----------------------------------------
-- RESUMES BUCKET POLICIES
-- ----------------------------------------

-- Users can view their own resumes
CREATE POLICY "Users can view own resumes"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can upload resumes to their own folder
CREATE POLICY "Users can upload own resumes"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can update their own resumes
CREATE POLICY "Users can update own resumes"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can delete their own resumes
CREATE POLICY "Users can delete own resumes"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- ----------------------------------------
-- FEEDBACK PDFS BUCKET POLICIES
-- ----------------------------------------

-- Users can view their own feedback PDFs
CREATE POLICY "Users can view own feedback pdfs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'feedback-pdfs' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Service role can upload feedback PDFs (backend only)
-- Note: Service role bypasses RLS, so no INSERT policy needed for backend

-- Users can download their own feedback PDFs
CREATE POLICY "Users can download own feedback pdfs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'feedback-pdfs' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- ----------------------------------------
-- DOCS BUCKET POLICIES
-- ----------------------------------------

-- Users can view their own docs
CREATE POLICY "Users can view own docs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'docs' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can upload to their own folder
CREATE POLICY "Users can upload own docs"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'docs' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can delete their own docs
CREATE POLICY "Users can delete own docs"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'docs' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- ----------------------------------------
-- IMAGES BUCKET POLICIES (PUBLIC)
-- ----------------------------------------

-- Anyone can view images (public bucket)
CREATE POLICY "Anyone can view images"
ON storage.objects FOR SELECT
USING (bucket_id = 'images');

-- Users can upload to their own folder
CREATE POLICY "Users can upload own images"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'images' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can update their own images
CREATE POLICY "Users can update own images"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'images' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can delete their own images
CREATE POLICY "Users can delete own images"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'images' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- ========================================
-- HELPER FUNCTIONS
-- ========================================

-- Function to get user's storage folder path
CREATE OR REPLACE FUNCTION get_user_storage_path(file_type TEXT, filename TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN auth.uid()::text || '/' || file_type || '/' || extract(epoch from now())::bigint || '_' || filename;
END;
$$;

-- Function to validate storage path belongs to user
CREATE OR REPLACE FUNCTION validate_storage_path(path TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN (string_to_array(path, '/'))[1] = auth.uid()::text;
END;
$$;

-- ========================================
-- COMMENTS
-- ========================================

COMMENT ON FUNCTION get_user_storage_path IS 'Generates a storage path with userId prefix for RLS compliance';
COMMENT ON FUNCTION validate_storage_path IS 'Validates that a storage path belongs to the current user';
