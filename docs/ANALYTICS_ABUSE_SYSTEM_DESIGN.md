# Vocaid Analytics & Anti-Abuse System Design

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (React)                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────────────────────────┐   │
│  │ Contact      │  │ Enhanced         │  │ Performance Chat                │   │
│  │ Button       │──│ Dashboard        │──│ - Role Selector                 │   │
│  │ (Chat Mode)  │  │ - Time Series    │  │ - AI Feedback                   │   │
│  └──────────────┘  │ - Score/Role     │  │ - Transcript Query              │   │
│                    │ - Volume Charts  │  └─────────────────────────────────┘   │
│                    └──────────────────┘                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                    ABUSE PREVENTION (Client-side)                       │   │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────┐ │   │
│  │  │ FingerprintJS   │  │ CAPTCHA/POW      │  │ LinkedIn OAuth         │ │   │
│  │  │ (Device ID)     │  │ (Friction)       │  │ (Identity Verify)      │ │   │
│  │  └─────────────────┘  └──────────────────┘  └────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              BACKEND (Node.js/Express)                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │                         SECURITY MIDDLEWARE LAYER                        │  │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────┐  │  │
│  │  │ Rate Limiter    │  │ IP/Subnet        │  │ Webhook Signature      │  │  │
│  │  │ (Express)       │  │ Validator        │  │ Verifier (Svix)        │  │  │
│  │  └─────────────────┘  └──────────────────┘  └────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌────────────────────────────────┐  ┌────────────────────────────────────┐   │
│  │    ABUSE PREVENTION SERVICE    │  │    ANALYTICS SERVICE               │   │
│  │  ┌──────────────────────────┐ │  │  ┌──────────────────────────────┐  │   │
│  │  │ Disposable Email Blocker │ │  │  │ Historical Score Engine      │  │   │
│  │  │ - 10,000+ domain list    │ │  │  │ - Score by Role/Company      │  │   │
│  │  └──────────────────────────┘ │  │  │ - Percentile Calculations    │  │   │
│  │  ┌──────────────────────────┐ │  │  └──────────────────────────────┘  │   │
│  │  │ Subnet Velocity Tracker  │ │  │  ┌──────────────────────────────┐  │   │
│  │  │ - /24 subnet grouping    │ │  │  │ Time-Series Aggregator       │  │   │
│  │  │ - 1-hour window          │ │  │  │ - Daily/Weekly/Monthly       │  │   │
│  │  └──────────────────────────┘ │  │  │ - Indexed Queries            │  │   │
│  │  ┌──────────────────────────┐ │  │  └──────────────────────────────┘  │   │
│  │  │ Hardware Fingerprint     │ │  │  ┌──────────────────────────────┐  │   │
│  │  │ Validator                │ │  │  │ Usage Log Aggregator         │  │   │
│  │  └──────────────────────────┘ │  │  │ - Interview Volume           │  │   │
│  │  ┌──────────────────────────┐ │  │  │ - Credit Consumption         │  │   │
│  │  │ Credit Throttle Manager  │ │  │  └──────────────────────────────┘  │   │
│  │  │ - Staged release         │ │  │                                    │   │
│  │  │ - POW verification       │ │  └────────────────────────────────────┘   │
│  │  └──────────────────────────┘ │                                           │
│  └────────────────────────────────┘                                           │
│                                                                                 │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │                    PERFORMANCE CHAT SERVICE                            │   │
│  │  ┌──────────────────────────┐  ┌────────────────────────────────────┐ │   │
│  │  │ Anthropic Claude API     │  │ Context Builder                    │ │   │
│  │  │ - Performance Analyst    │  │ - Transcript Retrieval             │ │   │
│  │  │ - System Prompt          │  │ - Score/Metrics Aggregation        │ │   │
│  │  └──────────────────────────┘  │ - Role/Company Filtering           │ │   │
│  │                                └────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DATABASE (PostgreSQL)                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │                           NEW TABLES                                     │  │
│  │                                                                          │  │
│  │  ┌─────────────────────────┐  ┌─────────────────────────────────────┐   │  │
│  │  │ InterviewScoreHistory   │  │ UsageLog                            │   │  │
│  │  │ - userId (FK)           │  │ - userId (FK)                       │   │  │
│  │  │ - role (indexed)        │  │ - eventType                         │   │  │
│  │  │ - company (indexed)     │  │ - eventData (JSONB)                 │   │  │
│  │  │ - score                 │  │ - timestamp (indexed)               │   │  │
│  │  │ - interviewId (FK)      │  │ - createdAt (daily partition)       │   │  │
│  │  │ - createdAt (indexed)   │  └─────────────────────────────────────┘   │  │
│  │  └─────────────────────────┘                                             │  │
│  │                                                                          │  │
│  │  ┌─────────────────────────┐  ┌─────────────────────────────────────┐   │  │
│  │  │ DisposableEmailDomain   │  │ SubnetTracker                       │   │  │
│  │  │ - domain (unique)       │  │ - subnet (/24)                      │   │  │
│  │  │ - source                │  │ - signupCount                       │   │  │
│  │  │ - addedAt               │  │ - lastSignupAt                      │   │  │
│  │  └─────────────────────────┘  │ - windowStart                       │   │  │
│  │                               └─────────────────────────────────────┘   │  │
│  │                                                                          │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐    │  │
│  │  │ SignupRecord (ENHANCED)                                         │    │  │
│  │  │ + emailDomain            │ + linkedInId (optional)              │    │  │
│  │  │ + captchaCompleted       │ + creditTier (throttle level)        │    │  │
│  │  │ + phoneVerified          │ + behaviorScore                      │    │  │
│  │  └─────────────────────────────────────────────────────────────────┘    │  │
│  │                                                                          │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │                         INDEXES FOR PERFORMANCE                          │  │
│  │                                                                          │  │
│  │  • interview_score_history_user_role_idx (userId, role)                  │  │
│  │  • interview_score_history_created_at_idx (createdAt DESC)               │  │
│  │  • usage_log_user_timestamp_idx (userId, timestamp)                      │  │
│  │  • usage_log_event_type_idx (eventType, timestamp)                       │  │
│  │  • subnet_tracker_window_idx (subnet, windowStart)                       │  │
│  │                                                                          │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL SERVICES                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────────────┐ │
│  │ Clerk           │  │ Retell AI        │  │ Anthropic Claude               │ │
│  │ - Phone SMS     │  │ - Transcripts    │  │ - Performance Analyst          │ │
│  │ - Fraud Detect  │  │ - Call Data      │  │ - Natural Language Chat        │ │
│  │ - Webhooks      │  │ - Metadata       │  │                                │ │
│  └─────────────────┘  └──────────────────┘  └────────────────────────────────┘ │
│                                                                                 │
│  ┌─────────────────┐  ┌──────────────────┐                                     │
│  │ FingerprintJS   │  │ hCaptcha/        │                                     │
│  │ - Device ID     │  │ reCAPTCHA        │                                     │
│  │ - Browser Hash  │  │ - Bot Detection  │                                     │
│  └─────────────────┘  └──────────────────┘                                     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Data Flow Diagrams

