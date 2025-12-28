/**
 * PDF Generation Service v1.0
 * 
 * Server-side PDF generation with consistent branding,
 * professional layout, and optimized file size.
 */

import { jsPDF } from 'jspdf';
import { StructuredFeedback, CompetencyScore, ImprovementItem, StudyPlanItem } from '../types/feedback';
import logger from '../utils/logger';

// ============================================
// BRAND CONSTANTS
// ============================================

const BRAND = {
  // Colors (RGB)
  purple600: [88, 28, 135] as [number, number, number],
  purple500: [139, 92, 246] as [number, number, number],
  black: [0, 0, 0] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
  gray900: [24, 24, 27] as [number, number, number],
  gray700: [63, 63, 70] as [number, number, number],
  gray500: [113, 113, 122] as [number, number, number],
  gray300: [212, 212, 216] as [number, number, number],
  gray100: [244, 244, 245] as [number, number, number],
  green600: [22, 163, 74] as [number, number, number],
  yellow600: [202, 138, 4] as [number, number, number],
  red600: [220, 38, 38] as [number, number, number],
  
  // Typography
  fontFamily: 'helvetica',
  
  // Spacing
  marginX: 20,
  marginY: 20,
  lineHeight: 6,
  sectionGap: 12,
  
  // Page
  pageWidth: 210, // A4
  pageHeight: 297,
  contentWidth: 170, // 210 - 2*20
};

// ============================================
// TYPES
// ============================================

export interface PDFGenerationOptions {
  includeTranscriptHighlights?: boolean;
  includeStudyPlan?: boolean;
  includeCommunicationAnalysis?: boolean;
  maxPages?: number;
  locale?: string;
}

export interface PDFGenerationResult {
  success: boolean;
  pdfBase64?: string;
  pageCount?: number;
  fileSizeBytes?: number;
  error?: string;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function getScoreColor(score: number): [number, number, number] {
  if (score >= 80) return BRAND.green600;
  if (score >= 60) return BRAND.purple600;
  if (score >= 40) return BRAND.yellow600;
  return BRAND.red600;
}

function getScoreLabel(score: number, locale: string = 'en'): string {
  const labels: Record<string, Record<string, string>> = {
    en: { excellent: 'Excellent', good: 'Good', fair: 'Fair', needsWork: 'Needs Improvement' },
    es: { excellent: 'Excelente', good: 'Bueno', fair: 'Regular', needsWork: 'Necesita Mejorar' },
    pt: { excellent: 'Excelente', good: 'Bom', fair: 'Regular', needsWork: 'Precisa Melhorar' },
  };
  const l = labels[locale] || labels['en'];
  
  if (score >= 80) return l.excellent;
  if (score >= 60) return l.good;
  if (score >= 40) return l.fair;
  return l.needsWork;
}

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// ============================================
// PDF SECTIONS
// ============================================

class PDFBuilder {
  private doc: jsPDF;
  private y: number;
  private pageNumber: number;
  private locale: string;
  
