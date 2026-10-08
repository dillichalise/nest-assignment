import { ConfigService } from '@nestjs/config';

/**
 * JWT_EXPIRES_IN is read from env as a string; a unitless string is treated
 * as milliseconds by jsonwebtoken, so always convert to a number of seconds.
 */
export const getJwtExpiresInSeconds = (config: ConfigService): number => {
  const seconds = Number(config.getOrThrow<string>('JWT_EXPIRES_IN'));
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error('JWT_EXPIRES_IN must be a positive integer (seconds)');
  }
  return seconds;
};
