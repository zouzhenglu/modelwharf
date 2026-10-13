'use strict';
/**
 * Qoder COSY signing — Node port of the clean-room algorithm from
 * fengyinxia/qoder2api (qoder_auth.py), cross-verified with shuishuipingan/qoder2api-hub.
 *
 * Two planes:
 *  - Bearer data plane (chat, model list): Authorization: Bearer COSY.<payloadB64>.<md5sig>
 *      payload  = stdBase64(compactJsonSorted({cosyVersion, ideVersion, info, requestId, version}))
 *      info     = stdBase64(AES-128-CBC(identityJson, key=tempKey, iv=tempKey))   // IV == key
 *      cosy_key = stdBase64(RSA-PKCS1v15-1024(SERVER_PUB, tempKey))
 *      sig      = md5hex(payload \n cosyKey \n date \n body \n pathWithoutAlgo)   // \n separators
 *  - Signature plane (PAT→jobToken, user/status, heartbeat):
 *      signature header = md5hex("cosy" & "&" & SECRET & "&" & RFC1123 date); bodies custom-b64 but unsigned.
 *
 * Body transport: custom-base64 (private alphabet + 3-segment rotation, '$' pad).
 */
const crypto = require('crypto');

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const S2C = new Map([...STD_ALPHABET].map((c, i) => [c, CUSTOM_ALPHABET[i]]));
S2C.set('=', '$');
const C2S = new Map([...S2C.entries()].map(([s, c]) => [c, s]));

const SERVER_PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const SIGNATURE_SECRET = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=='; // "war, war never changes"
const COSY_VERSION = '1.1.64';

/** custom base64 encode: std b64 -> tail/middle/head rotation -> char substitution */
function qoderEncode(plaintext) {
  const std = Buffer.from(plaintext).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return [...rearranged].map(ch => S2C.get(ch) ?? ch).join('');
}

/** custom base64 decode (inverse) */
function qoderDecode(s) {
  const mapped = [...s].map(ch => C2S.get(ch) ?? ch).join('');
  const n = mapped.length;
  const a = Math.floor(n / 3);
  const std = mapped.slice(n - a) + mapped.slice(a, n - a) + mapped.slice(0, a);
  return Buffer.from(std, 'base64');
}

const md5hex = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/** stable machine identity per uid (hub scheme; server does not verify) */
function machineIdentity(uid) {
  const derive = (salt) => md5hex(`${salt}:${uid || 'anonymous'}`);
  return {
    machineId: derive('machineid').slice(0, 32),
    machineType: derive('machinetype').replace(/-/g, '').slice(0, 18),
    machineToken: Buffer.from(crypto.createHash('sha512').update(`machinetoken:${uid || 'anonymous'}`).digest())
      .toString('base64url').slice(0, 43),
  };
}

/**
 * Build a COSY session from identity fields + tokens.
 * identity: {name?, aid?, uid, yx_uid?, organization_id?, organization_name?, user_type?, securityOauthToken, refreshToken?}
 */
function createSession(identity) {
  const tempKey = crypto.randomBytes(16).toString('hex').slice(0, 16); // 16 ascii hex chars
  const rsaPub = crypto.createPublicKey(SERVER_PUB_PEM);
  const wrappedKey = crypto.publicEncrypt({ key: rsaPub, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(tempKey, 'ascii'));
  const cosyKey = wrappedKey.toString('base64');

  const payloadJson = JSON.stringify({
    name: identity.name || '',
    aid: identity.aid || '',
    uid: identity.uid || '',
    yx_uid: identity.yx_uid || '',
    organization_id: identity.organization_id || '',
    organization_name: identity.organization_name || '',
    user_type: identity.user_type || '',
    security_oauth_token: identity.securityOauthToken || '',
    refresh_token: identity.refreshToken || '',
  }); // compact separators, insertion order
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(tempKey, 'ascii'), Buffer.from(tempKey, 'ascii'));
  const info = Buffer.concat([cipher.update(payloadJson, 'utf8'), cipher.final()]).toString('base64');

  const machine = machineIdentity(identity.uid);
  return { tempKey, cosyKey, info, machine, uid: identity.uid || '' };
}

/** per-request Bearer headers for the data plane */
function bearerRequest(session, { method = 'POST', path, bodyObj, accept = 'application/json', modelKey } = {}) {
  const date = String(Math.floor(Date.now() / 1000));
  const body = bodyObj == null ? '' : qoderEncode(JSON.stringify(bodyObj));
  const payload = Buffer.from(JSON.stringify({
    cosyVersion: COSY_VERSION,
    ideVersion: '',
    info: session.info,
    requestId: crypto.randomUUID(),
    version: 'v1',
  })).toString('base64');
  // path without /algo prefix, no query
  const sig = md5hex([payload, session.cosyKey, date, body, path.replace(/^\/algo/, '')].join('\n'));
  const headers = {
    'accept': accept,
    'accept-encoding': 'identity',
    'authorization': `Bearer COSY.${payload}.${sig}`,
    'content-type': 'application/json',
    'cosy-clienttype': '5',
    'cosy-data-policy': 'AGREE',
    'cosy-date': date,
    'cosy-key': session.cosyKey,
    'cosy-machineid': session.machine.machineId,
    'cosy-machinetoken': session.machine.machineToken,
    'cosy-machinetype': session.machine.machineType,
    'cosy-user': session.uid,
    'cosy-version': COSY_VERSION,
    'login-version': 'v2',
    'user-agent': 'Go-http-client/2.0',
    ...(accept.includes('event-stream') ? { 'cache-control': 'no-cache' } : {}),
    ...(modelKey ? { 'x-model-key': modelKey, 'x-model-source': 'system' } : {}),
  };
  return { headers, body }; // send `body` string as-is (it is what was signed)
}

/** signature-plane headers (PAT/jobToken exchange, user/status, heartbeat) */
function signatureHeaders() {
  const date = new Date().toUTCString(); // RFC1123 GMT
  return {
    'accept': 'application/json',
    'accept-encoding': 'identity',
    'appcode': 'cosy',
    'content-type': 'application/json',
    'cosy-clienttype': '5',
    'cosy-version': COSY_VERSION,
    'date': date,
    'login-version': 'v2',
    'signature': md5hex(['cosy', SIGNATURE_SECRET, date].join('&')),
    'user-agent': 'Go-http-client/2.0',
  };
}

module.exports = { qoderEncode, qoderDecode, createSession, bearerRequest, signatureHeaders, COSY_VERSION };
