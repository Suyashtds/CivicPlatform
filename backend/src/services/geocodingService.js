const axios = require('axios');

// ── Reverse Geocoding using OpenStreetMap Nominatim (free) ───
// Converts lat/lng into a human-readable address
const reverseGeocode = async (latitude, longitude) => {
  try {
    const { data } = await axios.get(
      'https://nominatim.openstreetmap.org/reverse',
      {
        params: {
          lat:            latitude,
          lon:            longitude,
          format:         'json',
          addressdetails: 1,
        },
        headers: {
          // Nominatim requires a User-Agent header
          'User-Agent': 'CivicIssuePlatform/1.0 (civicissuereportingplatform@gmail.com)',
        },
        timeout: 5000, // 5 second timeout so it doesn't slow down complaint submission
      }
    );

    if (!data || !data.address) return null;

    const addr = data.address;

    return {
      // Full formatted address
      address: data.display_name,

      // City — try multiple fields since Nominatim varies by region
      city: addr.city || addr.town || addr.village || addr.county || null,

      // Ward/neighbourhood — useful for ward-level filtering
      ward: addr.suburb || addr.neighbourhood || addr.quarter || null,

      // State and country for future multi-city expansion
      state:   addr.state || null,
      country: addr.country || null,

      // Postcode
      postcode: addr.postcode || null,
    };
  } catch (err) {
    // Don't fail complaint submission if geocoding fails
    console.warn('Reverse geocoding failed:', err.message);
    return null;
  }
};

// ── Forward Geocoding — address text -> lat/lng ──────────────
// Powers the GIS dashboard's "search by address" feature.
const forwardGeocode = async (query) => {
  try {
    const { data } = await axios.get(
      'https://nominatim.openstreetmap.org/search',
      {
        params: { q: query, format: 'json', addressdetails: 1, limit: 5 },
        headers: { 'User-Agent': 'CivicIssuePlatform/1.0 (civicissuereportingplatform@gmail.com)' },
        timeout: 5000,
      }
    );
    if (!data || !data.length) return [];

    return data.map((d) => ({
      address: d.display_name,
      latitude: parseFloat(d.lat),
      longitude: parseFloat(d.lon),
      city: d.address?.city || d.address?.town || d.address?.village || null,
      ward: d.address?.suburb || d.address?.neighbourhood || null,
    }));
  } catch (err) {
    console.warn('Forward geocoding failed:', err.message);
    return [];
  }
};

module.exports = { reverseGeocode, forwardGeocode };
