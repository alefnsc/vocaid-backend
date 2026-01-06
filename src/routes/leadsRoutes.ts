/**
 * Leads Routes
 *
 * Lead capture was previously backed by a Prisma `Lead` model.
 * The canonical `prisma/schema.prisma` in this repo does not include that model,
 * so these endpoints are temporarily disabled to keep the backend typecheck clean.
 */

import { Router, Request, Response } from 'express';
import logger from '../utils/logger';

const router = Router();
const leadsLogger = logger.child({ component: 'leads-routes' });

function disabled(res: Response) {
  return res.status(410).json({
    status: 'error',
    message: 'Leads capture is not available on this deployment.'
  });
}

router.post('/demo-request', (_req: Request, res: Response) => {
  leadsLogger.warn('Leads endpoint called but disabled', { path: '/demo-request' });
  return disabled(res);
});

router.post('/early-access', (_req: Request, res: Response) => {
  leadsLogger.warn('Leads endpoint called but disabled', { path: '/early-access' });
  return disabled(res);
});

router.get('/stats', (_req: Request, res: Response) => {
  leadsLogger.warn('Leads stats endpoint called but disabled', { path: '/stats' });
  return disabled(res);
});

export default router;
