/**
 * Email Service
 * Handles email delivery using Resend SDK
 */

import { Resend } from 'resend';
import logger from '../utils/logger';

// Create email logger
const emailLogger = logger.child({ component: 'email' });

// Initialize Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

// Email configuration
const EMAIL_FROM = process.env.EMAIL_FROM || 'Voxly <onboarding@resend.dev>';
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
  <title>Interview Feedback - Voxly</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          
          <!-- Header with gradient -->
          <tr>
            <td style="background: linear-gradient(135deg, #5417C9 0%, #7c3aed 100%); padding: 40px 30px; text-align: center;">
              <img src="${FRONTEND_URL}/Main.png" alt="Voxly" width="60" height="60" style="margin-bottom: 16px; border-radius: 12px;">
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
                © 2025 Voxly - AI-Powered Interview Preparation
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                <a href="${FRONTEND_URL}" style="color: #5417C9; text-decoration: none;">Visit Voxly</a> • 
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

  try {
    const { data, error } = await resend.emails.send({
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

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: [toEmail],
      subject: 'Welcome to Voxly - Your AI Interview Coach!',
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
              <h1 style="color: #ffffff; margin: 0;">Welcome to Voxly! 🎉</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 30px;">
              <p style="color: #374151; font-size: 16px;">Hi ${userName},</p>
              <p style="color: #374151; font-size: 16px; line-height: 1.6;">
                Welcome to Voxly, your AI-powered interview preparation platform! 
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

export default {
  sendFeedbackEmail,
  sendWelcomeEmail
};
