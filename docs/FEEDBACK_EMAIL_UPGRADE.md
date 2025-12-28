# Feedback Generation & Email System Upgrade

## Overview

This document summarizes the complete implementation of the improved feedback generation, PDF styling, and email delivery system for Vocaid.

---

## 1. Current-State Audit Summary

### Previous Architecture Issues

| Component | Issue | Impact |
|-----------|-------|--------|
| **Feedback JSON** | Generic prompt, no role-specific scoring | Inconsistent, generic feedback |
| **PDF Generation** | Frontend-only (jsPDF), basic styling | Security concern, unprofessional appearance |
| **Email Template** | Inline HTML, no localization | Not brand-consistent across languages |
| **Storage** | No versioning or audit trail | Cannot track feedback quality over time |
| **Large PDFs** | No size limits or memory management | Server crashes possible |

---

## 2. New Feedback JSON Schema (`/src/types/feedback.ts`)

### Key Features

- **Schema Version**: `1.0` for migration support
- **Prompt Version**: Tracks which LLM prompts generated the feedback
- **Model Version**: Records OpenAI model used

### Structure

```typescript
interface StructuredFeedback {
  schemaVersion: '1.0';
  promptVersion: string;
  model: string;
  generatedAt: string;
  
  session: SessionMetadata;
  overallScore: number; // 0-100
  scoreConfidence?: { lower: number; upper: number };
  executiveSummary: string;
  
  competencies: CompetencyScore[];      // With evidence & timestamps
  strengths: StrengthItem[];            // 3-5 with evidence
  improvements: ImprovementItem[];      // 3-5 with howToImprove
  highlights: InterviewHighlight[];     // Best/worst moments
  communication: CommunicationAnalysis; // Pace, filler words, clarity
  studyPlan: StudyPlanItem[];           // Prioritized topics
  nextSessionGoals: NextSessionGoal[];  // 1-2 measurable goals
  warnings: DataQualityWarning[];       // Data quality issues
}
```

---

## 3. Scoring Rubrics (`/src/types/rubrics.ts`)

### Role-Specific Competency Weights

| Role Type | Primary Competencies |
|-----------|---------------------|
| Software Engineer | Technical (30%), Problem Solving (25%), System Design (15%) |
| Frontend Engineer | Technical (30%), Communication (20%), Problem Solving (20%) |
| Product Manager | Communication (25%), Problem Solving (20%), Leadership (20%) |
| Engineering Manager | Leadership (30%), Communication (25%), Behavioral (20%) |

### Seniority Expectations

| Level | Min Score | Depth | Leadership | System Design |
|-------|-----------|-------|------------|---------------|
| Intern | 40 | Basic | No | No |
| Junior | 50 | Basic | No | No |
| Mid | 60 | Intermediate | No | Yes |
| Senior | 70 | Advanced | Yes | Yes |
| Staff+ | 75+ | Expert | Yes | Yes |

### Score Anchors (1-5 Scale)

Each competency has behavioral indicators for each score level:
- **1 (Insufficient)**: Cannot explain basics, fundamental errors
- **3 (Competent)**: Solid fundamentals, can apply correctly
- **5 (Expert)**: Industry-leading, can teach others

---

## 4. LLM Feedback Service (`/src/services/feedbackGenerationService.ts`)

### Layered Prompting Architecture

```
┌─────────────────────────────────────┐
│         SYSTEM PROMPT               │
│  - Schema compliance rules          │
│  - Truthfulness requirements        │
│  - Tone guidelines                  │
│  - Scoring principles               │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│        DEVELOPER PROMPT             │
│  - Role context                     │
│  - Seniority expectations           │
│  - Competency weights               │
│  - Scoring anchors                  │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│          USER PROMPT                │
│  - Interview metadata               │
│  - Timestamped transcript           │
│  - Resume skills (if provided)      │
│  - Speech analytics                 │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│        OUTPUT SCHEMA                │
│  - Exact JSON structure required    │
│  - All fields specified             │
└─────────────────────────────────────┘
```

### Key Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Model | `gpt-4-turbo-preview` | Best quality/speed balance |
| Temperature | `0.3` | Low for consistency |
| Max Tokens | `4000` | Enough for detailed feedback |
| Response Format | `json_object` | Enforced JSON output |

### Validation

- Schema validation (required fields, value bounds)
- Weighted score recalculation from competencies
- Data quality warnings for short interviews, missing resume

---

## 5. PDF Generation Service (`/src/services/pdfGenerationService.ts`)

