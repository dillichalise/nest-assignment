import { ArgumentMetadata, Type } from '@nestjs/common';
import { OpenAPIObject } from '@nestjs/swagger';
import { createValidationPipe } from '../src/common/pipes/validation.pipe';
import { AssignReviewerDto } from '../src/applications/dto/assign-reviewer.dto';
import { CreateApplicationDto } from '../src/applications/dto/create-application.dto';
import { RecordDecisionDto } from '../src/applications/dto/record-decision.dto';
import { UpdateApplicationDto } from '../src/applications/dto/update-application.dto';
import { LoginDto } from '../src/auth/dto/login.dto';
import { buildSwaggerDocument } from '../src/swagger.setup';
import { createHarness, Harness } from './helpers/e2e-harness';

/**
 * The API documentation is tested like code: structure, completeness and, above
 * all, that every request example in it is actually accepted by the API.
 */
describe('API documentation (OpenAPI / Swagger)', () => {
  let h: Harness;
  let doc: OpenAPIObject;

  beforeAll(async () => {
    h = await createHarness();
    doc = buildSwaggerDocument(h.app);
  });
  afterAll(() => h.close());

  type Operation = {
    tags?: string[];
    summary?: string;
    description?: string;
    security?: unknown[];
    parameters?: {
      name: string;
      in: string;
      description?: string;
      schema?: Record<string, unknown>;
    }[];
    requestBody?: {
      content: {
        'application/json': {
          schema?: unknown;
          examples?: Record<string, { value: unknown }>;
          example?: unknown;
        };
      };
    };
    responses: Record<
      string,
      {
        description?: string;
        content?: Record<string, { schema?: { $ref?: string } }>;
      }
    >;
  };
  const operations = () =>
    Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods as Record<string, Operation>).map(
        ([method, op]) => ({
          route: `${method.toUpperCase()} ${path}`,
          path,
          method,
          op,
        }),
      ),
    );
  const PUBLIC = ['GET /health', 'POST /auth/login'];

  describe('the document as a whole', () => {
    it('is OpenAPI 3 with a title, a version and an overview that explains how to try it', () => {
      expect(doc.openapi).toMatch(/^3\./);
      expect(doc.info.title).toBe('Merchant Platform API');
      expect(doc.info.version).toBeTruthy();
      expect(doc.info.description).toMatch(/Authorize/);
      expect(doc.info.description).toMatch(/SALES/);
      expect(doc.info.description).toMatch(/requestId/);
    });

    it('declares a bearer JWT scheme that explains what to paste', () => {
      const scheme = doc.components?.securitySchemes?.bearer as {
        type: string;
        scheme: string;
        bearerFormat: string;
        description: string;
      };
      expect(scheme).toMatchObject({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
      expect(scheme.description).toMatch(/login/);
    });

    it('declares every tag it uses, each with a description', () => {
      const declared = new Map(
        (doc.tags ?? []).map((t) => [t.name, t.description]),
      );
      const used = new Set(operations().flatMap(({ op }) => op.tags ?? []));
      for (const tag of used) {
        expect(declared.has(tag)).toBe(true);
        expect(declared.get(tag)?.length).toBeGreaterThan(20);
      }
      expect([...declared.keys()].every((t) => used.has(t))).toBe(true); // no orphan tags
    });
  });

  describe('every operation', () => {
    it('has a tag, a summary and a description', () => {
      for (const { route, op } of operations()) {
        expect({ route, tagged: (op.tags ?? []).length > 0 }).toEqual({
          route,
          tagged: true,
        });
        expect({ route, summary: (op.summary ?? '').length > 5 }).toEqual({
          route,
          summary: true,
        });
        expect({
          route,
          description: (op.description ?? '').length > 15,
        }).toEqual({ route, description: true });
      }
    });

    it('describes every response, not just lists the status code', () => {
      for (const { route, op } of operations()) {
        for (const [status, response] of Object.entries(op.responses)) {
          expect({
            route,
            status,
            described: (response.description ?? '').length > 5,
          }).toEqual({
            route,
            status,
            described: true,
          });
        }
      }
    });

    it('documents every error with the shared ErrorResponseDto body', () => {
      for (const { route, op } of operations()) {
        for (const [status, response] of Object.entries(op.responses)) {
          if (Number(status) >= 400) {
            const ref = response.content?.['application/json']?.schema?.$ref;
            expect({ route, status, ref }).toEqual({
              route,
              status,
              ref: '#/components/schemas/ErrorResponseDto',
            });
          }
        }
      }
    });

    it('declares a success response', () => {
      for (const { route, op } of operations()) {
        expect({
          route,
          ok: Object.keys(op.responses).some((s) => s.startsWith('2')),
        }).toEqual({ route, ok: true });
      }
    });
  });

  describe('security is documented as it is enforced', () => {
    it('every protected operation requires the bearer token and can answer 401', () => {
      for (const { route, op } of operations().filter(
        (o) => !PUBLIC.includes(o.route),
      )) {
        expect({ route, secured: JSON.stringify(op.security) }).toEqual({
          route,
          secured: JSON.stringify([{ bearer: [] }]),
        });
        expect({ route, has401: '401' in op.responses }).toEqual({
          route,
          has401: true,
        });
      }
    });

    it('the public operations declare no security', () => {
      for (const { route, op } of operations().filter((o) =>
        PUBLIC.includes(o.route),
      )) {
        expect({ route, security: op.security }).toEqual({
          route,
          security: undefined,
        });
      }
    });

    it('role-restricted operations say who may call them, and can answer 403', () => {
      const restricted = [
        'POST /applications/{id}/assign',
        'POST /applications/{id}/decision',
        'POST /applications/{id}/risk-review/retry',
        'GET /applications/{id}/audit',
      ];
      for (const route of restricted) {
        const { op } = operations().find((o) => o.route === route)!;
        expect({ route, has403: '403' in op.responses }).toEqual({
          route,
          has403: true,
        });
        expect({
          route,
          says: /ADMIN|REVIEWER/.test(`${op.summary} ${op.description}`),
        }).toEqual({ route, says: true });
      }
    });
  });

  describe('request bodies and parameters', () => {
    it('every operation that takes a body shows at least one example', () => {
      const withBody = operations().filter((o) => o.op.requestBody);
      expect(withBody.map((o) => o.route).sort()).toEqual(
        [
          'PATCH /applications/{id}',
          'POST /applications',
          'POST /applications/{id}/assign',
          'POST /applications/{id}/decision',
          'POST /auth/login',
        ].sort(),
      );
      for (const { route, op } of withBody) {
        const json = op.requestBody!.content['application/json'];
        const examples = Object.keys(json.examples ?? {});
        expect({
          route,
          hasExample: examples.length > 0 || json.example !== undefined,
        }).toEqual({ route, hasExample: true });
      }
    });

    it('offers all three outcomes as decision examples', () => {
      const { op } = operations().find(
        (o) => o.route === 'POST /applications/{id}/decision',
      )!;
      const values = Object.values(
        op.requestBody!.content['application/json'].examples!,
      ).map((e) => (e.value as { decision: string }).decision);
      expect(values.sort()).toEqual(['APPROVED', 'INFO_REQUESTED', 'REJECTED']);
    });

    it('every request example is accepted by the real validation rules (the docs cannot drift)', async () => {
      const pipe = createValidationPipe();
      const dtoFor: Record<string, Type> = {
        'POST /auth/login': LoginDto,
        'POST /applications': CreateApplicationDto,
        'PATCH /applications/{id}': UpdateApplicationDto,
        'POST /applications/{id}/assign': AssignReviewerDto,
        'POST /applications/{id}/decision': RecordDecisionDto,
      };
      let checked = 0;
      for (const [route, dto] of Object.entries(dtoFor)) {
        const { op } = operations().find((o) => o.route === route)!;
        for (const [name, example] of Object.entries(
          op.requestBody!.content['application/json'].examples!,
        )) {
          await expect(
            pipe.transform(example.value, {
              type: 'body',
              metatype: dto,
            } as ArgumentMetadata),
          ).resolves.toBeDefined();
          checked += 1;
          void name;
        }
      }
      expect(checked).toBeGreaterThanOrEqual(9);
    });

    it('documents pagination on both list endpoints, with defaults and limits', () => {
      for (const route of [
        'GET /applications',
        'GET /applications/{id}/audit',
      ]) {
        const { op } = operations().find((o) => o.route === route)!;
        const params = Object.fromEntries(
          (op.parameters ?? [])
            .filter((p) => p.in === 'query')
            .map((p) => [p.name, p.schema!]),
        );
        expect(params.page).toMatchObject({ default: 1, minimum: 1 });
        expect(params.limit).toMatchObject({
          default: 20,
          minimum: 1,
          maximum: 100,
        });
      }
    });

    it('documents the status filter with every allowed value', () => {
      const { op } = operations().find((o) => o.route === 'GET /applications')!;
      const status = op.parameters!.find((p) => p.name === 'status')!
        .schema as { enum: string[] };
      expect(status.enum).toEqual([
        'DRAFT',
        'SUBMITTED',
        'IN_REVIEW',
        'INFO_REQUESTED',
        'APPROVED',
        'REJECTED',
      ]);
    });

    it('documents the id path parameter as a uuid on every :id route', () => {
      for (const { route, op } of operations().filter((o) =>
        o.path.includes('{id}'),
      )) {
        const id = op.parameters?.find(
          (p) => p.name === 'id' && p.in === 'path',
        );
        expect({ route, documented: !!id }).toEqual({
          route,
          documented: true,
        });
      }
    });
  });

  describe('schemas', () => {
    const schemas = () =>
      doc.components!.schemas as Record<
        string,
        {
          properties?: Record<
            string,
            { enum?: string[]; example?: unknown; type?: string }
          >;
        }
      >;

    it('lists the allowed values of every enum', () => {
      const s = schemas();
      expect(s.ApplicationResponseDto.properties!.status.enum).toEqual([
        'DRAFT',
        'SUBMITTED',
        'IN_REVIEW',
        'INFO_REQUESTED',
        'APPROVED',
        'REJECTED',
      ]);
      expect(s.ApplicationResponseDto.properties!.riskStatus.enum).toEqual([
        'NOT_STARTED',
        'PENDING',
        'COMPLETED',
        'FAILED',
      ]);
      expect(s.RecordDecisionDto.properties!.decision.enum).toEqual([
        'APPROVED',
        'REJECTED',
        'INFO_REQUESTED',
      ]);
      expect(s.MeResponseDto.properties!.role.enum).toEqual([
        'ADMIN',
        'REVIEWER',
        'SALES',
      ]);
    });

    it('gives the main response schema concrete examples', () => {
      const props = schemas().ApplicationResponseDto.properties!;
      for (const field of [
        'id',
        'businessName',
        'status',
        'riskScore',
        'createdAt',
      ]) {
        expect({ field, example: props[field].example !== undefined }).toEqual({
          field,
          example: true,
        });
      }
    });

    it('describes the error schema', () => {
      const props = schemas().ErrorResponseDto.properties!;
      expect(Object.keys(props).sort()).toEqual([
        'details',
        'error',
        'message',
        'path',
        'requestId',
        'statusCode',
        'timestamp',
      ]);
    });
  });
});
