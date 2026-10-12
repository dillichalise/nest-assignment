import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const AUDIT_DEFAULT_PAGE = 1;
export const AUDIT_DEFAULT_LIMIT = 20;
export const AUDIT_MAX_LIMIT = 100;

export class AuditLogsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: AUDIT_DEFAULT_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page: number = AUDIT_DEFAULT_PAGE;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: AUDIT_MAX_LIMIT,
    default: AUDIT_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_MAX_LIMIT)
  limit: number = AUDIT_DEFAULT_LIMIT;
}
