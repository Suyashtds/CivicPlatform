// ============================================================
// Geo / GIS Controller
// ------------------------------------------------------------
// Data endpoints for the "Interactive GIS Dashboard" feature.
// NOTE: this project has no frontend yet — these endpoints return
// map-ready GeoJSON/JSON so a Leaflet/Mapbox client can be built
// against them directly (marker clustering + heatmaps are cheap to
// do client-side once points are on the map; ward BOUNDARY polygons
// are NOT included because no shapefile/boundary source exists in
// this project — see docs/ARCHITECTURE.md "Deferred").
// ============================================================
const db = require('../db');
const { forwardGeocode } = require('../services/geocodingService');

// ── GET /geo/complaints ───────────────────────────────────────
// Returns complaints as GeoJSON FeatureCollection, filterable —
// what marker clustering / layer toggles on a map would consume.
const getComplaintsGeoJSON = async (req, res) => {
  const { category, status, priority_min, ward_id, city_id, bbox } = req.query;
  const conditions = ['latitude IS NOT NULL', 'longitude IS NOT NULL'];
  const values = [];
  let idx = 1;

  if (category)     { conditions.push(`category = $${idx++}`);        values.push(category); }
  if (status)       { conditions.push(`status = $${idx++}`);          values.push(status); }
  if (ward_id)       { conditions.push(`ward_id = $${idx++}`);         values.push(ward_id); }
  if (city_id)       { conditions.push(`city_id = $${idx++}`);         values.push(city_id); }
  if (priority_min)   { conditions.push(`priority_score >= $${idx++}`); values.push(priority_min); }
  if (bbox) {
    // bbox = "minLng,minLat,maxLng,maxLat" — for viewport-based loading
    const [minLng, minLat, maxLng, maxLat] = bbox.split(',').map(Number);
    conditions.push(`longitude BETWEEN $${idx++} AND $${idx++}`);
    values.push(minLng, maxLng);
    conditions.push(`latitude BETWEEN $${idx++} AND $${idx++}`);
    values.push(minLat, maxLat);
  }

  try {
    const { rows } = await db.query(
      `SELECT id, title, category, status, priority_score, upvote_count,
              latitude, longitude, ward, ward_id, image_url, created_at
         FROM complaints
        WHERE ${conditions.join(' AND ')}
        ORDER BY priority_score DESC
        LIMIT 5000`,
      values
    );

    const geojson = {
      type: 'FeatureCollection',
      features: rows.map((c) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.longitude, c.latitude] },
        properties: {
          id: c.id, title: c.title, category: c.category, status: c.status,
          priority_score: c.priority_score, upvote_count: c.upvote_count,
          ward: c.ward, image_url: c.image_url, created_at: c.created_at,
        },
      })),
    };
    res.json(geojson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /geo/heatmap ──────────────────────────────────────────
// Lightweight [lat, lng, weight] triples — the exact shape
// Leaflet.heat / most heatmap libraries expect.
const getHeatmapPoints = async (req, res) => {
  const { category, status, ward_id } = req.query;
  const conditions = ['latitude IS NOT NULL', 'longitude IS NOT NULL'];
  const values = [];
  let idx = 1;
  if (category) { conditions.push(`category = $${idx++}`); values.push(category); }
  if (status)   { conditions.push(`status = $${idx++}`);   values.push(status); }
  if (ward_id)  { conditions.push(`ward_id = $${idx++}`);  values.push(ward_id); }

  try {
    const { rows } = await db.query(
      `SELECT latitude, longitude, GREATEST(priority_score, 1) AS weight
         FROM complaints WHERE ${conditions.join(' AND ')} LIMIT 5000`,
      values
    );
    res.json({ points: rows.map(r => [r.latitude, r.longitude, r.weight]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /geo/ward-stats ────────────────────────────────────────
// Per-ward aggregate used to colour ward regions on the map (a
// choropleth) even without boundary polygons — front-end can pair
// this with any ward-boundary GeoJSON it has, keyed by ward_id.
const getWardStats = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ward_id, ward, COUNT(*) AS total,
              SUM(CASE WHEN status NOT IN ('resolved','closed','rejected') THEN 1 ELSE 0 END) AS pending,
              ROUND(AVG(priority_score)::numeric,1) AS avg_priority,
              ROUND(AVG(latitude)::numeric,6) AS centroid_lat,
              ROUND(AVG(longitude)::numeric,6) AS centroid_lng
         FROM complaints
        WHERE ward_id IS NOT NULL
        GROUP BY ward_id, ward
        ORDER BY total DESC`
    );
    res.json({ wards: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── GET /geo/search-address ───────────────────────────────────
const searchAddress = async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 3) return res.status(400).json({ error: 'q must be at least 3 characters' });
  const results = await forwardGeocode(q.trim());
  res.json({ results });
};

module.exports = { getComplaintsGeoJSON, getHeatmapPoints, getWardStats, searchAddress };
