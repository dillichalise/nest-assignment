import { ApiProperty } from '@nestjs/swagger';

export class LoginResponseDto {
  @ApiProperty({
    description: 'JWT bearer token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOi4uLn0.signature',
  })
  accessToken!: string;

  @ApiProperty({ example: 3600, description: 'Token lifetime in seconds' })
  expiresIn!: number;
}
