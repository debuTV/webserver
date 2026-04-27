const sqlite3 = require('sqlite3').verbose();

/** @typedef {import('./define').CreateUserInput} CreateUserInput */
/** @typedef {import('./define').FindUsersQuery} FindUsersQuery */
/** @typedef {import('./define').LegacyPlayerRow} LegacyPlayerRow */
/** @typedef {import('./define').SqlRunResult} SqlRunResult */
/** @typedef {import('./define').UpdateUserInput} UpdateUserInput */
/** @typedef {import('./define').UserColumnDefinition} UserColumnDefinition */
/** @typedef {import('./define').UserRecord} UserRecord */
/** @typedef {import('./define').VirtualUserRecord} VirtualUserRecord */

const USERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    openid TEXT NOT NULL UNIQUE,
    unionid TEXT DEFAULT NULL,
    username TEXT DEFAULT NULL,
    password_hash TEXT DEFAULT NULL,
    nickname TEXT,
    avatar_url TEXT,
    gold_count INTEGER DEFAULT 0,
    play_time REAL DEFAULT 0.0,
    last_login_at TEXT,
    last_lottery_date TEXT,
    last_lottery_result INTEGER,
    is_virtual INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`;

const USER_COLUMNS = [
    { name: 'openid', definition: 'TEXT' },
    { name: 'unionid', definition: 'TEXT' },
    { name: 'username', definition: 'TEXT' },
    { name: 'password_hash', definition: 'TEXT' },
    { name: 'nickname', definition: 'TEXT' },
    { name: 'avatar_url', definition: 'TEXT' },
    { name: 'gold_count', definition: 'INTEGER DEFAULT 0' },
    { name: 'play_time', definition: 'REAL DEFAULT 0.0' },
    { name: 'last_login_at', definition: 'TEXT' },
    { name: 'last_lottery_date', definition: 'TEXT' },
    { name: 'last_lottery_result', definition: 'INTEGER' },
    { name: 'is_virtual', definition: 'INTEGER DEFAULT 0' },
    { name: 'created_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { name: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
];

/**
 * 生成指定范围内的随机整数。
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @returns {number} 生成的随机整数
 */
function randomInteger(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 构建一条虚拟用户的初始数据。
 * @param {number} index 当前批次中的序号
 * @param {number} batchKey 本次批量创建使用的批次键
 * @returns {CreateUserInput} 可直接写入数据库的虚拟用户数据
 */
function buildVirtualUser(index, batchKey) {
    const goldCount = randomInteger(100, 5000);
    const playTime = Number((Math.random() * 1000).toFixed(2));

    return {
        openid: `virtual-openid-${batchKey}-${index}`,
        nickname: `虚拟玩家_${batchKey.toString().slice(-4)}_${index + 1}`,
        goldCount,
        playTime,
        isVirtual: true,
    };
}

/**
 * 基于 sqlite3 的简单连接池实现。
 */
class SQLitePool {
    /**
     * 初始化一个 SQLite 连接池。
     * @param {string} dbPath 数据库文件路径
     * @param {number} [maxConnections=5] 最大连接数
     */
    constructor(dbPath, maxConnections = 5) {
        this.dbPath = dbPath;
        this.maxConnections = maxConnections;
        this.pool = [];
        this.waitingQueue = [];
        this.activeCount = 0;
    }

    /**
     * 获取一个可用数据库连接，没有空闲连接时会等待。
     * @returns {Promise<import('sqlite3').Database>} 可用的数据库连接
     */
    async acquire() {
        if (this.pool.length > 0) {
            return this.pool.pop();
        }
        if (this.activeCount < this.maxConnections) {
            this.activeCount += 1;
            return await this._createConnection();
        }

        return await new Promise((resolve) => {
            this.waitingQueue.push(resolve);
        });
    }

    /**
     * 归还数据库连接给连接池或等待中的请求。
     * @param {import('sqlite3').Database} db 待归还的数据库连接
     * @returns {void} 无返回值
     */
    release(db) {
        if (this.waitingQueue.length > 0) {
            const nextRequest = this.waitingQueue.shift();
            nextRequest(db);
            return;
        }

        this.pool.push(db);
    }

    /**
     * 新建一个 sqlite3 数据库连接。
     * @returns {Promise<import('sqlite3').Database>} 新创建的数据库连接
     */
    _createConnection() {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(db);
            });
        });
    }

    /**
     * 在获取到的数据库连接上执行一个任务函数。
     * @param {(db: import('sqlite3').Database) => Promise<*>|*} taskFn 具体执行的数据库任务
     * @returns {Promise<*>} 任务函数的执行结果
     */
    async execute(taskFn) {
        const db = await this.acquire();
        try {
            return await taskFn(db);
        } finally {
            this.release(db);
        }
    }

    /**
     * 关闭连接池中当前缓存的全部数据库连接。
     * @returns {Promise<void>} 所有连接关闭后返回
     */
    async drain() {
        const closes = this.pool.map(
            (db) => new Promise((resolve) => db.close(resolve)),
        );
        await Promise.all(closes);
        this.pool = [];
        this.activeCount = 0;
    }
}

/**
 * 面向业务的玩家数据库访问层。
 */
class PlayerDB {
    /**
     * 创建玩家数据库访问实例。
     * @param {string} dbPath 数据库文件路径
     * @param {number} [poolSize=5] 连接池大小
     */
    constructor(dbPath, poolSize = 5) {
        this.pool = new SQLitePool(dbPath, poolSize);
    }

    /**
     * 初始化用户表、索引和历史数据迁移逻辑。
     * @returns {Promise<void>} 初始化完成后返回
     */
    async initTable() {
        await this.pool.execute((db) => {
            return new Promise((resolve, reject) => {
                db.run(USERS_TABLE_SQL, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
        });

        await this._ensureUserColumns(USER_COLUMNS);
        await this._ensureUsersUpdatedAtTrigger();
        await this._run(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_openid ON users (openid)',
        );
        await this._run(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unionid ON users (unionid) WHERE unionid IS NOT NULL',
        );
        await this._run(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username) WHERE username IS NOT NULL',
        );
        await this._migrateLegacyPlayersTable();
    }

    /**
     * 确保 users 表包含业务所需的全部列。
     * @param {UserColumnDefinition[]} columns 需要保证存在的列定义
     * @returns {Promise<void>} 列校验与补齐完成后返回
     */
    async _ensureUserColumns(columns) {
        const existingColumns = await this._all('PRAGMA table_info(users)');
        const existingNames = new Set(
            existingColumns.map((column) => column.name),
        );

        for (const column of columns) {
            if (!existingNames.has(column.name)) {
                await this._run(
                    `ALTER TABLE users ADD COLUMN ${column.name} ${column.definition}`,
                );
            }
        }
    }

    /**
     * 确保 users 表在更新时自动刷新 updated_at 字段。
     * @returns {Promise<void>} 触发器更新完成后返回
     */
    async _ensureUsersUpdatedAtTrigger() {
        await this._run('DROP TRIGGER IF EXISTS trg_users_updated_at');
        await this._run(`
      CREATE TRIGGER trg_users_updated_at
      AFTER UPDATE ON users
      FOR EACH ROW
      WHEN NEW.updated_at = OLD.updated_at
      BEGIN
        UPDATE users
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.id;
      END
    `);
    }

    /**
     * 判断指定数据表是否存在。
     * @param {string} tableName 数据表名称
     * @returns {Promise<boolean>} 数据表存在时返回 true
     */
    async _tableExists(tableName) {
        const row = await this._get(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            [tableName],
        );
        return Boolean(row);
    }

    /**
     * 将旧 players 表中的记录转换为当前 users 表的写入结构。
     * @param {LegacyPlayerRow|null|undefined} row 旧表中的玩家记录
     * @returns {CreateUserInput|null} 转换后的用户数据；缺少关键标识时返回 null
     */
    normalizeLegacyUserRow(row) {
        if (!row) {
            return null;
        }

        const openid =
            row.web_open_id || row.mini_open_id || row.union_id || null;
        if (!openid) {
            return null;
        }

        return {
            openid,
            unionid: row.union_id || null,
            nickname: row.player_name || '',
            avatarUrl: row.avatar_url || null,
            goldCount: 0,
            playTime: Number(row.online_time) || 0,
            lastLoginAt: row.last_login_at || null,
            lastLotteryDate: row.last_lottery_date || null,
            lastLotteryResult: row.last_lottery_result ?? null,
        };
    }

    /**
     * 将旧版 players 表中的玩家数据迁移到新的 users 表。
     * @returns {Promise<void>} 迁移完成后返回
     */
    async _migrateLegacyPlayersTable() {
        const hasPlayersTable = await this._tableExists('players');
        if (!hasPlayersTable) {
            return;
        }

        const legacyColumns = await this._all('PRAGMA table_info(players)');
        const legacyColumnNames = new Set(
            legacyColumns.map((column) => column.name),
        );
        if (!legacyColumnNames.has('player_name')) {
            return;
        }

        const legacyRows = await this._all('SELECT * FROM players');
        for (const legacyRow of legacyRows) {
            const normalizedUser = this.normalizeLegacyUserRow(legacyRow);
            if (!normalizedUser) {
                continue;
            }

            const existingUser =
                (await this.getUserByOpenId(normalizedUser.openid)) ||
                (normalizedUser.unionid
                    ? await this.getUserByUnionId(normalizedUser.unionid)
                    : null);

            if (existingUser) {
                await this.updateUser(existingUser.id, {
                    openid: normalizedUser.openid,
                    unionid: normalizedUser.unionid || existingUser.unionid,
                    nickname: normalizedUser.nickname || existingUser.nickname,
                    avatarUrl:
                        normalizedUser.avatarUrl || existingUser.avatar_url,
                    goldCount: Number(existingUser.gold_count) || 0,
                    playTime: Math.max(
                        Number(existingUser.play_time) || 0,
                        normalizedUser.playTime,
                    ),
                    lastLoginAt:
                        normalizedUser.lastLoginAt ||
                        existingUser.last_login_at,
                    lastLotteryDate:
                        normalizedUser.lastLotteryDate ||
                        existingUser.last_lottery_date,
                    lastLotteryResult:
                        normalizedUser.lastLotteryResult ??
                        existingUser.last_lottery_result,
                });
                continue;
            }

            await this.createUser(normalizedUser);
        }
    }

    /**
     * 执行会修改数据库的 SQL 语句。
     * @param {string} sql 要执行的 SQL 语句
     * @param {Array<*>} [params=[]] SQL 参数列表
     * @returns {Promise<SqlRunResult>} 执行结果，包含 lastID 和 changes
     */
    async _run(sql, params = []) {
        return await this.pool.execute((db) => {
            return new Promise((resolve, reject) => {
                db.run(sql, params, function (err) {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve({ id: this.lastID, changes: this.changes });
                });
            });
        });
    }

    /**
     * 执行只返回单行结果的 SQL 查询。
     * @param {string} sql 要执行的 SQL 语句
     * @param {Array<*>} [params=[]] SQL 参数列表
     * @returns {Promise<*>} 查询到的单行结果，没有结果时返回 null
     */
    async _get(sql, params = []) {
        return await this.pool.execute((db) => {
            return new Promise((resolve, reject) => {
                db.get(sql, params, (err, row) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(row || null);
                });
            });
        });
    }

    /**
     * 执行返回多行结果的 SQL 查询。
     * @param {string} sql 要执行的 SQL 语句
     * @param {Array<*>} [params=[]] SQL 参数列表
     * @returns {Promise<*[]>} 查询结果数组
     */
    async _all(sql, params = []) {
        return await this.pool.execute((db) => {
            return new Promise((resolve, reject) => {
                db.all(sql, params, (err, rows) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(rows);
                });
            });
        });
    }

    /**
     * 对外暴露的通用执行入口。
     * @param {string} sql 要执行的 SQL 语句
     * @param {Array<*>} [params=[]] SQL 参数列表
     * @returns {Promise<SqlRunResult>} 执行结果
     */
    async run(sql, params = []) {
        return await this._run(sql, params);
    }

    /**
     * 对外暴露的单行查询入口。
     * @param {string} sql 要执行的 SQL 语句
     * @param {Array<*>} [params=[]] SQL 参数列表
     * @returns {Promise<*>} 查询结果
     */
    async get(sql, params = []) {
        return await this._get(sql, params);
    }

    /**
     * 对外暴露的多行查询入口。
     * @param {string} sql 要执行的 SQL 语句
     * @param {Array<*>} [params=[]] SQL 参数列表
     * @returns {Promise<*[]>} 查询结果数组
     */
    async all(sql, params = []) {
        return await this._all(sql, params);
    }

    /**
     * 兼容旧逻辑，新增一条仅包含昵称和在线时长的玩家记录。
     * @param {string} name 玩家名称
     * @param {number} time 在线时长
     * @returns {Promise<SqlRunResult>} 插入结果
     */
    async addPlayer(name, time) {
        return await this.createUser({
            openid: `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            nickname: name,
            playTime: time,
        });
    }

    /**
     * 按用户 ID 删除一条玩家记录。
     * @param {number|string} id 用户 ID
     * @returns {Promise<SqlRunResult>} 删除结果
     */
    async deletePlayer(id) {
        return await this._run('DELETE FROM users WHERE id = ?', [id]);
    }

    /**
     * 更新指定玩家的在线时长。
     * @param {number|string} id 用户 ID
     * @param {number} newTime 新的在线时长
     * @returns {Promise<SqlRunResult>} 更新结果
     */
    async updateTime(id, newTime) {
        return await this._run(
            'UPDATE users SET play_time = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newTime, id],
        );
    }

    /**
     * 新建一条用户记录。
     * @param {CreateUserInput} user 要写入的用户数据
     * @returns {Promise<SqlRunResult>} 插入结果
     * @throws {Error} 当缺少 openid 时抛出错误
     */
    async createUser({
        openid,
        unionid = null,
        username = null,
        passwordHash = null,
        nickname = '',
        avatarUrl = null,
        goldCount = 0,
        playTime = 0,
        lastLoginAt = null,
        lastLotteryDate = null,
        lastLotteryResult = null,
        isVirtual = false,
    }) {
        if (!openid) {
            throw new Error('创建用户时必须提供 openid');
        }

        return await this._run(
            `INSERT INTO users (
        openid,
        unionid,
        username,
        password_hash,
        nickname,
        avatar_url,
        gold_count,
        play_time,
        last_login_at,
        last_lottery_date,
        last_lottery_result,
        is_virtual
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                openid,
                unionid,
                username,
                passwordHash,
                nickname,
                avatarUrl,
                goldCount,
                playTime,
                lastLoginAt,
                lastLotteryDate,
                lastLotteryResult,
                isVirtual ? 1 : 0,
            ],
        );
    }

    /**
     * 更新现有用户记录，并仅覆盖传入的字段。
     * @param {number|string} id 用户 ID
     * @param {UpdateUserInput} updates 需要更新的字段集合
     * @returns {Promise<SqlRunResult>} 更新结果
     * @throws {Error} 当目标用户不存在时抛出错误
     */
    async updateUser(id, updates) {
        const existingUser = await this.getUserById(id);
        if (!existingUser) {
            throw new Error(`用户 ${id} 不存在`);
        }

        const hasOwn = (key) =>
            Object.prototype.hasOwnProperty.call(updates, key);
        const nextUser = {
            openid: hasOwn('openid') ? updates.openid : existingUser.openid,
            unionid: hasOwn('unionid') ? updates.unionid : existingUser.unionid,
            username: hasOwn('username')
                ? updates.username
                : existingUser.username,
            passwordHash: hasOwn('passwordHash')
                ? updates.passwordHash
                : existingUser.password_hash,
            nickname: hasOwn('nickname')
                ? updates.nickname
                : existingUser.nickname,
            avatarUrl: hasOwn('avatarUrl')
                ? updates.avatarUrl
                : existingUser.avatar_url,
            goldCount: hasOwn('goldCount')
                ? updates.goldCount
                : existingUser.gold_count,
            playTime: hasOwn('playTime')
                ? updates.playTime
                : existingUser.play_time,
            lastLoginAt: hasOwn('lastLoginAt')
                ? updates.lastLoginAt
                : existingUser.last_login_at,
            lastLotteryDate: hasOwn('lastLotteryDate')
                ? updates.lastLotteryDate
                : existingUser.last_lottery_date,
            lastLotteryResult: hasOwn('lastLotteryResult')
                ? updates.lastLotteryResult
                : existingUser.last_lottery_result,
            isVirtual: hasOwn('isVirtual')
                ? updates.isVirtual
                : existingUser.is_virtual,
        };

        return await this._run(
            `UPDATE users
       SET openid = ?,
           unionid = ?,
           username = ?,
           password_hash = ?,
           nickname = ?,
           avatar_url = ?,
           gold_count = ?,
           play_time = ?,
           last_login_at = ?,
           last_lottery_date = ?,
           last_lottery_result = ?,
           is_virtual = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
            [
                nextUser.openid,
                nextUser.unionid,
                nextUser.username,
                nextUser.passwordHash,
                nextUser.nickname,
                nextUser.avatarUrl,
                nextUser.goldCount,
                nextUser.playTime,
                nextUser.lastLoginAt,
                nextUser.lastLotteryDate,
                nextUser.lastLotteryResult,
                nextUser.isVirtual ? 1 : 0,
                id,
            ],
        );
    }

    /**
     * 记录指定用户当天的摇奖结果，并累加金币数量。
     * @param {number|string} id 用户 ID
     * @param {string} lotteryDate 摇奖日期键
     * @param {number} lotteryResult 摇奖结果
     * @returns {Promise<SqlRunResult>} 更新结果
     */
    async setLotteryResult(id, lotteryDate, lotteryResult) {
        return await this._run(
            `UPDATE users
       SET last_lottery_date = ?,
           last_lottery_result = ?,
           gold_count = COALESCE(gold_count, 0) + ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
            [lotteryDate, lotteryResult, lotteryResult, id],
        );
    }

    /**
     * 获取当前 users 表中的玩家总数。
     * @returns {Promise<number>} 玩家总数
     */
    async getAllPlayersCount() {
        const result = await this._get('SELECT COUNT(*) AS count FROM users');
        return result ? result.count : 0;
    }

    /**
     * 按用户 ID 查询单条用户记录。
     * @param {number|string} id 用户 ID
     * @returns {Promise<UserRecord|null>} 查询到的用户记录，没有时返回 null
     */
    async getUserById(id) {
        return await this._get('SELECT * FROM users WHERE id = ?', [id]);
    }

    /**
     * 兼容旧接口命名，按 ID 查询玩家记录。
     * @param {number|string} id 用户 ID
     * @returns {Promise<UserRecord|null>} 查询到的玩家记录，没有时返回 null
     */
    async getPlayerById(id) {
        return await this.getUserById(id);
    }

    /**
     * 按昵称精确查询用户记录。
     * @param {string} name 用户昵称
     * @returns {Promise<UserRecord[]>} 匹配到的用户列表
     */
    async getUserByName(name) {
        return await this._all('SELECT * FROM users WHERE nickname = ?', [
            name,
        ]);
    }

    /**
     * 兼容旧接口命名，按昵称查询玩家记录。
     * @param {string} name 玩家昵称
     * @returns {Promise<UserRecord[]>} 匹配到的玩家列表
     */
    async getPlayerByName(name) {
        return await this.getUserByName(name);
    }

    /**
     * 按 openid 查询单条用户记录。
     * @param {string} openid 用户 openid
     * @returns {Promise<UserRecord|null>} 查询到的用户记录，没有时返回 null
     */
    async getUserByOpenId(openid) {
        return await this._get('SELECT * FROM users WHERE openid = ?', [
            openid,
        ]);
    }

    /**
     * 按 unionid 查询单条用户记录。
     * @param {string} unionid 用户 unionid
     * @returns {Promise<UserRecord|null>} 查询到的用户记录，没有时返回 null
     */
    async getUserByUnionId(unionid) {
        return await this._get('SELECT * FROM users WHERE unionid = ?', [
            unionid,
        ]);
    }

    /**
     * 按用户名查询本地账号记录。
     * @param {string} username 用户名
     * @returns {Promise<UserRecord|null>} 查询到的用户记录，没有时返回 null
     */
    async getUserByUsername(username) {
        return await this._get('SELECT * FROM users WHERE username = ?', [
            username,
        ]);
    }

    /**
     * 兼容旧接口命名，按 unionid 查询玩家记录。
     * @param {string} unionid 用户 unionid
     * @returns {Promise<UserRecord|null>} 查询到的玩家记录，没有时返回 null
     */
    async getPlayerByUnionId(unionid) {
        return await this.getUserByUnionId(unionid);
    }

    /**
     * 按分页参数查询用户列表。
     * @param {number} limit 返回记录数
     * @param {number} offset 偏移量
     * @returns {Promise<UserRecord[]>} 查询到的用户列表
     */
    async getPlayersRange(limit, offset) {
        return await this._all(
            `SELECT * FROM users
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
            [limit, offset],
        );
    }

    /**
     * 根据多种过滤条件查询用户列表。
     * @param {FindUsersQuery} query 查询条件
     * @returns {Promise<UserRecord[]>} 匹配到的用户列表
     */
    async findUsers({ id, nickname, minPlayTime, maxPlayTime }) {
        let sql = 'SELECT * FROM users WHERE 1 = 1';
        const params = [];

        if (id !== undefined && id !== null && id !== '') {
            sql += ' AND id = ?';
            params.push(Number(id));
        }
        if (nickname) {
            sql += ' AND nickname LIKE ?';
            params.push(`%${nickname}%`);
        }
        if (
            minPlayTime !== undefined &&
            minPlayTime !== null &&
            minPlayTime !== ''
        ) {
            sql += ' AND play_time >= ?';
            params.push(Number(minPlayTime));
        }
        if (
            maxPlayTime !== undefined &&
            maxPlayTime !== null &&
            maxPlayTime !== ''
        ) {
            sql += ' AND play_time <= ?';
            params.push(Number(maxPlayTime));
        }

        sql += ' ORDER BY id ASC';
        return await this._all(sql, params);
    }

    /**
     * 批量创建虚拟用户并返回新建结果。
     * @param {number} [count=20] 需要创建的虚拟用户数量
     * @returns {Promise<VirtualUserRecord[]>} 新建的虚拟用户列表
     * @throws {Error} 当 count 不是正整数时抛出错误
     */
    async createVirtualUsers(count = 20) {
        const total = Number(count);
        if (!Number.isInteger(total) || total <= 0) {
            throw new Error('count 必须是正整数');
        }

        const batchKey = Date.now();
        const createdUsers = [];

        for (let index = 0; index < total; index += 1) {
            const virtualUser = buildVirtualUser(index, batchKey);
            const result = await this.createUser(virtualUser);
            createdUsers.push({
                id: result.id,
                ...virtualUser,
            });
        }

        return createdUsers;
    }

    /**
     * 删除全部虚拟用户记录。
     * @returns {Promise<SqlRunResult>} 删除结果
     */
    async clearVirtualUsers() {
        return await this._run('DELETE FROM users WHERE is_virtual = 1');
    }

    /**
     * 关闭当前数据库访问实例持有的连接池。
     * @returns {Promise<void>} 连接池关闭完成后返回
     */
    async close() {
        await this.pool.drain();
    }
}

module.exports = PlayerDB;
module.exports.PlayerDB = PlayerDB;
