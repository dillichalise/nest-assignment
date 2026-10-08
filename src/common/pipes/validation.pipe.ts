import {
  BadRequestException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';

const flatten = (errors: ValidationError[], parent = ''): unknown[] =>
  errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints
      ? [{ field, errors: Object.values(e.constraints) }]
      : [];
    return [...own, ...flatten(e.children ?? [], field)];
  });

export const createValidationPipe = () =>
  new ValidationPipe({
    whitelist: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BadRequestException({
        message: 'Validation failed',
        details: flatten(errors),
      }),
  });
