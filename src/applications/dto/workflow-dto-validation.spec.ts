import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { AssignReviewerDto } from './assign-reviewer.dto';
import { RecordDecisionDto } from './record-decision.dto';

const pipe = createValidationPipe();
const run = <T>(type: new () => T, value: unknown) =>
  pipe.transform(value, {
    type: 'body',
    metatype: type,
  } as ArgumentMetadata) as Promise<T>;

describe('RecordDecisionDto', () => {
  it('accepts APPROVED with no reason', async () => {
    const dto = await run(RecordDecisionDto, { decision: 'APPROVED' });
    expect(dto.reason).toBeUndefined();
  });

  it('accepts APPROVED with an optional reason, trimmed', async () => {
    const dto = await run(RecordDecisionDto, {
      decision: 'APPROVED',
      reason: '  looks fine ',
    });
    expect(dto.reason).toBe('looks fine');
  });

  it.each(['REJECTED', 'INFO_REQUESTED'])(
    'requires a reason for %s',
    async (decision) => {
      await expect(run(RecordDecisionDto, { decision })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        run(RecordDecisionDto, { decision, reason: '' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        run(RecordDecisionDto, { decision, reason: '   ' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        run(RecordDecisionDto, { decision, reason: 'why' }),
      ).resolves.toBeDefined();
    },
  );

  it('still validates a reason that is supplied with APPROVED', async () => {
    await expect(
      run(RecordDecisionDto, { decision: 'APPROVED', reason: 123 }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      run(RecordDecisionDto, {
        decision: 'APPROVED',
        reason: 'x'.repeat(2001),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it.each(['SUBMITTED', 'IN_REVIEW', 'DRAFT', 'approved', '', undefined, 5])(
    'rejects the decision value %p',
    async (decision) => {
      await expect(
        run(RecordDecisionDto, { decision, reason: 'x' }),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it('strips unknown fields', async () => {
    const dto = await run(RecordDecisionDto, {
      decision: 'APPROVED',
      status: 'DRAFT',
    });
    expect(dto).not.toHaveProperty('status');
  });
});

describe('AssignReviewerDto', () => {
  it('accepts a uuid', async () => {
    await expect(
      run(AssignReviewerDto, {
        reviewerId: '6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11',
      }),
    ).resolves.toBeDefined();
  });

  it.each([undefined, '', 'abc', 123])(
    'rejects reviewerId %p',
    async (reviewerId) => {
      await expect(run(AssignReviewerDto, { reviewerId })).rejects.toThrow(
        BadRequestException,
      );
    },
  );
});
