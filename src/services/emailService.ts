/**
 * Email Service
 * Handles email delivery using Resend SDK with idempotency and tracking
 */

import { PrismaClient, EmailSendStatus } from '@prisma/client';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

// Create email logger
const emailLogger = logger.child({ component: 'email' });

// Prisma client for email logging
const prisma = new PrismaClient();

// Lazy-load Resend to avoid initialization errors when API key is missing
let resend: any = null;
let resendInitialized = false;

function getResendClient(): any {
  if (resendInitialized) return resend;
  
  resendInitialized = true;
  const apiKey = process.env.RESEND_API_KEY;
  
  if (apiKey) {
    try {
      // Dynamic import to avoid initialization errors
      const { Resend } = require('resend');
      resend = new Resend(apiKey);
      emailLogger.info('Resend email service initialized');
    } catch (error: any) {
      emailLogger.error('Failed to initialize Resend', { error: error.message });
      resend = null;
    }
  } else {
    emailLogger.warn('RESEND_API_KEY not set - emails will be logged but not sent');
  }
  
  return resend;
}

/**
 * Generate idempotency key for email
 * Uses interviewId + templateType to prevent duplicate sends
 */
export function generateEmailIdempotencyKey(interviewId: string, templateType: string): string {
  return `email_${interviewId}_${templateType}_${Date.now()}`;
}

/**
 * Check if email was already sent (idempotency check)
 */
export async function checkEmailAlreadySent(interviewId: string): Promise<boolean> {
  try {
    const interview = await prisma.interview.findUnique({
      where: { id: interviewId },
      select: { emailSendStatus: true, emailSentAt: true }
    });
    
    return interview?.emailSendStatus === 'SENT';
  } catch (error) {
    emailLogger.error('Error checking email status', { interviewId, error });
    return false;
  }
}

/**
 * Log email to database for audit trail
 */
export async function logEmailToDatabase(params: {
  interviewId: string;
  toEmail: string;
  subject: string;
  templateType: string;
  status: EmailSendStatus;
  messageId?: string;
  errorMessage?: string;
  idempotencyKey?: string;
  language?: string;
  hasAttachment?: boolean;
  attachmentSize?: number;
}): Promise<void> {
  try {
    await prisma.emailLog.create({
      data: {
        interviewId: params.interviewId,
        toEmail: params.toEmail,
        subject: params.subject,
        templateType: params.templateType,
        status: params.status,
        messageId: params.messageId,
        errorMessage: params.errorMessage,
        idempotencyKey: params.idempotencyKey,
        language: params.language,
        hasAttachment: params.hasAttachment || false,
        attachmentSize: params.attachmentSize,
        sentAt: params.status === 'SENT' ? new Date() : null
      }
    });
    
    // Also update the interview record
    await prisma.interview.update({
      where: { id: params.interviewId },
      data: {
        emailSendStatus: params.status,
        emailSentAt: params.status === 'SENT' ? new Date() : undefined,
        emailLastError: params.errorMessage,
        emailMessageId: params.messageId,
        emailIdempotencyKey: params.idempotencyKey
      }
    });
  } catch (error: any) {
    emailLogger.error('Failed to log email to database', { error: error.message, interviewId: params.interviewId });
  }
}

// Email configuration
const EMAIL_FROM = process.env.EMAIL_FROM || 'Vocaid <onboarding@resend.dev>';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://voxly-frontend-pearl.vercel.app';

// ========================================
// INTERFACES
// ========================================

export interface SendFeedbackEmailParams {
  toEmail: string;
  candidateName: string;
  jobTitle: string;
  companyName: string;
  score: number;
  interviewId: string;
  feedbackPdfBase64?: string | null;
  resumeBase64?: string | null;
  resumeFileName?: string | null;
  feedbackSummary?: string;
}