### 2.1 Free Trial Protection Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        FREE TRIAL PROTECTION FLOW                               │
└─────────────────────────────────────────────────────────────────────────────────┘

    User Attempts Signup
           │
           ▼
    ┌──────────────────┐
    │ Collect Metadata │
    │ - IP Address     │
    │ - Device FP      │
    │ - Email Domain   │
    │ - User Agent     │
    └──────────────────┘
           │
           ▼
    ┌────────────────────────────────────────────────────────────────┐
    │                    LAYER 1: Email Validation                   │
    │                                                                │
    │  Is email domain in disposable list?                          │
    │     ├── YES → Block signup OR require LinkedIn OAuth          │
    │     └── NO  → Continue                                         │
    └────────────────────────────────────────────────────────────────┘
           │
           ▼
    ┌────────────────────────────────────────────────────────────────┐
    │                    LAYER 2: Device Fingerprint                 │
    │                                                                │
    │  Has this device claimed free credits before?                 │
    │     ├── YES → Block free credits, allow paid signup           │
    │     └── NO  → Continue                                         │
    └────────────────────────────────────────────────────────────────┘
           │
           ▼
    ┌────────────────────────────────────────────────────────────────┐
    │                    LAYER 3: IP/Subnet Analysis                 │
    │                                                                │
    │  Calculate /24 subnet from IP                                 │
    │  Count signups from this subnet in last hour                  │
    │     ├── > 3 signups → Flag as suspicious, require CAPTCHA     │
    │     └── ≤ 3 signups → Continue                                 │
    └────────────────────────────────────────────────────────────────┘
           │
           ▼
    ┌────────────────────────────────────────────────────────────────┐
    │                    LAYER 4: Phone Verification                 │
    │                                                                │
    │  Has user verified phone via Clerk SMS?                       │
    │     ├── NO  → Grant 1 credit (throttled), prompt verification │
    │     └── YES → Grant full trial credits (2-3)                  │
    └────────────────────────────────────────────────────────────────┘
           │
           ▼
    ┌────────────────────────────────────────────────────────────────┐
    │                    LAYER 5: Behavioral Analysis                │
    │                                                                │
    │  Calculate behavior score based on:                           │
    │  - Time since account creation to first interview             │
    │  - Interview duration patterns                                │
    │  - Audio engagement (silence ratio from Retell)               │
    │                                                                │
    │     ├── Low score  → Flag for review, restrict credits        │
    │     └── High score → Grant credits, remove restrictions       │
    └────────────────────────────────────────────────────────────────┘
