const crypto = require('crypto');
const { db, ensureDbReady } = require('./util');

/** @typedef {import('./define').AuthPayload} AuthPayload */
/** @typedef {import('./define').CreateUserInput} CreateUserInput */
/** @typedef {import('./define').LoginLocalUserInput} LoginLocalUserInput */
/** @typedef {import('./define').RegisterLocalUserInput} RegisterLocalUserInput */
/** @typedef {import('./define').SerializedUser} SerializedUser */
/** @typedef {import('./define').SessionRecord} SessionRecord */
/** @typedef {import('./define').UserRecord} UserRecord */

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SALT_BYTES = 16;
const sessionStore = new Map();

/**
 * 创建带 HTTP 状态码的错误对象。
 * @param {string} message 错误信息
 * @param {number} statusCode HTTP 状态码
 * @returns {Error} 带 statusCode 属性的错误对象
 */
function createHttpError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

/**
 * 读取环境变量，并在未配置时返回默认值。
 * @param {string} name 环境变量名称
 * @param {string} [fallback=''] 默认值
 * @returns {string} 环境变量值或默认值
 */
function getEnvValue(name, fallback = '') {
    return process.env[name] || fallback;
}

/**
 * 解析当前服务使用的会话有效期配置。
 * @returns {number} 会话过期时间，单位毫秒
 */
function getSessionTtlMs() {
    const configuredValue = Number(
        getEnvValue('AUTH_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS),
    );
    if (Number.isFinite(configuredValue) && configuredValue > 0) {
        return configuredValue;
    }
    return DEFAULT_SESSION_TTL_MS;
}

/**
 * 判断用户记录是否属于本地账号。
 * @param {UserRecord|CreateUserInput|null|undefined} user 待判断的用户对象
 * @returns {boolean} 如果包含 username 字段则视为本地账号
 */
function isLocalAccount(user) {
    return Boolean(user && user.username);
}

/**
 * 将数据库中的用户记录序列化为前端可直接使用的结构。
 * @param {UserRecord} user 数据库用户记录
 * @returns {SerializedUser} 序列化后的用户信息
 */
function serializeUser(user) {
    return {
        id: user.id,
        username: user.username || null,
        accountType: isLocalAccount(user) ? 'local' : 'wechat',
        openid: isLocalAccount(user) ? null : user.openid,
        unionid: user.unionid,
        nickname: user.nickname,
        avatarUrl: user.avatar_url,
        goldCount: Number(user.gold_count) || 0,
        playTime: Number(user.play_time) || 0,
        lastLoginAt: user.last_login_at,
        lastLotteryDate: user.last_lottery_date,
        lastLotteryResult: user.last_lottery_result,
        isVirtual: Boolean(Number(user.is_virtual) || 0),
        createdAt: user.created_at,
        updatedAt: user.updated_at,
    };
}

/**
 * 规范化用户名，去掉首尾空白并统一转成小写。
 * @param {string} username 原始用户名
 * @returns {string} 规范化后的用户名；非字符串时返回空字符串
 */
function normalizeUsername(username) {
    if (typeof username !== 'string') {
        return '';
    }

    return username.trim().toLowerCase();
}

/**
 * 规范化昵称，并在昵称为空时返回兜底值。
 * @param {string} nickname 原始昵称
 * @param {string} [fallback=''] 兜底昵称
 * @returns {string} 规范化后的昵称
 */
function normalizeNickname(nickname, fallback = '') {
    if (typeof nickname !== 'string') {
        return fallback;
    }

    const normalizedValue = nickname.trim();
    return normalizedValue || fallback;
}

/**
 * 校验用户名是否合法。
 * @param {string} username 已规范化的用户名
 * @returns {void} 无返回值
 * @throws {Error} 当用户名为空、长度不合法或包含空白字符时抛出错误
 */
function validateUsername(username) {
    if (!username) {
        throw createHttpError('用户名不能为空', 400);
    }
    if (username.length < 3 || username.length > 32) {
        throw createHttpError('用户名长度必须在 3 到 32 个字符之间', 400);
    }
    if (/\s/.test(username)) {
        throw createHttpError('用户名不能包含空白字符', 400);
    }
}

/**
 * 校验密码是否合法。
 * @param {string} password 原始密码
 * @returns {void} 无返回值
 * @throws {Error} 当密码为空或长度不合法时抛出错误
 */
function validatePassword(password) {
    if (typeof password !== 'string' || !password) {
        throw createHttpError('密码不能为空', 400);
    }
    if (password.length < 6 || password.length > 72) {
        throw createHttpError('密码长度必须在 6 到 72 个字符之间', 400);
    }
}

/**
 * 为本地账号构建稳定的 openid 标识。
 * @param {string} username 已规范化的用户名
 * @returns {string} 本地账号对应的 openid
 */
function buildLocalOpenId(username) {
    return `local:${encodeURIComponent(username)}`;
}

/**
 * 清理内存中已经过期的会话记录。
 * @returns {void} 无返回值
 */
function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionToken, session] of sessionStore.entries()) {
        if (session.expiresAt <= now) {
            sessionStore.delete(sessionToken);
        }
    }
}

