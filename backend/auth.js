// ── GOOGLE OAUTH + JWT AUTH ────────────────────────────────────────────────────
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-prod';
const TOKEN_TTL = '7d'; // session length

const oauth = new OAuth2Client(GOOGLE_CLIENT_ID);

// Verify Google ID token from frontend (Google Identity Services)
async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not configured');
  const ticket = await oauth.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error('Empty Google token payload');
  return {
    google_id: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    email_verified: payload.email_verified,
  };
}

// Sign a JWT for our app
function signSession(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Verify JWT and return user payload (or null)
function verifySession(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Express middleware — sets req.user if Authorization header is present and valid
function authOptional(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const user = verifySession(m[1]);
    if (user) req.user = user;
  }
  next();
}

// Express middleware — rejects if no valid token
function authRequired(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

module.exports = {
  verifyGoogleIdToken,
  signSession,
  verifySession,
  authOptional,
  authRequired,
};