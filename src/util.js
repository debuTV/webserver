const fs = require('fs/promises');
const path = require('path');
const PlayerDB = require('./sqlite');

/** @typedef {import('./define').AnnouncementEntry} AnnouncementEntry */
/** @typedef {import('./define').FindPlayersInput} FindPlayersInput */
/** @typedef {import('./define').HelpArticle} HelpArticle */
/** @typedef {import('./define').LotteryDrawResult} LotteryDrawResult */
/** @typedef {import('./define').SerializedUser} SerializedUser */
/** @typedef {import('./define').UserRecord} UserRecord */
/** @typedef {import('./define').VirtualUserRecord} VirtualUserRecord */

const db = new PlayerDB(path.resolve(__dirname, '..', 'game.db'), 10);
const dbReady = db.initTable();
const messageLogPath = path.resolve(__dirname, '..', 'message', 'log.json');
const helpMarkdownDirectoryPath = path.resolve(
    __dirname,
    '..',
    'message',
    'helpmarkdown',
);
let markedInstancePromise = null;

/**
 * 延迟加载 markdown 渲染器，避免在模块初始化阶段引入 ESM 依赖。
 * @returns {Promise<import('marked').Marked>} marked 渲染器实例
 */
async function getMarkedRenderer() {
    if (!markedInstancePromise) {
        markedInstancePromise = import('marked').then((module) => module.marked);
    }

    return await markedInstancePromise;
}

/**
 * 将单条原始公告记录规范化为前端稳定使用的结构。
 * @param {Record<string, unknown>} entry 原始公告记录
 * @param {number} index 当前记录索引
 * @returns {AnnouncementEntry} 规范化后的公告数据
 */
function normalizeAnnouncementEntry(entry, index) {
    const id = entry.id ?? entry.Id ?? entry.index ?? entry.Index ?? index;
    const title =
        entry.title ?? entry.Title ?? entry.name ?? `公告 ${index + 1}`;
    const text =
        entry.text ?? entry.Text ?? entry.content ?? entry.message ?? '';
    const time = entry.time ?? entry.Time ?? entry.createdAt ?? null;

    return {
        id,
        title: String(title),
        text: String(text),
        time: time === null ? null : String(time),
    };
}

/**
 * 按文件名对 markdown 文件执行稳定排序，优先使用数字顺序。
 * @param {string} left 左侧文件名
 * @param {string} right 右侧文件名
 * @returns {number} 排序比较结果
 */
function sortMarkdownFiles(left, right) {
    return left.localeCompare(right, 'zh-Hans-CN', {
        numeric: true,
        sensitivity: 'base',
    });
}

/**
 * 从 markdown 文本中提取首个标题作为帮助卡片标题。
 * @param {string} markdown 原始 markdown 文本
 * @param {string} fallback 未命中标题时的默认标题
 * @returns {string} 提取到的标题文本
 */
function extractMarkdownTitle(markdown, fallback) {
    const titleMatch = /^\s*#{1,6}\s+(.+)$/m.exec(markdown);
    if (!titleMatch) {
        return fallback;
    }

    return titleMatch[1].trim();
}

/**
 * 从 markdown 文本中提取首段简述，用于帮助卡片折叠态预览。
 * @param {string} markdown 原始 markdown 文本
 * @returns {string} 预览摘要
 */