/**
 * 生成随机会话令牌。
 * @returns {string} 十六进制格式的会话令牌
 */
function createSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * 为指定用户创建新的内存会话。
 * @param {number} userId 用户 ID
 * @returns {SessionRecord} 新建的会话记录
 */
function createSession(userId) {
    cleanupExpiredSessions();

    const sessionToken = createSessionToken();
    const createdAt = Date.now();
    const expiresAt = createdAt + getSessionTtlMs();
    const session = {
        userId,
        sessionToken,
        createdAt,
        expiresAt,
    };

    sessionStore.set(sessionToken, session);
    return session;
}

/**
 * 按令牌读取当前有效会话。
 * @param {string} sessionToken 会话令牌
 * @returns {SessionRecord|null} 找到且未过期时返回会话，否则返回 null
 */
function getSession(sessionToken) {
    cleanupExpiredSessions();

    const session = sessionStore.get(sessionToken);
    if (!session) {
        return null;
    }
    if (session.expiresAt <= Date.now()) {
        sessionStore.delete(sessionToken);
        return null;
    }

    return session;
}

/**
 * 删除指定会话令牌对应的内存会话。
 * @param {string} sessionToken 会话令牌
 * @returns {void} 无返回值
 */
function deleteSession(sessionToken) {
    sessionStore.delete(sessionToken);
}

/**
 * 从 Authorization 头中提取 Bearer Token。
 * @param {string} [authorizationHeader=''] Authorization 请求头值
 * @returns {string} 提取到的令牌；格式不合法时返回空字符串
 */
function extractBearerToken(authorizationHeader = '') {
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
    return match ? match[1].trim() : '';
}

/**
 * 对用户密码进行加盐哈希。
 * @param {string} password 原始密码
 * @returns {Promise<string>} 由盐值和哈希值组成的存储字符串
 * @throws {Error} 当底层加密过程失败时抛出错误
 */
function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(PASSWORD_SALT_BYTES).toString('hex');
        crypto.scrypt(
            password,
            salt,
            PASSWORD_KEY_LENGTH,
            (error, derivedKey) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(`${salt}:${derivedKey.toString('hex')}`);
            },
        );
    });
}

/**
 * 校验原始密码是否与已存储哈希一致。
 * @param {string} password 原始密码
 * @param {string} [storedHash=''] 已保存的密码哈希
 * @returns {Promise<boolean>} 密码匹配时返回 true，否则返回 false
 * @throws {Error} 当底层加密过程失败时抛出错误
 */
