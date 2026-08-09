// Run with: npm test (jest), from backend/
// Exercises imageVerificationController.createVerifiedComplaint end-to-end
// through a minimal Express app, with the ML service, Cloudinary, DB,
// email and notification layers all mocked — no live Postgres or network
// calls required.
const express = require('express');
const request = require('supertest');

jest.mock('axios');
const axios = require('axios');

jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');

jest.mock('../src/middleware/upload', () => {
  const actual = jest.requireActual('../src/middleware/upload');
  return {
    ...actual,
    uploadToCloudinary: jest.fn().mockResolvedValue({
      secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/complaints/test.jpg',
    }),
  };
});

jest.mock('../src/controllers/notificationController', () => ({
  notifyComplaintSubmitted: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/emailService', () => ({
  sendVerifiedComplaintEmail: jest.fn().mockResolvedValue(undefined),
  sendReviewQueueEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/realtime/socket', () => ({
  emitComplaintCreated: jest.fn(),
}));

const { uploadComplaintImage: multerComplaint, handleUploadError, uploadToCloudinary } = require('../src/middleware/upload');
const { createVerifiedComplaint } = require('../src/controllers/imageVerificationController');

function buildApp() {
  const app = express();
  // Auth stub — replaces the real JWT middleware for this isolated test
  app.use((req, _res, next) => { req.user = { id: 'test-user-id', role: 'citizen' }; next(); });
  app.post('/complaints/verified', multerComplaint, handleUploadError, createVerifiedComplaint);
  return app;
}

describe('POST /complaints/verified', () => {
  afterEach(() => jest.clearAllMocks());

  test('SUCCESS: trust_score >= 80 creates and returns an approved complaint', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        status: 'approved',
        issue_type: 'pothole',
        confidence: 0.91,
        trust_score: 86,
        is_duplicate: false,
        is_blurry: false,
        is_screenshot: false,
        rejection_reasons: [],
        top3: [{ label: 'pothole', confidence: 0.91 }],
        breakdown: { ml: 36, gps: 15, exif: 10, blur: 10, duplicate: 15, reputation: 10 },
      },
    });

    // resolveWard -> findWard db call
    db.query.mockResolvedValueOnce({
      rows: [{ id: 3, name: 'Ward 3', department: 'Roads', officer_email: 'ward3@civic.gov' }],
    });
    // department lookup
    db.query.mockResolvedValueOnce({ rows: [{ id: 9 }] });
    // INSERT complaints RETURNING *
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'complaint-uuid-1', title: 'Large pothole', category: 'pothole', latitude: 21.14, longitude: 79.08, image_url: 'https://res.cloudinary.com/demo/image/upload/v1/complaints/test.jpg', ward_id: 3 }],
    });
    // INSERT ml_image_analysis
    db.query.mockResolvedValueOnce({ rows: [] });
    // INSERT status_history
    db.query.mockResolvedValueOnce({ rows: [] });

    const app = buildApp();
    const res = await request(app)
      .post('/complaints/verified')
      .field('title', 'Large pothole')
      .field('description', 'Deep pothole outside 14 MG Road, cars swerving to avoid it')
      .field('latitude', '21.1458')
      .field('longitude', '79.0882')
      .field('accuracy', '12.5')
      .field('captured_at', '2026-07-19T10:00:00Z')
      .attach('image', Buffer.alloc(250 * 1024, 'a'), { filename: 'pothole.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.result).toBe('approved');
    expect(res.body.complaint.id).toBe('complaint-uuid-1');
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/analyze'),
      expect.anything(),
      expect.objectContaining({ headers: expect.anything() })
    );
  });

  test('REJECTION: trust_score < 60 is rejected without touching the database', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        status: 'rejected',
        issue_type: null,
        confidence: 0.2,
        trust_score: 34,
        is_duplicate: false,
        is_blurry: true,
        is_screenshot: true,
        rejection_reasons: [
          'Image is too blurry to verify the issue clearly.',
          'Image looks like a screenshot (missing_exif), not a live photo.',
        ],
        top3: [],
        breakdown: { ml: 8, gps: 0, exif: 0, blur: 0, duplicate: 15, reputation: 10 },
      },
    });

    const app = buildApp();
    const res = await request(app)
      .post('/complaints/verified')
      .field('title', 'Garbage pile')
      .field('description', 'Screenshot of something, not an actual photo')
      .field('latitude', '21.1458')
      .field('longitude', '79.0882')
      .attach('image', Buffer.alloc(250 * 1024, 'b'), { filename: 'screenshot.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('rejected');
    expect(res.body.trust_score).toBe(34);
    expect(res.body.reasons.length).toBeGreaterThan(0);
    expect(db.query).not.toHaveBeenCalled(); // rejected before any complaint/review_queue writes
    expect(uploadToCloudinary).not.toHaveBeenCalled(); // Patch B: rejected images are never uploaded
  });

  test('requires an image file', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/complaints/verified')
      .field('title', 'No photo')
      .field('description', 'Forgot to attach a photo')
      .field('latitude', '21.14')
      .field('longitude', '79.08');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image is required/i);
  });

  test('rejects images under 200KB before any ML call or Cloudinary upload (Patch F)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/complaints/verified')
      .field('title', 'Tiny photo')
      .field('description', 'A photo that is too small to be a genuine camera capture')
      .field('latitude', '21.14')
      .field('longitude', '79.08')
      .attach('image', Buffer.from('too-small'), { filename: 'tiny.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 200KB/i);
    expect(axios.post).not.toHaveBeenCalled(); // never reached the ML call
    expect(db.query).not.toHaveBeenCalled();   // never reached the database
  });
});
