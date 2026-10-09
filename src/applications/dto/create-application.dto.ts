import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsISO4217CurrencyCode,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsDecimalAmount } from '../../common/decorators/is-decimal-amount.decorator';
import { Trim } from '../../common/decorators/trim.decorator';

/**
 * Only client-editable business data lives here. status, riskStatus,
 * createdById, assignedReviewerId, decision fields etc. are deliberately
 * absent: the global ValidationPipe (whitelist) strips anything not declared.
 */
export class CreateApplicationDto {
  @ApiProperty({ example: 'Moka Cafe', maxLength: 255 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  businessName!: string;

  @ApiProperty({ example: 'Moka Cafe Pvt. Ltd.', maxLength: 255 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  legalBusinessName!: string;

  @ApiProperty({ example: 'cafe', maxLength: 100 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  businessType!: string;

  @ApiProperty({ example: 'Cafe Owner', maxLength: 255 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  ownerName!: string;

  @ApiProperty({ example: 'cafe_owner@example.com', maxLength: 255 })
  @Trim()
  @IsEmail()
  @MaxLength(255)
  ownerEmail!: string;

  @ApiProperty({ example: '+977 9876543210' })
  @Trim()
  @Matches(/^\+?[0-9()\-\s]{5,50}$/, {
    message: 'ownerPhone must be a valid phone number',
  })
  ownerPhone!: string;

  @ApiProperty({
    example: '123-456-789',
    description:
      'Sensitive. Masked in responses; encrypted at rest in Pack 09.',
    maxLength: 50,
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  ownerTaxId!: string;

  @ApiProperty({
    type: String,
    example: '25000.00',
    description:
      'Expected monthly processing volume. Positive, up to 12 integer digits and 2 decimals. Number or numeric string.',
  })
  @IsDecimalAmount(12)
  monthlyVolume!: string;

  @ApiProperty({
    type: String,
    example: '42.50',
    description:
      'Average ticket size. Positive, up to 10 integer digits and 2 decimals. Number or numeric string.',
  })
  @IsDecimalAmount(10)
  averageTicketSize!: string;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code' })
  @Trim()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsISO4217CurrencyCode()
  currency!: string;
}
