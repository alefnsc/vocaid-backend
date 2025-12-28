/**
 * Seed Mock Interviews
 * 
 * Creates rich interview data with markdown feedback for testing
 * the Feedback page, InterviewDetails, and Interviews list views.
 * 
 * Run with: npx ts-node prisma/seed-mock-interviews.ts
 */

import { PrismaClient, InterviewStatus } from '@prisma/client';

const prisma = new PrismaClient();

// Helper to generate date N days ago
function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

// Helper to format timestamp as mm:ss
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Mock interview data with rich markdown feedback
const mockInterviews = [
  {
    jobTitle: 'Senior Frontend Engineer',
    companyName: 'Stripe',
    jobDescription: 'We are looking for a Senior Frontend Engineer to join our Payments team. You will work on building scalable, accessible UI components using React and TypeScript. Experience with design systems and performance optimization required.',
    seniority: 'Senior',
    language: 'en',
    status: InterviewStatus.COMPLETED,
    score: 87,
    callDuration: 1250, // ~21 minutes
    daysAgoCreated: 3,
    feedbackText: `## Summary

Excellent interview performance demonstrating strong technical depth and clear communication skills. The candidate showed deep understanding of React patterns, TypeScript best practices, and modern frontend architecture. Areas of strength include component design, performance optimization, and explaining complex concepts clearly.

## 💪 Strengths

- **Component Architecture**: Demonstrated excellent understanding of component composition patterns, explaining how to build reusable, accessible components with proper prop drilling alternatives like Context and composition.
- **Performance Optimization**: Provided concrete examples of React.memo, useMemo, and code splitting strategies with clear explanations of when each approach is appropriate.
- **TypeScript Expertise**: Strong typing skills evident in discussing discriminated unions, generic components, and type inference patterns.
- **Communication Clarity**: Explained technical concepts in a structured, easy-to-follow manner using the STAR method effectively.

## 📈 Areas for Improvement

- **Testing Strategy**: While understanding was shown, could benefit from more depth in discussing integration testing patterns with React Testing Library and end-to-end testing with Playwright.
- **State Management Trade-offs**: Consider exploring more nuanced comparisons between Redux, Zustand, and React Query for different use cases.
- **Accessibility Details**: Good high-level understanding but could provide more specific ARIA attribute examples and screen reader testing approaches.

## Recommendations

- Study React Testing Library's user-event patterns and async utilities
- Build a small project comparing Zustand vs Jotai for atomic state management
- Complete the Deque University accessibility certification
- Practice explaining system design decisions with trade-off matrices

## Evidence (Timestamped)

| Time | Quote | Analysis |
|------|-------|----------|
| ${formatTimestamp(142)} | "I'd use React.memo with a custom comparison function here because the object prop changes reference on every render but the values stay the same" | Excellent understanding of memoization nuances |
| ${formatTimestamp(287)} | "For this payment form, I'd implement optimistic updates with rollback using React Query's mutation callbacks" | Strong real-world application of data fetching patterns |
| ${formatTimestamp(445)} | "The STAR method helps me structure... Situation was a checkout page with 3 second load times" | Clear communication and concrete examples |

## Next Practice Plan (7 days)

| Day | Focus Area | Exercise |
|-----|------------|----------|
| 1-2 | Testing | Write integration tests for a form component with RTL |
| 3-4 | State Management | Build a todo app with Zustand, then refactor to Jotai |
| 5-6 | Accessibility | Audit a sample app with axe-core and fix all issues |
| 7 | Mock Interview | Practice explaining trade-offs for 30 minutes |
`,
    metrics: [
      { category: 'technical', metricName: 'React & TypeScript', score: 9.2, feedback: 'Excellent depth in modern React patterns' },
      { category: 'technical', metricName: 'Problem Solving', score: 8.5, feedback: 'Strong analytical approach' },
      { category: 'communication', metricName: 'Clarity', score: 8.8, feedback: 'Clear and structured explanations' },
      { category: 'communication', metricName: 'Conciseness', score: 8.2, feedback: 'Good balance of detail and brevity' },
      { category: 'behavioral', metricName: 'STAR Method', score: 8.7, feedback: 'Effective use of structured answers' },
      { category: 'behavioral', metricName: 'Confidence', score: 8.5, feedback: 'Poised and assured delivery' }
    ]
  },
  {
    jobTitle: 'Full Stack Developer',
    companyName: 'Notion',
    jobDescription: 'Join Notion as a Full Stack Developer working on our collaborative editing features. You will work across the stack with React, Node.js, and PostgreSQL. Experience with real-time systems and WebSockets is a plus.',
    seniority: 'Mid',
    language: 'en',
    status: InterviewStatus.COMPLETED,
    score: 72,
    callDuration: 980, // ~16 minutes
    daysAgoCreated: 12,
    feedbackText: `## Summary

Good interview showing solid foundational knowledge across the full stack. The candidate demonstrated competence in both frontend and backend technologies with room to deepen expertise in real-time systems and database optimization.

## 💪 Strengths

- **Full Stack Versatility**: Comfortable discussing both React components and Node.js API design, showing genuine cross-stack capability.
- **Database Fundamentals**: Good understanding of PostgreSQL queries, indexing, and basic query optimization.
- **API Design**: Clear explanations of RESTful patterns and when to use different HTTP methods.

## 📈 Areas for Improvement

- **Real-time Systems**: Limited depth in WebSocket implementation patterns and handling connection state management.
- **Performance at Scale**: Could benefit from discussing caching strategies, connection pooling, and horizontal scaling approaches.
- **System Design**: Answers stayed at implementation level; practice thinking about architectural trade-offs.

## Recommendations

- Build a real-time chat application using Socket.io to gain hands-on WebSocket experience
- Study database indexing strategies with EXPLAIN ANALYZE in PostgreSQL
- Take the "Designing Data-Intensive Applications" book chapter on replication
- Practice system design questions focusing on collaboration features

## Evidence (Timestamped)

| Time | Quote | Analysis |
|------|-------|----------|
| ${formatTimestamp(95)} | "I'd use useEffect with a WebSocket connection, and... um, clean it up in the return function" | Correct pattern but hesitation suggests less experience |
| ${formatTimestamp(234)} | "For the API, I'd make the endpoint POST /documents/{id}/collaborators and return the updated collaborator list" | Good REST API intuition |
| ${formatTimestamp(412)} | "I'm not sure about the exact query but I'd add an index on the foreign key" | Correct instinct but needs more specificity |

## Next Practice Plan (7 days)

| Day | Focus Area | Exercise |
|-----|------------|----------|
| 1-2 | WebSockets | Build a simple real-time counter with Socket.io |
| 3-4 | PostgreSQL | Practice EXPLAIN ANALYZE on 5 different queries |
| 5 | Caching | Implement Redis caching for an API endpoint |
| 6-7 | System Design | Design a Google Docs-like collaborative editor (whiteboard practice) |
`,
    metrics: [
      { category: 'technical', metricName: 'Frontend', score: 7.5, feedback: 'Solid React knowledge' },
      { category: 'technical', metricName: 'Backend', score: 7.2, feedback: 'Good Node.js fundamentals' },
      { category: 'technical', metricName: 'Database', score: 6.8, feedback: 'Basics covered, depth needed' },
      { category: 'communication', metricName: 'Clarity', score: 7.4, feedback: 'Generally clear but some hesitation' },
      { category: 'behavioral', metricName: 'Problem Solving', score: 7.0, feedback: 'Methodical approach' }
    ]
  },
  {
    jobTitle: 'Backend Engineer',
    companyName: 'Datadog',
    jobDescription: 'Datadog is hiring Backend Engineers to work on our observability platform. You will build high-throughput data pipelines using Go and Kafka. Experience with distributed systems and monitoring at scale required.',
    seniority: 'Senior',
    language: 'en',
    status: InterviewStatus.COMPLETED,
    score: 65,
    callDuration: 1100, // ~18 minutes
    daysAgoCreated: 28,
    feedbackText: `## Summary

The candidate showed foundational knowledge but struggled with some distributed systems concepts critical to the role. Good communication skills and problem-solving approach, but technical depth in high-throughput systems needs development.

## 💪 Strengths

- **Problem-Solving Approach**: Methodically broke down problems and asked clarifying questions before diving into solutions.
- **Communication**: Clear articulation of thought process, making it easy to follow reasoning.
- **Basic Go Knowledge**: Demonstrated familiarity with Go syntax, goroutines, and channels.

## 📈 Areas for Improvement

- **Kafka Internals**: Limited understanding of partitioning strategies, consumer groups, and exactly-once semantics.
- **Distributed Systems Patterns**: Needs deeper knowledge of consensus algorithms, leader election, and partition tolerance.
- **Performance Optimization**: Could not articulate specific strategies for handling millions of events per second.
- **Go Advanced Patterns**: Worker pools, graceful shutdown, and context cancellation patterns need work.

## Recommendations

- Complete the Kafka Definitive Guide book, focusing on chapters 4-6
- Implement a basic Raft consensus algorithm to understand distributed consensus
- Study Datadog's engineering blog posts on their ingest pipeline architecture
- Build a high-throughput Go service with proper worker pool patterns
- Practice explaining trade-offs for different message queue configurations

## Evidence (Timestamped)

| Time | Quote | Analysis |
|------|-------|----------|
| ${formatTimestamp(156)} | "I think Kafka uses... partitions for parallelism? I'm not sure how consumer groups work exactly" | Gaps in fundamental Kafka concepts |
| ${formatTimestamp(298)} | "For high throughput I'd use goroutines, maybe a buffered channel" | Right direction but missing specifics |
| ${formatTimestamp(445)} | "I haven't worked with exactly-once semantics, but I imagine you'd need some kind of ID" | Honest about gaps, correct intuition |

## Next Practice Plan (7 days)

| Day | Focus Area | Exercise |
|-----|------------|----------|
| 1-2 | Kafka | Set up local Kafka, experiment with partitions and consumer groups |
| 3-4 | Go Patterns | Implement a worker pool with graceful shutdown |
| 5 | Distributed Systems | Read Raft paper and implement key-value store |
| 6-7 | Load Testing | Build and load test a 100k req/sec service |
`,
    metrics: [
      { category: 'technical', metricName: 'Go Proficiency', score: 6.5, feedback: 'Basic knowledge, advanced patterns needed' },
      { category: 'technical', metricName: 'Kafka/Messaging', score: 5.5, feedback: 'Conceptual gaps present' },
      { category: 'technical', metricName: 'Distributed Systems', score: 6.0, feedback: 'Foundational understanding' },
      { category: 'communication', metricName: 'Clarity', score: 7.5, feedback: 'Clear thought process' },
      { category: 'behavioral', metricName: 'Honesty', score: 8.0, feedback: 'Honest about knowledge gaps' }
    ]
  },
  {
    jobTitle: 'Software Engineer',
    companyName: 'Vercel',
    jobDescription: 'Join Vercel to work on Next.js and our deployment platform. You will build features used by millions of developers. Strong JavaScript/TypeScript skills and understanding of web performance required.',
    seniority: 'Mid',
    language: 'en',
    status: InterviewStatus.COMPLETED,
    score: 91,
    callDuration: 1380, // ~23 minutes
    daysAgoCreated: 45,
    feedbackText: `## Summary

Outstanding interview performance! The candidate demonstrated exceptional knowledge of Next.js, web performance, and the modern JavaScript ecosystem. Answers were detailed, practical, and showed real-world experience. This candidate would be an excellent fit for the role.

## 💪 Strengths

- **Next.js Expertise**: Deep understanding of App Router, Server Components, Server Actions, and the rendering strategies (SSG, SSR, ISR).
- **Web Performance**: Excellent articulation of Core Web Vitals, bundle optimization, image loading strategies, and performance debugging.
- **TypeScript Mastery**: Sophisticated use of generics, conditional types, and type-safe API design.
- **Practical Experience**: Every answer backed by real-world examples and trade-off discussions.
- **Communication Excellence**: Answers were perfectly structured with context, solution, and rationale.

## 📈 Areas for Improvement

- **Edge Runtime Limitations**: Could expand knowledge on Edge runtime constraints and when to choose different runtimes.
- **Monorepo Tooling**: Basic familiarity with Turborepo but could deepen understanding of caching and task orchestration.

## Recommendations

- Explore Edge Runtime in more depth by building an edge-first application
- Contribute to or study Turborepo's caching mechanism
- Consider writing a blog post about your Next.js performance optimization experiences
- Continue practicing to maintain this excellent level

## Evidence (Timestamped)

| Time | Quote | Analysis |
|------|-------|----------|
| ${formatTimestamp(89)} | "With Server Components, I'd fetch the data directly in the component, use Suspense for streaming, and the client bundle stays small because the component never ships to the browser" | Excellent understanding of RSC benefits |
| ${formatTimestamp(234)} | "For this image gallery, I'd use next/image with priority on above-the-fold images, lazy loading below, and blur placeholder for perceived performance" | Perfect practical application |
| ${formatTimestamp(567)} | "The trade-off with ISR is stale data during revalidation, so for this dashboard I'd use on-demand revalidation triggered by a webhook when data changes" | Nuanced understanding of caching strategies |
| ${formatTimestamp(890)} | "I'd set up the TypeScript config with strict mode, noUncheckedIndexedAccess, and exactOptionalPropertyTypes for maximum type safety" | Advanced TypeScript configuration knowledge |

## Next Practice Plan (7 days)

| Day | Focus Area | Exercise |
|-----|------------|----------|
| 1-2 | Edge Runtime | Build an API route using Edge Runtime with limitations in mind |
| 3-4 | Turborepo | Set up a monorepo with shared packages and explore caching |
| 5-7 | Open Source | Find a good first issue in the Next.js repository |
`,
    metrics: [
      { category: 'technical', metricName: 'Next.js', score: 9.5, feedback: 'Expert-level knowledge' },
      { category: 'technical', metricName: 'TypeScript', score: 9.2, feedback: 'Advanced type system understanding' },
      { category: 'technical', metricName: 'Web Performance', score: 9.0, feedback: 'Excellent Core Web Vitals knowledge' },
      { category: 'communication', metricName: 'Clarity', score: 9.3, feedback: 'Exceptionally clear explanations' },
      { category: 'communication', metricName: 'Structure', score: 9.0, feedback: 'Well-organized answers' },
      { category: 'behavioral', metricName: 'Confidence', score: 8.8, feedback: 'Assured without arrogance' }
    ]
  },
  {
    jobTitle: 'Junior Developer',
    companyName: 'Shopify',
    jobDescription: 'Shopify is looking for a Junior Developer to join our merchant tools team. You will work with React and Ruby on Rails. This is a great opportunity for early-career developers to learn and grow.',
    seniority: 'Junior',
    language: 'en',
    status: InterviewStatus.COMPLETED,
    score: 58,
    callDuration: 720, // ~12 minutes
    daysAgoCreated: 60,
    feedbackText: `## Summary

The candidate showed enthusiasm and basic programming knowledge appropriate for a junior position. There is clear potential for growth with proper mentorship. Technical foundations are present but need strengthening in practical application.

## 💪 Strengths

- **Enthusiasm & Curiosity**: Showed genuine interest in learning and asked thoughtful follow-up questions.
- **Basic React Knowledge**: Understands component basics, props, and simple state management.
- **Coachable Attitude**: Receptive to hints and guidance during the interview, showing growth potential.
- **Honest Self-Assessment**: Acknowledged areas of uncertainty rather than guessing.

## 📈 Areas for Improvement

- **React Hooks**: Limited understanding of useEffect, dependency arrays, and cleanup functions.
- **JavaScript Fundamentals**: Needs stronger grasp of async/await, promises, and array methods.
- **Problem Decomposition**: Tendency to jump to code before fully understanding the problem.
- **API Integration**: Basic understanding but hasn't implemented full CRUD operations.
- **Ruby on Rails**: Minimal exposure; would need significant onboarding.

## Recommendations

- Complete freeCodeCamp's JavaScript Algorithms and Data Structures certification
- Build 3 small React projects with increasing complexity (todo app → weather app → e-commerce)
- Take an online Ruby on Rails tutorial to understand MVC basics
- Practice "thinking out loud" during problem-solving
- Study common array methods: map, filter, reduce, find

## Evidence (Timestamped)

| Time | Quote | Analysis |
|------|-------|----------|
| ${formatTimestamp(67)} | "I'd use useState to track the items... but I'm not sure when useEffect runs exactly" | Good instinct but needs hooks practice |
| ${formatTimestamp(189)} | "Can I ask a clarifying question? Should the data come from an API or be hardcoded?" | Good practice asking for requirements |
| ${formatTimestamp(345)} | "I haven't used Ruby before but I know it's object-oriented like Python" | Honest and shows some programming context |

## Next Practice Plan (7 days)

| Day | Focus Area | Exercise |
|-----|------------|----------|
| 1-2 | JavaScript | Complete 20 array method exercises on Exercism |
| 3-4 | React Hooks | Build a counter with useState, then add useEffect for document title |
| 5 | API Integration | Fetch and display data from a public API |
| 6-7 | Rails Basics | Complete the Rails Getting Started guide |
`,
    metrics: [
      { category: 'technical', metricName: 'React Basics', score: 5.5, feedback: 'Foundational understanding' },
      { category: 'technical', metricName: 'JavaScript', score: 5.0, feedback: 'Needs fundamentals work' },
      { category: 'technical', metricName: 'Problem Solving', score: 5.8, feedback: 'Basic approach, room to grow' },
      { category: 'communication', metricName: 'Clarity', score: 6.0, feedback: 'Understandable but could be clearer' },
      { category: 'behavioral', metricName: 'Coachability', score: 7.5, feedback: 'Receptive to feedback' },
      { category: 'behavioral', metricName: 'Enthusiasm', score: 8.0, feedback: 'Genuine interest' }
    ]
  },
  {
    jobTitle: 'Staff Engineer',
    companyName: 'Figma',
    jobDescription: 'Figma is hiring a Staff Engineer to lead technical initiatives on our core editor team. You will architect solutions for real-time collaboration, mentor engineers, and drive technical strategy. 8+ years of experience required.',
    seniority: 'Staff',
    language: 'en',
    status: InterviewStatus.COMPLETED,
    score: 78,
    callDuration: 1560, // ~26 minutes
    daysAgoCreated: 75,
    feedbackText: `## Summary

Strong technical depth and good leadership examples demonstrated. The candidate has the experience and capability for a staff role, but could strengthen their approach to cross-team influence and technical strategy articulation. Good potential with some areas to develop.

## 💪 Strengths

- **Technical Architecture**: Excellent understanding of CRDT-based real-time systems and conflict resolution.
- **Mentorship Examples**: Provided concrete examples of growing junior engineers through pairing and code review.
- **System Design**: Strong ability to break down complex systems into well-bounded components.
- **Performance Intuition**: Good instincts for identifying performance bottlenecks and optimization strategies.

## 📈 Areas for Improvement

- **Cross-Team Influence**: Examples were primarily within the immediate team; need to demonstrate broader organizational impact.
- **Technical Strategy Communication**: Could improve at articulating long-term technical vision to non-technical stakeholders.
- **Trade-off Matrices**: Good at identifying trade-offs but could structure decisions more systematically.
- **Conflict Resolution**: Limited examples of navigating technical disagreements at the staff level.

## Recommendations

- Document a technical vision for a project and present it to a mock stakeholder group
- Practice the "disagree and commit" pattern in real scenarios
- Study how other staff engineers at Figma communicate technical strategy (engineering blog)
- Build a framework for evaluating technical decisions with clear criteria and weights
- Seek opportunities to influence teams outside your immediate scope

## Evidence (Timestamped)

| Time | Quote | Analysis |
|------|-------|----------|
| ${formatTimestamp(234)} | "For real-time collaboration I'd use a CRDT like Y.js, with a central server for persistence and conflict resolution for edge cases the CRDT can't handle automatically" | Strong technical depth |
| ${formatTimestamp(456)} | "I mentored a junior engineer by pairing twice a week for three months, and she's now a mid-level leading her own feature" | Good concrete mentorship example |
| ${formatTimestamp(678)} | "I'm not sure how I'd convince another team to adopt this... I'd probably talk to their manager?" | Opportunity to develop influence skills |
| ${formatTimestamp(890)} | "The trade-off is consistency vs. availability, and for a design tool I'd prioritize availability with eventual consistency" | Good instinct for contextual decisions |

## Next Practice Plan (7 days)

| Day | Focus Area | Exercise |
|-----|------------|----------|
| 1-2 | Technical Writing | Write a 1-page RFC for a technical initiative |
| 3-4 | Stakeholder Communication | Practice explaining technical trade-offs to a non-technical friend |
| 5 | Influence | Identify a cross-team opportunity at work and draft an approach |
| 6-7 | Decision Frameworks | Create a decision matrix for a past architectural decision |
`,
    metrics: [
      { category: 'technical', metricName: 'Architecture', score: 8.5, feedback: 'Strong system design skills' },
      { category: 'technical', metricName: 'Real-time Systems', score: 8.2, feedback: 'Deep CRDT understanding' },
      { category: 'leadership', metricName: 'Mentorship', score: 8.0, feedback: 'Good concrete examples' },
      { category: 'leadership', metricName: 'Cross-team Influence', score: 6.5, feedback: 'Area for development' },
      { category: 'communication', metricName: 'Technical Strategy', score: 7.0, feedback: 'Could be stronger' },
      { category: 'behavioral', metricName: 'Decision Making', score: 7.5, feedback: 'Good instincts, needs structure' }
    ]
  }
];

