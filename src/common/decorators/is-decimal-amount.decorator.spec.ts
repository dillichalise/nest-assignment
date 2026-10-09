import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IsDecimalAmount } from './is-decimal-amount.decorator';

class Probe {
  @IsDecimalAmount(5)
  amount!: unknown;
}

const check = (amount: unknown) => {
  const probe = plainToInstance(Probe, { amount });
  return { errors: validateSync(probe), amount: probe.amount };
};

describe('IsDecimalAmount', () => {
  it.each([[100], ['100'], [12.5], ['0.01'], [99999.99], ['5.0']])(
    'accepts %p',
    (v) => {
      const { errors, amount } = check(v);
      expect(errors).toHaveLength(0);
      expect(typeof amount).toBe('string');
    },
  );

  it.each([
    [0],
    ['0.00'],
    [-5],
    [1.234],
    [100000],
    ['abc'],
    [''],
    [null],
    [undefined],
    [1e21],
    [true],
  ])('rejects %p', (v) => {
    expect(check(v).errors.length).toBeGreaterThan(0);
  });
});
