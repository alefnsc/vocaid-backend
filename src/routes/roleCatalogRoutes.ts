/**
 * Role Catalog Routes
 * 
 * API endpoints for the canonical role catalog.
 * Used by frontend for role selection across interview creation, 
 * resume scoring, and dashboard filtering.
 * 
 * Routes:
 * - GET /api/roles/catalog - Get full role catalog grouped by industry
 * - GET /api/roles/search - Search/suggest roles for a query
 * - GET /api/roles/:roleKey - Get specific role definition
 * 
 * @module routes/roleCatalogRoutes
 */

import { Router, Request, Response } from 'express';
import {
  getRoleCatalog,
  getAllRoles,
  getRoleByKey,
  suggestSimilarRoles,
  normalizeToRoleKey,
  getIndustryKeys
} from '../services/roleCatalogService';

const router = Router();

/**
 * GET /api/roles/catalog
 * Get full role catalog grouped by industry
 */
router.get('/catalog', async (_req: Request, res: Response) => {
  try {
    const catalog = getRoleCatalog();
    
    return res.json({
      status: 'success',
      data: {
        industries: catalog,
        totalRoles: getAllRoles().length
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch role catalog'
    });
  }
});

/**
 * GET /api/roles/industries
 * Get list of available industries
 */
router.get('/industries', async (_req: Request, res: Response) => {
  try {
    const catalog = getRoleCatalog();
    
    return res.json({
      status: 'success',
      data: catalog.map(g => ({
        key: g.industryKey,
        name: g.displayName,
        roleCount: g.roles.length
      }))
    });
  } catch (error: any) {
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch industries'
    });
  }
});

/**
 * GET /api/roles/search
 * Search for roles matching a query
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q, limit } = req.query;
    const query = (q as string) || '';
    const maxResults = Math.min(parseInt(limit as string) || 10, 50);
    
    if (!query.trim()) {
      // Return popular roles if no query
      const allRoles = getAllRoles();
      return res.json({
        status: 'success',
        data: {
          query,
          results: allRoles.slice(0, maxResults).map(r => ({
            roleKey: r.roleKey,
            displayName: r.displayName,
            industry: r.industry
          }))
        }
      });
    }
    
    const suggestions = suggestSimilarRoles(query, maxResults);
    
    return res.json({
      status: 'success',
      data: {
        query,
        results: suggestions.map(r => ({
          roleKey: r.roleKey,
          displayName: r.displayName,
          industry: r.industry
        })),
        // Also return normalized key if exact match found
        normalizedKey: normalizeToRoleKey(query)
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      status: 'error',
      message: 'Failed to search roles'
    });
  }
});

/**
 * GET /api/roles/:roleKey
 * Get specific role definition by key
 */
router.get('/:roleKey', async (req: Request, res: Response) => {
  try {
    const { roleKey } = req.params;
    const role = getRoleByKey(roleKey);
    
    if (!role) {
      // Try to find similar roles
      const suggestions = suggestSimilarRoles(roleKey, 3);
      
      return res.status(404).json({
        status: 'error',
        message: `Role '${roleKey}' not found`,
        suggestions: suggestions.map(r => ({
          roleKey: r.roleKey,
          displayName: r.displayName
        }))
      });
    }
    
    return res.json({
      status: 'success',
      data: role
    });
  } catch (error: any) {
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch role'
    });
  }
});

export default router;
