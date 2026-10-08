import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../common/enums/role.enum';

export class MeResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'sales@example.com' })
  email!: string;

  @ApiProperty({ example: 'Dilli Sales' })
  name!: string;

  @ApiProperty({ enum: Role })
  role!: Role;
}
