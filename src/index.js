const https = require('https');
const path = require('path');
const express = require('express');
const log4js = require('log4js');
const {
    drawLottery,
    findPlayers,
    getAllPlayersCount,
    getCurrentTime,
    getAnnouncementLog,
    getHelpArticles,
    getPlayersRange,
    createVirtualPlayers,
    clearVirtualPlayers,
} = require('./util');
const {
    authRequired,
    deleteSession,
    loginLocalUser,
    registerLocalUser,
} = require('./auth');

/** @typedef {import('./define').UpstreamProxyResult} UpstreamProxyResult */
/** @typedef {import('./define').PositiveIntegerOptions} PositiveIntegerOptions */
/** @typedef {import('./define').SmartQueryResult} SmartQueryResult */
/** @typedef {import('./define').TimeRangeFilter} TimeRangeFilter */

log4js.configure({
    appenders: {
        OUT: { type: 'stdout' },
        LOG: {
            type: 'file',
            filename: path.resolve(__dirname, '..', 'log', 'log.log'),
        },
        ERROR: {
            type: 'file',
            filename: path.resolve(__dirname, '..', 'log', 'error.log'),
        },
    },
    categories: {
        default: { appenders: ['OUT', 'LOG'], level: 'info' },
        error: { appenders: ['OUT', 'ERROR'], level: 'error' },
    },
});

const CURRENT_STATUS_URL =
    'https://list.darkrp.cn:9000/ServerList/CurrentStatus';
const ONLINE_STATS_URL = 'https://api.darkrp.cn/api/onlineStats';
const LIVE_INFOS_URL = 'https://api.darkrp.cn/api/liveInfos';

const logERROR = log4js.getLogger('error');
const logLOG = log4js.getLogger('default');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
    logLOG.info(`${req.method} ${req.originalUrl}`);
    next();
});

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
 * 解析形如 `10-50` 的时长区间查询字符串。
 * @param {string} value 原始区间字符串
 * @returns {TimeRangeFilter|null} 解析成功时返回最小和最大时长，否则返回 null
 */
function parseTimeRange(value) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
    if (!match) {
        return null;
    }

    return {
        minTime: Number(match[1]),
        maxTime: Number(match[2]),
    };
}

/**
 * 解析玩家搜索关键字，自动识别 ID、昵称和时长区间三种模式。
 * @param {string} value 搜索关键字
 * @returns {SmartQueryResult} 解析后的查询模式和过滤条件
 * @throws {Error} 当关键字为空或不是字符串时抛出错误
 */
function parseSmartQueryValue(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw createHttpError('value 必须是非空字符串', 400);
    }

    const normalizedValue = value.trim();
    const timeRange = parseTimeRange(normalizedValue);
    if (timeRange) {
        return {
            mode: 'mintime-maxtime',
            filters: timeRange,
        };
    }

    if (/^\d+$/.test(normalizedValue)) {
        return {
            mode: 'id',
            filters: { id: Number(normalizedValue) },
        };
    }

    return {
        mode: 'name',
        filters: { name: normalizedValue },
    };
}

/**
 * 将输入值解析成指定范围内的正整数。
 * @param {number|string|null|undefined} value 原始输入值
 * @param {PositiveIntegerOptions} [options={}] 解析配置
 * @returns {number|undefined} 解析后的整数值；当输入为空时返回 fallback
 * @throws {Error} 当输入不是合法范围内的正整数时抛出错误
 */
function parsePositiveInteger(
    value,
    { fallback, fieldName = 'count', max = 100 } = {},
) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    const parsedValue = Number(value);
    if (
        !Number.isInteger(parsedValue) ||
        parsedValue <= 0 ||
        parsedValue > max
    ) {
        throw createHttpError(`${fieldName} 必须是 1 到 ${max} 的整数`, 400);
    }

    return parsedValue;
}

/**
 * 转发指定的上游接口，并保留其响应状态码、类型和正文。
 * @param {string} url 目标上游地址
 * @returns {Promise<UpstreamProxyResult>} 上游接口的原始响应结果
 * @throws {Error} 当上游请求超时或网络失败时抛出错误
 */
function proxyUpstreamJson(url) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const request = https.request(
            target,
            {
                method: 'GET',
                timeout: 10000,
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Encoding': 'identity',
                },
            },
            (response) => {
                const chunks = [];

                response.on('data', (chunk) => {
                    chunks.push(
                        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                    );
                });
                response.on('end', () => {
                    resolve({
                        statusCode: response.statusCode || 502,
                        contentType:
                            response.headers['content-type'] ||
                            'application/json; charset=utf-8',
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            },
        );

        request.on('timeout', () => {
            request.destroy(new Error('上游请求超时'));
        });
        request.on('error', reject);
        request.end();
    });
}

