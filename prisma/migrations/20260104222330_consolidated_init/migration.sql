-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('PERSONAL');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('FORM', 'OAUTH');

-- CreateEnum
CREATE TYPE "ResumeSource" AS ENUM ('UPLOAD', 'LINKEDIN', 'GENERATED');

-- CreateEnum
CREATE TYPE "ResumeScoreProvider" AS ENUM ('AFFINDA', 'TEXTKERNEL', 'INTERNAL_KEYWORD', 'INTERNAL_INTERVIEW_OUTCOME');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InterviewEndReason" AS ENUM ('COMPLETED', 'USER_HANGUP', 'TIME_LIMIT', 'INCOMPATIBILITY', 'TECHNICAL_ERROR', 'SILENCE_TIMEOUT', 'AGENT_ERROR');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'IN_PROCESS');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MERCADOPAGO', 'PAYPAL', 'STRIPE');

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('PURCHASE', 'GRANT', 'SPEND', 'REFUND', 'RESTORE', 'ADMIN', 'PROMO', 'REFERRAL', 'EXPIRE');

-- CreateEnum
CREATE TYPE "EmailSendStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TransactionalEmailType" AS ENUM ('WELCOME', 'CREDITS_PURCHASE_RECEIPT', 'PASSWORD_RESET', 'INTERVIEW_REMINDER', 'LOW_CREDITS_WARNING', 'INTERVIEW_COMPLETE');