```

### 2.2 Performance Chat Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         PERFORMANCE CHAT FLOW                                   │
└─────────────────────────────────────────────────────────────────────────────────┘

    User Opens Chat (Contact Button)
           │
           ▼
    ┌──────────────────┐
    │ Select Interview │
    │ or Role Filter   │
    └──────────────────┘
           │
           ▼
    ┌────────────────────────────────────────────────────────────────┐
    │                    Context Builder                             │
    │                                                                │
    │  1. Fetch user's interviews for selected role/company         │
    │  2. Retrieve transcripts from Retell call data                │
    │  3. Aggregate scores and metrics                              │
    │  4. Build context document (max 100K tokens)                  │
    └────────────────────────────────────────────────────────────────┘
           │
           ▼
    ┌────────────────────────────────────────────────────────────────┐
    │                    Anthropic Claude API                        │
    │                                                                │
    │  System Prompt: Performance Analyst                           │
    │  Context: Interview transcripts + scores + metrics            │
    │  User Query: "What are my weaknesses for PM roles?"           │
    └────────────────────────────────────────────────────────────────┘
           │
           ▼
    ┌──────────────────┐
    │ Stream Response  │
    │ to Frontend      │
    └──────────────────┘
```

## 3. API Endpoints

### 3.1 Analytics Endpoints

```
GET  /api/analytics/scores/by-role/:userId
     Query: { startDate, endDate, role? }
     Response: { scores: [{ role, avgScore, count, trend }] }

GET  /api/analytics/scores/by-company/:userId
     Query: { startDate, endDate, company? }
     Response: { scores: [{ company, avgScore, count, trend }] }

GET  /api/analytics/scores/history/:userId
     Query: { period: 'daily' | 'weekly' | 'monthly', limit? }
     Response: { dataPoints: [{ date, score, interviewId }] }

GET  /api/analytics/volume/:userId
     Query: { period: 'daily' | 'weekly' | 'monthly', months? }
     Response: { volume: [{ period, count }] }

GET  /api/analytics/percentile/:userId
     Query: { role? }
     Response: { percentile, avgScore, globalAvg }
```