### Brand Constants

```typescript
const BRAND = {
  purple600: [88, 28, 135],   // Primary accent
  gray900: [24, 24, 27],      // Headings
  gray700: [63, 63, 70],      // Body text
  green600: [22, 163, 74],    // Excellent scores
  yellow600: [202, 138, 4],   // Fair scores
  red600: [220, 38, 38],      // Needs improvement
};
```

### PDF Structure

1. **Header**
   - Purple accent bar
   - "Interview Feedback Report" title
   - Role + Seniority + Date

2. **Score Section**
   - Large score number with color coding
   - Score label (Excellent/Good/Fair/Needs Improvement)
   - Executive summary

3. **Competency Table**
   - Name, Score (0-5), Brief explanation
   - Alternating row backgrounds

4. **Strengths Section**
   - Green bullet points
   - Title + Description

5. **Improvements Section**
   - Priority badges (red/yellow/gray)
   - Title + How to improve + Time estimate

6. **Study Plan Section**
   - Purple border accent
   - Numbered topics with hour estimates
   - Exercises for each

7. **Next Session Goals**
   - Purple callout box
   - Measurable goals with targets

8. **Footer**
   - Page numbers
   - Vocaid branding

---

## 6. Email Template Service (`/src/services/emailTemplateService.ts`)

### Localization Support

Fully localized templates for:
- English (en)
- Spanish (es)
- Portuguese (pt)
- Chinese (zh)
- Hindi (hi)
- Japanese (ja)
- Korean (ko)
- German (de)
- French (fr)
- Italian (it)

### Email Structure

```html
┌─────────────────────────────────────┐
│  [Purple accent bar 6px]            │
├─────────────────────────────────────┤
│  Vocaid (logo text)                 │
│  Hi [Name],                         │
├─────────────────────────────────────┤
│  ┌─────────────────────────────┐    │
│  │  [Score Badge]  Excellent   │    │
│  │                 Role Title  │    │
│  └─────────────────────────────┘    │
├─────────────────────────────────────┤
│  Quick Summary                      │
│  [Executive summary text]           │
├─────────────────────────────────────┤
│  [View Full Report] (purple button) │
├─────────────────────────────────────┤
│  ╔═══════════════════════════════╗  │
│  ║ Your complete feedback report ║  │
│  ║ is attached as a PDF.         ║  │
│  ╚═══════════════════════════════╝  │
├─────────────────────────────────────┤
│  Footer:                            │
│  - Why you received this            │
│  - Support contact                  │
│  - Manage preferences               │
│  - © 2024 Vocaid                    │
└─────────────────────────────────────┘
```

---

## 7. Prisma Schema Updates

### New Models

#### FeedbackJson

```prisma
model FeedbackJson {
  id              String    @id @default(uuid()) @db.Uuid
  interviewId     String    @map("interview_id") @db.Uuid
  schemaVersion   String    @map("schema_version")
  promptVersion   String    @map("prompt_version")
  model           String
  contentJson     Json      @map("content_json") @db.JsonB
  overallScore    Float     @map("overall_score")
  generationTimeMs Int?     @map("generation_time_ms")
  tokenCount      Int?      @map("token_count")
  warningCount    Int?      @map("warning_count")
  createdAt       DateTime  @default(now())
  
  interview       Interview @relation(...)
  pdfs            FeedbackPdf[]
}
```

#### FeedbackPdf

```prisma
model FeedbackPdf {
  id              String    @id @default(uuid()) @db.Uuid
  interviewId     String    @map("interview_id") @db.Uuid
  feedbackJsonId  String    @map("feedback_json_id") @db.Uuid
  pageCount       Int       @map("page_count")
  fileSizeBytes   Int       @map("file_size_bytes")
  checksum        String    @db.VarChar(64)
  storageKey      String?   @map("storage_key")
  pdfBase64       String?   @map("pdf_base64") @db.Text
  locale          String?
  createdAt       DateTime  @default(now())
  
  interview       Interview @relation(...)
  feedbackJson    FeedbackJson @relation(...)
}
```

---

## 8. Large PDF Handling (`/src/routes/emailRoutes.ts`)

### Size Thresholds

| Threshold | Value | Purpose |
|-----------|-------|---------|
| MAX_DECODED_PDF_SIZE | 8 MB | Maximum decoded PDF |
| MAX_PDF_BASE64_LENGTH | ~10.6 MB | Base64 limit (8MB × 1.37) |
| TEMP_FILE_THRESHOLD | 2 MB | Switch to temp-file strategy |
| REQUEST_TIMEOUT_MS | 30 seconds | Request timeout guard |