-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('RESEND');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "google_id" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "image_url" TEXT,
    "password_hash" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "email_verified_at" TIMESTAMP(3),
    "credits" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_type" "UserType" NOT NULL DEFAULT 'PERSONAL',
    "country_code" VARCHAR(2) NOT NULL DEFAULT 'BR',
    "preferred_language" VARCHAR(10),
    "registration_region" VARCHAR(10),
    "registration_country" VARCHAR(2),
    "initial_ip" VARCHAR(45),
    "onboarding_complete" BOOLEAN NOT NULL DEFAULT false,
    "onboarding_completed_at" TIMESTAMP(3),
    "current_role" VARCHAR(50),
    "current_seniority" VARCHAR(30),
    "auth_providers" VARCHAR(30)[],
    "last_auth_provider" VARCHAR(30),
    "phone_number" VARCHAR(20),
    "phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "phone_verified_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credits_wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "total_earned" INTEGER NOT NULL DEFAULT 0,
    "total_spent" INTEGER NOT NULL DEFAULT 0,
    "total_purchased" INTEGER NOT NULL DEFAULT 0,
    "total_granted" INTEGER NOT NULL DEFAULT 0,
    "last_credit_at" TIMESTAMP(3),
    "last_debit_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credits_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "reference_type" VARCHAR(50),
    "reference_id" UUID,
    "description" VARCHAR(255) NOT NULL,
    "metadata" JSONB,
    "idempotency_key" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_documents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source" "ResumeSource" NOT NULL DEFAULT 'UPLOAD',
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "storage_key" VARCHAR(500),
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linkedin_profile_url" VARCHAR(500),
    "parsed_text" TEXT,
    "parsed_metadata" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parent_version_id" UUID,
    "is_latest" BOOLEAN NOT NULL DEFAULT true,
    "quality_score" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_scores" (
    "id" UUID NOT NULL,
    "resume_id" UUID NOT NULL,
    "role_title" VARCHAR(255) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "provider" "ResumeScoreProvider" NOT NULL,
    "breakdown" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "privacy_accepted_at" TIMESTAMP(3) NOT NULL,
    "terms_version" VARCHAR(20) NOT NULL,
    "privacy_version" VARCHAR(20) NOT NULL,
    "transactional_opt_in" BOOLEAN NOT NULL DEFAULT true,
    "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "marketing_opt_in_at" TIMESTAMP(3),
    "marketing_version" VARCHAR(20),
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "source" "ConsentSource" NOT NULL DEFAULT 'FORM',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "retell_call_id" TEXT,
    "job_title" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "job_description" TEXT NOT NULL,
    "role_country_code" VARCHAR(2),
    "seniority" VARCHAR(30),
    "language" VARCHAR(10),
    "agent_id" VARCHAR(100),
    "voice_id" VARCHAR(100),
    "resume_score_at_session" INTEGER,
    "resume_storage_key" VARCHAR(500),
    "resume_file_name" TEXT,
    "resume_mime_type" TEXT,
    "resume_id" UUID,
    "status" "InterviewStatus" NOT NULL DEFAULT 'PENDING',
    "score" DOUBLE PRECISION,
    "feedback_pdf_storage_key" VARCHAR(500),
    "feedback_text" TEXT,
    "call_duration" INTEGER,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "transcript" TEXT,
    "sentiment_score" DOUBLE PRECISION,
    "wpm_average" DOUBLE PRECISION,
    "confidence_timeline" JSONB,
    "email_sent_at" TIMESTAMP(3),
    "email_send_status" "EmailSendStatus" NOT NULL DEFAULT 'PENDING',
    "email_last_error" TEXT,
    "email_idempotency_key" VARCHAR(255),
    "email_message_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_jsons" (
    "id" UUID NOT NULL,
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

    CONSTRAINT "feedback_jsons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_pdfs" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "feedback_json_id" UUID NOT NULL,
    "page_count" INTEGER NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "storage_key" VARCHAR(500),
    "locale" VARCHAR(10),
    "includes_study_plan" BOOLEAN NOT NULL DEFAULT true,
    "includes_highlights" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pdfs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_metrics" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "metric_name" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "max_score" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "feedback" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_metrics_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "study_recommendations" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "topics" JSONB NOT NULL,
    "weak_areas" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MERCADOPAGO',
    "mercadopago_id" TEXT,
    "preference_id" TEXT,
    "provider_payment_id" VARCHAR(255),
    "package_id" TEXT NOT NULL,
    "package_name" TEXT NOT NULL,
    "credits_amount" INTEGER NOT NULL,
    "amount_usd" DOUBLE PRECISION NOT NULL,
    "amount_brl" DOUBLE PRECISION NOT NULL,
    "currency" VARCHAR(3),
    "exchange_rate" DOUBLE PRECISION,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "status_detail" TEXT,
    "webhook_idempotency_key" VARCHAR(255),
    "webhook_processed_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
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
    "resource_type" VARCHAR(50),
    "amount" INTEGER NOT NULL DEFAULT 0,
    "interview_id" UUID,
    "description" TEXT,
    "event_data" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "to_email" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(500) NOT NULL,
    "template_type" VARCHAR(50) NOT NULL,
    "status" "EmailSendStatus" NOT NULL DEFAULT 'PENDING',
    "message_id" VARCHAR(255),
    "error_message" TEXT,
    "idempotency_key" VARCHAR(255),
    "language" VARCHAR(10),
    "has_attachment" BOOLEAN NOT NULL DEFAULT false,
    "attachment_size" INTEGER,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactional_emails" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "to_email" VARCHAR(255) NOT NULL,
    "email_type" "TransactionalEmailType" NOT NULL,
    "status" "EmailSendStatus" NOT NULL DEFAULT 'PENDING',
    "provider" "EmailProvider" NOT NULL DEFAULT 'RESEND',
    "provider_message_id" VARCHAR(255),
    "idempotency_key" VARCHAR(255) NOT NULL,
    "payload_json" JSONB,
    "error_json" JSONB,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "language" VARCHAR(10),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactional_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_sessions" (
    "id" UUID NOT NULL,
    "interview_id" UUID NOT NULL,
    "retell_call_id" VARCHAR(100),
    "retell_agent_id" VARCHAR(100),
    "language" VARCHAR(10) NOT NULL,
    "role_title" VARCHAR(200) NOT NULL,
    "seniority" VARCHAR(30),
    "role_country" VARCHAR(2),
    "call_started_at" TIMESTAMP(3),
    "first_agent_utterance_at" TIMESTAMP(3),
    "call_ended_at" TIMESTAMP(3),
    "time_to_first_token" INTEGER,
    "time_to_first_audio" INTEGER,
    "avg_response_latency" DOUBLE PRECISION,
    "transcript_length" INTEGER,
    "total_turns" INTEGER,
    "agent_turns" INTEGER,
    "user_turns" INTEGER,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "total_tokens" INTEGER,
    "estimated_cost_usd" DOUBLE PRECISION,
    "llm_model" VARCHAR(100),
    "llm_provider" VARCHAR(50),
    "end_reason" "InterviewEndReason",
    "completion_rate" DOUBLE PRECISION,
    "clarification_turns" INTEGER,
    "silence_count" INTEGER,
    "retell_duration_sec" INTEGER,
    "retell_disconnect_reason" VARCHAR(100),
    "has_custom_prompt" BOOLEAN NOT NULL DEFAULT false,
    "recruiter_prompt_length" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_is_active_idx" ON "users"("is_active");

-- CreateIndex
CREATE INDEX "users_preferred_language_idx" ON "users"("preferred_language");

-- CreateIndex
CREATE INDEX "users_registration_region_idx" ON "users"("registration_region");

-- CreateIndex
CREATE INDEX "users_current_role_idx" ON "users"("current_role");

-- CreateIndex
CREATE INDEX "users_onboarding_completed_at_idx" ON "users"("onboarding_completed_at");

-- CreateIndex
CREATE INDEX "users_user_type_idx" ON "users"("user_type");

-- CreateIndex
CREATE INDEX "users_country_code_idx" ON "users"("country_code");

-- CreateIndex
CREATE INDEX "users_phone_number_idx" ON "users"("phone_number");

-- CreateIndex
CREATE INDEX "users_phone_verified_idx" ON "users"("phone_verified");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");

-- CreateIndex
CREATE INDEX "email_verification_tokens_expires_at_idx" ON "email_verification_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "email_verification_tokens_used_at_idx" ON "email_verification_tokens"("used_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "password_reset_tokens_used_at_idx" ON "password_reset_tokens"("used_at");

-- CreateIndex
CREATE UNIQUE INDEX "credits_wallets_user_id_key" ON "credits_wallets"("user_id");

-- CreateIndex
CREATE INDEX "credits_wallets_balance_idx" ON "credits_wallets"("balance");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_key" ON "credit_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "credit_ledger_user_id_created_at_idx" ON "credit_ledger"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "credit_ledger_type_idx" ON "credit_ledger"("type");

-- CreateIndex
CREATE INDEX "credit_ledger_reference_type_reference_id_idx" ON "credit_ledger"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "credit_ledger_created_at_idx" ON "credit_ledger"("created_at");

-- CreateIndex
CREATE INDEX "resume_documents_user_id_idx" ON "resume_documents"("user_id");

-- CreateIndex
CREATE INDEX "resume_documents_is_primary_idx" ON "resume_documents"("is_primary");

-- CreateIndex
CREATE INDEX "resume_documents_is_active_is_latest_idx" ON "resume_documents"("is_active", "is_latest");

-- CreateIndex
CREATE INDEX "resume_documents_tags_idx" ON "resume_documents"("tags");

-- CreateIndex
CREATE INDEX "resume_documents_last_used_at_idx" ON "resume_documents"("last_used_at");

-- CreateIndex
CREATE INDEX "resume_documents_source_idx" ON "resume_documents"("source");

-- CreateIndex
CREATE INDEX "resume_documents_storage_key_idx" ON "resume_documents"("storage_key");

-- CreateIndex
CREATE INDEX "resume_scores_resume_id_idx" ON "resume_scores"("resume_id");

-- CreateIndex
CREATE INDEX "resume_scores_role_title_idx" ON "resume_scores"("role_title");

-- CreateIndex
CREATE INDEX "resume_scores_provider_idx" ON "resume_scores"("provider");

-- CreateIndex
CREATE INDEX "resume_scores_score_idx" ON "resume_scores"("score");

-- CreateIndex
CREATE UNIQUE INDEX "resume_scores_resume_id_role_title_provider_key" ON "resume_scores"("resume_id", "role_title", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "user_consents_user_id_key" ON "user_consents"("user_id");

-- CreateIndex
CREATE INDEX "user_consents_terms_accepted_at_idx" ON "user_consents"("terms_accepted_at");

-- CreateIndex
CREATE INDEX "user_consents_privacy_accepted_at_idx" ON "user_consents"("privacy_accepted_at");

-- CreateIndex
CREATE INDEX "user_consents_marketing_opt_in_idx" ON "user_consents"("marketing_opt_in");

-- CreateIndex
CREATE INDEX "user_consents_source_idx" ON "user_consents"("source");

-- CreateIndex
CREATE UNIQUE INDEX "interviews_retell_call_id_key" ON "interviews"("retell_call_id");

-- CreateIndex
CREATE UNIQUE INDEX "interviews_email_idempotency_key_key" ON "interviews"("email_idempotency_key");

-- CreateIndex
CREATE INDEX "interviews_user_id_idx" ON "interviews"("user_id");

-- CreateIndex
CREATE INDEX "interviews_retell_call_id_idx" ON "interviews"("retell_call_id");

-- CreateIndex
CREATE INDEX "interviews_status_idx" ON "interviews"("status");

-- CreateIndex
CREATE INDEX "interviews_created_at_idx" ON "interviews"("created_at");

-- CreateIndex
CREATE INDEX "interviews_job_title_idx" ON "interviews"("job_title");

-- CreateIndex
CREATE INDEX "interviews_company_name_idx" ON "interviews"("company_name");

-- CreateIndex
CREATE INDEX "interviews_seniority_idx" ON "interviews"("seniority");

-- CreateIndex
CREATE INDEX "interviews_language_idx" ON "interviews"("language");

-- CreateIndex
CREATE INDEX "interviews_resume_id_idx" ON "interviews"("resume_id");

-- CreateIndex
CREATE INDEX "interviews_email_send_status_idx" ON "interviews"("email_send_status");

-- CreateIndex
CREATE INDEX "interviews_role_country_code_idx" ON "interviews"("role_country_code");

-- CreateIndex
CREATE INDEX "interviews_user_id_created_at_idx" ON "interviews"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "interviews_user_id_ended_at_idx" ON "interviews"("user_id", "ended_at");

-- CreateIndex
CREATE INDEX "feedback_jsons_interview_id_idx" ON "feedback_jsons"("interview_id");

-- CreateIndex
CREATE INDEX "feedback_jsons_schema_version_idx" ON "feedback_jsons"("schema_version");

-- CreateIndex
CREATE INDEX "feedback_jsons_created_at_idx" ON "feedback_jsons"("created_at");

-- CreateIndex
CREATE INDEX "feedback_pdfs_interview_id_idx" ON "feedback_pdfs"("interview_id");

-- CreateIndex
CREATE INDEX "feedback_pdfs_feedback_json_id_idx" ON "feedback_pdfs"("feedback_json_id");

-- CreateIndex
CREATE INDEX "feedback_pdfs_checksum_idx" ON "feedback_pdfs"("checksum");

-- CreateIndex
CREATE INDEX "feedback_pdfs_created_at_idx" ON "feedback_pdfs"("created_at");

-- CreateIndex
CREATE INDEX "feedback_pdfs_storage_key_idx" ON "feedback_pdfs"("storage_key");

-- CreateIndex
CREATE INDEX "interview_metrics_interview_id_idx" ON "interview_metrics"("interview_id");

-- CreateIndex
CREATE INDEX "interview_metrics_category_idx" ON "interview_metrics"("category");

-- CreateIndex
CREATE INDEX "transcript_segments_interview_id_idx" ON "transcript_segments"("interview_id");

-- CreateIndex
CREATE INDEX "transcript_segments_start_time_idx" ON "transcript_segments"("start_time");

-- CreateIndex
CREATE INDEX "transcript_segments_segment_index_idx" ON "transcript_segments"("segment_index");

-- CreateIndex
CREATE UNIQUE INDEX "study_recommendations_interview_id_key" ON "study_recommendations"("interview_id");

-- CreateIndex
CREATE INDEX "study_recommendations_interview_id_idx" ON "study_recommendations"("interview_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_mercadopago_id_key" ON "payments"("mercadopago_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_webhook_idempotency_key_key" ON "payments"("webhook_idempotency_key");

-- CreateIndex
CREATE INDEX "payments_user_id_idx" ON "payments"("user_id");

-- CreateIndex
CREATE INDEX "payments_mercadopago_id_idx" ON "payments"("mercadopago_id");

-- CreateIndex
CREATE INDEX "payments_provider_idx" ON "payments"("provider");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_created_at_idx" ON "payments"("created_at");

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
CREATE INDEX "usage_logs_user_id_resource_type_created_at_idx" ON "usage_logs"("user_id", "resource_type", "created_at");

-- CreateIndex
CREATE INDEX "usage_logs_event_type_timestamp_idx" ON "usage_logs"("event_type", "timestamp");

-- CreateIndex
CREATE INDEX "usage_logs_timestamp_idx" ON "usage_logs"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "email_logs_idempotency_key_key" ON "email_logs"("idempotency_key");

-- CreateIndex
CREATE INDEX "email_logs_interview_id_idx" ON "email_logs"("interview_id");

-- CreateIndex
CREATE INDEX "email_logs_status_idx" ON "email_logs"("status");

-- CreateIndex
CREATE INDEX "email_logs_to_email_idx" ON "email_logs"("to_email");

-- CreateIndex
CREATE INDEX "email_logs_template_type_idx" ON "email_logs"("template_type");

-- CreateIndex
CREATE INDEX "email_logs_created_at_idx" ON "email_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "transactional_emails_idempotency_key_key" ON "transactional_emails"("idempotency_key");

-- CreateIndex
CREATE INDEX "transactional_emails_user_id_idx" ON "transactional_emails"("user_id");

-- CreateIndex
CREATE INDEX "transactional_emails_email_type_idx" ON "transactional_emails"("email_type");

-- CreateIndex
CREATE INDEX "transactional_emails_status_idx" ON "transactional_emails"("status");

-- CreateIndex
CREATE INDEX "transactional_emails_to_email_idx" ON "transactional_emails"("to_email");

-- CreateIndex
CREATE INDEX "transactional_emails_created_at_idx" ON "transactional_emails"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "interview_sessions_interview_id_key" ON "interview_sessions"("interview_id");

-- CreateIndex
CREATE INDEX "interview_sessions_interview_id_idx" ON "interview_sessions"("interview_id");

-- CreateIndex
CREATE INDEX "interview_sessions_retell_call_id_idx" ON "interview_sessions"("retell_call_id");

-- CreateIndex
CREATE INDEX "interview_sessions_language_idx" ON "interview_sessions"("language");

-- CreateIndex
CREATE INDEX "interview_sessions_role_title_idx" ON "interview_sessions"("role_title");

-- CreateIndex
CREATE INDEX "interview_sessions_call_started_at_idx" ON "interview_sessions"("call_started_at");

-- CreateIndex
CREATE INDEX "interview_sessions_end_reason_idx" ON "interview_sessions"("end_reason");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits_wallets" ADD CONSTRAINT "credits_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_documents" ADD CONSTRAINT "resume_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_documents" ADD CONSTRAINT "resume_documents_parent_version_id_fkey" FOREIGN KEY ("parent_version_id") REFERENCES "resume_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_scores" ADD CONSTRAINT "resume_scores_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_jsons" ADD CONSTRAINT "feedback_jsons_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_pdfs" ADD CONSTRAINT "feedback_pdfs_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_pdfs" ADD CONSTRAINT "feedback_pdfs_feedback_json_id_fkey" FOREIGN KEY ("feedback_json_id") REFERENCES "feedback_jsons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_metrics" ADD CONSTRAINT "interview_metrics_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_recommendations" ADD CONSTRAINT "study_recommendations_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_score_history" ADD CONSTRAINT "interview_score_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_score_history" ADD CONSTRAINT "interview_score_history_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactional_emails" ADD CONSTRAINT "transactional_emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

