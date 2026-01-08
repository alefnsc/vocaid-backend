-- CreateEnum
CREATE TYPE "BetaFeedbackType" AS ENUM ('BUG', 'FEATURE');

-- CreateEnum
CREATE TYPE "BetaFeedbackStatus" AS ENUM ('NEW', 'TRIAGED', 'DONE', 'SPAM');

-- CreateEnum
CREATE TYPE "BetaFeedbackSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'BLOCKING');

-- CreateEnum
CREATE TYPE "BetaFeedbackFrequency" AS ENUM ('ALWAYS', 'SOMETIMES', 'ONCE');

-- CreateEnum
CREATE TYPE "BetaFeedbackPriority" AS ENUM ('NICE_TO_HAVE', 'IMPORTANT', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BetaFeedbackTargetUser" AS ENUM ('SELF', 'RECRUITERS', 'OTHER');

-- CreateTable
CREATE TABLE "beta_feedback" (
    "id" UUID NOT NULL,
    "ref_id" UUID NOT NULL,
    "type" "BetaFeedbackType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "BetaFeedbackSeverity",
    "frequency" "BetaFeedbackFrequency",
    "steps_to_reproduce" JSONB,
    "expected_behavior" TEXT,
    "actual_behavior" TEXT,
    "priority" "BetaFeedbackPriority",
    "target_user" "BetaFeedbackTargetUser",
    "goal" TEXT,
    "alternatives_tried" TEXT,
    "page_url" VARCHAR(500) NOT NULL,
    "user_email" VARCHAR(255) NOT NULL,
    "clerk_user_id" VARCHAR(100),
    "vocaid_user_id" UUID,
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "app_env" VARCHAR(20) NOT NULL,
    "app_version" VARCHAR(20) NOT NULL,
    "user_agent" VARCHAR(500),
    "allow_follow_up" BOOLEAN NOT NULL DEFAULT false,
    "status" "BetaFeedbackStatus" NOT NULL DEFAULT 'NEW',
    "source" VARCHAR(50) NOT NULL DEFAULT 'web',
    "ip_address" VARCHAR(45),
    "recaptcha_score" DOUBLE PRECISION,
    "recaptcha_action" VARCHAR(50),
    "recaptcha_verified_at" TIMESTAMP(3),
    "recaptcha_raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "beta_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "beta_feedback_ref_id_key" ON "beta_feedback"("ref_id");

-- CreateIndex
CREATE INDEX "beta_feedback_type_idx" ON "beta_feedback"("type");

-- CreateIndex
CREATE INDEX "beta_feedback_status_idx" ON "beta_feedback"("status");

-- CreateIndex
CREATE INDEX "beta_feedback_user_email_idx" ON "beta_feedback"("user_email");

-- CreateIndex
CREATE INDEX "beta_feedback_clerk_user_id_idx" ON "beta_feedback"("clerk_user_id");

-- CreateIndex
CREATE INDEX "beta_feedback_vocaid_user_id_idx" ON "beta_feedback"("vocaid_user_id");

-- CreateIndex
CREATE INDEX "beta_feedback_created_at_idx" ON "beta_feedback"("created_at");

-- AddForeignKey
ALTER TABLE "beta_feedback" ADD CONSTRAINT "beta_feedback_vocaid_user_id_fkey" FOREIGN KEY ("vocaid_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