  constructor(locale: string = 'en') {
    this.doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });
    this.y = BRAND.marginY;
    this.pageNumber = 1;
    this.locale = locale;
  }
  
  private checkPageBreak(neededSpace: number = 30): void {
    if (this.y + neededSpace > BRAND.pageHeight - BRAND.marginY) {
      this.addPage();
    }
  }
  
  private addPage(): void {
    this.doc.addPage();
    this.pageNumber++;
    this.y = BRAND.marginY;
    this.addPageNumber();
  }
  
  private addPageNumber(): void {
    this.doc.setFontSize(9);
    this.doc.setTextColor(...BRAND.gray500);
    this.doc.text(
      `Page ${this.pageNumber}`,
      BRAND.pageWidth / 2,
      BRAND.pageHeight - 10,
      { align: 'center' }
    );
  }
  
  // Header section with title and branding
  addHeader(feedback: StructuredFeedback): void {
    // Purple accent bar at top
    this.doc.setFillColor(...BRAND.purple600);
    this.doc.rect(0, 0, BRAND.pageWidth, 8, 'F');
    
    this.y = 20;
    
    // Title
    this.doc.setFont(BRAND.fontFamily, 'bold');
    this.doc.setFontSize(24);
    this.doc.setTextColor(...BRAND.gray900);
    this.doc.text('Interview Feedback Report', BRAND.marginX, this.y);
    this.y += 12;
    
    // Subtitle with role info
    this.doc.setFont(BRAND.fontFamily, 'normal');
    this.doc.setFontSize(12);
    this.doc.setTextColor(...BRAND.gray700);
    const roleText = `${feedback.session.roleTitle} • ${feedback.session.seniority.charAt(0).toUpperCase() + feedback.session.seniority.slice(1)} Level`;
    this.doc.text(roleText, BRAND.marginX, this.y);
    this.y += 6;
    
    // Date
    this.doc.setFontSize(10);
    this.doc.setTextColor(...BRAND.gray500);
    const dateText = new Date(feedback.session.interviewDate).toLocaleDateString(this.locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    this.doc.text(dateText, BRAND.marginX, this.y);
    this.y += BRAND.sectionGap;
    
    // Divider
    this.doc.setDrawColor(...BRAND.gray300);
    this.doc.line(BRAND.marginX, this.y, BRAND.pageWidth - BRAND.marginX, this.y);
    this.y += BRAND.sectionGap;
  }
  
  // Overall score section with circular badge
  addScoreSection(feedback: StructuredFeedback): void {
    this.checkPageBreak(50);
    
    const score = feedback.overallScore;
    const scoreColor = getScoreColor(score);
    const label = getScoreLabel(score, this.locale);
    
    // Score box
    const boxX = BRAND.marginX;
    const boxWidth = BRAND.contentWidth;
    const boxHeight = 40;
    
    this.doc.setFillColor(...BRAND.gray100);
    this.doc.roundedRect(boxX, this.y, boxWidth, boxHeight, 3, 3, 'F');
    
    // Score number
    this.doc.setFont(BRAND.fontFamily, 'bold');
    this.doc.setFontSize(36);
    this.doc.setTextColor(...scoreColor);
    this.doc.text(`${score}%`, boxX + 15, this.y + 28);
    
    // Score label
    this.doc.setFontSize(14);
    this.doc.setTextColor(...BRAND.gray700);
    this.doc.text(label, boxX + 50, this.y + 18);
    
    // Executive summary
    this.doc.setFont(BRAND.fontFamily, 'normal');
    this.doc.setFontSize(10);
    this.doc.setTextColor(...BRAND.gray700);
    const summaryLines = this.doc.splitTextToSize(feedback.executiveSummary, boxWidth - 70);
    this.doc.text(summaryLines, boxX + 50, this.y + 26);
    
    this.y += boxHeight + BRAND.sectionGap;
  }
  
  // Competency breakdown table
  addCompetencyTable(competencies: CompetencyScore[]): void {
    this.checkPageBreak(60);
    
    // Section title
    this.doc.setFont(BRAND.fontFamily, 'bold');
    this.doc.setFontSize(14);
    this.doc.setTextColor(...BRAND.purple600);
    this.doc.text('Competency Breakdown', BRAND.marginX, this.y);
    this.y += 8;
    
    // Table header
    const colWidths = [50, 20, 100];
    const startX = BRAND.marginX;
    
    this.doc.setFillColor(...BRAND.gray100);
    this.doc.rect(startX, this.y, BRAND.contentWidth, 8, 'F');
    
    this.doc.setFont(BRAND.fontFamily, 'bold');
    this.doc.setFontSize(9);
    this.doc.setTextColor(...BRAND.gray700);
    this.doc.text('Competency', startX + 2, this.y + 5.5);
    this.doc.text('Score', startX + colWidths[0] + 2, this.y + 5.5);
    this.doc.text('Assessment', startX + colWidths[0] + colWidths[1] + 2, this.y + 5.5);
    this.y += 10;
    
    // Table rows
    this.doc.setFont(BRAND.fontFamily, 'normal');
    this.doc.setFontSize(9);
    
    competencies.forEach((comp, index) => {
      this.checkPageBreak(12);
      
      // Alternating row background
      if (index % 2 === 0) {
        this.doc.setFillColor(250, 250, 250);
        this.doc.rect(startX, this.y - 1, BRAND.contentWidth, 10, 'F');
      }
      
      // Competency name
      this.doc.setTextColor(...BRAND.gray900);
      this.doc.text(comp.name, startX + 2, this.y + 5);
      
      // Score with color
      const scoreColor = getScoreColor(comp.score * 20);
      this.doc.setTextColor(...scoreColor);
      this.doc.text(`${comp.score}/5`, startX + colWidths[0] + 2, this.y + 5);
      
      // Brief explanation
      this.doc.setTextColor(...BRAND.gray700);
      const explanation = truncateText(comp.explanation, 70);
      this.doc.text(explanation, startX + colWidths[0] + colWidths[1] + 2, this.y + 5);
      
      this.y += 10;
    });
    
    this.y += BRAND.sectionGap;
  }
  
  // Strengths section
  addStrengths(feedback: StructuredFeedback): void {
    this.checkPageBreak(40);
    
    this.doc.setFont(BRAND.fontFamily, 'bold');
    this.doc.setFontSize(14);
    this.doc.setTextColor(...BRAND.green600);
    this.doc.text('Key Strengths', BRAND.marginX, this.y);
    this.y += 8;
    
    this.doc.setFont(BRAND.fontFamily, 'normal');
    this.doc.setFontSize(10);
    
    feedback.strengths.slice(0, 5).forEach((strength) => {
      this.checkPageBreak(20);
      
      // Bullet point
      this.doc.setFillColor(...BRAND.green600);
      this.doc.circle(BRAND.marginX + 2, this.y + 2, 1.5, 'F');
      
      // Title
      this.doc.setFont(BRAND.fontFamily, 'bold');
      this.doc.setTextColor(...BRAND.gray900);
      this.doc.text(strength.title, BRAND.marginX + 8, this.y + 3);
      this.y += 6;
      
      // Description
      this.doc.setFont(BRAND.fontFamily, 'normal');
      this.doc.setTextColor(...BRAND.gray700);
      const descLines = this.doc.splitTextToSize(strength.description, BRAND.contentWidth - 10);
      this.doc.text(descLines, BRAND.marginX + 8, this.y + 2);
      this.y += descLines.length * 4 + 4;
    });
    
    this.y += BRAND.sectionGap / 2;
  }
  
  // Improvements section
  addImprovements(improvements: ImprovementItem[]): void {
    this.checkPageBreak(40);
    
    this.doc.setFont(BRAND.fontFamily, 'bold');
    this.doc.setFontSize(14);
    this.doc.setTextColor(...BRAND.yellow600);
    this.doc.text('Areas for Improvement', BRAND.marginX, this.y);
    this.y += 8;
    
    this.doc.setFont(BRAND.fontFamily, 'normal');
    this.doc.setFontSize(10);
    
    improvements.slice(0, 5).forEach((item) => {
      this.checkPageBreak(30);
      
      // Priority badge
      const priorityColors: Record<number, [number, number, number]> = {
        1: BRAND.red600,
        2: BRAND.yellow600,
        3: BRAND.gray500
      };
      this.doc.setFillColor(...(priorityColors[item.priority] || BRAND.gray500));
      this.doc.roundedRect(BRAND.marginX, this.y - 1, 4, 4, 1, 1, 'F');
      
      // Title
      this.doc.setFont(BRAND.fontFamily, 'bold');
      this.doc.setTextColor(...BRAND.gray900);
      this.doc.text(item.title, BRAND.marginX + 8, this.y + 2);
      this.y += 6;
      
      // How to improve
      this.doc.setFont(BRAND.fontFamily, 'normal');
      this.doc.setTextColor(...BRAND.gray700);
      const howLines = this.doc.splitTextToSize(`How to improve: ${item.howToImprove}`, BRAND.contentWidth - 10);
      this.doc.text(howLines, BRAND.marginX + 8, this.y + 2);
      this.y += howLines.length * 4 + 2;
      
      // Time to address
      this.doc.setFontSize(9);
      this.doc.setTextColor(...BRAND.gray500);
      this.doc.text(`Est. time: ${item.timeToAddress}`, BRAND.marginX + 8, this.y + 2);
      this.y += 8;
    });
    
    this.y += BRAND.sectionGap / 2;
  }
  
  // Study plan section
  addStudyPlan(studyPlan: StudyPlanItem[]): void {
    this.checkPageBreak(50);
    
    // Section with purple border
    this.doc.setDrawColor(...BRAND.purple600);
    this.doc.setLineWidth(0.5);
    this.doc.line(BRAND.marginX, this.y, BRAND.marginX, this.y + 8);
    
    this.doc.setFont(BRAND.fontFamily, 'bold');
    this.doc.setFontSize(14);
    this.doc.setTextColor(...BRAND.purple600);
    this.doc.text('Study Plan', BRAND.marginX + 4, this.y + 6);
    this.y += 12;
    
    this.doc.setFont(BRAND.fontFamily, 'normal');
    this.doc.setFontSize(10);
    
    studyPlan.slice(0, 5).forEach((item, index) => {
      this.checkPageBreak(20);
      
      // Number badge
      this.doc.setFillColor(...BRAND.purple600);
      this.doc.circle(BRAND.marginX + 4, this.y + 2, 3, 'F');
      this.doc.setTextColor(...BRAND.white);
      this.doc.setFontSize(8);
      this.doc.text(`${index + 1}`, BRAND.marginX + 2.5, this.y + 3.5);
      
      // Topic
      this.doc.setFont(BRAND.fontFamily, 'bold');
      this.doc.setFontSize(10);
      this.doc.setTextColor(...BRAND.gray900);
      this.doc.text(item.topic, BRAND.marginX + 12, this.y + 3);
      
      // Hours badge
      this.doc.setFont(BRAND.fontFamily, 'normal');
      this.doc.setFontSize(8);
      this.doc.setTextColor(...BRAND.gray500);
      this.doc.text(`~${item.estimatedHours}h`, BRAND.pageWidth - BRAND.marginX - 15, this.y + 3);
      
      this.y += 7;
      
      // Exercises
      this.doc.setFont(BRAND.fontFamily, 'normal');
      this.doc.setFontSize(9);
      this.doc.setTextColor(...BRAND.gray700);
      item.exercises.slice(0, 2).forEach((exercise) => {
        this.checkPageBreak(6);
        const exLines = this.doc.splitTextToSize(`• ${exercise}`, BRAND.contentWidth - 15);
        this.doc.text(exLines, BRAND.marginX + 12, this.y);
        this.y += exLines.length * 4;
      });
      
      this.y += 4;
    });
    
    this.y += BRAND.sectionGap / 2;
  }
  
  // Next session goals callout
  addNextSessionGoals(feedback: StructuredFeedback): void {
    if (!feedback.nextSessionGoals?.length) return;
    
    this.checkPageBreak(40);
    
    // Callout box with purple border
    const boxHeight = 10 + feedback.nextSessionGoals.length * 12;
    this.doc.setDrawColor(...BRAND.purple600);
    this.doc.setLineWidth(1);
    this.doc.setFillColor(250, 245, 255); // Very light purple
    this.doc.roundedRect(BRAND.marginX, this.y, BRAND.contentWidth, boxHeight, 3, 3, 'FD');
    
    this.y += 6;
    
    this.doc.setFont(BRAND.fontFamily, 'bold');
    this.doc.setFontSize(11);
    this.doc.setTextColor(...BRAND.purple600);
    this.doc.text('Goals for Next Session', BRAND.marginX + 5, this.y + 2);
    this.y += 8;
    
    this.doc.setFont(BRAND.fontFamily, 'normal');
    this.doc.setFontSize(10);
    this.doc.setTextColor(...BRAND.gray900);
    
    feedback.nextSessionGoals.forEach((goal) => {
      this.doc.text(`• ${goal.goal}`, BRAND.marginX + 5, this.y + 2);
      this.doc.setFontSize(9);
      this.doc.setTextColor(...BRAND.gray500);
      this.doc.text(`Target: ${goal.target}`, BRAND.marginX + 10, this.y + 7);
      this.doc.setFontSize(10);
      this.doc.setTextColor(...BRAND.gray900);
      this.y += 12;
    });
    
    this.y += BRAND.sectionGap;
  }
  
  // Footer with branding
  addFooter(): void {
    // Add page number to all pages
    const totalPages = this.doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      this.doc.setPage(i);
      this.doc.setFontSize(8);
      this.doc.setTextColor(...BRAND.gray500);
      this.doc.text(
        `Page ${i} of ${totalPages}`,
        BRAND.pageWidth / 2,
        BRAND.pageHeight - 8,
        { align: 'center' }
      );
      
      // Footer text
      this.doc.text(
        'Generated by Vocaid • vocaid.ai',
        BRAND.pageWidth / 2,
        BRAND.pageHeight - 12,
        { align: 'center' }
      );
    }
  }
  
  // Build complete PDF
  build(feedback: StructuredFeedback, options: PDFGenerationOptions = {}): string {
    this.addHeader(feedback);
    this.addScoreSection(feedback);
    
    if (feedback.competencies.length > 0) {
      this.addCompetencyTable(feedback.competencies);
    }
    
    if (feedback.strengths.length > 0) {
      this.addStrengths(feedback);
    }
    
    if (feedback.improvements.length > 0) {
      this.addImprovements(feedback.improvements);
    }
    
    if (options.includeStudyPlan !== false && feedback.studyPlan.length > 0) {
      this.addStudyPlan(feedback.studyPlan);
    }
    
    this.addNextSessionGoals(feedback);
    this.addFooter();
    
    // Return base64 without data URL prefix
    return this.doc.output('datauristring').split(',')[1];
  }
  
  getPageCount(): number {
    return this.doc.getNumberOfPages();
  }
}

