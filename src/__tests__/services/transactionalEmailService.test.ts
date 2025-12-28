/**
 * Transactional Email Service Tests
 * 
 * Unit tests for email service functions
 * 
 * @module tests/services/transactionalEmailService
 * 
 * TODO: These tests are currently skipped because they require a complete
 * mock of the service dependency chain. The service imports other services
 * that import the logger and call .child(), which needs proper Jest hoisting.
 * 
 * To fix:
 * 1. Create a proper mock module for services/consentService
 * 2. Use jest.isolateModules() to reset module state between tests
 */

import { testUtils } from '../setup';

// Skip entire test suite until service mocks are properly configured
describe.skip('Transactional Email Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================
  // isEmailMockMode Tests
  // =========================================
  describe('isEmailMockMode', () => {
    it('should return boolean indicating mock mode', async () => {
      // With EMAIL_PROVIDER_MODE=mock from setup, this should return true
      const { isEmailMockMode } = await import('../../services/transactionalEmailService');
      expect(typeof isEmailMockMode()).toBe('boolean');
    });
  });

  // =========================================
  // getAvailableEmailTypes Tests
  // =========================================
  describe('getAvailableEmailTypes', () => {
    it('should return array of email types', async () => {
      const { getAvailableEmailTypes } = await import('../../services/transactionalEmailService');
      const types = getAvailableEmailTypes();
      
      expect(Array.isArray(types)).toBe(true);
      expect(types.length).toBeGreaterThan(0);
    });
  });

  // =========================================
  // previewEmail Tests
  // =========================================
  describe('previewEmail', () => {
    it('should return HTML, text, and subject for welcome email', async () => {
      const { previewEmail } = await import('../../services/transactionalEmailService');
      const preview = previewEmail('welcome', 'en');
      
      expect(preview.html).toBeDefined();
      expect(preview.text).toBeDefined();
      expect(preview.subject).toBeDefined();
      expect(preview.html).toContain('<!DOCTYPE html');
    });

    it('should support Portuguese language', async () => {
      const { previewEmail } = await import('../../services/transactionalEmailService');
      const preview = previewEmail('welcome', 'pt');
      
      expect(preview.subject).toBeDefined();
    });

    it('should generate previews for all email types', async () => {
      const { previewEmail } = await import('../../services/transactionalEmailService');
      const validTypes: Array<'welcome' | 'purchase' | 'low-credits' | 'interview-reminder' | 'interview-complete'> = 
        ['welcome', 'purchase', 'low-credits', 'interview-reminder', 'interview-complete'];
      
      for (const type of validTypes) {
        const preview = previewEmail(type, 'en');
        expect(preview.html).toBeDefined();
        expect(preview.text).toBeDefined();
        expect(preview.subject).toBeDefined();
      }
    });

    it('should accept custom sample data', async () => {
      const { previewEmail } = await import('../../services/transactionalEmailService');
      const preview = previewEmail('welcome', 'en', { firstName: 'CustomName' });
      
      expect(preview.html).toContain('CustomName');
    });
  });

  // =========================================
  // Email Template Content Tests
  // =========================================
  describe('Email Templates', () => {
    it('welcome email should include branding', async () => {
      const { previewEmail } = await import('../../services/transactionalEmailService');
      const preview = previewEmail('welcome', 'en');
      
      expect(preview.html).toContain('Vocaid');
    });

    it('interview-reminder should include CTA link', async () => {
      const { previewEmail } = await import('../../services/transactionalEmailService');
      const preview = previewEmail('interview-reminder', 'en');
      
      // Should contain a link to practice
      expect(preview.html).toContain('href=');
    });
  });
});
