import { ConfigService } from '@nestjs/config';
import { getJwtExpiresInSeconds } from './jwt-expiry';

const configWith = (value: unknown) =>
  ({ getOrThrow: jest.fn(() => value) }) as unknown as ConfigService;

describe('getJwtExpiresInSeconds', () => {
  it('converts the env string to a NUMBER of seconds', () => {
    const seconds = getJwtExpiresInSeconds(configWith('3600'));

    // Regression: a unitless STRING is read by jsonwebtoken as milliseconds, which once
    // produced tokens that expired after 3 seconds instead of an hour.
    expect(seconds).toBe(3600);
    expect(typeof seconds).toBe('number');
  });

  it('accepts surrounding whitespace in the env value', () => {
    expect(getJwtExpiresInSeconds(configWith(' 900 '))).toBe(900);
  });

  it.each([
    '0',
    '-5',
    'abc',
    '1.5',
    '',
    '   ',
    'NaN',
    'Infinity',
    '1h',
    '1e3x',
  ])('rejects %p instead of silently issuing odd tokens', (bad) => {
    expect(() => getJwtExpiresInSeconds(configWith(bad))).toThrow(
      'JWT_EXPIRES_IN must be a positive integer (seconds)',
    );
  });

  it('propagates the error when the setting is missing entirely', () => {
    const config = {
      getOrThrow: jest.fn(() => {
        throw new Error('Configuration key "JWT_EXPIRES_IN" does not exist');
      }),
    } as unknown as ConfigService;
    expect(() => getJwtExpiresInSeconds(config)).toThrow('does not exist');
  });
});
