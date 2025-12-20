-- AlterTable
ALTER TABLE "interviews" ADD COLUMN     "confidence_timeline" JSONB,
ADD COLUMN     "sentiment_score" DOUBLE PRECISION,
ADD COLUMN     "transcript" TEXT,
ADD COLUMN     "wpm_average" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "signup_records" ADD COLUMN     "behavior_score" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "captcha_completed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "credit_tier" TEXT NOT NULL DEFAULT 'full',
ADD COLUMN     "email_domain" TEXT,
ADD COLUMN     "linkedin_id" TEXT,
ADD COLUMN     "phone_verified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "initial_ip" VARCHAR(45),
ADD COLUMN     "onboarding_complete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "preferred_language" VARCHAR(10),
ADD COLUMN     "registration_country" VARCHAR(2),
ADD COLUMN     "registration_region" VARCHAR(10);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "speaker" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "start_time" DOUBLE PRECISION NOT NULL,
    "end_time" DOUBLE PRECISION NOT NULL,
    "sentiment_score" DOUBLE PRECISION,
    "segment_index" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_performance_benchmarks" (
    "id" UUID NOT NULL,
    "role_title" TEXT NOT NULL,
    "global_average_score" DOUBLE PRECISION NOT NULL,
    "total_interviews" INTEGER NOT NULL,
    "score_distribution" JSONB NOT NULL,
    "avg_communication" DOUBLE PRECISION,
    "avg_problem_solving" DOUBLE PRECISION,
    "avg_technical_depth" DOUBLE PRECISION,
    "avg_leadership" DOUBLE PRECISION,
    "avg_adaptability" DOUBLE PRECISION,
    "last_calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_performance_benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_recommendations" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "topics" JSONB NOT NULL,
    "weak_areas" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_score_history" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "overall_score" DOUBLE PRECISION NOT NULL,
    "technical_score" DOUBLE PRECISION,
    "communication_score" DOUBLE PRECISION,
    "confidence_score" DOUBLE PRECISION,
    "call_duration" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_score_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_data" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disposable_email_domains" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "source" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disposable_email_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subnet_trackers" (
    "id" UUID NOT NULL,
    "subnet" TEXT NOT NULL,
    "signup_count" INTEGER NOT NULL DEFAULT 1,
    "last_signup_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "window_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subnet_trackers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_filter" TEXT,
    "company_filter" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transcript_segments_interview_id_idx" ON "transcript_segments"("interview_id");

-- CreateIndex
CREATE INDEX "transcript_segments_start_time_idx" ON "transcript_segments"("start_time");

-- CreateIndex
CREATE INDEX "transcript_segments_segment_index_idx" ON "transcript_segments"("segment_index");

-- CreateIndex
CREATE UNIQUE INDEX "role_performance_benchmarks_role_title_key" ON "role_performance_benchmarks"("role_title");

-- CreateIndex
CREATE INDEX "role_performance_benchmarks_role_title_idx" ON "role_performance_benchmarks"("role_title");

-- CreateIndex
CREATE INDEX "role_performance_benchmarks_last_calculated_at_idx" ON "role_performance_benchmarks"("last_calculated_at");

-- CreateIndex
CREATE UNIQUE INDEX "study_recommendations_interview_id_key" ON "study_recommendations"("interview_id");

-- CreateIndex
CREATE INDEX "study_recommendations_interview_id_idx" ON "study_recommendations"("interview_id");

-- CreateIndex
CREATE INDEX "interview_score_history_user_id_role_idx" ON "interview_score_history"("user_id", "role");

-- CreateIndex
CREATE INDEX "interview_score_history_user_id_company_idx" ON "interview_score_history"("user_id", "company");

-- CreateIndex
CREATE INDEX "interview_score_history_user_id_created_at_idx" ON "interview_score_history"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "interview_score_history_created_at_idx" ON "interview_score_history"("created_at");

-- CreateIndex
CREATE INDEX "interview_score_history_role_idx" ON "interview_score_history"("role");

-- CreateIndex
CREATE INDEX "usage_logs_user_id_timestamp_idx" ON "usage_logs"("user_id", "timestamp");

-- CreateIndex
CREATE INDEX "usage_logs_event_type_timestamp_idx" ON "usage_logs"("event_type", "timestamp");

-- CreateIndex
CREATE INDEX "usage_logs_timestamp_idx" ON "usage_logs"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "disposable_email_domains_domain_key" ON "disposable_email_domains"("domain");

-- CreateIndex
CREATE INDEX "disposable_email_domains_domain_idx" ON "disposable_email_domains"("domain");

-- CreateIndex
CREATE INDEX "disposable_email_domains_is_active_idx" ON "disposable_email_domains"("is_active");

-- CreateIndex
CREATE INDEX "subnet_trackers_subnet_idx" ON "subnet_trackers"("subnet");

-- CreateIndex
CREATE INDEX "subnet_trackers_window_start_idx" ON "subnet_trackers"("window_start");

-- CreateIndex
CREATE INDEX "subnet_trackers_expires_at_idx" ON "subnet_trackers"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "subnet_trackers_subnet_window_start_key" ON "subnet_trackers"("subnet", "window_start");

-- CreateIndex
CREATE INDEX "chat_sessions_user_id_idx" ON "chat_sessions"("user_id");

-- CreateIndex
CREATE INDEX "chat_sessions_is_active_idx" ON "chat_sessions"("is_active");

-- CreateIndex
CREATE INDEX "chat_messages_session_id_idx" ON "chat_messages"("session_id");

-- CreateIndex
CREATE INDEX "chat_messages_created_at_idx" ON "chat_messages"("created_at");

-- CreateIndex
CREATE INDEX "interviews_job_title_idx" ON "interviews"("job_title");

-- CreateIndex
CREATE INDEX "interviews_company_name_idx" ON "interviews"("company_name");

-- CreateIndex
CREATE INDEX "signup_records_email_domain_idx" ON "signup_records"("email_domain");

-- CreateIndex
CREATE INDEX "signup_records_credit_tier_idx" ON "signup_records"("credit_tier");

-- CreateIndex
CREATE INDEX "signup_records_phone_verified_idx" ON "signup_records"("phone_verified");

-- CreateIndex
CREATE INDEX "users_preferred_language_idx" ON "users"("preferred_language");

-- CreateIndex
CREATE INDEX "users_registration_region_idx" ON "users"("registration_region");

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_score_history" ADD CONSTRAINT "interview_score_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_score_history" ADD CONSTRAINT "interview_score_history_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
