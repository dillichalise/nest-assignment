import { ApplicationAccessSubject } from '../policies/policy.service';
import { MerchantApplication } from './merchant-application.entity';

describe('MerchantApplication', () => {
  it('structurally satisfies the policy subject shape', () => {
    // Compile-time check: breaks the build if the entity drifts from the policy contract.
    const toSubject = (a: MerchantApplication): ApplicationAccessSubject => a;
    expect(typeof toSubject).toBe('function');
  });
});