function extractMarkdownSummary(markdown) {
    const lines = markdown
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

    if (!lines.length) {
        return '点击展开后查看完整帮助内容。';
    }

    return lines[0]
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[`>*_-]/g, '')
        .trim();
}

/**
 * 移除 markdown 开头的首个标题，避免卡片标题与正文首屏重复展示。
 * @param {string} markdown 原始 markdown 文本
 * @returns {string} 移除标题后的 markdown 正文
 */
function stripLeadingMarkdownTitle(markdown) {
    const lines = markdown.split(/\r?\n/);
    let currentIndex = 0;

    while (currentIndex < lines.length && !lines[currentIndex].trim()) {
        currentIndex += 1;
    }

    if (
        currentIndex < lines.length &&
        /^#{1,6}\s+/.test(lines[currentIndex].trim())
    ) {
        const contentLines = lines.slice(currentIndex + 1);

        while (contentLines.length && !contentLines[0].trim()) {
            contentLines.shift();
        }

        return contentLines.join('\n');
    }

    return markdown;
}

/**
 * 等待数据库初始化完成。
 * @returns {Promise<void>} 数据库可用后返回
 */
async function ensureDbReady() {
    await dbReady;
}

/**
 * 将数据库用户记录或虚拟用户记录映射为统一的前端展示结构。
 * @param {UserRecord|SerializedUser|VirtualUserRecord} user 原始用户记录
 * @returns {SerializedUser} 统一结构后的用户信息
 */
function mapUserRecord(user) {
    return {
        id: user.id,
        username: user.username ?? null,
        accountType: user.username ? 'local' : 'wechat',
        openid: user.username ? null : user.openid,
        unionid: user.unionid,
        nickname: user.nickname,
        avatarUrl: user.avatar_url ?? user.avatarUrl ?? null,
        goldCount: Number(user.gold_count ?? user.goldCount) || 0,
        playTime: Number(user.play_time ?? user.playTime) || 0,
        lastLoginAt: user.last_login_at ?? user.lastLoginAt ?? null,
        lastLotteryDate: user.last_lottery_date ?? user.lastLotteryDate ?? null,
        lastLotteryResult:
            user.last_lottery_result ?? user.lastLotteryResult ?? null,
        createdAt: user.created_at ?? user.createdAt ?? null,
        updatedAt: user.updated_at ?? user.updatedAt ?? null,
        isVirtual: Boolean(Number(user.is_virtual ?? user.isVirtual ?? 0)),
    };
}

/**
 * 获取当前时间的 ISO 字符串表示。
 * @returns {string} 当前时间的 ISO 字符串
 */
function getCurrentTime() {
    const now = new Date();
    return now.toISOString();
}

/**
 * 生成一个 0 到 999 之间的随机整数。
 * @returns {number} 随机生成的整数
 */
function getRandomPlayer() {
    return Math.floor(Math.random() * 1000);
}

/**
 * 获取从指定起止索引范围内的玩家数据。
 * @param {number} i 起始索引（从0开始）
 * @param {number} j 结束索引
 * @returns {Promise<SerializedUser[]>} 指定区间的玩家列表
 * @throws {Error} 当索引不是合法整数区间时抛出错误
 */
async function getPlayersRange(i, j) {
    await ensureDbReady();

    const startIndex = Number(i);
    const endIndex = Number(j);

    if (
        !Number.isInteger(startIndex) ||
        !Number.isInteger(endIndex) ||
        startIndex < 0 ||
        endIndex < startIndex
    ) {
        throw new Error('i 和 j 必须是从 0 开始的整数，且 j 不能小于 i');
    }

    const limit = endIndex - startIndex + 1;
    const offset = startIndex;
    const users = await db.getPlayersRange(limit, offset);
    return users.map(mapUserRecord);
}

/**
 * 获取当前所有玩家数量。
 * @returns {Promise<number>} 玩家总数
 */
async function getAllPlayersCount() {
    await ensureDbReady();
    return await db.getAllPlayersCount();
}

/**
 * 通过 ID、昵称和时长范围查找玩家。
 * @param {FindPlayersInput} params 查询条件
 * @returns {Promise<SerializedUser[]>} 匹配到的玩家列表
 */
async function findPlayers({ id, name, minTime, maxTime }) {
    await ensureDbReady();

    const users = await db.findUsers({
        id,
        nickname: name,
        minPlayTime: minTime,
        maxPlayTime: maxTime,
    });

    return users.map(mapUserRecord);
}

/**
 * 按指定数量批量创建虚拟玩家。
 * @param {number} [count=20] 需要创建的虚拟玩家数量
 * @returns {Promise<SerializedUser[]>} 创建完成后的虚拟玩家列表
 */
async function createVirtualPlayers(count = 20) {
    await ensureDbReady();

    const users = await db.createVirtualUsers(count);
    return users.map(mapUserRecord);
}

/**
 * 清空所有虚拟玩家数据。
 * @returns {Promise<number>} 被删除的虚拟玩家数量
 */
async function clearVirtualPlayers() {
    await ensureDbReady();

    const result = await db.clearVirtualUsers();
    return result.changes || 0;
}

/**
 * 将日期对象转换为当日的 `YYYY-MM-DD` 键。
 * @param {Date} [date=new Date()] 待转换的日期对象
 * @returns {string} 当日日期键
 */
function getTodayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

/**
 * 执行摇奖逻辑，并在同一天内复用首次摇奖结果。
 * @param {number|string} playerId 玩家 ID
 * @param {string} [sessionId=''] 预留的会话标识参数
 * @returns {Promise<LotteryDrawResult|null>} 摇奖结果；玩家不存在时返回 null
 * @throws {Error} 当 playerId 不是合法正整数时抛出错误
 */
async function drawLottery(playerId, sessionId = '') {
    await ensureDbReady();

    const normalizedPlayerId = Number(playerId);
    if (!Number.isInteger(normalizedPlayerId) || normalizedPlayerId <= 0) {
        throw new Error('playerId 必须是正整数');
    }
    const user = await db.getUserById(normalizedPlayerId);
    if (!user) {
        return null;
    }

    const todayKey = getTodayKey();
    if (
        user.last_lottery_date === todayKey &&
        user.last_lottery_result !== null &&
        user.last_lottery_result !== undefined
    ) {
        return {
            playerId: normalizedPlayerId,
            result: Number(user.last_lottery_result),
            reused: true,
            date: todayKey,
            goldCount: Number(user.gold_count) || 0,
        };
    }

    const result = getRandomPlayer();
    await db.setLotteryResult(normalizedPlayerId, todayKey, result);
    const updatedUser = await db.getUserById(normalizedPlayerId);

    return {
        playerId: normalizedPlayerId,
        result,
        reused: false,
        date: todayKey,
        goldCount: updatedUser ? Number(updatedUser.gold_count) || 0 : result,
    };
}

/**
 * 读取公告日志文件，并统一转换为前端使用的公告数组。
 * @returns {Promise<AnnouncementEntry[]>} 公告列表
 * @throws {Error} 当日志文件读取或 JSON 解析失败时抛出错误
 */
async function getAnnouncementLog() {
    const content = await fs.readFile(messageLogPath, 'utf8');
    const payload = JSON.parse(content);
    const entries = Array.isArray(payload) ? payload : payload ? [payload] : [];

    return entries.map((entry, index) =>
        normalizeAnnouncementEntry(entry, index),
    );
}

/**
 * 读取帮助中心 markdown 文件并渲染为可直接展示的 HTML 卡片数据。
 * @returns {Promise<HelpArticle[]>} 帮助文章列表
 * @throws {Error} 当 markdown 目录读取失败时抛出错误
 */
async function getHelpArticles() {
    let fileNames = [];

    try {
        fileNames = await fs.readdir(helpMarkdownDirectoryPath);
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }

    const markdownFiles = fileNames
        .filter((fileName) => fileName.toLowerCase().endsWith('.md'))
        .sort(sortMarkdownFiles);
    const marked = await getMarkedRenderer();

    return await Promise.all(
        markdownFiles.map(async (fileName, index) => {
            const filePath = path.resolve(helpMarkdownDirectoryPath, fileName);
            const [markdown, stat] = await Promise.all([
                fs.readFile(filePath, 'utf8'),
                fs.stat(filePath),
            ]);
            const title = extractMarkdownTitle(
                markdown,
                `帮助 ${index + 1}`,
            );

            return {
                id: path.parse(fileName).name,
                title,
                summary: extractMarkdownSummary(markdown),
                html: marked.parse(stripLeadingMarkdownTitle(markdown)),
                updatedAt: stat.mtime.toISOString(),
                order: index + 1,
            };
        }),
    );
}

/**
 * 调试用方法：批量生成 10000 条随机玩家数据。
 * @returns {Promise<void>} 数据生成完成后返回
 * @throws {Error} 当批量写入数据库失败时抛出错误
 */
async function debugGenerateData() {
    await ensureDbReady();

    console.log('开始生成测试数据...');
    const start = Date.now();
    const batchKey = Date.now();

    await db.pool.execute(async (rawDb) => {
        return new Promise((resolve, reject) => {
            rawDb.serialize(() => {
                rawDb.run('BEGIN TRANSACTION');

                const stmt = rawDb.prepare(
                    'INSERT INTO users (openid, nickname, play_time, gold_count) VALUES (?, ?, ?, ?)',
                );
                for (let i = 0; i < 10000; i++) {
                    const name = `Player_${getRandomPlayer()}_${i}`;
                    const openid = `debug-openid-${batchKey}-${i}`;
                    const time = parseFloat((Math.random() * 1000).toFixed(2));
                    const goldCount = Math.floor(Math.random() * 5000);
                    stmt.run(openid, name, time, goldCount);
                }

                stmt.finalize();
                rawDb.run('COMMIT', (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    console.log(
                        `Debug数据生成完毕，耗时: ${Date.now() - start}ms`,
                    );
                    resolve();
                });
            });
        });
    });
}

module.exports = {
    db,
    ensureDbReady,
    getCurrentTime,
    getRandomPlayer,
    getPlayersRange,
    getAllPlayersCount,
    findPlayers,
    createVirtualPlayers,
    clearVirtualPlayers,
    drawLottery,
    getAnnouncementLog,
    getHelpArticles,
    debugGenerateData,
    mapUserRecord,
};