export interface AutomatedFeedbackEmailParams {
  toEmail: string;
  candidateName: string;
  jobTitle: string;
  companyName: string;
  score: number;
  interviewId: string;
  strengths: string[];
  improvements: string[];
  recommendations: string[];
  technicalScore: number;
  communicationScore: number;
  problemSolvingScore: number;
  callDurationMinutes: number;
  feedbackPdfBase64?: string | null;
  language?: string; // For localized emails
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ========================================
// EMAIL TEMPLATES
// ========================================

function generateFeedbackEmailHtml(params: {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  score: number;
  interviewDetailsUrl: string;
  feedbackSummary?: string;
}): string {
  const { candidateName, jobTitle, companyName, score, interviewDetailsUrl, feedbackSummary } = params;
  
  const scoreColor = score >= 80 ? '#22c55e' : score >= 60 ? '#5417C9' : score >= 40 ? '#eab308' : '#ef4444';
  const scoreLabel = score >= 80 ? 'Excellent!' : score >= 60 ? 'Good Job!' : score >= 40 ? 'Keep Practicing' : 'Needs Improvement';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Interview Feedback - Vocaid</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          
          <!-- Header with gradient -->
          <tr>
            <td style="background: linear-gradient(135deg, #5417C9 0%, #7c3aed 100%); padding: 40px 30px; text-align: center;">
              <img src="${FRONTEND_URL}/Main.png" alt="Vocaid" width="60" height="60" style="margin-bottom: 16px; border-radius: 12px;">
              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700;">Interview Feedback Ready!</h1>
              <p style="color: #e9d5ff; margin: 8px 0 0 0; font-size: 16px;">Your AI-powered interview analysis is complete</p>
            </td>
          </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="color: #374151; font-size: 16px; margin: 0 0 20px 0; line-height: 1.6;">
                Hi <strong>${candidateName}</strong>,
              </p>
              <p style="color: #374151; font-size: 16px; margin: 0 0 30px 0; line-height: 1.6;">
                Great job completing your mock interview for <strong>${jobTitle}</strong> at <strong>${companyName}</strong>! Here's a summary of your performance.
              </p>
              
              <!-- Score Card -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%); border-radius: 12px; margin-bottom: 30px;">
                <tr>
                  <td style="padding: 30px; text-align: center;">
                    <div style="display: inline-block; width: 120px; height: 120px; border-radius: 60px; background-color: #ffffff; line-height: 120px; font-size: 42px; font-weight: 700; color: ${scoreColor}; box-shadow: 0 4px 12px rgba(84, 23, 201, 0.2);">
                      ${score}%
                    </div>
                    <p style="color: ${scoreColor}; font-size: 20px; font-weight: 600; margin: 16px 0 0 0;">${scoreLabel}</p>
                  </td>
                </tr>
              </table>
              
              ${feedbackSummary ? `
              <!-- Summary Section -->
              <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 30px; border-left: 4px solid #5417C9;">
                <h3 style="color: #374151; font-size: 16px; margin: 0 0 12px 0; font-weight: 600;">📋 Summary</h3>
                <p style="color: #6b7280; font-size: 14px; margin: 0; line-height: 1.6;">${feedbackSummary}</p>
              </div>
              ` : ''}
              