function verifyPassword(password, storedHash = '') {
    const [salt, expectedHash] =
        typeof storedHash === 'string' ? storedHash.split(':') : [];
    if (!salt || !expectedHash) {
        return false;
    }

    return new Promise((resolve, reject) => {
        crypto.scrypt(
            password,
            salt,
            PASSWORD_KEY_LENGTH,
            (error, derivedKey) => {
                if (error) {
                    reject(error);
                    return;
                }

                const expectedBuffer = Buffer.from(expectedHash, 'hex');
                if (expectedBuffer.length !== derivedKey.length) {
                    resolve(false);
                    return;
                }

                resolve(crypto.timingSafeEqual(expectedBuffer, derivedKey));
            },
        );
    });
}

/**
 * 构建认证接口返回给前端的标准会话载荷。
 * @param {UserRecord} user 已完成登录或注册的用户记录
 * @returns {AuthPayload} 返回给前端的认证响应载荷
 */
function buildAuthPayload(user) {
    const session = createSession(user.id);
    return {
        sessionToken: session.sessionToken,
        expiresAt: new Date(session.expiresAt).toISOString(),
        user: serializeUser(user),
    };
}

/**
 * 注册本地账号并返回登录会话信息。
 * @param {RegisterLocalUserInput} params 注册参数
 * @returns {Promise<AuthPayload>} 注册成功后的认证载荷
 * @throws {Error} 当用户名已存在或注册参数不合法时抛出错误
 */
async function registerLocalUser({ username, password, nickname }) {
    await ensureDbReady();

    const normalizedUsername = normalizeUsername(username);
    validateUsername(normalizedUsername);
    validatePassword(password);

    const existingUser = await db.getUserByUsername(normalizedUsername);
    if (existingUser) {
        throw createHttpError('用户名已存在', 409);
    }

    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    const created = await db.createUser({
        openid: buildLocalOpenId(normalizedUsername),
        username: normalizedUsername,
        passwordHash,
        nickname: normalizeNickname(nickname, normalizedUsername),
        lastLoginAt: now,
    });
    const user = await db.getUserById(created.id);

    return buildAuthPayload(user);
}

/**
 * 使用用户名和密码登录本地账号。
 * @param {LoginLocalUserInput} params 登录参数
 * @returns {Promise<AuthPayload>} 登录成功后的认证载荷
 * @throws {Error} 当用户名或密码错误，或参数不合法时抛出错误
 */
async function loginLocalUser({ username, password }) {
    await ensureDbReady();

    const normalizedUsername = normalizeUsername(username);
    validateUsername(normalizedUsername);
    validatePassword(password);

    const user = await db.getUserByUsername(normalizedUsername);
    if (!user || !user.password_hash) {
        throw createHttpError('用户名或密码错误', 401);
    }

    const passwordValid = await verifyPassword(password, user.password_hash);
    if (!passwordValid) {
        throw createHttpError('用户名或密码错误', 401);
    }

    await db.updateUser(user.id, {
        lastLoginAt: new Date().toISOString(),
    });
    const refreshedUser = await db.getUserById(user.id);

    return buildAuthPayload(refreshedUser);
}

/**
 * 校验请求中的 Bearer Token，并把会话与用户信息挂到请求对象上。
 * @param {import('express').Request} req Express 请求对象
 * @param {import('express').Response} res Express 响应对象
 * @param {import('express').NextFunction} next Express 下一步回调
 * @returns {Promise<void>} 中间件处理完成后返回
 */
async function authRequired(req, res, next) {
    try {
        await ensureDbReady();

        const token = extractBearerToken(req.headers.authorization);
        if (!token) {
            throw createHttpError('未提供 token', 401);
        }

        const session = getSession(token);
        if (!session) {
            throw createHttpError('无效 token 或 token 已过期', 401);
        }

        const user = await db.getUserById(session.userId);
        if (!user) {
            deleteSession(token);
            throw createHttpError('登录用户不存在或已失效', 401);
        }

        req.session = session;
        req.user = serializeUser(user);
        req.userRecord = user;
        next();
    } catch (error) {
        if (!error.statusCode) {
            error.statusCode = 401;
        }
        next(error);
    }
}

module.exports = {
    authRequired,
    deleteSession,
    getSession,
    loginLocalUser,
    registerLocalUser,
    serializeUser,
};
