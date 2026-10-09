import { ForbiddenException } from '@nestjs/common';
import { AuthUser } from '../auth/auth-user.interface';
import { Role } from '../common/enums/role.enum';
import { NotFoundError } from '../common/errors/domain.error';
import { ApplicationAccessSubject, PolicyService } from './policy.service';

const user = (id: string, role: Role): AuthUser => ({
  id,
  email: `${id}@example.com`,
  role,
});

describe('PolicyService', () => {
  const policy = new PolicyService();
  const admin = user('admin', Role.ADMIN);
  const salesA = user('salesA', Role.SALES);
  const salesB = user('salesB', Role.SALES);
  const reviewer1 = user('rev1', Role.REVIEWER);
  const reviewer2 = user('rev2', Role.REVIEWER);

  const app: ApplicationAccessSubject = {
    createdById: 'salesA',
    assignedReviewerId: 'rev1',
  };
  const unassigned: ApplicationAccessSubject = {
    createdById: 'salesA',
    assignedReviewerId: null,
  };

  describe('view', () => {
    it.each([
      ['ADMIN', admin, true],
      ['owning SALES', salesA, true],
      ['other SALES', salesB, false],
      ['assigned REVIEWER', reviewer1, true],
      ['other REVIEWER', reviewer2, false],
    ])('%s -> %s', (_n, who, expected) => {
      expect(policy.canViewApplication(who, app)).toBe(expected);
    });

    it('a reviewer cannot view an unassigned application', () => {
      expect(policy.canViewApplication(reviewer1, unassigned)).toBe(false);
    });
  });

  describe('applicationScope (list filter)', () => {
    it('ADMIN is unscoped, SALES by creator, REVIEWER by assignment', () => {
      expect(policy.applicationScope(admin)).toEqual({});
      expect(policy.applicationScope(salesA)).toEqual({
        createdById: 'salesA',
      });
      expect(policy.applicationScope(reviewer1)).toEqual({
        assignedReviewerId: 'rev1',
      });
    });

    it('is consistent with canViewApplication for every user and application', () => {
      const apps: ApplicationAccessSubject[] = [app, unassigned];
      const matches = (u: AuthUser, a: ApplicationAccessSubject) => {
        const scope = policy.applicationScope(u);
        return Object.entries(scope).every(
          ([k, v]) => a[k as keyof ApplicationAccessSubject] === v,
        );
      };
      for (const u of [admin, salesA, salesB, reviewer1, reviewer2]) {
        for (const a of apps) {
          expect(matches(u, a)).toBe(policy.canViewApplication(u, a));
        }
      }
    });

    it('fails closed for an unknown role', () => {
      const ghost = { id: 'x', email: 'x', role: 'GHOST' as Role };
      expect(() => policy.applicationScope(ghost)).toThrow(ForbiddenException);
    });
  });

  describe('edit', () => {
    it.each([
      ['ADMIN', admin, true],
      ['owning SALES', salesA, true],
      ['other SALES', salesB, false],
      ['assigned REVIEWER', reviewer1, false],
    ])('%s -> %s', (_n, who, expected) => {
      expect(policy.canEditApplication(who, app)).toBe(expected);
    });
  });

  describe('decide', () => {
    it.each([
      ['assigned REVIEWER', reviewer1, true],
      ['other REVIEWER', reviewer2, false],
      ['ADMIN (no override)', admin, false],
      ['owning SALES', salesA, false],
    ])('%s -> %s', (_n, who, expected) => {
      expect(policy.canDecideApplication(who, app)).toBe(expected);
    });
  });

  describe('assert* denial convention', () => {
    it('view/edit denial is a 404 so existence is not leaked', () => {
      expect(() => policy.assertCanView(salesB, app)).toThrow(NotFoundError);
      expect(() => policy.assertCanEdit(salesB, app)).toThrow(NotFoundError);
    });

    it('decide: invisible object -> 404, visible but not allowed -> 403', () => {
      expect(() => policy.assertCanDecide(salesB, app)).toThrow(NotFoundError);
      expect(() => policy.assertCanDecide(admin, app)).toThrow(
        ForbiddenException,
      );
      expect(() => policy.assertCanDecide(reviewer1, app)).not.toThrow();
    });
  });
});
