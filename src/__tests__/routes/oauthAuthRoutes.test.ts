import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

jest.mock('../../services/sessionService', () => {
  const sessions = new Map<
    string,
    {
      userId: string;
      expiresAt: Date;
      createdAt: Date;
      lastAccessedAt: Date;
      ipAddress?: string | null;
      userAgent?: string | null;
      user: {
        id: string;
        email: string;
        emailVerified: boolean;
        isActive: boolean;
      };
    }
  >();

  const cookieName = 'vocaid_session';
  const cookieOptions = {
    httpOnly: true,
    secure: false,
    sameSite: 'lax' as const,
    path: '/',
  };

  function randomToken(prefix: string) {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  }

  return {
    __esModule: true,
    getSessionCookieName: () => cookieName,
    getSessionCookieOptions: () => cookieOptions,
    getSessionToken: (cookies: Record<string, string | undefined>) => cookies?.[cookieName] || null,
    validateSession: async (token: string) => {
      if (!token) return null;
      const session = sessions.get(token);
      if (!session) return null;
      if (session.expiresAt.getTime() < Date.now()) {
        sessions.delete(token);
        return null;
      }
      return session;
    },
    createSession: async (
      input: { userId: string; ipAddress?: string | null; userAgent?: string | null },
      res: any
    ) => {
      const token = randomToken(input.userId);
      const now = new Date();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60);

      sessions.set(token, {
        userId: input.userId,
        createdAt: now,
        lastAccessedAt: now,
        expiresAt,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        user: {
          id: input.userId,
          email: `user.${input.userId}@example.com`,
          emailVerified: true,
          isActive: true,
        },
      });

      res.cookie(cookieName, token, { ...cookieOptions, expires: expiresAt });
      return {
        token,
        expiresAt,
      };
    },
    destroySession: async (token: string, res: any) => {
      sessions.delete(token);
      res.clearCookie(cookieName, cookieOptions);
    },
    destroyAllUserSessions: async () => {
      sessions.clear();
    },
  };
});

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
};

function mockFetchJson(data: any, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function buildApp(authRouter: any) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

function parseStateFromRedirect(location: string): string {
  const url = new URL(location);
  const state = url.searchParams.get('state');
  if (!state) throw new Error('Missing state in redirect URL');
  return state;
}

function getPrismaMock() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  return new PrismaClient();
}