              <!-- CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding: 10px 0 30px 0;">
                    <a href="${interviewDetailsUrl}" style="display: inline-block; background: linear-gradient(135deg, #5417C9 0%, #7c3aed 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 12px rgba(84, 23, 201, 0.3);">
                      View Full Feedback →
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Attachments Notice -->
              <p style="color: #9ca3af; font-size: 14px; text-align: center; margin: 0; line-height: 1.6;">
                📎 Your feedback PDF is attached to this email for your records.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 24px 30px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="color: #9ca3af; font-size: 12px; margin: 0 0 8px 0;">
                © 2025 Vocaid - AI-Powered Interview Preparation
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                <a href="${FRONTEND_URL}" style="color: #5417C9; text-decoration: none;">Visit Vocaid</a> • 
                <a href="${FRONTEND_URL}/about" style="color: #5417C9; text-decoration: none;">About</a>
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// ========================================
// EMAIL FUNCTIONS
// ========================================

/**
 * Send interview feedback email with optional attachments
 */
export async function sendFeedbackEmail(params: SendFeedbackEmailParams): Promise<EmailResult> {
  const {
    toEmail,
    candidateName,
    jobTitle,
    companyName,
    score,
    interviewId,
    feedbackPdfBase64,
    resumeBase64,
    resumeFileName,
    feedbackSummary
  } = params;

  // Validate required params
  if (!toEmail || !candidateName || !jobTitle || !interviewId) {
    emailLogger.error('Missing required email parameters', { toEmail, candidateName, jobTitle, interviewId });
    return { success: false, error: 'Missing required parameters' };
  }

  const interviewDetailsUrl = `${FRONTEND_URL}/interview/${interviewId}`;
  
  // Build attachments array
  const attachments: Array<{ filename: string; content: string }> = [];
  
  if (feedbackPdfBase64) {
    attachments.push({
      filename: `${candidateName.replace(/\s+/g, '_')}_Interview_Feedback.pdf`,
      content: feedbackPdfBase64
    });
  }
  
  if (resumeBase64 && resumeFileName) {
    attachments.push({
      filename: resumeFileName,
      content: resumeBase64
    });
  }

  emailLogger.info('Sending feedback email', { 
    to: toEmail, 
    interviewId, 
    hasAttachments: attachments.length 
  });

  // Get Resend client (lazy-loaded)
  const resendClient = getResendClient();
  
  // If Resend is not configured, log and return success (for development)
  if (!resendClient) {
    emailLogger.warn('Resend not configured - email would be sent', { 
      to: toEmail, 
      subject: `Interview Feedback - ${jobTitle} at ${companyName}`,
      interviewId 
    });
    return { success: true, messageId: 'mock-no-resend' };
  }

  try {
    const { data, error } = await resendClient.emails.send({
      from: EMAIL_FROM,
      to: [toEmail],
      subject: `Your Interview Feedback - ${jobTitle} at ${companyName}`,
      html: generateFeedbackEmailHtml({
        candidateName,
        jobTitle,
        companyName,
        score: Math.round(score),
        interviewDetailsUrl,
        feedbackSummary
      }),
      attachments: attachments.length > 0 ? attachments : undefined
    });

    if (error) {
      emailLogger.error('Resend API error', { error: error.message, toEmail, interviewId });
      return { success: false, error: error.message };
    }

    emailLogger.info('Feedback email sent successfully', { 
      messageId: data?.id, 
      toEmail, 
      interviewId 
    });
    
    return { success: true, messageId: data?.id };
  } catch (error: any) {
    emailLogger.error('Failed to send feedback email', { 
      error: error.message, 
      toEmail, 
      interviewId 
    });
    return { success: false, error: error.message };
  }
}

/**
 * Send welcome email to new users
 */
export async function sendWelcomeEmail(
  toEmail: string, 
  userName: string
): Promise<EmailResult> {
  emailLogger.info('Sending welcome email', { to: toEmail });

  // Get Resend client (lazy-loaded)
  const resendClient = getResendClient();
  
  // If Resend is not configured, log and return success (for development)
  if (!resendClient) {
    emailLogger.warn('Resend not configured - welcome email would be sent', { 
      to: toEmail, 
      userName 
    });
    return { success: true, messageId: 'mock-no-resend' };
  }

  try {
    const { data, error } = await resendClient.emails.send({
      from: EMAIL_FROM,
      to: [toEmail],
      subject: 'Welcome to Vocaid - Your AI Interview Coach!',
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 12px; overflow: hidden;">
          <tr>
            <td style="background: linear-gradient(135deg, #5417C9 0%, #7c3aed 100%); padding: 40px 30px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0;">Welcome to Vocaid! 🎉</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 30px;">
              <p style="color: #374151; font-size: 16px;">Hi ${userName},</p>
              <p style="color: #374151; font-size: 16px; line-height: 1.6;">
                Welcome to Vocaid, your AI-powered interview preparation platform! 
                We've given you <strong>1 free credit</strong> to get started.
              </p>
              <p style="color: #374151; font-size: 16px; line-height: 1.6;">
                Start practicing now and ace your next interview!
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding: 20px 0;">
                    <a href="${FRONTEND_URL}/interview-setup" style="display: inline-block; background: #5417C9; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">
                      Start Your First Interview
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `
    });

    if (error) {
      emailLogger.error('Failed to send welcome email', { error: error.message });
      return { success: false, error: error.message };
    }

    return { success: true, messageId: data?.id };
  } catch (error: any) {
    emailLogger.error('Welcome email error', { error: error.message });
    return { success: false, error: error.message };
  }
}

// ========================================
// LOCALIZATION SUPPORT
// ========================================

interface EmailTranslations {
  subject: string;
  greeting: string;
  completedIntro: string;
  overallScore: string;
  scoreLabels: { excellent: string; good: string; keepPracticing: string; needsImprovement: string };
  duration: string;
  minutes: string;
  skillsBreakdown: string;
  technical: string;
  communication: string;
  problemSolving: string;
  strengths: string;
  improvements: string;
  recommendations: string;
  viewFullFeedback: string;
  attachmentNotice: string;
  scheduleNext: string;
  footer: string;
}

const emailTranslations: Record<string, EmailTranslations> = {
  'en-US': {
    subject: 'Your Interview Performance Report',
    greeting: 'Hi',
    completedIntro: 'You just completed your mock interview for',
    overallScore: 'Overall Score',
    scoreLabels: { excellent: 'Excellent!', good: 'Good Job!', keepPracticing: 'Keep Practicing', needsImprovement: 'Needs Improvement' },
    duration: 'Duration',
    minutes: 'minutes',
    skillsBreakdown: 'Skills Breakdown',
    technical: 'Technical',
    communication: 'Communication',
    problemSolving: 'Problem Solving',
    strengths: 'What You Did Well',
    improvements: 'Areas to Focus On',
    recommendations: 'Personalized Tips',
    viewFullFeedback: 'View Full Report',
    attachmentNotice: 'Your detailed feedback PDF is attached to this email.',
    scheduleNext: 'Schedule Next Practice',
    footer: 'Keep practicing to ace your real interview!'
  },
  'pt-BR': {
    subject: 'Seu Relatório de Desempenho na Entrevista',
    greeting: 'Olá',
    completedIntro: 'Você acabou de concluir sua entrevista simulada para',
    overallScore: 'Pontuação Geral',
    scoreLabels: { excellent: 'Excelente!', good: 'Bom Trabalho!', keepPracticing: 'Continue Praticando', needsImprovement: 'Precisa Melhorar' },
    duration: 'Duração',
    minutes: 'minutos',
    skillsBreakdown: 'Análise de Competências',
    technical: 'Técnico',
    communication: 'Comunicação',
    problemSolving: 'Resolução de Problemas',
    strengths: 'O Que Você Fez Bem',
    improvements: 'Áreas para Focar',
    recommendations: 'Dicas Personalizadas',
    viewFullFeedback: 'Ver Relatório Completo',
    attachmentNotice: 'Seu feedback detalhado em PDF está anexado a este email.',
    scheduleNext: 'Agendar Próxima Prática',
    footer: 'Continue praticando para arrasar na entrevista real!'
  },
  'es-ES': {
    subject: 'Tu Informe de Rendimiento en la Entrevista',
    greeting: 'Hola',
    completedIntro: 'Acabas de completar tu entrevista simulada para',
    overallScore: 'Puntuación General',
    scoreLabels: { excellent: '¡Excelente!', good: '¡Buen Trabajo!', keepPracticing: 'Sigue Practicando', needsImprovement: 'Necesita Mejorar' },
    duration: 'Duración',
    minutes: 'minutos',
    skillsBreakdown: 'Análisis de Habilidades',
    technical: 'Técnico',
    communication: 'Comunicación',
    problemSolving: 'Resolución de Problemas',
    strengths: 'Lo Que Hiciste Bien',
    improvements: 'Áreas de Enfoque',
    recommendations: 'Consejos Personalizados',
    viewFullFeedback: 'Ver Informe Completo',
    attachmentNotice: 'Tu feedback detallado en PDF está adjunto a este email.',
    scheduleNext: 'Programar Siguiente Práctica',
    footer: '¡Sigue practicando para brillar en tu entrevista real!'
  },
  'fr-FR': {
    subject: 'Votre Rapport de Performance d\'Entretien',
    greeting: 'Bonjour',
    completedIntro: 'Vous venez de terminer votre entretien simulé pour',
    overallScore: 'Score Global',
    scoreLabels: { excellent: 'Excellent !', good: 'Bon Travail !', keepPracticing: 'Continuez à Pratiquer', needsImprovement: 'À Améliorer' },
    duration: 'Durée',
    minutes: 'minutes',
    skillsBreakdown: 'Analyse des Compétences',
    technical: 'Technique',
    communication: 'Communication',
    problemSolving: 'Résolution de Problèmes',
    strengths: 'Ce Que Vous Avez Bien Fait',
    improvements: 'Points à Améliorer',
    recommendations: 'Conseils Personnalisés',
    viewFullFeedback: 'Voir le Rapport Complet',
    attachmentNotice: 'Votre feedback détaillé en PDF est joint à cet email.',
    scheduleNext: 'Planifier la Prochaine Session',
    footer: 'Continuez à pratiquer pour réussir votre vrai entretien !'
  },
  'zh-CN': {
    subject: '您的面试表现报告',
    greeting: '您好',
    completedIntro: '您刚刚完成了模拟面试',
    overallScore: '总体评分',
    scoreLabels: { excellent: '优秀！', good: '做得好！', keepPracticing: '继续练习', needsImprovement: '需要改进' },
    duration: '时长',
    minutes: '分钟',
    skillsBreakdown: '技能分析',
    technical: '技术能力',
    communication: '沟通能力',
    problemSolving: '解决问题能力',
    strengths: '表现优秀的方面',
    improvements: '需要关注的领域',
    recommendations: '个性化建议',
    viewFullFeedback: '查看完整报告',
    attachmentNotice: '详细反馈PDF已附在此邮件中。',
    scheduleNext: '安排下一次练习',
    footer: '继续练习，在真正的面试中表现出色！'
  },
  'ru-RU': {
    subject: 'Ваш Отчёт о Прохождении Собеседования',
    greeting: 'Привет',
    completedIntro: 'Вы только что завершили пробное собеседование на позицию',
    overallScore: 'Общий Балл',
    scoreLabels: { excellent: 'Отлично!', good: 'Хорошая Работа!', keepPracticing: 'Продолжайте Практиковаться', needsImprovement: 'Нужно Улучшить' },
    duration: 'Длительность',
    minutes: 'минут',
    skillsBreakdown: 'Анализ Навыков',
    technical: 'Технические',
    communication: 'Коммуникация',
    problemSolving: 'Решение Проблем',
    strengths: 'Что Вы Сделали Хорошо',
    improvements: 'Области для Улучшения',
    recommendations: 'Персональные Советы',
    viewFullFeedback: 'Посмотреть Полный Отчёт',
    attachmentNotice: 'Подробный отзыв в формате PDF прикреплён к этому письму.',
    scheduleNext: 'Запланировать Следующую Практику',
    footer: 'Продолжайте практиковаться, чтобы блеснуть на реальном собеседовании!'
  },
  'hi-IN': {
    subject: 'आपकी साक्षात्कार प्रदर्शन रिपोर्ट',
    greeting: 'नमस्ते',
    completedIntro: 'आपने अभी मॉक इंटरव्यू पूरा किया',
    overallScore: 'कुल स्कोर',
    scoreLabels: { excellent: 'उत्कृष्ट!', good: 'अच्छा काम!', keepPracticing: 'अभ्यास जारी रखें', needsImprovement: 'सुधार की जरूरत' },
    duration: 'अवधि',
    minutes: 'मिनट',
    skillsBreakdown: 'कौशल विश्लेषण',
    technical: 'तकनीकी',
    communication: 'संचार',
    problemSolving: 'समस्या समाधान',
    strengths: 'आपने क्या अच्छा किया',
    improvements: 'ध्यान देने योग्य क्षेत्र',
    recommendations: 'व्यक्तिगत सुझाव',
    viewFullFeedback: 'पूर्ण रिपोर्ट देखें',
    attachmentNotice: 'आपकी विस्तृत प्रतिक्रिया PDF इस ईमेल में संलग्न है।',
    scheduleNext: 'अगला अभ्यास शेड्यूल करें',
    footer: 'वास्तविक साक्षात्कार में सफल होने के लिए अभ्यास जारी रखें!'
  }
};

function getEmailTranslations(language?: string): EmailTranslations {
  const lang = language || 'en-US';
  return emailTranslations[lang] || emailTranslations['en-US'];
}

// ========================================
// AUTOMATED FEEDBACK EMAIL
// ========================================

/**
 * Generate automated feedback email HTML with detailed insights
 */
function generateAutomatedFeedbackEmailHtml(params: AutomatedFeedbackEmailParams): string {
  const t = getEmailTranslations(params.language);
  const { 
    candidateName, jobTitle, companyName, score, interviewId,
    strengths, improvements, recommendations,
    technicalScore, communicationScore, problemSolvingScore,
    callDurationMinutes
  } = params;
  
  const scoreColor = score >= 80 ? '#22c55e' : score >= 60 ? '#5417C9' : score >= 40 ? '#eab308' : '#ef4444';
  const scoreLabel = score >= 80 ? t.scoreLabels.excellent : 
                     score >= 60 ? t.scoreLabels.good : 
                     score >= 40 ? t.scoreLabels.keepPracticing : 
                     t.scoreLabels.needsImprovement;
  
  const interviewDetailsUrl = `${FRONTEND_URL}/interview/${interviewId}`;
  const scheduleNextUrl = `${FRONTEND_URL}/interview-setup`;
  
  // Generate skill bars
  const skillBar = (label: string, score: number) => {
    const percentage = (score / 5) * 100;
    const barColor = score >= 4 ? '#22c55e' : score >= 3 ? '#5417C9' : score >= 2 ? '#eab308' : '#ef4444';
    return `
      <tr>
        <td style="padding: 8px 0;">
          <table role="presentation" width="100%">
            <tr>
              <td style="width: 120px; color: #6b7280; font-size: 14px;">${label}</td>
              <td style="padding-left: 12px;">
                <table role="presentation" width="100%" style="background-color: #e5e7eb; border-radius: 4px; height: 8px;">
                  <tr>
                    <td style="width: ${percentage}%; background-color: ${barColor}; border-radius: 4px;"></td>
                    <td></td>
                  </tr>
                </table>
              </td>
              <td style="width: 40px; text-align: right; color: #374151; font-weight: 600; font-size: 14px;">${score}/5</td>
            </tr>
          </table>
        </td>
      </tr>
    `;
  };
  
  // Generate list items
  const listItems = (items: string[], emoji: string) => 
    items.slice(0, 3).map(item => `
      <tr>
        <td style="padding: 6px 0; color: #374151; font-size: 14px; line-height: 1.5;">
          ${emoji} ${item}
        </td>
      </tr>
    `).join('');

  return `
<!DOCTYPE html>
<html lang="${params.language?.split('-')[0] || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.subject} - Vocaid</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #5417C9 0%, #7c3aed 100%); padding: 40px 30px; text-align: center;">
              <img src="${FRONTEND_URL}/Main.png" alt="Vocaid" width="60" height="60" style="margin-bottom: 16px; border-radius: 12px;">
              <h1 style="color: #ffffff; margin: 0; font-size: 26px; font-weight: 700;">${t.subject}</h1>
              <p style="color: #e9d5ff; margin: 8px 0 0 0; font-size: 15px;">${t.completedIntro} <strong>${jobTitle}</strong> at <strong>${companyName}</strong></p>
            </td>
          </tr>
          
          <!-- Greeting & Score -->
          <tr>
            <td style="padding: 35px 30px 20px 30px;">
              <p style="color: #374151; font-size: 16px; margin: 0 0 25px 0;">
                ${t.greeting} <strong>${candidateName}</strong>,
              </p>
              
              <!-- Score Card -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%); border-radius: 16px;">
                <tr>
                  <td style="padding: 25px; text-align: center;">
                    <table role="presentation" width="100%">
                      <tr>
                        <td style="text-align: center; width: 50%;">
                          <div style="display: inline-block; width: 100px; height: 100px; border-radius: 50px; background-color: #ffffff; line-height: 100px; font-size: 36px; font-weight: 700; color: ${scoreColor}; box-shadow: 0 4px 12px rgba(84, 23, 201, 0.2);">
                            ${Math.round(score)}%
                          </div>
                          <p style="color: ${scoreColor}; font-size: 16px; font-weight: 600; margin: 12px 0 0 0;">${scoreLabel}</p>
                          <p style="color: #9ca3af; font-size: 12px; margin: 4px 0 0 0;">${t.overallScore}</p>
                        </td>
                        <td style="text-align: left; padding-left: 20px; vertical-align: middle;">
                          <p style="color: #6b7280; font-size: 14px; margin: 0;">
                            <span style="font-size: 20px;">⏱️</span> ${t.duration}
                          </p>
                          <p style="color: #374151; font-size: 24px; font-weight: 600; margin: 4px 0 0 0;">
                            ${Math.round(callDurationMinutes)} ${t.minutes}
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Skills Breakdown -->
          <tr>
            <td style="padding: 0 30px 25px 30px;">
              <h3 style="color: #374151; font-size: 16px; margin: 0 0 15px 0; font-weight: 600;">📊 ${t.skillsBreakdown}</h3>
              <table role="presentation" width="100%" style="background-color: #f9fafb; border-radius: 12px; padding: 15px;">
                ${skillBar(t.technical, technicalScore)}
                ${skillBar(t.communication, communicationScore)}
                ${skillBar(t.problemSolving, problemSolvingScore)}
              </table>
            </td>
          </tr>
          
          ${strengths.length > 0 ? `
          <!-- Strengths -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <h3 style="color: #22c55e; font-size: 16px; margin: 0 0 12px 0; font-weight: 600;">💪 ${t.strengths}</h3>
              <table role="presentation" width="100%" style="background-color: #f0fdf4; border-radius: 12px; padding: 15px; border-left: 4px solid #22c55e;">
                ${listItems(strengths, '✓')}
              </table>
            </td>
          </tr>
          ` : ''}
          
          ${improvements.length > 0 ? `
          <!-- Improvements -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <h3 style="color: #eab308; font-size: 16px; margin: 0 0 12px 0; font-weight: 600;">🎯 ${t.improvements}</h3>
              <table role="presentation" width="100%" style="background-color: #fefce8; border-radius: 12px; padding: 15px; border-left: 4px solid #eab308;">
                ${listItems(improvements, '→')}
              </table>
            </td>
          </tr>
          ` : ''}
          
          ${recommendations.length > 0 ? `
          <!-- Recommendations -->
          <tr>
            <td style="padding: 0 30px 25px 30px;">
              <h3 style="color: #5417C9; font-size: 16px; margin: 0 0 12px 0; font-weight: 600;">💡 ${t.recommendations}</h3>
              <table role="presentation" width="100%" style="background-color: #f5f3ff; border-radius: 12px; padding: 15px; border-left: 4px solid #5417C9;">
                ${listItems(recommendations, '•')}
              </table>
            </td>
          </tr>
          ` : ''}
          
          <!-- CTA Buttons -->
          <tr>
            <td style="padding: 0 30px 30px 30px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding: 10px 0;">
                    <a href="${interviewDetailsUrl}" style="display: inline-block; background: linear-gradient(135deg, #5417C9 0%, #7c3aed 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 15px; font-weight: 600; box-shadow: 0 4px 12px rgba(84, 23, 201, 0.3); margin-right: 10px;">
                      ${t.viewFullFeedback} →
                    </a>
                    <a href="${scheduleNextUrl}" style="display: inline-block; background-color: #ffffff; color: #5417C9; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 15px; font-weight: 600; border: 2px solid #5417C9;">
                      ${t.scheduleNext}
                    </a>
                  </td>
                </tr>
              </table>
              <p style="color: #9ca3af; font-size: 13px; text-align: center; margin: 20px 0 0 0;">
                📎 ${t.attachmentNotice}
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 24px 30px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="color: #6b7280; font-size: 14px; margin: 0 0 8px 0; font-weight: 500;">
                ${t.footer}
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                © 2025 Vocaid - AI-Powered Interview Preparation
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin: 8px 0 0 0;">
                <a href="${FRONTEND_URL}" style="color: #5417C9; text-decoration: none;">Visit Vocaid</a> • 
                <a href="${FRONTEND_URL}/about" style="color: #5417C9; text-decoration: none;">About</a>
              </p>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * Send automated interview feedback email with detailed insights
 * Called automatically after interview completion and feedback generation
 * Includes idempotency checking and database logging
 */
export async function sendAutomatedFeedbackEmail(params: AutomatedFeedbackEmailParams): Promise<EmailResult> {
  const {
    toEmail,
    candidateName,
    jobTitle,
    companyName,
    score,
    interviewId,
    feedbackPdfBase64,
    language
  } = params;

  // Validate required params
  if (!toEmail || !candidateName || !jobTitle || !interviewId) {
    emailLogger.error('Missing required automated email parameters', { toEmail, candidateName, jobTitle, interviewId });
    return { success: false, error: 'Missing required parameters' };
  }

  // Idempotency check - skip if already sent
  const alreadySent = await checkEmailAlreadySent(interviewId);
  if (alreadySent) {
    emailLogger.info('Email already sent, skipping (idempotency)', { interviewId, toEmail });
    return { success: true, messageId: 'already-sent' };
  }

  const t = getEmailTranslations(language);
  const subject = `${t.subject} - ${jobTitle} at ${companyName}`;
  const idempotencyKey = generateEmailIdempotencyKey(interviewId, 'automated_feedback');
  
  // Build attachments array
  const attachments: Array<{ filename: string; content: string }> = [];
  const attachmentSize = feedbackPdfBase64 ? Buffer.byteLength(feedbackPdfBase64, 'base64') : 0;
  
  if (feedbackPdfBase64) {
    attachments.push({
      filename: `${candidateName.replace(/\s+/g, '_')}_Interview_Feedback.pdf`,
      content: feedbackPdfBase64
    });
  }

  emailLogger.info('Sending automated feedback email', { 
    to: toEmail, 
    interviewId,
    score: Math.round(score),
    language,
    hasAttachments: attachments.length,
    idempotencyKey
  });

  // Get Resend client (lazy-loaded)
  const resendClient = getResendClient();
  
  // If Resend is not configured, log and return success (for development)
  if (!resendClient) {
    emailLogger.warn('Resend not configured - automated email would be sent', { 
      to: toEmail, 
      subject,
      interviewId 
    });
    
    // Still log to database for tracking
    await logEmailToDatabase({
      interviewId,
      toEmail,
      subject,
      templateType: 'automated_feedback',
      status: 'SKIPPED',
      idempotencyKey,
      language,
      hasAttachment: attachments.length > 0,
      attachmentSize,
      errorMessage: 'Resend not configured'
    });
    
    return { success: true, messageId: 'mock-no-resend' };
  }

  try {
    const { data, error } = await resendClient.emails.send({
      from: EMAIL_FROM,
      to: [toEmail],
      subject,
      html: generateAutomatedFeedbackEmailHtml(params),
      attachments: attachments.length > 0 ? attachments : undefined
    });

    if (error) {
      emailLogger.error('Resend API error for automated email', { error: error.message, toEmail, interviewId });
      
      // Log failure to database
      await logEmailToDatabase({
        interviewId,
        toEmail,
        subject,
        templateType: 'automated_feedback',
        status: 'FAILED',
        errorMessage: error.message,
        idempotencyKey,
        language,
        hasAttachment: attachments.length > 0,
        attachmentSize
      });
      
      return { success: false, error: error.message };
    }

    emailLogger.info('Automated feedback email sent successfully', { 
      messageId: data?.id, 
      toEmail, 
      interviewId 
    });
    
    // Log success to database
    await logEmailToDatabase({
      interviewId,
      toEmail,
      subject,
      templateType: 'automated_feedback',
      status: 'SENT',
      messageId: data?.id,
      idempotencyKey,
      language,
      hasAttachment: attachments.length > 0,
      attachmentSize
    });
    
    return { success: true, messageId: data?.id };
  } catch (error: any) {
    emailLogger.error('Failed to send automated feedback email', { 
      error: error.message, 
      toEmail, 
      interviewId 
    });
    
    // Log failure to database
    await logEmailToDatabase({
      interviewId,
      toEmail,
      subject,
      templateType: 'automated_feedback',
      status: 'FAILED',
      errorMessage: error.message,
      idempotencyKey,
      language,
      hasAttachment: attachments.length > 0,
      attachmentSize
    });
    
    return { success: false, error: error.message };
  }
}

/**
 * Check if user has automated emails enabled (from profile preferences)
 */
export function shouldSendAutomatedEmail(userPreferences: Record<string, any> | null): boolean {
  // Default to true if no preferences set (opt-out model)
  if (!userPreferences) return true;
  
  // Check for explicit opt-out
  if (userPreferences.automatedFeedbackEmails === false) return false;
  if (userPreferences.emailNotifications === false) return false;
  
  return true;
}

export default {
  sendFeedbackEmail,
  sendWelcomeEmail,
  sendAutomatedFeedbackEmail,
  shouldSendAutomatedEmail,
  checkEmailAlreadySent,
  generateEmailIdempotencyKey,
  logEmailToDatabase
};
