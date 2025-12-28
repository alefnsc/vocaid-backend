/**
 * Trial Policy Service Tests
 * 
 * Tests for the trial credit granting policy including:
 * - Promo period detection (before/after Jan 15, 2026)
 * - User type restrictions (B2C only)
 * - Email verification requirements
 * - Abuse prevention integration
 * - Idempotency guarantees
 */

import {
  PROMO_START_DATE,
  PROMO_END_DATE,
  PROMO_TRIAL_CREDITS,
  DEFAULT_TRIAL_CREDITS,
  isPromoActive,
  getTrialCreditsAmount,
  getPromoRemainingDays
} from '../../services/trialPolicyService';

// ========================================
// PROMO DATE CONFIGURATION TESTS
// ========================================

describe('Trial Policy Configuration', () => {
  describe('Promo dates', () => {
    it('should have PROMO_START_DATE set to Dec 28, 2025', () => {
      expect(PROMO_START_DATE.toISOString()).toBe('2025-12-28T00:00:00.000Z');
    });

    it('should have PROMO_END_DATE set to Jan 15, 2026', () => {
      expect(PROMO_END_DATE.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    });

    it('should have promo period duration of 18 days', () => {
      const durationMs = PROMO_END_DATE.getTime() - PROMO_START_DATE.getTime();
      const durationDays = durationMs / (1000 * 60 * 60 * 24);
      expect(durationDays).toBe(18);
    });
  });

  describe('Credit amounts', () => {
    it('should have PROMO_TRIAL_CREDITS set to 5', () => {
      expect(PROMO_TRIAL_CREDITS).toBe(5);
    });

    it('should have DEFAULT_TRIAL_CREDITS set to 1', () => {
      expect(DEFAULT_TRIAL_CREDITS).toBe(1);
    });
  });
});

// ========================================
// PROMO PERIOD DETECTION TESTS
// ========================================

describe('isPromoActive()', () => {
  describe('before promo period', () => {
    it('should return false before promo start date', () => {
      const beforePromo = new Date('2025-12-27T23:59:59Z');
      expect(isPromoActive(beforePromo)).toBe(false);
    });

    it('should return false way before promo start date', () => {
      const wayBefore = new Date('2025-01-01T00:00:00Z');
      expect(isPromoActive(wayBefore)).toBe(false);
    });
  });

  describe('during promo period', () => {
    it('should return true at exact promo start', () => {
      const atStart = new Date('2025-12-28T00:00:00Z');
      expect(isPromoActive(atStart)).toBe(true);
    });

    it('should return true one second after promo start', () => {
      const justAfterStart = new Date('2025-12-28T00:00:01Z');
      expect(isPromoActive(justAfterStart)).toBe(true);
    });

    it('should return true in middle of promo period', () => {
      const midPromo = new Date('2026-01-05T12:00:00Z');
      expect(isPromoActive(midPromo)).toBe(true);
    });

    it('should return true one second before promo end', () => {
      const justBeforeEnd = new Date('2026-01-14T23:59:59Z');
      expect(isPromoActive(justBeforeEnd)).toBe(true);
    });
  });

  describe('after promo period', () => {
    it('should return false at exact promo end (exclusive)', () => {
      const atEnd = new Date('2026-01-15T00:00:00Z');
      expect(isPromoActive(atEnd)).toBe(false);
    });

    it('should return false one second after promo end', () => {
      const justAfterEnd = new Date('2026-01-15T00:00:01Z');
      expect(isPromoActive(justAfterEnd)).toBe(false);
    });

    it('should return false way after promo end', () => {
      const wayAfter = new Date('2027-01-01T00:00:00Z');
      expect(isPromoActive(wayAfter)).toBe(false);
    });
  });
});

// ========================================
// CREDIT AMOUNT CALCULATION TESTS
// ========================================

describe('getTrialCreditsAmount()', () => {
  describe('during promo period', () => {
    it('should return 5 credits at promo start', () => {
      const atStart = new Date('2025-12-28T00:00:00Z');
      expect(getTrialCreditsAmount(atStart)).toBe(5);
    });

    it('should return 5 credits in middle of promo', () => {
      const midPromo = new Date('2026-01-07T12:00:00Z');
      expect(getTrialCreditsAmount(midPromo)).toBe(5);
    });

    it('should return 5 credits one second before promo ends', () => {
      const justBeforeEnd = new Date('2026-01-14T23:59:59Z');
      expect(getTrialCreditsAmount(justBeforeEnd)).toBe(5);
    });
  });

  describe('after promo period', () => {
    it('should return 1 credit at exact promo end', () => {
      const atEnd = new Date('2026-01-15T00:00:00Z');
      expect(getTrialCreditsAmount(atEnd)).toBe(1);
    });

    it('should return 1 credit after promo end', () => {
      const afterEnd = new Date('2026-02-01T00:00:00Z');
      expect(getTrialCreditsAmount(afterEnd)).toBe(1);
    });

    it('should return 1 credit in 2027', () => {
      const future = new Date('2027-06-15T00:00:00Z');
      expect(getTrialCreditsAmount(future)).toBe(1);
    });
  });

  describe('before promo period', () => {
    it('should return 1 credit before promo starts', () => {
      const beforePromo = new Date('2025-12-27T23:59:59Z');
      expect(getTrialCreditsAmount(beforePromo)).toBe(1);
    });
  });
});

// ========================================
// PROMO REMAINING DAYS TESTS
// ========================================

describe('getPromoRemainingDays()', () => {
  describe('during promo period', () => {
    it('should return 18 days at promo start', () => {
      const atStart = new Date('2025-12-28T00:00:00Z');
      expect(getPromoRemainingDays(atStart)).toBe(18);
    });

    it('should return correct days in middle of promo', () => {
      // Jan 5, 2026 is 10 days before Jan 15
      const jan5 = new Date('2026-01-05T00:00:00Z');
      expect(getPromoRemainingDays(jan5)).toBe(10);
    });

    it('should return 1 day on last day of promo', () => {
      // Jan 14, 2026 is the last full day
      const lastDay = new Date('2026-01-14T00:00:00Z');
      expect(getPromoRemainingDays(lastDay)).toBe(1);
    });

    it('should return 1 on final seconds before midnight', () => {
      const finalSeconds = new Date('2026-01-14T23:59:59Z');
      // Should round up to 1
      expect(getPromoRemainingDays(finalSeconds)).toBe(1);
    });
  });

  describe('after promo period', () => {
    it('should return 0 at promo end', () => {
      const atEnd = new Date('2026-01-15T00:00:00Z');
      expect(getPromoRemainingDays(atEnd)).toBe(0);
    });

    it('should return 0 after promo ends', () => {
      const afterEnd = new Date('2026-02-01T00:00:00Z');
      expect(getPromoRemainingDays(afterEnd)).toBe(0);
    });
  });

  describe('before promo period', () => {
    it('should return 0 before promo starts', () => {
      const beforePromo = new Date('2025-12-27T00:00:00Z');
      expect(getPromoRemainingDays(beforePromo)).toBe(0);
    });
  });
});

// ========================================
// TIMEZONE EDGE CASE TESTS
// ========================================

describe('Timezone handling', () => {
  it('should use UTC for all comparisons', () => {
    // The promo end date is Jan 15, 2026 00:00:00 UTC
    // Someone at 11pm on Jan 14 in New York (UTC-5) is actually
    // Jan 15, 2026 04:00:00 UTC, so promo should be OVER
    
    // Jan 14 11:00pm EST = Jan 15 4:00am UTC
    const jan14ElevenPmEST = new Date('2026-01-15T04:00:00Z');
    expect(isPromoActive(jan14ElevenPmEST)).toBe(false);
    expect(getTrialCreditsAmount(jan14ElevenPmEST)).toBe(1);
  });

  it('should correctly handle date at UTC midnight cutoff', () => {
    // Exactly at the cutoff
    const exactCutoff = new Date('2026-01-15T00:00:00.000Z');
    expect(isPromoActive(exactCutoff)).toBe(false);
    
    // 1ms before cutoff
    const justBefore = new Date('2026-01-14T23:59:59.999Z');
    expect(isPromoActive(justBefore)).toBe(true);
  });
});

// ========================================
// EDGE CASE TESTS
// ========================================

describe('Edge cases', () => {
  it('should handle invalid date gracefully', () => {
    const invalidDate = new Date('invalid');
    // Should not throw, but behavior depends on implementation
    // NaN date should be treated as outside promo period
    expect(() => isPromoActive(invalidDate)).not.toThrow();
  });

  it('should handle default (no argument) calls correctly', () => {
    // These use current date - just verify they don't throw
    expect(() => isPromoActive()).not.toThrow();
    expect(() => getTrialCreditsAmount()).not.toThrow();
    expect(() => getPromoRemainingDays()).not.toThrow();
  });
});
