import { Logger } from '@nestjs/common';

// Keep unit-test output readable: services and workers log through Nest's
// Logger, which writes straight to stdout. Specs that assert on logging spy on
// Logger.prototype, which this does not affect.
Logger.overrideLogger(false);
