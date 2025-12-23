-- Add auth provider tracking fields to users table
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_providers" VARCHAR(30)[] DEFAULT ARRAY[]::VARCHAR(30)[];
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_auth_provider" VARCHAR(30);

-- Create index for auth provider queries
CREATE INDEX IF NOT EXISTS "users_last_auth_provider_idx" ON "users"("last_auth_provider");