### Two-Path Strategy

```
Request arrives
      │
      ▼
  Content-Length check
  (reject > 12MB before parsing)
      │
      ▼
  JSON body parsing
  (limit: 12MB)
      │
      ▼
  Zod validation
      │
      ▼
  PDF validation
  (magic bytes, decoded size)
      │
      ▼
  Size < 2MB? ───Yes──→ In-Memory Path
      │                      │
      No                     │
      │                      ▼
      ▼               Send via Resend
  Temp-File Path            │
      │                      │
      ▼                      │
  Write to /tmp/vocaid-pdf   │
      │                      │
      ▼                      │
  Send via Resend            │
      │                      │
      ▼                      │
  Cleanup temp file          │
      │                      │
      └──────────────────────┘
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| VALIDATION_ERROR | 400 | Invalid request body |
| INVALID_PDF | 400 | PDF format invalid |
| INVALID_BASE64 | 400 | Base64 encoding error |
| PAYLOAD_TOO_LARGE | 413 | PDF exceeds 8MB |
| NOT_FOUND | 404 | Interview not found |
| FORBIDDEN | 403 | Access denied |
| NO_EMAIL | 400 | User has no email |
| TIMEOUT | 408 | Request timeout |
| SEND_FAILED | 502 | Resend delivery failed |
| INTERNAL_ERROR | 500 | Unexpected error |

### Middleware Order

1. `addRequestId` - Generate unique request ID
2. `ensureJsonResponse` - Force JSON content type
3. `timeoutGuard` - 30s request timeout
4. `contentLengthCheck` - Reject before parsing
5. `pdfBodyParser` - Parse JSON with 12MB limit
6. `requireAuth` - Clerk authentication
7. Route handler
8. Error handler (always JSON)

---

## 9. Files Created/Modified

### New Files

| File | Purpose |
|------|---------|
| `/src/types/feedback.ts` | Structured feedback schema |
| `/src/types/rubrics.ts` | Scoring rubrics by role/seniority |
| `/src/services/feedbackGenerationService.ts` | LLM feedback generation |
| `/src/services/pdfGenerationService.ts` | Server-side PDF rendering |
| `/src/services/emailTemplateService.ts` | Branded email templates |

### Modified Files

| File | Changes |
|------|---------|
| `/prisma/schema.prisma` | Added FeedbackJson, FeedbackPdf models |
| `/src/routes/emailRoutes.ts` | v2.0 with large PDF handling |

### Migration Files

| File | Purpose |
|------|---------|
| `/prisma/migrations/manual_feedback_versioning.sql` | Idempotent SQL for production |

---

## 10. Deployment Checklist

### Pre-Deployment (Local/Dev)

- [ ] Run Prisma migration: `npx prisma migrate dev --name add_feedback_versioning`

### Pre-Deployment (Production)

Run the manual SQL migration script directly on the production database:

```bash
# Option 1: psql command line
psql -d Vocaid -U postgres -f prisma/migrations/manual_feedback_versioning.sql

# Option 2: Using DATABASE_URL
psql "$DATABASE_URL" -f prisma/migrations/manual_feedback_versioning.sql
```

The script is **idempotent** (safe to run multiple times) and includes verification checks.
- [ ] Verify jsPDF is in dependencies: `npm install jspdf`
- [ ] Ensure temp directory is writable: `/tmp/vocaid-pdf`

### Verification Steps

1. **TypeScript Compilation**
   ```bash
   npx tsc --noEmit
   ```

2. **Prisma Client Generation**
   ```bash
   npx prisma generate
   ```

3. **Run Unit Tests**
   ```bash
   npm test
   ```

4. **Manual E2E Test**
   - Complete a mock interview
   - Verify feedback page loads
   - Check PDF generation
   - Confirm email received with attachment

### Rollback Plan

If issues arise:
1. Revert to previous emailRoutes.ts
2. Keep using frontend PDF generation
3. Monitor email delivery logs

---

## 11. Future Improvements

1. **S3 Storage**: Move PDF storage from base64 in DB to S3
2. **Streaming PDF**: Use puppeteer for HTML→PDF with better styling
3. **Transcript Summarization**: For long interviews, summarize before LLM
4. **A/B Test Prompts**: Track prompt versions and compare feedback quality
5. **Real-time Analytics**: Track filler words, pace during interview