// ============================================
// MAIN SERVICE CLASS
// ============================================

export class PDFGenerationService {
  /**
   * Generate a branded PDF from structured feedback
   */
  generate(
    feedback: StructuredFeedback,
    options: PDFGenerationOptions = {}
  ): PDFGenerationResult {
    const startTime = Date.now();
    
    try {
      logger.info('Starting PDF generation', {
        sessionId: feedback.session.sessionId,
        overallScore: feedback.overallScore
      });
      
      const locale = options.locale || feedback.session.language || 'en';
      const builder = new PDFBuilder(locale);
      const pdfBase64 = builder.build(feedback, options);
      const pageCount = builder.getPageCount();
      
      // Calculate approximate size (base64 is ~33% larger than binary)
      const fileSizeBytes = Math.round(pdfBase64.length * 0.75);
      
      logger.info('PDF generation completed', {
        sessionId: feedback.session.sessionId,
        pageCount,
        fileSizeBytes,
        processingTimeMs: Date.now() - startTime
      });
      
      return {
        success: true,
        pdfBase64,
        pageCount,
        fileSizeBytes
      };
      
    } catch (error: any) {
      logger.error('PDF generation failed', {
        sessionId: feedback.session.sessionId,
        error: error.message
      });
      
      return {
        success: false,
        error: error.message || 'Failed to generate PDF'
      };
    }
  }
  
  /**
   * Validate that a base64 string is a valid PDF
   */
  validatePDF(base64: string): { valid: boolean; error?: string } {
    try {
      // Decode first few bytes to check PDF magic number
      const bytes = Buffer.from(base64.slice(0, 10), 'base64');
      const header = bytes.toString('ascii');
      
      if (!header.startsWith('%PDF')) {
        return { valid: false, error: 'Invalid PDF header' };
      }
      
      return { valid: true };
    } catch (error: any) {
      return { valid: false, error: error.message };
    }
  }
}

// ============================================
// SINGLETON EXPORT
// ============================================

export const pdfGenerationService = new PDFGenerationService();
