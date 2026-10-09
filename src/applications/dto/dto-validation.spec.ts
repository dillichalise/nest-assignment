import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { createValidationPipe } from '../../common/pipes/validation.pipe';
import { CreateApplicationDto } from './create-application.dto';
import { ListApplicationsQueryDto } from './list-applications-query.dto';
import { UpdateApplicationDto } from './update-application.dto';

// Runs DTOs through the SAME pipe the app uses, so whitelisting is really tested.
const pipe = createValidationPipe();
const run = <T>(
  type: new () => T,
  value: unknown,
  kind: 'body' | 'query' = 'body',
) =>
  pipe.transform(value, {
    type: kind,
    metatype: type,
  } as ArgumentMetadata) as Promise<T>;

const valid = {
  businessName: '  Moka Cafe ',
  legalBusinessName: 'Moka Cafe Pvt. Ltd.',
  businessType: 'cafe',
  ownerName: 'Pat Owner',
  ownerEmail: 'cafe_owner@example.com',
  ownerPhone: '+977 9876543210',
  ownerTaxId: '123-456-789',
  monthlyVolume: 25000,
  averageTicketSize: 42.5,
  currency: 'USD',
};

describe('CreateApplicationDto', () => {
  it('accepts a valid payload, trims strings and normalizes amounts to strings', async () => {
    const dto = await run(CreateApplicationDto, valid);
    expect(dto.businessName).toBe('Moka Cafe');
    expect(dto.monthlyVolume).toBe('25000');
    expect(dto.averageTicketSize).toBe('42.5');
  });

  it('normalizes the currency code to upper case', async () => {
    const dto = await run(CreateApplicationDto, {
      ...valid,
      currency: ' usd ',
    });
    expect(dto.currency).toBe('USD');
  });

  it('strips workflow fields a client tries to smuggle in', async () => {
    const dto = await run(CreateApplicationDto, {
      ...valid,
      status: 'APPROVED',
      riskStatus: 'COMPLETED',
      createdById: 'attacker',
      assignedReviewerId: 'attacker',
      riskScore: 0,
      decidedAt: '2026-01-01',
    });
    expect(dto).not.toHaveProperty('status');
    expect(dto).not.toHaveProperty('riskStatus');
    expect(dto).not.toHaveProperty('createdById');
    expect(dto).not.toHaveProperty('assignedReviewerId');
    expect(dto).not.toHaveProperty('riskScore');
    expect(dto).not.toHaveProperty('decidedAt');
  });

  it.each([
    ['businessName', ''],
    ['businessName', '   '],
    ['businessName', 'x'.repeat(256)],
    ['ownerEmail', 'not-an-email'],
    ['ownerPhone', 'abc'],
    ['monthlyVolume', 0],
    ['monthlyVolume', -1],
    ['averageTicketSize', 1.234],
    ['currency', 'ZZZ'],
  ])('rejects %s = %p', async (field, value) => {
    await expect(
      run(CreateApplicationDto, { ...valid, [field]: value }),
    ).rejects.toThrow(BadRequestException);
  });

  it('reports every failing field at once', async () => {
    const err = await run(CreateApplicationDto, {}).catch((e) => e);
    const fields = err
      .getResponse()
      .details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'businessName',
        'ownerEmail',
        'monthlyVolume',
        'currency',
      ]),
    );
  });
});

describe('UpdateApplicationDto', () => {
  it('makes every field optional but still validates what is sent', async () => {
    await expect(run(UpdateApplicationDto, {})).resolves.toBeDefined();
    await expect(
      run(UpdateApplicationDto, { ownerEmail: 'bad' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('cannot be used to change status, owner, reviewer or risk fields', async () => {
    const dto = await run(UpdateApplicationDto, {
      businessName: 'ok',
      status: 'APPROVED',
      createdById: 'attacker',
      assignedReviewerId: 'attacker',
      riskStatus: 'COMPLETED',
      riskScore: 1,
      decisionReason: 'trust me',
    });
    expect(Object.keys(dto)).toEqual(['businessName']);
  });
});

describe('ListApplicationsQueryDto', () => {
  it('applies defaults', async () => {
    const q = await run(ListApplicationsQueryDto, {}, 'query');
    expect(q.page).toBe(1);
    expect(q.limit).toBe(20);
  });

  it('coerces numeric strings from the query string', async () => {
    const q = await run(
      ListApplicationsQueryDto,
      { page: '2', limit: '50', status: 'DRAFT' },
      'query',
    );
    expect(q.page).toBe(2);
    expect(q.limit).toBe(50);
    expect(q.status).toBe('DRAFT');
  });

  it.each([
    [{ limit: '101' }],
    [{ limit: '0' }],
    [{ page: '0' }],
    [{ page: '-1' }],
    [{ page: 'abc' }],
    [{ limit: '1.5' }],
    [{ status: 'NOPE' }],
  ])('rejects %p', async (query) => {
    await expect(run(ListApplicationsQueryDto, query, 'query')).rejects.toThrow(
      BadRequestException,
    );
  });
});