describe('OAuth routes (mocked)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };

    process.env.FRONTEND_URL = 'http://localhost:3000';
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret';
    process.env.X_CLIENT_ID = 'x-client-id';
    process.env.X_CLIENT_SECRET = 'x-client-secret';

    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('Google OAuth defaults returnTo to /auth/post-login and authenticates session', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const authRouter = require('../../routes/authRoutes').default;
    const prisma = getPrismaMock();

    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user_google_1',
      email: 'test@example.com',
      authProviders: ['google'],
      firstName: 'Test',
      lastName: 'User',
      imageUrl: null,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      isActive: true,
      lastAuthProvider: 'google',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_google_1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      imageUrl: null,
      currentRole: 'B2C_FREE',
      countryCode: null,
      preferredLanguage: 'en',
      emailVerified: true,
      credits: 0,
      phoneNumber: null,
      phoneVerified: false,
      createdAt: new Date(),
      registrationRegion: null,
      passwordHash: null,
      authProviders: ['google'],
      lastAuthProvider: 'google',
    });

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockFetchJson({ access_token: 'at' }))
      .mockResolvedValueOnce(
        mockFetchJson({
          id: 'gid',
          email: 'test@example.com',
          verified_email: true,
          given_name: 'Test',
          family_name: 'User',
          picture: null,
        })
      );

    const app = buildApp(authRouter);
    const agent = request.agent(app);

    const startRes = await agent.get('/api/auth/google').expect(302);
    const state = parseStateFromRedirect(startRes.headers.location);

    const cbRes = await agent
      .get(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`)
      .expect(302);

    expect(cbRes.headers.location).toBe('http://localhost:3000/auth/post-login');
    const setCookieHeader = cbRes.headers['set-cookie'];
    const setCookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join(';') : setCookieHeader;
    expect(setCookieStr).toContain('vocaid_session=');

    const meRes = await agent.get('/api/auth/me').expect(200);
    expect(meRes.body?.authenticated).toBe(true);
    expect(meRes.body?.user?.id).toBe('user_google_1');
  });

  it('LinkedIn OAuth honors returnTo and authenticates session', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const authRouter = require('../../routes/authRoutes').default;
    const prisma = getPrismaMock();

    prisma.linkedInProfile.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user_li_1',
      email: 'li@example.com',
      authProviders: ['linkedin'],
      firstName: 'Li',
      lastName: 'User',
      imageUrl: null,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      isActive: true,
      lastAuthProvider: 'linkedin',
    });
    prisma.linkedInProfile.create.mockResolvedValue({ userId: 'user_li_1' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user_li_1',
      email: 'li@example.com',
      firstName: 'Li',
      lastName: 'User',
      imageUrl: null,
      currentRole: 'B2C_FREE',
      countryCode: null,
      preferredLanguage: 'en',
      emailVerified: true,
      credits: 0,
      phoneNumber: null,
      phoneVerified: false,
      createdAt: new Date(),
      registrationRegion: null,
      passwordHash: null,
      authProviders: ['linkedin'],
      lastAuthProvider: 'linkedin',
    });

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockFetchJson({ access_token: 'lat', expires_in: 3600 }))
      .mockResolvedValueOnce(
        mockFetchJson({
          sub: 'lid',
          email: 'li@example.com',
          name: 'Li User',
          given_name: 'Li',
          family_name: 'User',
          picture: null,
        })
      );

    const app = buildApp(authRouter);
    const agent = request.agent(app);

    const startRes = await agent.get('/api/auth/linkedin?returnTo=/auth/post-login').expect(302);
    const state = parseStateFromRedirect(startRes.headers.location);

    const cbRes = await agent
      .get(`/api/auth/linkedin/callback?code=abc&state=${encodeURIComponent(state)}`)
      .expect(302);

    expect(cbRes.headers.location).toBe('http://localhost:3000/auth/post-login');

    const meRes = await agent.get('/api/auth/me').expect(200);
    expect(meRes.body?.authenticated).toBe(true);
    expect(meRes.body?.user?.id).toBe('user_li_1');
  });

  it('X OAuth honors returnTo and authenticates session', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const authRouter = require('../../routes/authRoutes').default;
    const prisma = getPrismaMock();

    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.findUnique
      // In X OAuth callback flow: check if a user exists with confirmed_email
      .mockResolvedValueOnce(null)
      // In /api/auth/me: fetch current user
      .mockResolvedValueOnce({
        id: 'user_x_1',
        email: 'xuser@x.vocaid.io',
        firstName: 'X',
        lastName: 'User',
        imageUrl: null,
        currentRole: 'B2C_FREE',
        countryCode: null,
        preferredLanguage: 'en',
        emailVerified: true,
        credits: 0,
        phoneNumber: null,
        phoneVerified: false,
        createdAt: new Date(),
        registrationRegion: null,
        passwordHash: null,
        authProviders: ['x'],
        lastAuthProvider: 'x',
      });
    prisma.user.create.mockResolvedValue({
      id: 'user_x_1',
      email: 'xuser@x.vocaid.io',
      authProviders: ['x'],
      firstName: 'X',
      lastName: 'User',
      imageUrl: null,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      isActive: true,
      lastAuthProvider: 'x',
    });
    prisma.xProfile.create.mockResolvedValue({
      id: 'xprofile_1',
      userId: 'user_x_1',
      xUserId: 'xid',
      username: 'xuser',
      name: 'X User',
      pictureUrl: 'http://example.com/normal.jpg',
    });

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        mockFetchJson({
          access_token: 'xat',
          expires_in: 3600,
          token_type: 'bearer',
          scope: 'users.read',
        })
      )
      .mockResolvedValueOnce(
        mockFetchJson({
          data: {
            id: 'xid',
            name: 'X User',
            username: 'xuser',
            profile_image_url: 'http://example.com/normal.jpg',
            confirmed_email: 'xuser@x.vocaid.io',
          },
        })
      );

    const app = buildApp(authRouter);
    const agent = request.agent(app);

    const startRes = await agent.get('/api/auth/x?returnTo=/auth/post-login').expect(302);
    const redirectUrl = new URL(startRes.headers.location);
    const state = redirectUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    const cbRes = await agent
      .get(`/api/auth/x/callback?code=abc&state=${encodeURIComponent(state!)}`)
      .expect(302);

    expect(cbRes.headers.location).toBe('http://localhost:3000/auth/post-login');

    const meRes = await agent.get('/api/auth/me').expect(200);
    expect(meRes.body?.authenticated).toBe(true);
    expect(meRes.body?.user?.id).toBe('user_x_1');
  });

  it('X OAuth returns invalid_state when state is missing from PKCE store', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const authRouter = require('../../routes/authRoutes').default;
    const app = buildApp(authRouter);

    const res = await request(app)
      .get('/api/auth/x/callback?code=abc&state=does_not_exist')
      .expect(302);

    expect(res.headers.location).toBe('http://localhost:3000/auth/error?error=invalid_state');
  });
});
