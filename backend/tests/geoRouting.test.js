// Run with: npm test (jest), from backend/
// Mocks the db layer entirely so this runs without a live Postgres/PostGIS.
jest.mock('../src/db', () => ({ query: jest.fn() }));

const db = require('../src/db');
const { findWard, findNearestWard, resolveWard } = require('../src/services/geoRoutingService');

describe('geoRoutingService', () => {
  afterEach(() => jest.clearAllMocks());

  test('findWard returns the ward polygon containing the point', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 3, name: 'Ward 3 - Dharampeth', department: 'Sanitation', officer_email: 'ward3@civic.gov' }],
    });

    const ward = await findWard(21.1458, 79.0882);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ST_Contains'),
      [79.0882, 21.1458] // lng, lat order — PostGIS expects (lng, lat)
    );
    expect(ward).toEqual({ id: 3, name: 'Ward 3 - Dharampeth', department: 'Sanitation', officer_email: 'ward3@civic.gov' });
  });

  test('findWard returns null when no polygon contains the point', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const ward = await findWard(0, 0);
    expect(ward).toBeNull();
  });

  test('findNearestWard falls back to distance-based lookup within radius', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 7, name: 'Ward 7', department: 'Roads', officer_email: 'ward7@civic.gov', distance_m: 120.4 }],
    });

    const ward = await findNearestWard(21.15, 79.09, 300);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ST_DWithin'),
      [79.09, 21.15, 300]
    );
    expect(ward.distance_m).toBeCloseTo(120.4);
  });

  test('resolveWard prefers exact containment over nearest-fallback', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Ward 1' }] }); // findWard hit
    const result = await resolveWard(21.14, 79.08);
    expect(result.match_type).toBe('contains');
    expect(db.query).toHaveBeenCalledTimes(1); // never fell through to nearest lookup
  });

  test('resolveWard falls back to nearest ward when no polygon contains the point', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });                                   // findWard miss
    db.query.mockResolvedValueOnce({ rows: [{ id: 2, name: 'Ward 2', distance_m: 50 }] }); // nearest hit

    const result = await resolveWard(21.99, 79.99);
    expect(result.match_type).toBe('nearest');
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('resolveWard returns null when neither containment nor nearest match', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await resolveWard(0, 0);
    expect(result).toBeNull();
  });
});
