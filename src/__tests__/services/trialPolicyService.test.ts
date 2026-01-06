/**
 * Trial Policy Service Tests
 *
 * The current trial policy is intentionally simple:
 * - Trial credits are ALWAYS 5.
 * - Credits are claimable (not auto-granted).
 */

import { TRIAL_CREDITS_AMOUNT } from '../../services/trialPolicyService';

describe('Trial Policy', () => {
  it('uses a fixed trial amount of 5', () => {
    expect(TRIAL_CREDITS_AMOUNT).toBe(5);
  });
});
