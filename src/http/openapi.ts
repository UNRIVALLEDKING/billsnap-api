export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "BillDrop API",
    version: "1.0.0",
    description:
      "Multi-tenant API for bill processing, inventory tracking, catalog merging, and accounting exports.",
  },
  servers: [{ url: "http://localhost:3000", description: "Local development" }],
  paths: {
    "/v1/auth/demo-login": {
      post: {
        summary: "Demo Login",
        description: "Signs in using demo credentials outside production.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Session created with access and refresh tokens." },
          "401": { description: "Invalid credentials." },
          "422": { description: "Validation failed." },
        },
      },
    },
    "/v1/auth/refresh": {
      post: {
        summary: "Refresh Tokens",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["refresh_token"],
                properties: {
                  refresh_token: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "New token pair." },
          "401": { description: "Unauthenticated or expired refresh token." },
        },
      },
    },
    "/v1/me": {
      get: {
        summary: "Get Current User and Memberships",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "User profile, active businesses and roles." },
          "401": { description: "Unauthenticated." },
        },
      },
    },
    "/v1/businesses": {
      get: {
        summary: "List User Businesses",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "List of businesses user belongs to." },
        },
      },
      post: {
        summary: "Create Business",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  gstin: { type: "string" },
                  state_code: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Business created with user as owner." },
        },
      },
    },
    "/v1/bills": {
      get: {
        summary: "List Bills",
        security: [{ bearerAuth: [], businessHeader: [] }],
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "type", in: "query", schema: { type: "string", enum: ["purchase", "sale"] } },
          { name: "status", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Paginated list of bills." },
        },
      },
      post: {
        summary: "Drop / Ingest Bill File",
        security: [{ bearerAuth: [], businessHeader: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file", "meta"],
                properties: {
                  file: { type: "string", format: "binary" },
                  meta: {
                    type: "string",
                    description: "JSON string containing type, client_ref, source, dropped_at",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Bill ingested and queued for extraction." },
        },
      },
    },
    "/v1/bills/{id}": {
      get: {
        summary: "Get Bill Details",
        security: [{ bearerAuth: [], businessHeader: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Bill view with lines and totals." },
          "404": { description: "Bill not found." },
        },
      },
    },
    "/v1/bills/{id}/confirm": {
      post: {
        summary: "Confirm and Save Bill",
        description:
          "Confirms bill extraction edits, verifies totals, triggers stock increments, and locks bill.",
        security: [{ bearerAuth: [], businessHeader: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Bill confirmed successfully." },
          "409": { description: "Conflict / invalid state." },
        },
      },
    },
    "/v1/inventory": {
      get: {
        summary: "List Master Products",
        security: [{ bearerAuth: [], businessHeader: [] }],
        parameters: [
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "category", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "List of master products with unified stock weights." },
        },
      },
    },
    "/v1/inventory/master-products": {
      post: {
        summary: "Create Master Product",
        security: [{ bearerAuth: [], businessHeader: [] }],
        responses: {
          "201": { description: "Master product created." },
        },
      },
    },
    "/v1/inventory/master-products/{id}/adjust": {
      post: {
        summary: "Adjust Stock Weight Manually",
        security: [{ bearerAuth: [], businessHeader: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Stock adjusted and audit transaction recorded." },
        },
      },
    },
    "/v1/products/{id}/mapping": {
      put: {
        summary: "Map Vendor Product to Master Inventory Product",
        security: [{ bearerAuth: [], businessHeader: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Product mapping updated." },
        },
      },
    },
    "/v1/exports": {
      post: {
        summary: "Trigger Accounting Export",
        description: "Creates multi-sheet Excel or CSV zip export of bills and lines.",
        security: [{ bearerAuth: [], businessHeader: [] }],
        responses: {
          "201": { description: "Export queued." },
        },
      },
      get: {
        summary: "List Exports",
        security: [{ bearerAuth: [], businessHeader: [] }],
        responses: {
          "200": { description: "List of recent exports." },
        },
      },
    },
    "/v1/exports/{id}/download": {
      get: {
        summary: "Download Export File",
        security: [{ bearerAuth: [], businessHeader: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Streamed export file." },
          "302": { description: "Redirect to presigned R2 storage URL." },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
      businessHeader: {
        type: "apiKey",
        in: "header",
        name: "X-Business-Id",
      },
    },
  },
};
