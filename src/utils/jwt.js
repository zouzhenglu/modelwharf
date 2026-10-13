'use strict';
/**
 * JWT claims extraction for account identity display (username/nickname/email).
 * Works for any provider whose token is a JWT (workbuddy, trae, qwen, ...).
 */
function decodeJwtClaims(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(payload, 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return {
      nickname: claims.nickname || claims.name || claims.displayName || claims.username || claims.preferred_username || null,
      email: claims.email || claims.mail || null,
      phone: claims.preferred_username && String(claims.preferred_username).match(/^\d{6,}$/) ? claims.preferred_username : (claims.phone_number || claims.mobile || null),
      sub: claims.sub || claims.user_id || claims.userId || null,
      expiredAt: claims.exp ? claims.exp * 1000 : null,
    };
  } catch { return null; }
}

module.exports = { decodeJwtClaims };
