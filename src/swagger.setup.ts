import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export const SWAGGER_PATH = 'docs';

const OVERVIEW = `
Merchant onboarding: sales users create and submit merchant applications, an admin assigns a reviewer, a background job runs a (simulated) third-party risk check, and the assigned reviewer records the decision. Every significant action is written to an append-only audit trail.

### Try it in this page
1. **Log in**: open \`POST /auth/login\`, click *Try it out*, send the email and password of a seeded user (\`sales@example.com\`, \`admin@example.com\`, \`reviewer@example.com\`; the password is \`SEED_PASSWORD\` in your \`.env\`).
2. **Authorize**: copy \`accessToken\` from the response, click the **Authorize** button (top right), paste it (without the word *Bearer*) and confirm. The token is remembered across page reloads; log in again as another user to switch role.
3. **Walk the flow**: *Create* an application (as SALES) → *Submit* it → *Assign* a reviewer (as ADMIN; use the reviewer's id from \`GET /auth/me\` when logged in as the reviewer) → wait a second until \`riskStatus\` is \`COMPLETED\` → *Record a decision* (as the assigned REVIEWER).

### Roles
| Role | May |
|---|---|
| **SALES** | create, edit and submit **their own** applications |
| **ADMIN** | everything operational: assign reviewers, retry failed risk reviews, read the audit trail, see unmasked owner data on one application |
| **REVIEWER** | read applications **assigned to them** and record the decision. ADMIN cannot decide |

### Errors
Every error has the same body (\`ErrorResponseDto\`): \`statusCode\`, \`error\`, \`message\`, optional \`details\`, a \`requestId\` (also in the \`x-request-id\` response header and the logs), \`timestamp\` and \`path\`. \`404\` is returned both for things that do not exist and for things you are not allowed to see, on purpose.
`;

/** The OpenAPI document. Also used by the test suite to check the documentation itself. */
export const buildSwaggerDocument = (app: INestApplication): OpenAPIObject =>
  SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Merchant Platform API')
      .setDescription(OVERVIEW.trim())
      .setVersion('1.0')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'The `accessToken` returned by `POST /auth/login`. Paste only the token, without the word "Bearer". Tokens last one hour.',
      })
      .addTag(
        'Auth',
        'Log in and inspect the current user. These are the only routes (besides /health) that work without a token.',
      )
      .addTag(
        'Applications',
        'Create, edit, read and list merchant applications. What you can see depends on your role.',
      )
      .addTag(
        'Application workflow',
        'Move an application through its lifecycle: submit, assign a reviewer, record a decision.',
      )
      .addTag(
        'Risk review',
        'The background risk check that runs after every submission, and how to retry it when it fails.',
      )
      .addTag(
        'Audit trail',
        'The append-only history of what happened to an application (ADMIN only).',
      )
      .addTag('Health', 'Liveness check for monitoring.')
      .build(),
  );

export const setupSwagger = (app: INestApplication): void => {
  SwaggerModule.setup(SWAGGER_PATH, app, buildSwaggerDocument(app), {
    customSiteTitle: 'Merchant Platform API',
    swaggerOptions: {
      // Keep the pasted token across page reloads.
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'list',
    },
  });
};
