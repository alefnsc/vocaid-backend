-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'IN_PROCESS');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "clerk_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "image_url" TEXT,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "retell_call_id" TEXT,
    "job_title" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "job_description" TEXT NOT NULL,
    "resume_data" TEXT,
    "resume_file_name" TEXT,
    "resume_mime_type" TEXT,
    "status" "InterviewStatus" NOT NULL DEFAULT 'PENDING',
    "score" DOUBLE PRECISION,
    "feedback_pdf" TEXT,
    "feedback_text" TEXT,
    "call_duration" INTEGER,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mercadopago_id" TEXT,
    "preference_id" TEXT,
    "package_id" TEXT NOT NULL,
    "package_name" TEXT NOT NULL,
    "credits_amount" INTEGER NOT NULL,
    "amount_usd" DOUBLE PRECISION NOT NULL,
    "amount_brl" DOUBLE PRECISION NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "status_detail" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_id_key" ON "users"("clerk_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_clerk_id_idx" ON "users"("clerk_id");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_is_active_idx" ON "users"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "interviews_retell_call_id_key" ON "interviews"("retell_call_id");

-- CreateIndex
CREATE INDEX "interviews_user_id_idx" ON "interviews"("user_id");

-- CreateIndex
CREATE INDEX "interviews_retell_call_id_idx" ON "interviews"("retell_call_id");

-- CreateIndex
CREATE INDEX "interviews_status_idx" ON "interviews"("status");

-- CreateIndex
CREATE INDEX "interviews_created_at_idx" ON "interviews"("created_at");

-- CreateIndex
CREATE INDEX "interview_metrics_interview_id_idx" ON "interview_metrics"("interview_id");

-- CreateIndex
CREATE INDEX "interview_metrics_category_idx" ON "interview_metrics"("category");

-- CreateIndex
CREATE UNIQUE INDEX "payments_mercadopago_id_key" ON "payments"("mercadopago_id");

-- CreateIndex
CREATE INDEX "payments_user_id_idx" ON "payments"("user_id");

-- CreateIndex
CREATE INDEX "payments_mercadopago_id_idx" ON "payments"("mercadopago_id");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_created_at_idx" ON "payments"("created_at");

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_metrics" ADD CONSTRAINT "interview_metrics_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
