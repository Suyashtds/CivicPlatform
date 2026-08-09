// ============================================================
// Swagger / OpenAPI setup
// ------------------------------------------------------------
// Additive: mounted at /api-docs in src/index.js. Documents the
// image-verification pipeline endpoints; existing routes keep
// working exactly as before regardless of whether this is wired in.
// ============================================================
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Civic Platform API',
    version: '1.0.0',
    description: 'Civic issue reporting & governance platform, including the image verification + geo-routing pipeline.',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/complaints': {
      post: {
        summary: 'Create a complaint (text-based flow, existing)',
        tags: ['Complaints'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'description', 'latitude', 'longitude'],
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  latitude: { type: 'number' },
                  longitude: { type: 'number' },
                  image_url: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Complaint created' }, 200: { description: 'Duplicate detected' } },
      },
    },
    '/complaints/verified': {
      post: {
        summary: 'Create a complaint via the image verification + trust score pipeline',
        tags: ['Image Verification'],
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['image', 'title', 'description', 'latitude', 'longitude'],
                properties: {
                  image: { type: 'string', format: 'binary' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  latitude: { type: 'number' },
                  longitude: { type: 'number' },
                  accuracy: { type: 'number' },
                  captured_at: { type: 'string', format: 'date-time' },
                  timezone: { type: 'string' },
                  userAgent: { type: 'string' },
                  heading: { type: 'number' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Approved and created (trust_score >= 80)' },
          202: { description: 'Sent to manual review queue (trust_score 60-79)' },
          200: { description: 'Rejected (trust_score < 60)' },
          502: { description: 'ML service unavailable' },
        },
      },
    },
    '/ml/analyze (ML service, not this API)': {
      post: {
        summary: 'ML service POST /analyze — documented for reference; served by ml-service on its own port',
        tags: ['Image Verification'],
        responses: { 200: { description: 'Trust-score verdict for an uploaded image' } },
      },
    },
    '/admin/review-queue': {
      get: {
        summary: 'List manual review queue items',
        tags: ['Image Verification'],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] } },
        ],
        responses: { 200: { description: 'Paginated review queue items' } },
      },
    },
    '/admin/review-queue/{id}/approve': {
      post: {
        summary: 'Approve a review-queue item, creating the resulting complaint',
        tags: ['Image Verification'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Approved and complaint created' } },
      },
    },
  },
};

const swaggerSpec = swaggerJsdoc({ definition: swaggerDefinition, apis: [] });

function setupSwagger(app) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

module.exports = { setupSwagger, swaggerSpec };
