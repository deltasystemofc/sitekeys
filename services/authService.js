const crypto = require('crypto');

const ADMIN_USER = process.env.ADMIN_USER || 'DELTACHEATS';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Dt192837!';
const SECRET_KEY = process.env.SESSION_SECRET || 'delta_secure_session_key_2026_x89!@#';

/**
 * Cria um token assinado (HMAC-SHA256) com tempo de expiração (7 dias)
 */
function createToken(username) {
  const payload = {
    username,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 dias
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(payloadBase64).digest('base64url');
  return `${payloadBase64}.${signature}`;
}

/**
 * Valida o token e retorna o payload se válido
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadBase64, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', SECRET_KEY).update(payloadBase64).digest('base64url');

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
    if (Date.now() > payload.exp) {
      return null; // Expirado
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Autentica usuário e senha
 */
function login(username, password) {
  if (!username || !password) {
    return { success: false, error: 'Preencha o usuário e a senha.' };
  }

  if (username.trim() === ADMIN_USER && password === ADMIN_PASS) {
    const token = createToken(username.trim());
    return {
      success: true,
      token,
      user: { username: username.trim(), role: 'admin' }
    };
  }

  return { success: false, error: 'Usuário ou senha incorretos.' };
}

/**
 * Middleware Express para proteger rotas da API
 */
function authMiddleware(req, res, next) {
  // Rotas públicas
  const publicPaths = ['/api/auth/login', '/public'];
  if (publicPaths.includes(req.path)) {
    return next();
  }

  // Token via Header Authorization: Bearer <token> ou query ?auth_token=<token> (para SSE)
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query.auth_token) {
    token = req.query.auth_token;
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ success: false, error: 'Acesso não autorizado. Faça login novamente.', code: 'UNAUTHORIZED' });
  }

  req.user = payload;
  next();
}

module.exports = {
  login,
  verifyToken,
  authMiddleware
};
