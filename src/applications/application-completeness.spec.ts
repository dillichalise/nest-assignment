import { findIncompleteFields } from './application-completeness';

const complete = {
  businessName: 'Moka Cafe',
  legalBusinessName: 'Moka Cafe Pvt Ltd',
  businessType: 'cafe',
  ownerName: 'Cafe Owner',
  ownerEmail: 'cafe_owner@example.com',
  ownerPhone: '+977 9876543210',
  ownerTaxId: '123-456-789',
  currency: 'USD',
  monthlyVolume: '25000.00',
  averageTicketSize: '42.50',
};

describe('findIncompleteFields', () => {
  it('returns nothing for a complete application', () => {
    expect(findIncompleteFields(complete)).toEqual([]);
  });

  it.each(['businessName', 'ownerEmail', 'ownerTaxId', 'currency'] as const)(
    'flags a blank %s',
    (field) => {
      expect(findIncompleteFields({ ...complete, [field]: '' })).toEqual([
        field,
      ]);
      expect(findIncompleteFields({ ...complete, [field]: '   ' })).toEqual([
        field,
      ]);
    },
  );

  it.each(['0', '0.00', '-5', 'abc', ''])(
    'flags a non-positive or invalid amount (%p)',
    (value) => {
      expect(
        findIncompleteFields({ ...complete, monthlyVolume: value }),
      ).toEqual(['monthlyVolume']);
    },
  );

  it('reports every problem at once', () => {
    const result = findIncompleteFields({
      ...complete,
      businessName: '',
      averageTicketSize: '0',
    });
    expect(result).toEqual(['businessName', 'averageTicketSize']);
  });
});
