import { PrismaClient, InterviewStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // First, get the user
  const user = await prisma.user.findUnique({
    where: { clerkId: 'user_35weQzNjK0AOMAUwc6du50IOV8c' }
  });
  
  if (!user) {
    console.log('User not found!');
    return;
  }
  
  console.log('Found user:', user.id, user.email);
  
  // Create mock interviews with different statuses and dates
  const interviewsData = [
    {
      retellCallId: 'call_mock_001',
      companyName: 'Google',
      jobTitle: 'Senior Software Engineer',
      jobDescription: 'We are looking for a Senior Software Engineer to join our Cloud Platform team. You will design and implement scalable distributed systems.',
      status: InterviewStatus.COMPLETED,
      score: 85,
      callDuration: 847, // ~14 minutes
      startedAt: new Date('2025-11-28T14:30:00Z'),
      endedAt: new Date('2025-11-28T14:44:07Z'),
      feedbackText: 'Strong technical skills demonstrated. Good problem-solving approach with clear communication. Could improve on time management during complex problems.',
    },
    {
      retellCallId: 'call_mock_002',
      companyName: 'Amazon',
      jobTitle: 'Full Stack Developer',
      jobDescription: 'Join our e-commerce team to build customer-facing features using React, Node.js, and AWS services.',
      status: InterviewStatus.COMPLETED,
      score: 78,
      callDuration: 723, // ~12 minutes
      startedAt: new Date('2025-11-25T10:00:00Z'),
      endedAt: new Date('2025-11-25T10:12:03Z'),
      feedbackText: 'Good communication and leadership examples. STAR method was used effectively. Could provide more specific metrics and outcomes.',
    },
    {
      retellCallId: 'call_mock_003',
      companyName: 'Microsoft',
      jobTitle: 'Backend Engineer',
      jobDescription: 'Work on Azure cloud services, building APIs and microservices that power millions of users worldwide.',
      status: InterviewStatus.COMPLETED,
      score: 92,
      callDuration: 912, // ~15 minutes
      startedAt: new Date('2025-11-20T16:00:00Z'),
      endedAt: new Date('2025-11-20T16:15:12Z'),
      feedbackText: 'Excellent technical depth and system design skills. Very structured approach to problem solving. Strong candidate overall.',
    },
    {
      retellCallId: 'call_mock_004',
      companyName: 'Meta',
      jobTitle: 'Software Engineer',
      jobDescription: 'Build products that connect billions of people. Work on News Feed, Messenger, or Instagram features.',
      status: InterviewStatus.COMPLETED,
      score: 72,
      callDuration: 654, // ~11 minutes
      startedAt: new Date('2025-11-15T09:00:00Z'),
      endedAt: new Date('2025-11-15T09:10:54Z'),
      feedbackText: 'Good foundational knowledge. Showed potential but struggled with optimization. Keep practicing data structures.',
    },
    {
      retellCallId: 'call_mock_005',
      companyName: 'Netflix',
      jobTitle: 'Platform Engineer',
      jobDescription: 'Design and build the infrastructure that powers streaming for 200+ million subscribers worldwide.',
      status: InterviewStatus.COMPLETED,
      score: 88,
      callDuration: 1023, // ~17 minutes
      startedAt: new Date('2025-11-10T11:00:00Z'),
      endedAt: new Date('2025-11-10T11:17:03Z'),
      feedbackText: 'Impressive system design skills. Good understanding of distributed systems and scalability patterns. Well-structured approach.',
    },
  ];

  // Insert interviews and metrics
  for (const data of interviewsData) {
    const interview = await prisma.interview.upsert({
      where: { retellCallId: data.retellCallId },
      update: {
        companyName: data.companyName,
        jobTitle: data.jobTitle,
        jobDescription: data.jobDescription,
        status: data.status,
        score: data.score,
        callDuration: data.callDuration,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        feedbackText: data.feedbackText,
      },
      create: {
        userId: user.id,
        retellCallId: data.retellCallId,
        companyName: data.companyName,
        jobTitle: data.jobTitle,
        jobDescription: data.jobDescription,
        status: data.status,
        score: data.score,
        callDuration: data.callDuration,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        feedbackText: data.feedbackText,
      },
    });
    
    console.log('Created interview:', interview.companyName, '-', interview.jobTitle);
    
    // Create metrics for this interview
    const metricsData = [
      { category: 'technical', metricName: 'Technical Knowledge', score: data.score * 0.95 + Math.random() * 10 - 5 },
      { category: 'technical', metricName: 'Problem Solving', score: data.score * 0.9 + Math.random() * 10 - 5 },
      { category: 'communication', metricName: 'Clarity', score: data.score * 0.85 + Math.random() * 10 - 5 },
      { category: 'communication', metricName: 'Confidence', score: data.score * 0.88 + Math.random() * 10 - 5 },
      { category: 'behavioral', metricName: 'Leadership', score: data.score * 0.82 + Math.random() * 10 - 5 },
      { category: 'behavioral', metricName: 'Teamwork', score: data.score * 0.9 + Math.random() * 10 - 5 },
    ];
    
    for (const metric of metricsData) {
      await prisma.interviewMetric.create({
        data: {
          interviewId: interview.id,
          category: metric.category,
          metricName: metric.metricName,
          score: Math.min(100, Math.max(0, metric.score)), // Clamp between 0-100
          maxScore: 100,
          feedback: `Performance in ${metric.metricName.toLowerCase()} was ${metric.score >= 80 ? 'excellent' : metric.score >= 60 ? 'good' : 'needs improvement'}.`,
        },
      });
    }
    console.log('  Added 6 metrics for interview');
  }

  console.log('\n✅ Created', interviewsData.length, 'mock interviews with metrics');
  
  // Display summary
  const count = await prisma.interview.count({ where: { userId: user.id } });
  const avgScore = await prisma.interview.aggregate({
    where: { userId: user.id, status: InterviewStatus.COMPLETED },
    _avg: { score: true }
  });
  const metricsCount = await prisma.interviewMetric.count();
  
  console.log('Total interviews for user:', count);
  console.log('Total metrics created:', metricsCount);
  console.log('Average overall score:', avgScore._avg?.score?.toFixed(1) || 'N/A');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