async function main() {
  const targetEmail = 'alexandrefonsecach@gmail.com';
  
  console.log('🔍 Looking for user:', targetEmail);
  
  const user = await prisma.user.findUnique({
    where: { email: targetEmail }
  });
  
  if (!user) {
    console.error('❌ User not found:', targetEmail);
    process.exit(1);
  }
  
  console.log('✅ Found user:', user.firstName, user.lastName, `(${user.id})`);
  
  // Clean up existing mock interviews for this user (optional)
  console.log('\n🧹 Cleaning up existing mock interviews...');
  const deletedInterviews = await prisma.interview.deleteMany({
    where: {
      userId: user.id,
      retellCallId: {
        startsWith: 'mock_call_'
      }
    }
  });
  console.log(`   Deleted ${deletedInterviews.count} existing mock interviews`);
  
  // Create new mock interviews
  console.log('\n📝 Creating mock interviews...\n');
  
  for (const interviewData of mockInterviews) {
    const createdDate = daysAgo(interviewData.daysAgoCreated);
    const startedAt = new Date(createdDate);
    const endedAt = new Date(startedAt.getTime() + interviewData.callDuration * 1000);
    
    const interview = await prisma.interview.create({
      data: {
        userId: user.id,
        retellCallId: `mock_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        jobTitle: interviewData.jobTitle,
        companyName: interviewData.companyName,
        jobDescription: interviewData.jobDescription,
        seniority: interviewData.seniority,
        language: interviewData.language,
        status: interviewData.status,
        score: interviewData.score,
        feedbackText: interviewData.feedbackText,
        callDuration: interviewData.callDuration,
        startedAt,
        endedAt,
        createdAt: createdDate,
        updatedAt: createdDate
      }
    });
    
    console.log(`✅ Created: ${interview.jobTitle} @ ${interview.companyName}`);
    console.log(`   Score: ${interview.score}% | Seniority: ${interviewData.seniority} | Created: ${interviewData.daysAgoCreated} days ago`);
    
    // Create metrics for this interview
    for (const metric of interviewData.metrics) {
      await prisma.interviewMetric.create({
        data: {
          interviewId: interview.id,
          category: metric.category,
          metricName: metric.metricName,
          score: metric.score,
          maxScore: 10,
          feedback: metric.feedback
        }
      });
    }
    console.log(`   Added ${interviewData.metrics.length} metrics`);
    console.log('');
  }
  
  console.log('🎉 Mock interview seeding complete!');
  console.log(`   Total interviews created: ${mockInterviews.length}`);
  console.log(`   Score range: ${Math.min(...mockInterviews.map(i => i.score))}% - ${Math.max(...mockInterviews.map(i => i.score))}%`);
  console.log(`   Date range: ${Math.max(...mockInterviews.map(i => i.daysAgoCreated))} days ago - ${Math.min(...mockInterviews.map(i => i.daysAgoCreated))} days ago`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
