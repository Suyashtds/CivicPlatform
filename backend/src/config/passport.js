const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const axios = require('axios');
const db = require('../db');
const { uploadToCloudinary } = require('../middleware/upload');

// ── Helper: download Google photo and upload to our Cloudinary ──
const saveGooglePhotoToCloudinary = async (googlePhotoUrl) => {
  try {
    // Google photo URLs sometimes have size params like =s96-c; request a larger version
    const highResUrl = googlePhotoUrl.replace(/=s\d+-c$/, '=s400-c');

    // Download the image as a buffer
    const response = await axios.get(highResUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');

    // Upload to our own Cloudinary avatars folder with same transformation as manual uploads
    const result = await uploadToCloudinary(buffer, 'avatars', {
      transformation: [
        { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        { quality: 'auto:good' },
      ],
    });

    return result.secure_url;
  } catch (err) {
    console.error('Failed to save Google photo to Cloudinary:', err.message);
    // Fallback: use the original Google URL if download/upload fails
    return googlePhotoUrl;
  }
};

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL;

if (googleClientId && googleClientSecret) {
  passport.use(new GoogleStrategy({
      clientID: googleClientId,
      clientSecret: googleClientSecret,
      callbackURL: googleCallbackUrl,
    },
    async (accessToken, refreshToken, profile, done) => {
    try {
      const email           = profile.emails?.[0]?.value;
      const name            = profile.displayName;
      const google_photo_url = profile.photos?.[0]?.value;
      const google_id       = profile.id;

      if (!email) {
        return done(new Error('No email found in Google profile'), null);
      }

      // Check if user already exists by google_id or email
      const existing = await db.query(
        'SELECT * FROM users WHERE google_id = $1 OR email = $2',
        [google_id, email]
      );

      let user;

      if (existing.rows.length) {
        const existingUser = existing.rows[0];

        // Only download+upload photo if user doesn't already have an avatar
        let avatar_url = existingUser.avatar_url;
        if (!avatar_url && google_photo_url) {
          avatar_url = await saveGooglePhotoToCloudinary(google_photo_url);
        }

        const result = await db.query(
          `UPDATE users
              SET google_id = $1,
                  avatar_url = $2,
                  is_verified = TRUE,
                  updated_at = NOW()
            WHERE id = $3
          RETURNING *`,
          [google_id, avatar_url, existingUser.id]
        );
        user = result.rows[0];
      } else {
        // New user — download Google photo and save to our Cloudinary first
        let avatar_url = null;
        if (google_photo_url) {
          avatar_url = await saveGooglePhotoToCloudinary(google_photo_url);
        }

        const result = await db.query(
          `INSERT INTO users (name, email, google_id, avatar_url, role, is_verified)
           VALUES ($1, $2, $3, $4, 'citizen', TRUE)
           RETURNING *`,
          [name, email, google_id, avatar_url]
        );
        user = result.rows[0];
      }

      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
    }
  ));
} else {
  console.warn('Google OAuth credentials not configured; skipping Google strategy registration.');
}

// Not using sessions — we issue JWT instead, but passport requires these
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, rows[0]);
  } catch (err) {
    done(err, null);
  }
});

module.exports = passport;