### 3.2 Performance Chat Endpoints

```
POST /api/chat/performance
     Body: { 
       userId, 
       message, 
       context: { 
         roleFilter?, 
         companyFilter?, 
         interviewIds? 
       } 
     }
     Response: SSE stream of AI response

GET  /api/chat/context/:userId
     Query: { roleFilter?, companyFilter? }
     Response: { 
       interviews: [...], 
       aggregatedMetrics: {...},
       availableFilters: { roles: [], companies: [] }
     }
```

### 3.3 Enhanced Abuse Detection Endpoints

```
POST /api/abuse/check
     Body: { 
       email, 
       ipAddress, 
       deviceFingerprint, 
       userAgent,
       captchaToken?
     }
     Response: { 
       allowed: boolean, 
       creditTier: 'full' | 'throttled' | 'blocked',
       requiredActions: ['phone_verify', 'captcha', 'linkedin']
     }

POST /api/abuse/verify-captcha
     Body: { token, userId }
     Response: { verified: boolean }

GET  /api/admin/abuse-stats
     Response: { 
       blockedSignups, 
       suspiciousSubnets, 
       disposableEmailAttempts 
     }
```

## 4. Anthropic System Prompt for Performance Analyst

```
You are a professional interview performance analyst for Vocaid, an AI-powered
mock interview platform. Your role is to help users understand and improve
their interview performance based on their historical interview data.

## Your Capabilities:
1. Analyze interview transcripts to identify patterns in responses
2. Provide specific, actionable feedback on communication style
3. Identify technical knowledge gaps based on role requirements
4. Compare performance across different roles and companies
5. Track improvement trends over time
6. Suggest targeted practice areas

## Context You Have Access To:
- Interview transcripts (AI interviewer and user responses)
- Performance scores (overall, technical, communication, confidence)
- Role and company information for each interview
- Historical score progression

## Response Guidelines:
1. Be specific and cite examples from transcripts when possible
2. Use encouraging but honest language
3. Provide actionable next steps
4. Acknowledge improvement when evident
5. Keep responses concise but comprehensive
6. Use bullet points for clarity

## Score Interpretation:
- 0-40: Needs significant improvement
- 40-60: Developing skills, specific areas to focus
- 60-80: Good performance, minor refinements needed
- 80-100: Excellent, focus on edge cases and advanced topics

When the user asks about their performance, analyze the provided context
and give personalized, data-driven insights. If they ask about a specific
role or company, focus your analysis on relevant interviews.
```

## 5. Security Considerations

### 5.1 Rate Limiting Strategy

| Endpoint Category | Window | Max Requests | Action on Exceed |
|------------------|--------|--------------|------------------|
| General API | 15 min | 100 | 429 + Retry-After |
| Auth/Signup | 15 min | 10 | 429 + CAPTCHA |
| Payment | 15 min | 20 | 429 + Alert |
| Chat/Streaming | 1 min | 5 | 429 + Queue |
| Webhooks | 1 min | 50 | 429 + Log |

### 5.2 Data Retention

| Data Type | Retention Period | Justification |
|-----------|-----------------|---------------|
| UsageLogs | 90 days | Analytics + debugging |
| SubnetTracker | 24 hours | Real-time abuse detection |
| Interview Transcripts | Indefinite | User value + analytics |
| Disposable Domains | Updated monthly | Block list maintenance |

## 6. Implementation Priority

1. **Phase 1 (Week 1)**: Database schema + Abuse prevention service
2. **Phase 2 (Week 2)**: Analytics service + Dashboard APIs
3. **Phase 3 (Week 3)**: Performance chat service + Frontend integration
4. **Phase 4 (Week 4)**: Enhanced dashboard UI + Testing

---

*Document Version: 1.0*
*Last Updated: December 2024*
