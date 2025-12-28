-- ============================================================
-- MANUAL MIGRATION: Feedback Versioning Tables
-- ============================================================
-- Run this script on production to add FeedbackJson and FeedbackPdf tables.
-- 
-- Usage: 
--   psql -d Vocaid -U postgres -f manual_feedback_versioning.sql
--   OR run via pgAdmin / database client
--
-- This is safe to run multiple times (idempotent via IF NOT EXISTS).
-- ============================================================

-- Begin transaction
BEGIN;

-- ============================================================
-- TABLE: feedback_jsons
-- Stores structured feedback JSON with versioning metadata
-- ============================================================
CREATE TABLE IF NOT EXISTS "feedback_jsons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "interview_id" UUID NOT NULL,
    "schema_version" VARCHAR(20) NOT NULL,
    "prompt_version" VARCHAR(50) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "content_json" JSONB NOT NULL,
    "overall_score" DOUBLE PRECISION NOT NULL,
    "generation_time_ms" INTEGER,
    "token_count" INTEGER,
    "warning_count" INTEGER DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY ("id"),
    CONSTRAINT "feedback_jsons_interview_id_fkey" 
        FOREIGN KEY ("interview_id") 
        REFERENCES "interviews"("id") 
        ON DELETE CASCADE 
        ON UPDATE CASCADE
);

-- Indexes for feedback_jsons
CREATE INDEX IF NOT EXISTS "feedback_jsons_interview_id_idx" ON "feedback_jsons"("interview_id");
CREATE INDEX IF NOT EXISTS "feedback_jsons_schema_version_idx" ON "feedback_jsons"("schema_version");
CREATE INDEX IF NOT EXISTS "feedback_jsons_created_at_idx" ON "feedback_jsons"("created_at");

-- ============================================================
-- TABLE: feedback_pdfs
-- Stores PDF metadata and optional inline content
-- ============================================================
CREATE TABLE IF NOT EXISTS "feedback_pdfs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "interview_id" UUID NOT NULL,
    "feedback_json_id" UUID NOT NULL,
    "page_count" INTEGER NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "storage_key" VARCHAR(500),
    "pdf_base64" TEXT,
    "locale" VARCHAR(10),
    "includes_study_plan" BOOLEAN NOT NULL DEFAULT true,
    "includes_highlights" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY ("id"),
    CONSTRAINT "feedback_pdfs_interview_id_fkey" 
        FOREIGN KEY ("interview_id") 
        REFERENCES "interviews"("id") 
        ON DELETE CASCADE 
        ON UPDATE CASCADE,
    CONSTRAINT "feedback_pdfs_feedback_json_id_fkey" 
        FOREIGN KEY ("feedback_json_id") 
        REFERENCES "feedback_jsons"("id") 
        ON DELETE CASCADE 
        ON UPDATE CASCADE
);

-- Indexes for feedback_pdfs
CREATE INDEX IF NOT EXISTS "feedback_pdfs_interview_id_idx" ON "feedback_pdfs"("interview_id");
CREATE INDEX IF NOT EXISTS "feedback_pdfs_feedback_json_id_idx" ON "feedback_pdfs"("feedback_json_id");
CREATE INDEX IF NOT EXISTS "feedback_pdfs_checksum_idx" ON "feedback_pdfs"("checksum");
CREATE INDEX IF NOT EXISTS "feedback_pdfs_created_at_idx" ON "feedback_pdfs"("created_at");

-- ============================================================
-- Verify tables were created
-- ============================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'feedback_jsons') THEN
        RAISE NOTICE 'SUCCESS: feedback_jsons table exists';
    ELSE
        RAISE EXCEPTION 'FAILED: feedback_jsons table was not created';
    END IF;
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'feedback_pdfs') THEN
        RAISE NOTICE 'SUCCESS: feedback_pdfs table exists';
    ELSE
        RAISE EXCEPTION 'FAILED: feedback_pdfs table was not created';
    END IF;
END $$;

-- Commit transaction
COMMIT;

-- ============================================================
-- Post-migration: Regenerate Prisma client
-- ============================================================
-- After running this SQL, regenerate the Prisma client:
--   npx prisma generate
-- ============================================================
