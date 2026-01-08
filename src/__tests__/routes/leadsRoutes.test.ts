import express from 'express';
import request from 'supertest';

jest.mock('../../services/leadsService', () => ({
  __esModule: true,
  createLead: jest.fn(),
  getLeadStats: jest.fn(),
}));

describe('Leads routes - ref capture', () => {
  function buildApp() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const leadsRouter = require('../../routes/leadsRoutes').default;

    const app = express();
    app.use(express.json());
    app.use('/api/leads', leadsRouter);
    return app;
  }

  function getMocks() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const svc = require('../../services/leadsService');
    return svc as {
      createLead: jest.Mock;
      getLeadStats: jest.Mock;
    };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('prefers explicit ?ref= query param for early-access', async () => {
    const { createLead } = getMocks();
    createLead.mockResolvedValue({ success: true, lead: { id: 'lead_1' } });

    const app = buildApp();

    await request(app)
      .post('/api/leads/early-access?ref=partner_123')
      .send({
        name: 'Test User',
        email: 'test@example.com',
        interestedModules: ['recruiter'],
      })
      .expect(200);

    expect(createLead).toHaveBeenCalledTimes(1);
    expect(createLead.mock.calls[0][0].referrer).toBe('partner_123');
  });

  it('falls back to parsing ref from Referer header URL query', async () => {
    const { createLead } = getMocks();
    createLead.mockResolvedValue({ success: true, lead: { id: 'lead_1' } });

    const app = buildApp();

    await request(app)
      .post('/api/leads/early-access')
      .set('Referer', 'https://vocaid.ai/?ref=ref_from_referer&utm_source=x')
      .send({
        name: 'Test User',
        email: 'test2@example.com',
        interestedModules: ['employeeHub'],
      })
      .expect(200);

    expect(createLead).toHaveBeenCalledTimes(1);
    expect(createLead.mock.calls[0][0].referrer).toBe('ref_from_referer');
  });

  it('uses raw Referer header when no ref exists', async () => {
    const { createLead } = getMocks();
    createLead.mockResolvedValue({ success: true, lead: { id: 'lead_1' } });

    const app = buildApp();

    await request(app)
      .post('/api/leads/demo-request')
      .set('Referer', 'https://vocaid.ai/pricing')
      .send({
        name: 'Demo User',
        email: 'demo@example.com',
        company: 'Acme',
        teamSize: '1-10',
        useCase: 'Hiring',
      })
      .expect(200);

    expect(createLead).toHaveBeenCalledTimes(1);
    expect(createLead.mock.calls[0][0].referrer).toBe('https://vocaid.ai/pricing');
  });
});
