/**
 * Interview timer manager
 * Handles 15-minute maximum interview duration
 */

export class InterviewTimer {
  private startTime: Date;
  private maxDurationMinutes: number;
  private warningThresholdMinutes: number;
  private hasWarned: boolean = false;

  constructor(maxDurationMinutes: number = 15) {
    this.startTime = new Date();
    this.maxDurationMinutes = maxDurationMinutes;
    this.warningThresholdMinutes = maxDurationMinutes - 2; // Warn 2 minutes before end
  }

  /**
   * Get elapsed time in minutes
   */
  getElapsedMinutes(): number {
    const now = new Date();
    return (now.getTime() - this.startTime.getTime()) / 1000 / 60;
  }

  /**
   * Get remaining time in minutes
   */
  getRemainingMinutes(): number {
    return Math.max(0, this.maxDurationMinutes - this.getElapsedMinutes());
  }

  /**
   * Check if interview time has exceeded
   */
  hasExceededTime(): boolean {
    return this.getElapsedMinutes() >= this.maxDurationMinutes;
  }

  /**
   * Check if warning should be issued
   */
  shouldWarn(): boolean {
    if (this.hasWarned) {
      return false;
    }
    
    const elapsed = this.getElapsedMinutes();
    if (elapsed >= this.warningThresholdMinutes) {
      this.hasWarned = true;
      return true;
    }
    
    return false;
  }

  /**
   * Generate time warning message
   */
  getWarningMessage(): string {
    const remaining = Math.ceil(this.getRemainingMinutes());
    return `We have about ${remaining} minutes remaining in our interview. Let me ask you a few final questions to wrap up.`;
  }

  /**
   * Generate time's up message
   */
  getTimeUpMessage(): string {
    return "Thank you so much for your time today. We've reached the end of our scheduled interview time. It was great learning about your background and experience. We'll be in touch with next steps soon.";
  }

  /**
   * Get formatted elapsed time (MM:SS)
   */
  getFormattedElapsedTime(): string {
    const totalSeconds = Math.floor(this.getElapsedMinutes() * 60);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
}
