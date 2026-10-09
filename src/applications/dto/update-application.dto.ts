import { PartialType } from '@nestjs/swagger';
import { CreateApplicationDto } from './create-application.dto';

/** Every business field is optional on PATCH; workflow fields remain unreachable. */
export class UpdateApplicationDto extends PartialType(CreateApplicationDto) {}
