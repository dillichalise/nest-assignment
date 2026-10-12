import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AssignReviewerDto {
  @ApiProperty({
    format: 'uuid',
    example: '6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11',
    description: 'Id of an active user with the REVIEWER role',
  })
  @IsUUID()
  reviewerId!: string;
}
