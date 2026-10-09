import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

/**
 * A strictly positive money-like amount with at most 2 decimals.
 * Accepts a JSON number or a numeric string and normalizes to a string, so the
 * value never passes through a binary float on its way to Postgres `numeric`.
 */
export const IsDecimalAmount = (maxIntegerDigits: number) =>
  applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'number' ? String(value) : value,
    ),
    IsString({ message: '$property must be a number or numeric string' }),
    Matches(
      new RegExp(
        `^(?!0+(\\.0{1,2})?$)\\d{1,${maxIntegerDigits}}(\\.\\d{1,2})?$`,
      ),
      {
        message: `$property must be a positive amount with at most ${maxIntegerDigits} integer digits and 2 decimals`,
      },
    ),
  );
