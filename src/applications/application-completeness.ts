import { MerchantApplication } from './merchant-application.entity';

const REQUIRED_TEXT_FIELDS = [
  'businessName',
  'legalBusinessName',
  'businessType',
  'ownerName',
  'ownerEmail',
  'ownerPhone',
  'ownerTaxId',
  'currency',
] as const;

const REQUIRED_AMOUNT_FIELDS = ['monthlyVolume', 'averageTicketSize'] as const;

/**
 * Names of required fields that are blank or invalid. Input validation already
 * guards create/update; this is the last gate before an application leaves the
 * sales user's hands, so a bad row (manual DB edit, future code path) cannot
 * reach review.
 */
export const findIncompleteFields = (
  application: Pick<
    MerchantApplication,
    | (typeof REQUIRED_TEXT_FIELDS)[number]
    | (typeof REQUIRED_AMOUNT_FIELDS)[number]
  >,
): string[] => {
  const blankText = REQUIRED_TEXT_FIELDS.filter(
    (f) => !application[f] || application[f].trim() === '',
  );
  const badAmounts = REQUIRED_AMOUNT_FIELDS.filter((f) => {
    const n = Number(application[f]);
    return !Number.isFinite(n) || n <= 0;
  });
  return [...blankText, ...badAmounts];
};