app.get('/api/player/count', async (req, res) => {
    const count = await getAllPlayersCount();
    res.json({ count });
});

app.post('/api/auth/register', async (req, res) => {
    const payload = await registerLocalUser(req.body || {});
    res.status(201).json(payload);
});

app.post('/api/auth/login', async (req, res) => {
    const payload = await loginLocalUser(req.body || {});
    res.json(payload);
});

app.post('/api/auth/logout', authRequired, async (req, res) => {
    deleteSession(req.session.sessionToken);
    res.status(204).end();
});

app.get('/api/user/info', authRequired, async (req, res) => {
    res.json(req.user);
});

app.get('/api/lottery/draw', authRequired, async (req, res) => {
    const lottery = await drawLottery(req.user.id);
    if (!lottery) {
        throw createHttpError('玩家不存在', 404);
    }

    res.json({
        playerId: lottery.playerId,
        result: lottery.result,
        reused: lottery.reused,
        date: lottery.date,
        goldCount: lottery.goldCount,
    });
});

app.get('/api/system/time', (req, res) => {
    res.json({ currentTime: getCurrentTime() });
});

app.get('/api/system/server-status', async (req, res) => {
    try {
        const result = await proxyUpstreamJson(CURRENT_STATUS_URL);
        res.status(result.statusCode);
        res.type(result.contentType);

        if (
            typeof result.body === 'string' &&
            result.contentType.includes('application/json')
        ) {
            res.send(JSON.parse(result.body));
            return;
        }

        res.send(result.body);
    } catch (error) {
        logERROR.error(error);
        throw createHttpError(`转发当前状态失败: ${error.message}`, 502);
    }
});

app.get('/api/system/online-stats', async (req, res) => {
    try {
        const result = await proxyUpstreamJson(ONLINE_STATS_URL);
        res.status(result.statusCode);
        res.type(result.contentType);

        if (
            typeof result.body === 'string' &&
            result.contentType.includes('application/json')
        ) {
            res.send(JSON.parse(result.body));
            return;
        }

        res.send(result.body);
    } catch (error) {
        logERROR.error(error);
        throw createHttpError(`转发在线统计失败: ${error.message}`, 502);
    }
});

app.get('/api/system/live-recommendations', async (req, res) => {
    try {
        const result = await proxyUpstreamJson(LIVE_INFOS_URL);
        res.status(result.statusCode);
        res.type(result.contentType);

        if (
            typeof result.body === 'string' &&
            result.contentType.includes('application/json')
        ) {
            res.send(JSON.parse(result.body));
            return;
        }

        res.send(result.body);
    } catch (error) {
        logERROR.error(error);
        throw createHttpError(`转发直播推荐失败: ${error.message}`, 502);
    }
});

app.get('/api/announcement/list', async (req, res) => {
    const announcements = await getAnnouncementLog();
    res.json(announcements);
});

app.get('/api/help/articles', async (req, res) => {
    const articles = await getHelpArticles();
    res.json(articles);
});

app.post('/api/player/range', async (req, res) => {
    const { i, j } = req.body || {};
    const players = await getPlayersRange(i, j);

    res.json({
        i: Number(i),
        j: Number(j),
        count: players.length,
        players,
    });
});

app.post('/api/player/virtual/create', async (req, res) => {
    const count = parsePositiveInteger(req.body ? req.body.count : undefined, {
        fallback: 20,
        fieldName: 'count',
    });
    const players = await createVirtualPlayers(count);

    res.status(201).json({
        count: players.length,
        players,
    });
});

app.post('/api/player/virtual/clear', async (req, res) => {
    const deletedCount = await clearVirtualPlayers();

    res.json({
        count: deletedCount,
        deletedCount,
    });
});

app.post('/api/player/query', async (req, res) => {
    const parsedQuery = parseSmartQueryValue(
        req.body ? req.body.value : undefined,
    );
    const players = await findPlayers(parsedQuery.filters);

    res.json({
        mode: parsedQuery.mode,
        count: players.length,
        players,
    });
});

app.use((error, req, res, next) => {
    const statusCode = error.statusCode || 500;
    const message = error.message || '服务器内部错误';

    if (statusCode >= 500) {
        logERROR.error(error);
    } else {
        logLOG.warn(message);
    }

    res.status(statusCode).json({ message });
});

app.listen(8888, () => {
    logLOG.info('Server is running on port 8888');
    console.log('端口号：8888');
});
