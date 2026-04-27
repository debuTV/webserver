/**
 * @typedef {Object} UserColumnDefinition
 * @property {string} name 列名
 * @property {string} definition 列定义 SQL
 */

/**
 * @typedef {Object} SqlRunResult
 * @property {number} id 最近一次插入记录的 ID
 * @property {number} changes 受影响的记录数
 */

/**
 * @typedef {Object} UserRecord
 * @property {number} id 用户 ID
 * @property {string} openid 用户 openid
 * @property {string|null} unionid 微信 unionid
 * @property {string|null} username 本地账号用户名
 * @property {string|null} password_hash 密码哈希
 * @property {string} nickname 用户昵称
 * @property {string|null} avatar_url 头像地址
 * @property {number} gold_count 金币数量
 * @property {number} play_time 在线时长
 * @property {string|null} last_login_at 最近登录时间
 * @property {string|null} last_lottery_date 最近摇奖日期
 * @property {number|null} last_lottery_result 最近摇奖结果
 * @property {number|boolean} is_virtual 是否为虚拟用户
 * @property {string|null} created_at 创建时间
 * @property {string|null} updated_at 更新时间
 */

/**
 * @typedef {Object} SerializedUser
 * @property {number} id 用户 ID
 * @property {string|null} username 本地账号用户名
 * @property {'local'|'wechat'} accountType 账号类型
 * @property {string|null} openid openid
 * @property {string|null} unionid unionid
 * @property {string} nickname 昵称
 * @property {string|null} avatarUrl 头像地址
 * @property {number} goldCount 金币数量
 * @property {number} playTime 在线时长
 * @property {string|null} lastLoginAt 最近登录时间
 * @property {string|null} lastLotteryDate 最近摇奖日期
 * @property {number|null} lastLotteryResult 最近摇奖结果
 * @property {boolean} isVirtual 是否为虚拟用户
 * @property {string|null} createdAt 创建时间
 * @property {string|null} updatedAt 更新时间
 */

/**
 * @typedef {Object} SessionRecord
 * @property {number} userId 关联的用户 ID
 * @property {string} sessionToken 会话令牌
 * @property {number} createdAt 会话创建时间戳
 * @property {number} expiresAt 会话过期时间戳
 */

/**
 * @typedef {Object} AuthPayload
 * @property {string} sessionToken 会话令牌
 * @property {string} expiresAt 会话过期时间 ISO 字符串
 * @property {SerializedUser} user 当前登录用户信息
 */

/**
 * @typedef {Object} RegisterLocalUserInput
 * @property {string} username 注册用户名
 * @property {string} password 注册密码
 * @property {string} nickname 注册昵称
 */

/**
 * @typedef {Object} LoginLocalUserInput
 * @property {string} username 登录用户名
 * @property {string} password 登录密码
 */

/**
 * @typedef {Object} FindPlayersInput
 * @property {number|string} [id] 玩家 ID
 * @property {string} [name] 玩家昵称
 * @property {number|string} [minTime] 最小时长
 * @property {number|string} [maxTime] 最大时长
 */

/**
 * @typedef {Object} TimeRangeFilter
 * @property {number} minTime 最小时长
 * @property {number} maxTime 最大时长
 */

/**
 * @typedef {Object} SmartQueryResult
 * @property {'id'|'name'|'mintime-maxtime'} mode 解析后的查询模式
 * @property {FindPlayersInput} filters 查询过滤条件
 */

/**
 * @typedef {Object} PositiveIntegerOptions
 * @property {number} [fallback] 默认值
 * @property {string} [fieldName='count'] 字段名
 * @property {number} [max=100] 最大允许值
 */

/**
 * @typedef {Object} LotteryDrawResult
 * @property {number} playerId 玩家 ID
 * @property {number} result 本次摇奖结果
 * @property {boolean} reused 是否复用当日首次结果
 * @property {string} date 摇奖日期
 * @property {number} goldCount 当前金币数
 */

/**
 * @typedef {Object} AnnouncementEntry
 * @property {string|number} id 公告主键
 * @property {string} title 公告标题
 * @property {string} text 公告正文
 * @property {string|null} time 公告时间
 */

/**
 * @typedef {Object} HelpArticle
 * @property {string} id 帮助文章主键
 * @property {number} order 帮助文章顺序
 * @property {string} title 帮助文章标题
 * @property {string} summary 折叠态摘要
 * @property {string} html 渲染后的 HTML 内容
 * @property {string} updatedAt 文件更新时间
 */

/**
 * @typedef {Object} OnlineStatsPoint
 * @property {number} timestamp 采样时间戳
 * @property {number} totalPlayers 当前总玩家数
 * @property {number} onlineServers 当前在线服务器数
 */

/**
 * @typedef {Object} UpstreamProxyResult
 * @property {number} statusCode 上游接口状态码
 * @property {string} contentType 上游接口返回的内容类型
 * @property {string} body 上游接口响应体
 */

/**
 * @typedef {Object} LegacyPlayerRow
 * @property {string} [web_open_id] 网页 openid
 * @property {string} [mini_open_id] 小程序 openid
 * @property {string} [union_id] unionid
 * @property {string} [player_name] 玩家名称
 * @property {string} [avatar_url] 头像地址
 * @property {number|string} [online_time] 在线时长
 * @property {string} [last_login_at] 最近登录时间
 * @property {string} [last_lottery_date] 最近摇奖日期
 * @property {number|string|null} [last_lottery_result] 最近摇奖结果
 */

/**
 * @typedef {Object} CreateUserInput
 * @property {string} openid 用户 openid
 * @property {string|null} [unionid] unionid
 * @property {string|null} [username] 用户名
 * @property {string|null} [passwordHash] 密码哈希
 * @property {string} [nickname] 昵称
 * @property {string|null} [avatarUrl] 头像地址
 * @property {number} [goldCount] 金币数
 * @property {number} [playTime] 在线时长
 * @property {string|null} [lastLoginAt] 最近登录时间
 * @property {string|null} [lastLotteryDate] 最近摇奖日期
 * @property {number|null} [lastLotteryResult] 最近摇奖结果
 * @property {boolean} [isVirtual] 是否为虚拟用户
 */

/**
 * @typedef {Object} UpdateUserInput
 * @property {string} [openid] 用户 openid
 * @property {string|null} [unionid] unionid
 * @property {string|null} [username] 用户名
 * @property {string|null} [passwordHash] 密码哈希
 * @property {string} [nickname] 昵称
 * @property {string|null} [avatarUrl] 头像地址
 * @property {number} [goldCount] 金币数
 * @property {number} [playTime] 在线时长
 * @property {string|null} [lastLoginAt] 最近登录时间
 * @property {string|null} [lastLotteryDate] 最近摇奖日期
 * @property {number|null} [lastLotteryResult] 最近摇奖结果
 * @property {boolean|number} [isVirtual] 是否为虚拟用户
 */

/**
 * @typedef {Object} VirtualUserRecord
 * @property {number} id 用户 ID
 * @property {string} openid 用户 openid
 * @property {string} nickname 用户昵称
 * @property {number} goldCount 金币数
 * @property {number} playTime 在线时长
 * @property {boolean} isVirtual 是否为虚拟用户
 */

/**
 * @typedef {Object} FindUsersQuery
 * @property {number|string} [id] 用户 ID
 * @property {string} [nickname] 用户昵称
 * @property {number|string} [minPlayTime] 最小时长
 * @property {number|string} [maxPlayTime] 最大时长
 */

module.exports = {};
