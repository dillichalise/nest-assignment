import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsString, Min, ValidateNested } from 'class-validator';
import { createValidationPipe } from './validation.pipe';

class Address {
  @IsString() city!: string;
  @IsInt() @Min(1) zip!: number;
}
class Item {
  @IsString() sku!: string;
}
class Order {
  @IsEmail() email!: string;
  @ValidateNested() @Type(() => Address) address!: Address;
  @ValidateNested({ each: true }) @Type(() => Item) items!: Item[];
}

const pipe = createValidationPipe();
const run = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: Order } as ArgumentMetadata);

const detailsOf = async (value: unknown) => {
  const error = await run(value).catch((e) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  return (
    error.getResponse() as { details: { field: string; errors: string[] }[] }
  ).details;
};

describe('createValidationPipe', () => {
  const valid = {
    email: 'a@b.co',
    address: { city: 'Kathmandu', zip: 44600 },
    items: [{ sku: 'x' }],
  };

  it('accepts a valid body and builds real class instances', async () => {
    const order = (await run(valid)) as Order;
    expect(order).toBeInstanceOf(Order);
    expect(order.address).toBeInstanceOf(Address);
  });

  it('answers with a single "Validation failed" message and per-field details', async () => {
    const error = await run({}).catch((e) => e);
    expect(error.getResponse()).toMatchObject({ message: 'Validation failed' });
  });

  it('reports errors of nested objects with a dotted path', async () => {
    const details = await detailsOf({ ...valid, address: { city: 5, zip: 0 } });
    const fields = details.map((d) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining(['address.city', 'address.zip']),
    );
    expect(fields).not.toContain('address');
  });

  it('reports errors inside arrays with the element index', async () => {
    const details = await detailsOf({
      ...valid,
      items: [{ sku: 'ok' }, { sku: 7 }],
    });
    expect(details.map((d) => d.field)).toContain('items.1.sku');
  });

  it('reports a top-level and a nested problem together', async () => {
    const details = await detailsOf({
      ...valid,
      email: 'bad',
      address: { city: 'x', zip: -1 },
    });
    expect(details.map((d) => d.field).sort()).toEqual([
      'address.zip',
      'email',
    ]);
  });

  it('lists every violated rule of one field', async () => {
    const details = await detailsOf({
      ...valid,
      address: { city: 'x', zip: 'abc' },
    });
    const zip = details.find((d) => d.field === 'address.zip')!;
    expect(zip.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('strips properties that are not declared, at every level', async () => {
    const order = (await run({
      ...valid,
      isAdmin: true,
      address: { ...valid.address, secret: 'x' },
    })) as unknown as Record<string, unknown>;
    expect(order).not.toHaveProperty('isAdmin');
    expect(order.address).not.toHaveProperty('secret');
  });
});
