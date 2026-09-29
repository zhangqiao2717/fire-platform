/**
 * 天泽智联火警本地监控脚本
 * 每30分钟自动检查 · 发现新火警 → 写入 data.json + @负责人推送飞书 + 上传 GitHub
 */

const puppeteer = require('puppeteer-core');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

// ============================================================
// ⚙️ 配置区
// ============================================================
const CONFIG = {
    url:      'http://10.231.136.231:9832/bw-fck-bjdx-web/#/login',
    username: '19800312191',
    password: 'Li@666888',
    // 飞书应用凭证
    appId:     'cli_aae2a0a81f39dbef',
    appSecret: 'nq7xjmzr1BrB968siubypgFWexNsBGP4',
    // 群推送 chat_id（应用机器人方式，无需每群建 Webhook）
    chatIds: [
        // 'oc_b362688580f805857fddc1a2d9df0ff9', // 消防维保群（已暂停）
        'oc_5cedb65c30a3cf0887b1870b4cd08e82', // 北京基地消防工作群
    ],
    // 旧 Webhook 保留备用（若 API 失败自动降级）
    webhooks: [
        'https://open.feishu.cn/open-apis/bot/v2/hook/486a84ae-3861-4652-b00d-cad5e2759cba',
        'https://open.feishu.cn/open-apis/bot/v2/hook/7c826fde-ab70-456d-ad8e-32cb6298f084',
    ],
    siteUrl:        '',   // 留空=自动检测本机内网IP（推荐）；需要固定时填 'http://10.231.x.x:8080'
    dataFile:       path.join(__dirname, '..', 'data.json'),
    screenshotFile: path.join(__dirname, '..', 'screenshot.png'),
    chromePath:     'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};

// ============================================================
// 区域安全员配置（2026-09 按《理想北京基地部门联系名册》更新）
// 区域 → 安全员（推送接收人）；确认按钮只发到对应安全员私聊
// 注意：数组顺序 = 匹配优先级，越具体的区域越靠前
// openId 为空 = 该应用通讯录范围暂查不到 → 兜底转张乔处理
// ============================================================
const AREA_CONTACTS = [
    { label: '消防值班室',              keywords: ['消防值班室', '值班室'],               name: '张乔',   phone: '18638502717', openId: 'ou_9583e1847f3541c085f3ae7b102fa0eb' },
    { label: '涂装工装间',              keywords: ['涂装工装间'],                        name: '陈玉磊', phone: '13301176701', openId: 'ou_57d024700e5cb8776ebb5ca7bfe7cfe0' },
    { label: '冲压车间',                keywords: ['冲压车间'],                          name: '孟旭',   phone: '17631652645', openId: 'ou_40651e94c44db753ed367502aa660ed3' },
    { label: '焊装车间',                keywords: ['焊装车间'],                          name: '周俊男', phone: '18920442544', openId: 'ou_4eae123fe079d1b07783c9b3b583750c' },
    { label: '涂装车间',                keywords: ['涂装车间'],                          name: '郭书强', phone: '18658424252', openId: 'ou_02c19b2b1f4d26dfafe1bdd557bd6916' },
    { label: '总装车间/1#仓库',         keywords: ['总装车间', '1#仓库'],                name: '陈玉磊', phone: '13301176701', openId: 'ou_57d024700e5cb8776ebb5ca7bfe7cfe0' },
    { label: '焊装/总装物流LOC/2#仓库', keywords: ['LOC', '2#仓库', '物流仓库'],         name: '田佳新', phone: '17331338087', openId: 'ou_a25200600bfbbbc95317762a5514506b' },
    { label: '综合站房及配电室',        keywords: ['综合站房', '配电室'],                name: '孟庆依', phone: '13466670619', openId: 'ou_944a0663282fb8f6e98c0488181556f9' },
    { label: '污水站',                  keywords: ['污水站'],                            name: '张建才', phone: '13552616713', openId: 'ou_7b150f526661afe9cf5cf2ffbb6dfeac' },
    { label: '总装质量AODT/冲压金相间', keywords: ['AODT', '金相间'],                    name: '付福军', phone: '15011081851', openId: 'ou_8bc97f97d264640e6cd93e8bdfcd6ab1' },
    { label: '办公楼',                  keywords: ['办公楼'],                            name: '杜威',   phone: '13691294075', openId: 'ou_8618bb4c90f6a5c8f5f2386f08304f32' },
    { label: '总装辅房二楼',            keywords: ['总装辅房'],                          name: '杜威',   phone: '13691294075', openId: 'ou_8618bb4c90f6a5c8f5f2386f08304f32' },
    { label: '餐厅',                    keywords: ['餐厅'],                              name: '李祥月', phone: '17333880709', openId: 'ou_25c21f9c8ae90c3e78f2849f22a4d088' },
    { label: '4#厂房',                  keywords: ['4#厂房', '4号厂房'],                 name: '邓海南', phone: '15232971855', openId: 'ou_bd39c3e1aaa3a2ef6ff992c34a69e32d' },
    { label: '交检车间西',              keywords: ['交检车间西'],                        name: '杜海',   phone: '16750789888', openId: 'ou_1f90ed4e59e1cfdb522d7a4ceed6ec6d' },
    { label: '交检车间东',              keywords: ['交检车间东'],                        name: '陈璐',   phone: '15116968228', openId: 'ou_a20ecf39364a30d59b8c007249e6e112' },
    { label: '售后件仓库',              keywords: ['售后件仓库'],                        name: '赵红光', phone: '15910921799', openId: 'ou_d993c563494b1c11d1b527d030b05c28' },
];

// 投递兜底接收人（安全员账号缺失 / 消息不可达时，转张乔处理）
const FALLBACK_CONTACT = { label: '待核实', name: '张乔', phone: '18638502717', openId: 'ou_9583e1847f3541c085f3ae7b102fa0eb' };

// 按文本匹配区域（顺序匹配，返回命中项或 null）
function matchArea(text) {
    const t = String(text || '');
    for (const entry of AREA_CONTACTS) {
        for (const kw of entry.keywords) {
            if (t.includes(kw)) return entry;
        }
    }
    return null;
}

// ============================================================
// 页面噪点过滤：天泽页面的菜单/图例/系统名等文字会被抓取逻辑误当成"火警"
// （它们内容为空泛的状态词或系统分类名，没有设备/位置信息；曾导致反复弹窗骚扰）
// 注意：与 index.html 中同名规则保持一致（两处同逻辑）
// ============================================================
function isPhantomAlarm(a) {
    const raw = String((a && a.raw) || '').trim().replace(/\s+/g, '');
    const loc = String((a && a.location) || '').trim().replace(/\s+/g, '');
    if (!raw && !loc) return false;
    const statusCombo = /^(正常|火警|报警|预警|故障|隐患|动作|离线)+$/;
    // ① 纯状态词组合（菜单"火警"、图例栏"正常火警预警故障隐患动作离线"）
    if (raw && statusCombo.test(raw)) return true;
    if (loc && raw === loc && statusCombo.test(loc)) return true;
    // ② 裸系统分类名标签（如"火灾自动报警系统"，单独出现=页面标签而非报警）
    const sysLabels = ['火灾自动报警系统', '可燃气体探测报警系统', '自动喷水灭火系统', '消火栓灭火系统', '泡沫灭火系统', '气体灭火系统', '防烟排烟系统', '应急广播系统', '应急照明和疏散指示标志', '消防专用电话', '消防供配电设施', '消防供水设施', '防火分隔设施'];
    if (raw && sysLabels.indexOf(raw) !== -1 && (!loc || sysLabels.indexOf(loc) !== -1 || loc === '弹窗报警')) return true;
    return false;
}

// ============================================================
// 处理本轮抓取结果：
//   ① 过滤页面噪点（本轮抓取 + 历史数据里遗留的"伪火警"，幂等清理）
//   ② 去重参照 = 上一轮抓取 + 近3天历史记录（抓取波动时不会把旧报警当成"新增"重复提醒）
//   ③ 同一条报警在上轮/近期已确认过 → 继承确认状态，不再回到"待确认"
// 返回 { alarms, newAlarms, mergedAlarms, cleanedCount, filteredCount }
// ============================================================
function processScrapedAlarms(oldData, rawAlarms) {
    // ①a 清理历史数据里遗留的伪火警（幂等）
    let cleanedCount = 0;
    const cleanArray = (arr) => (Array.isArray(arr) ? arr.filter(a => {
        const bad = isPhantomAlarm(a);
        if (bad) cleanedCount++;
        return !bad;
    }) : []);
    oldData.tianze_alarms = cleanArray(oldData.tianze_alarms);
    oldData.alarm_history = cleanArray(oldData.alarm_history);

    // ①b 过滤本轮抓取结果
    const allRaw = Array.isArray(rawAlarms) ? rawAlarms : [];
    const alarms  = allRaw.filter(a => !isPhantomAlarm(a));
    const filteredCount = allRaw.length - alarms.length;

    // ② 去重参照：上一轮抓取 + 近14天历史记录
    //    说明：天泽门户会把同一批报警显示多日，且抓取偶有不稳定（有时抓到0条），
    //    用 14 天窗口避免"隔几天重抓同名报警 → 又当成新增重复提醒"；
    //    同时保留边界：超过14天的同名报警视为新事件，仍会正常提醒（安全优先）
    const RECENT_WINDOW_MS = 14 * 24 * 3600 * 1000;
    const isRecent = (t) => {
        if (!t) return false;
        const d = new Date(String(t).replace(/-/g, '/'));
        return !isNaN(d.getTime()) && (Date.now() - d.getTime()) < RECENT_WINDOW_MS;
    };
    const seenRaws = new Set();
    const addSeen = (a) => { if (a && a.raw) seenRaws.add(a.raw); };
    oldData.tianze_alarms.forEach(addSeen);
    (oldData.alarm_history || []).filter(a => isRecent(a.time)).forEach(addSeen);

    // ③ 已确认状态 + id 继承映射（近14天内同 raw 的报警视为同一条，继承其确认结果与 id）
    //    重点：用户点过"无火情"的报警，重抓后不能回到"待确认"反复打扰
    const confirmMap = new Map();
    const idMap      = new Map();
    const remember = (a) => {
        if (!a || !a.raw) return;
        if (a.id && !idMap.has(a.raw)) idMap.set(a.raw, a.id);
        if (!confirmMap.has(a.raw) && a.confirm_status && a.confirm_status !== 'pending') {
            confirmMap.set(a.raw, {
                confirm_status: a.confirm_status,
                confirm_person: a.confirm_person || '',
                confirm_time:   a.confirm_time || '',
            });
        }
    };
    oldData.tianze_alarms.forEach(remember);
    (oldData.alarm_history || []).filter(a => isRecent(a.time)).forEach(remember);

    // 新增报警（从未见过的）
    const newAlarms = alarms
        .filter(a => !seenRaws.has(a.raw))
        .map(a => ({
            ...a,
            id:             `alarm_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            confirm_status: 'pending',
            confirm_person: '',
            confirm_time:   '',
        }));

    // 本轮抓取的完整列表（同一条报警继承 id 与已确认状态；新增的记录用刚生成的 id）
    const newIdMap = new Map(newAlarms.map(a => [a.raw, a.id]));
    const mergedAlarms = alarms.map(a => {
        let out = a;
        const id = idMap.get(a.raw) || newIdMap.get(a.raw);
        if (id) out = { ...out, id };
        const prev = confirmMap.get(a.raw);
        if (prev) out = { ...out, ...prev };
        return out;
    });

    return { alarms, newAlarms, mergedAlarms, cleanedCount, filteredCount };
}

// ============================================================
// 工具：HTTP/HTTPS 请求
// ============================================================
function request(url, options, body) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const lib = isHttps ? https : http;
        const urlObj = new URL(url);
        const opts = {
            hostname: urlObj.hostname,
            port:     urlObj.port || (isHttps ? 443 : 80),
            path:     urlObj.pathname + urlObj.search,
            method:   options.method || 'GET',
            headers:  options.headers || {},
            ...options,
        };
        const req = lib.request(opts, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ============================================================
// 工具：获取本机内网访问地址（IP 变化时自动适配）
// ============================================================
function getSiteUrl() {
    if (CONFIG.siteUrl) return CONFIG.siteUrl;
    try {
        const os = require('os');
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return `http://${iface.address}:8080`;
                }
            }
        }
    } catch {}
    return 'http://localhost:8080';
}

// ============================================================
// 工具：获取飞书 app_access_token
// ============================================================
async function getAppToken() {
    if (!CONFIG.appSecret) return null;
    try {
        const res = await request(
            'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            JSON.stringify({ app_id: CONFIG.appId, app_secret: CONFIG.appSecret })
        );
        return JSON.parse(res)?.app_access_token || null;
    } catch(e) {
        console.warn('⚠️  获取 app_access_token 失败:', e.message);
        return null;
    }
}

// ============================================================
// 工具：通过手机号查询 open_id
// ============================================================
async function getOpenId(phone, appToken) {
    if (!appToken) return null;
    try {
        const res = await request(
            'https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id',
            { method: 'POST', headers: { 'Authorization': `Bearer ${appToken}`, 'Content-Type': 'application/json' } },
            JSON.stringify({ mobiles: [phone] })
        );
        const list = JSON.parse(res)?.data?.user_list || [];
        return list.find(u => u.mobile === phone)?.user_id || null;
    } catch(e) {
        console.warn(`⚠️  查询 ${phone} open_id 失败:`, e.message);
        return null;
    }
}

// ============================================================ 
// 工具：推送火警通知（区域安全员机制）
//   ① 群卡片：广播火警明细 + @对应区域安全员（不含确认按钮 → 杜绝越权点击）
//   ② 私聊卡片：只发给该区域安全员本人，带确认按钮
//      （飞书私聊消息仅本人可见可点 → "只有该区域安全员能确认"由飞书保证）
//   ③ 安全员 openId 暂缺的区域 → 兜底转张乔私聊，避免漏处理
// ============================================================
async function sendFeishu(alarms) {
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过火警推送'); return; }
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const site = getSiteUrl();

    // ── 1. 按区域分组 ──
    const areaGroups = {};   // label -> { contact, alarms: [] }
    const unmatched  = [];
    alarms.forEach(a => {
        const loc = a.location || a.raw || '';
        const contact = matchArea(loc);
        if (contact) {
            if (!areaGroups[contact.label]) areaGroups[contact.label] = { contact, alarms: [] };
            areaGroups[contact.label].alarms.push(a);
        } else {
            unmatched.push(a);
        }
    });

    // ── 2. 群广播卡片（不含按钮）──
    let listContent = '';
    for (const [area, group] of Object.entries(areaGroups)) {
        const c  = group.contact;
        const at = c.openId ? `<at id="${c.openId}"></at>` : `@${c.name}`;
        listContent += `**【${area}】** 安全员：${at} ${c.name} 📞 ${c.phone}\n`;
        group.alarms.forEach((a, i) => {
            listContent += `　${i + 1}. 🔥 ${a.type || '火警'} | ⏰ ${a.time || now} | 📍 ${a.location || ''}\n`;
        });
        listContent += '\n';
    }
    // 未识别位置的报警不在群卡片单独成栏，仅记日志；数据仍写入 data.json、网页可查
    if (unmatched.length > 0) {
        console.log(`⚠️  ${unmatched.length} 条火警未能识别区域，已记录并在网页显示：`);
        unmatched.forEach((a, i) => console.log(`   未识别[${i + 1}] ${a.location || '未知位置'} | ${a.type || '火警'} | ${a.time || now}`));
    }

    const atSummary = Object.values(areaGroups)
        .map(g => g.contact.openId ? `<at id="${g.contact.openId}"></at>` : `@${g.contact.name}`)
        .join(' ');

    const groupCard = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `🚨 火警通知 · ${alarms.length} 条报警 · 请对应安全员确认` },
            template: 'red',
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**检测时间：** ${now}\n**报警数量：** ${alarms.length} 条\n**通知安全员：** ${atSummary || '—'}`,
                },
            },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: listContent || '请查看平台详情' } },
            { tag: 'hr' },
            {
                tag: 'note',
                elements: [{
                    tag: 'plain_text',
                    content: '⚠️ 确认卡片已单独私聊发送给对应区域安全员，只有该区域安全员本人可以点击确认；其他人请勿代操作。',
                }],
            },
        ],
    };

    for (const chatId of (CONFIG.chatIds || [])) {
        await sendGroupMsg(chatId, groupCard, appToken);
    }

    // ─ 3. 私聊确认卡片（只有对应安全员能收到并点击）──
    for (const [area, group] of Object.entries(areaGroups)) {
        const c        = group.contact;
        const targetId = c.openId || FALLBACK_CONTACT.openId;
        const toFallback = !c.openId;

        const ids  = group.alarms.map(a => a.id).filter(Boolean).join(',');
        // 兜底时（安全员不可达），确认人记为"张乔（代【区域】）"，避免平台显示成未实际操作的人
        const confirmer = toFallback ? `${FALLBACK_CONTACT.name}（代${area}）` : c.name;
        const urlSafe = `${site}?confirm=safe&ids=${encodeURIComponent(ids)}&area=${encodeURIComponent(area)}&name=${encodeURIComponent(confirmer)}&time=${encodeURIComponent(now)}`;
        const urlEmer = `${site}?confirm=emergency&ids=${encodeURIComponent(ids)}&area=${encodeURIComponent(area)}&name=${encodeURIComponent(confirmer)}&time=${encodeURIComponent(now)}`;

        const detail = group.alarms.map((a, i) => `　${i + 1}. 🔥 ${a.type || '火警'} |  ${a.time || now} | 📍 ${a.location || ''}`).join('\n');

        const pCard = {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: 'plain_text', content: `【${area}】火警确认 · 请现场核实` },
                template: 'red',
            },
            elements: [
                {
                    tag: 'div',
                    text: {
                        tag: 'lark_md',
                        content: `**${c.name} 您好：**\n您负责的 **【${area}】** 发生火警报警，请立即现场核实：\n${detail}` +
                            (toFallback ? `\n\n⚠️（该区域安全员暂未绑定飞书账号，先转由您处理）` : ''),
                    },
                },
                { tag: 'hr' },
                {
                    tag: 'action',
                    actions: [
                        { tag: 'button', text: { tag: 'plain_text', content: '✅ 已现场确认，无火情' },         type: 'primary', url: urlSafe },
                        { tag: 'button', text: { tag: 'plain_text', content: '🚒 现场发生火情，立即启动应急预案' }, type: 'danger',  url: urlEmer },
                    ],
                },
                { tag: 'hr' },
                { tag: 'note', elements: [{ tag: 'plain_text', content: '本卡片仅发送给您本人；点击按钮将记录您的确认结果并同步到管理平台。' }] },
            ],
        };

        let ok = await sendToUser(targetId, pCard, appToken);

        // 发送失败（如：该安全员不在机器人"应用可用范围"内）→ 自动转张乔兜底，避免漏报
        if (!ok && targetId !== FALLBACK_CONTACT.openId) {
            const fbConfirmer = `${FALLBACK_CONTACT.name}（代${area}）`;
            const fbSafe = `${site}?confirm=safe&ids=${encodeURIComponent(ids)}&area=${encodeURIComponent(area)}&name=${encodeURIComponent(fbConfirmer)}&time=${encodeURIComponent(now)}`;
            const fbEmer = `${site}?confirm=emergency&ids=${encodeURIComponent(ids)}&area=${encodeURIComponent(area)}&name=${encodeURIComponent(fbConfirmer)}&time=${encodeURIComponent(now)}`;
            const fbCard = {
                config: { wide_screen_mode: true },
                header: { title: { tag: 'plain_text', content: `【${area}】火警确认 · 原收件人不可达，转您处理` }, template: 'orange' },
                elements: [
                    {
                        tag: 'div',
                        text: {
                            tag: 'lark_md',
                            content: `**${FALLBACK_CONTACT.name} 您好：**\n【${area}】的火警确认卡片无法送达安全员 **${c.name}**（${c.phone}），` +
                                `原因：该账号不在本机器人的"应用可用范围"内。\n请协助跟进，或联系管理员将 TA 加入可用范围：\n${detail}`,
                        },
                    },
                    { tag: 'hr' },
                    {
                        tag: 'action',
                        actions: [
                            { tag: 'button', text: { tag: 'plain_text', content: '✅ 已现场确认，无火情' },         type: 'primary', url: fbSafe },
                            { tag: 'button', text: { tag: 'plain_text', content: '🚒 现场发生火情，立即启动应急预案' }, type: 'danger',  url: fbEmer },
                        ],
                    },
                    { tag: 'hr' },
                    { tag: 'note', elements: [{ tag: 'plain_text', content: `修复办法：飞书管理后台 → 该应用 → 版本管理与发布 → 可用范围，勾选 ${c.name} 所在部门。` }] },
                ],
            };
            const fbOk = await sendToUser(FALLBACK_CONTACT.openId, fbCard, appToken);
            console.log(fbOk
                ? `↪️  ${c.name}（${area}）不可达，已转张乔兜底`
                : `⚠️  ${c.name}（${area}）不可达，且兜底转发也失败`);
        } else {
            console.log(ok
                ? `✅ 已私聊 ${toFallback ? '张乔（兜底）' : c.name}（${area}）发送确认卡片`
                : `⚠️  私聊发送失败：${area}`);
        }
    }

    // ── 4. 未能识别区域的报警 → 转张乔核实 ──
    if (unmatched.length > 0) {
        const ids  = unmatched.map(a => a.id).filter(Boolean).join(',');
        const urlSafe = `${site}?confirm=safe&ids=${encodeURIComponent(ids)}&area=${encodeURIComponent(FALLBACK_CONTACT.label)}&name=${encodeURIComponent(FALLBACK_CONTACT.name)}&time=${encodeURIComponent(now)}`;
        const urlEmer = `${site}?confirm=emergency&ids=${encodeURIComponent(ids)}&area=${encodeURIComponent(FALLBACK_CONTACT.label)}&name=${encodeURIComponent(FALLBACK_CONTACT.name)}&time=${encodeURIComponent(now)}`;
        const detail = unmatched.map((a, i) => `　${i + 1}. 📍 ${a.location || '未知'} | 🔥 ${a.type || '火警'} | ⏰ ${a.time || now}`).join('\n');
        const fCard = {
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: `⚠️ 火警确认 · 请核实` }, template: 'orange' },
            elements: [
                { tag: 'div', text: { tag: 'lark_md', content: `**${FALLBACK_CONTACT.name} 您好：**\n以下火警请您核实并确认：\n${detail}` } },
                { tag: 'hr' },
                { tag: 'action', actions: [
                    { tag: 'button', text: { tag: 'plain_text', content: '✅ 已现场确认，无火情' },         type: 'primary', url: urlSafe },
                    { tag: 'button', text: { tag: 'plain_text', content: ' 现场发生火情，立即启动应急预案' }, type: 'danger',  url: urlEmer },
                ]},
                { tag: 'note', elements: [{ tag: 'plain_text', content: '本卡片仅发送给您本人；点击按钮将记录确认结果并同步到管理平台。' }] },
            ],
        };
        await sendToUser(FALLBACK_CONTACT.openId, fCard, appToken);
        console.log(`✅ 已私聊张乔核实 ${unmatched.length} 条未能识别区域的火警`);
    }
}

// ============================================================
// 工具：私聊发送卡片（receive_id_type=open_id）
// ============================================================
async function sendToUser(openId, card, appToken) {
    if (!openId) return false;
    const body = JSON.stringify({
        receive_id: openId,
        msg_type:   'interactive',
        content:    JSON.stringify(card),
    });
    try {
        const res = await request(
            'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
            { method: 'POST', headers: { 'Authorization': `Bearer ${appToken}`, 'Content-Type': 'application/json' } },
            body
        );
        const result = JSON.parse(res);
        if (result.code === 0) return true;
        console.warn(`⚠️  私聊消息失败(${openId.slice(-6)}): ${result.msg}`);
        return false;
    } catch(e) {
        console.error('❌ 私聊消息异常:', e.message);
        return false;
    }
}

// ============================================================
// 工具：应用机器人发群消息（chat_id 方式，支持多群）
// ============================================================
async function sendGroupMsg(chatId, card, appToken) {
    const body = JSON.stringify({
        receive_id: chatId,
        msg_type:   'interactive',
        content:    JSON.stringify(card),
    });
    try {
        const res = await request(
            'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
            { method: 'POST', headers: { 'Authorization': `Bearer ${appToken}`, 'Content-Type': 'application/json' } },
            body
        );
        const result = JSON.parse(res);
        if (result.code === 0) {
            console.log(`✅ 群消息发送成功: ...${chatId.slice(-8)}`);
            return true;
        } else {
            console.warn(`⚠️  群消息失败 (...${chatId.slice(-8)}): ${result.msg}`);
            return false;
        }
    } catch(e) {
        console.error(`❌ 群消息异常 (...${chatId.slice(-8)}):`, e.message);
        return false;
    }
}

// ============================================================
// 工具：推送到 GitHub
// ============================================================
function pushToGithub() {
    try {
        const dir = path.join(__dirname, '..');
        // 先 stash 所有未暂存改动，避免 rebase 报错
        execSync('git stash', { cwd: dir });
        execSync('git pull --rebase origin main', { cwd: dir });
        // 恢复 stash
        try { execSync('git stash pop', { cwd: dir }); } catch {}
        execSync('git add data.json', { cwd: dir });
        execSync('git diff --staged --quiet || git commit -m "fire data update"', { cwd: dir, shell: true });
        execSync('git push origin main', { cwd: dir });
        console.log('✅ 已推送到 GitHub，网页将自动更新');
    } catch(e) {
        console.log('⚠️  GitHub 推送失败（可能无变化）:', e.message.split('\n')[0]);
    }
}

// ============================================================
// 推送故障/预警到消防维保群，@孙伟和牛超
// ============================================================
async function sendFaultWarning(faults) {
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过故障推送'); return; }

    const sunweiId  = await getOpenId('18822077121', appToken) || '';
    const niuchaoId = await getOpenId('18515622585', appToken) || '';
    const now       = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    let listContent = '';
    faults.forEach((f, i) => {
        listContent += `${i + 1}. **【${f.type}】** ${f.device} · 接收时间：${f.recvTime}\n`;
    });

    faults.forEach(f => {
        const closeUrl = `${CONFIG.siteUrl}?close-fault=1&id=${encodeURIComponent(f.id)}&device=${encodeURIComponent(f.device)}&time=${encodeURIComponent(now)}`;
        f._closeUrl = closeUrl;
    });

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `⚠️ 故障/预警通知 · ${faults.length} 条 · 请孙伟/牛超处理` },
            template: 'orange',
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**检测时间：** ${now}\n**数量：** ${faults.length} 条\n**处理人：** <at id="${sunweiId}"></at> 孙伟 · <at id="${niuchaoId}"></at> 牛超`,
                },
            },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: `**故障/预警明细：**\n${listContent}` } },
            { tag: 'hr' },
            {
                tag: 'action',
                actions: faults.slice(0, 4).map(f => ({
                    tag:  'button',
                    text: { tag: 'plain_text', content: `✅ 整改完成：${f.device}` },
                    type: 'primary',
                    url:  f._closeUrl,
                })),
            },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '⚠️ 点击按钮后将在网页"故障巡查"中关闭对应任务单' }] },
        ],
    };

    // 只推送到消防维保群（已暂停）
    // const maintainChatId = 'oc_b362688580f805857fddc1a2d9df0ff9';
    const maintainChatId = null;
    if (!maintainChatId) { console.log('⏸️  消防维保群推送已暂停'); return; }
    await sendGroupMsg(maintainChatId, card, appToken);
}

// ============================================================
// 飞书 Base：从值机异常记录表同步值班记录到 data.json
// ============================================================
async function syncDutyRecords() {
    console.log('📥 开始同步飞书值班记录...');
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过值班记录同步'); return; }

    const BASE_TOKEN  = 'EZsjbgvvLayY7SsAJktcueMIn3f';
    const TABLE_ID    = 'tblyff4r53U4ZuCT';
    const PAGE_SIZE   = 100;

    let allRecords = [];
    let pageToken  = '';

    try {
        // 分页拉取全量记录
        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records?page_size=${PAGE_SIZE}${pageToken ? '&page_token=' + pageToken : ''}`;
            const res = await request(url, {
                method:  'GET',
                headers: { 'Authorization': `Bearer ${appToken}` },
            });
            const json = JSON.parse(res);
            if (json.code !== 0) { console.warn('⚠️  拉取记录失败:', json.msg); break; }
            const items = json.data?.items || [];
            allRecords = allRecords.concat(items);
            pageToken  = json.data?.has_more ? json.data.page_token : '';
        } while (pageToken);

        console.log(`📊 共拉取 ${allRecords.length} 条值班记录`);

        // 转换为网页 dutyData 格式：[序号, 时间, 部门, 主机信息, 系统类别, 设备, 状态, 原因, 处理]
        const dutyData = allRecords.map((item, idx) => {
            const f = item.fields || {};
            const time     = f['异常时间']     ? new Date(f['异常时间']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
            const dept     = Array.isArray(f['区域'])         ? f['区域'][0]         : (f['区域'] || '');
            const hostInfo = f['消防主机信息记录/隐患描述']    || f['隐患描述'] || '';
            const sysType  = Array.isArray(f['系统隐患类型'])  ? f['系统隐患类型'][0] : (f['系统隐患类型'] || '');
            const device   = f['设备名称'] || '';
            const status   = Array.isArray(f['异常状态'])      ? f['异常状态'][0]     : (f['异常状态'] || '');
            const reason   = Array.isArray(f['原因记录'])      ? f['原因记录'][0]     : (f['原因记录'] || '');
            const measure  = f['整改措施'] || '';
            return [idx + 1, time, dept, hostInfo, sysType, device, status, reason, measure];
        });

        // 从值班记录中提取火警记录，同步到天泽智联火警记录
        const feishuAlarms = allRecords
            .filter(item => {
                const s = Array.isArray(item.fields['异常状态']) ? item.fields['异常状态'][0] : item.fields['异常状态'];
                return s === '火警';
            })
            .map(item => {
                const f = item.fields || {};
                const time = f['异常时间'] ? new Date(f['异常时间']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
                const area = Array.isArray(f['区域']) ? f['区域'][0] : (f['区域'] || '未填写');
                const device = f['设备名称'] || '';
                const desc = f['消防主机信息记录/隐患描述'] || f['隐患描述'] || '';
                const fixStatus = Array.isArray(f['整改情况']) ? f['整改情况'][0] : (f['整改情况'] || '整改中');
                const closedBy = Array.isArray(f['责任人']) ? (f['责任人'][0]?.name || '') : '';
                const closedTime = f['实际完成时间'] ? new Date(f['实际完成时间']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
                // 匹配区域安全员
                const _c = matchArea(area) || FALLBACK_CONTACT;
                let responsible = _c.name, responsiblePhone = _c.phone;
                return {
                    id:             `feishu_alarm_${item.record_id}`,
                    time,
                    location:       device || area,
                    area,
                    type:           '火警',
                    status:         fixStatus,
                    responsible,
                    responsible_phone: responsiblePhone,
                    confirm_status: fixStatus === '整改完成' ? 'confirmed_safe' : 'pending',
                    confirm_person: closedBy,
                    confirm_time:   closedTime,
                    raw:            desc,
                    source:         'feishu',
                };
            });

        // 从值班记录中提取故障记录，同步到故障巡查
        const feishuFaults = allRecords
            .filter(item => {
                const s = Array.isArray(item.fields['异常状态']) ? item.fields['异常状态'][0] : item.fields['异常状态'];
                return s === '值机故障' || s === '反馈' || s === '预警';
            })
            .map(item => {
                const f = item.fields || {};
                const time = f['异常时间'] ? new Date(f['异常时间']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
                const area = Array.isArray(f['区域']) ? f['区域'][0] : (f['区域'] || '');
                const status = Array.isArray(f['异常状态']) ? f['异常状态'][0] : (f['异常状态'] || '');
                const fixStatus = Array.isArray(f['整改情况']) ? f['整改情况'][0] : (f['整改情况'] || '整改中');
                const closedBy = Array.isArray(f['责任人']) ? (f['责任人'][0]?.name || '') : '';
                const closedTime = f['实际完成时间'] ? new Date(f['实际完成时间']).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
                return {
                    id:          `feishu_fault_${item.record_id}`,
                    type:        status === '预警' ? '预警' : '故障',
                    device:      f['设备名称'] || '',
                    recvTime:    time,
                    createTime:  time,
                    raw:         f['消防主机信息记录/隐患描述'] || f['隐患描述'] || '',
                    status:      fixStatus === '整改完成' ? '整改完成' : '整改中',
                    closedBy,
                    closedTime,
                    area,
                    source:      'feishu',
                };
            });

        console.log(`🔥 飞书火警记录: ${feishuAlarms.length} 条，故障记录: ${feishuFaults.length} 条`);

        // 写入 data.json
        const dataFile = path.join(__dirname, '..', 'data.json');
        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(dataFile, 'utf-8')); } catch {}

        // 合并火警：保留天泽智联抓取的记录，追加飞书来源（按 id 去重）
        const existingAlarmIds = new Set((oldData.alarm_history || []).map(a => a.id));
        const newFeishuAlarms  = feishuAlarms.filter(a => !existingAlarmIds.has(a.id));

        // 合并故障：保留天泽抓取的记录，追加飞书来源（按 id 去重）
        const existingFaultIds = new Set((oldData.fault || []).map(f => f.id));
        const newFeishuFaults  = feishuFaults.filter(f => !existingFaultIds.has(f.id));

        const newData = {
            ...oldData,
            duty:              dutyData,
            _duty_updated:     new Date().toISOString(),
            alarm_history:     [...newFeishuAlarms, ...(oldData.alarm_history || [])].slice(0, 500),
            fault:             [...newFeishuFaults, ...(oldData.fault || [])].slice(0, 500),
        };
        fs.writeFileSync(dataFile, JSON.stringify(newData, null, 2));
        console.log(`✅ 值班记录已同步到 data.json（${dutyData.length} 条）`);
    } catch(e) {
        console.warn('⚠️  值班记录同步失败:', e.message);
    }
}

// ============================================================
// 同步飞书测试记录数据（每周一执行）
// ============================================================
async function syncTestRecords() {
    console.log('📥 开始同步飞书测试记录...');
    try {
        const { execSync } = require('child_process');
        const raw = execSync(
            'lark-cli base +record-list --base-token EZsjbgvvLayY7SsAJktcueMIn3f --table-id tblcoV9Bgs7RCY9H --as user --page-size 500 --output json',
            { encoding: 'utf-8', timeout: 30000 }
        );
        const parsed = JSON.parse(raw);
        const records = parsed?.data?.items || [];

        const testRecords = records.map(r => {
            const f = r.fields || {};
            return [
                '',                                                  // 序号（渲染时自动填充）
                (f['月份'] || [''])[0] || '',                       // 月份
                (f['系统类型'] || [''])[0] || '',                   // 测试内容
                f['区域点位测试总数'] || '',                         // 总数量
                '',                                                  // 季度
                '',                                                  // 半年
                f['隐患描述'] || '',                                 // 测试问题
                '',                                                  // 设备问题数
            ];
        }).filter(r => r[1] || r[2]);

        const dataFile = require('path').join(__dirname, '..', 'data.json');
        let data = {};
        try { data = JSON.parse(require('fs').readFileSync(dataFile, 'utf-8')); } catch {}
        data.testRecord = testRecords;
        require('fs').writeFileSync(dataFile, JSON.stringify(data, null, 2));
        console.log(`✅ 测试记录已同步（${testRecords.length} 条）`);
    } catch(e) {
        console.warn('⚠️  测试记录同步失败:', e.message);
    }
}

// ============================================================
// 测试计划数据（每月1日推送当月需执行项目）
// ============================================================
const TEST_PLAN = [
    { name: '消防电源配电柜·主备电源',         cycle: '每月'   },
    { name: '末端配电切换装置·切换功能',         cycle: '每半年' },
    { name: '火灾报警控制器·主备电工作状态',     cycle: '每月'   },
    { name: '火灾报警探测器·报警功能测试(10%)',  cycle: '每月'   },
    { name: '集中控制型系统·手动应急启动',       cycle: '每月'   },
    { name: '消防水池（水箱）·水位补水措施',     cycle: '每月'   },
    { name: '消火栓箱·外观及配件(10%)',          cycle: '每月'   },
    { name: '报警阀组·外观及报警试验',           cycle: '每月'   },
    { name: '排烟风机·手动/自动启动',            cycle: '每季度' },
    { name: '防火卷帘·手动/自动升降(10%)',       cycle: '每月'   },
];

// 判断当月需要执行的测试项
function getMonthlyTasks(month) {
    // month: 1-12
    return TEST_PLAN.filter(t => {
        if (t.cycle === '每月')   return true;
        if (t.cycle === '每季度') return [3, 6, 9, 12].includes(month);
        if (t.cycle === '每半年') return [6, 12].includes(month);
        if (t.cycle === '每年')   return month === 12;
        return false;
    });
}

// ============================================================
// 同步飞书保养记录到 data.json（每天执行）
// ============================================================
async function syncMaintenanceRecords() {
    console.log('📥 开始同步飞书保养记录...');
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过保养记录同步'); return; }

    const BASE_TOKEN = 'EZsjbgvvLayY7SsAJktcueMIn3f';
    const TABLE_ID   = 'tblTzKaHm8owsQH1';
    const PAGE_SIZE  = 100;

    let allRecords = [];
    let pageToken  = '';

    try {
        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records?page_size=${PAGE_SIZE}&text_field_option=html${pageToken ? '&page_token=' + pageToken : ''}`;
            const res = await request(url, {
                method:  'GET',
                headers: { 'Authorization': `Bearer ${appToken}` },
            });
            const json = JSON.parse(res);
            if (json.code !== 0) { console.warn('⚠️  拉取保养记录失败:', json.msg); break; }
            const items = json.data?.items || [];
            allRecords = allRecords.concat(items);
            pageToken  = json.data?.has_more ? json.data.page_token : '';
        } while (pageToken);

        console.log(`📊 共拉取 ${allRecords.length} 条保养记录`);

        // 辅助函数：去掉 HTML 标签，取纯文本
        const stripHtml = (str) => {
            if (!str) return '';
            return String(str).replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim();
        };

        // 辅助函数：安全提取飞书字段值（处理 lookup/select/text/number 等格式）
        const getField = (val) => {
            if (val === null || val === undefined) return '';
            if (typeof val === 'number') return String(val);
            if (typeof val === 'string') {
                // 可能是 HTML 字符串（text_field_option=html 模式）
                const clean = stripHtml(val);
                return (clean && !clean.startsWith('opt')) ? clean : '';
            }
            if (Array.isArray(val)) {
                return val.map(v => {
                    if (typeof v === 'number') return String(v);
                    if (typeof v === 'string') {
                        const clean = stripHtml(v);
                        return (clean && !clean.startsWith('opt')) ? clean : '';
                    }
                    if (v && typeof v === 'object') {
                        // lookup 字段：text 可能包含 HTML
                        const raw = v.text || v.value || v.name || '';
                        const clean = stripHtml(raw);
                        return (clean && !clean.startsWith('opt')) ? clean : '';
                    }
                    return '';
                }).filter(Boolean).join('、');
            }
            if (typeof val === 'object') {
                const raw = val.text || val.value || val.name || '';
                const clean = stripHtml(raw);
                return (clean && !clean.startsWith('opt')) ? clean : '';
            }
            return String(val);
        };

        // 转换为网页 recordData 格式（增强版）：[序号, 日期, 保养项目(完整), 月份, 数量, 详细内容, 系统名称, 频次, 保养状态]
        const recordData = allRecords.map((item) => {
            const f       = item.fields || {};
            // 优先取实际保养时间，其次计划保养日期，再次记录时间
            const rawDate = f['实际保养时间'] || f['计划保养日期'] || f['记录'] || null;
            const date    = rawDate ? new Date(rawDate).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
            const sysName = getField(f['系统名称']);
            // 保养项目是直接文本字段
            const project = typeof f['保养项目'] === 'string' ? f['保养项目'].trim()
                          : getField(f['保养项目']);
            const monthRaw = Array.isArray(f['计划实施月份']) ? f['计划实施月份'][0] : (f['计划实施月份'] || '');
            const month    = typeof monthRaw === 'string' ? monthRaw.replace(/["\[\]]/g, '').trim() : String(monthRaw);
            const qty      = f['保养设备数量'] ? String(f['保养设备数量'])
                           : (f['设备数量'] ? String(f['设备数量']) : '');
            const detail   = typeof f['保养内容'] === 'string' ? f['保养内容'].trim()
                           : getField(f['保养内容']);
            const freq     = typeof f['保养频次'] === 'string' ? f['保养频次'].trim()
                           : getField(f['保养频次']);
            const statusRaw = Array.isArray(f['保养情况']) ? f['保养情况'][0] : (f['保养情况'] || '');
            const status   = typeof statusRaw === 'string' ? statusRaw.replace(/^✅\s*/, '').trim() : String(statusRaw);
            return [0, date, project || sysName, month, qty, detail || project, sysName, freq, status];
        }).filter(r => r[1]); // 过滤掉没有日期的记录

        // 按月份高到低（同月份再按日期倒序）
        recordData.sort((a, b) => {
            const ma = parseInt(a[3]) || 0, mb = parseInt(b[3]) || 0;
            if (mb !== ma) return mb - ma;
            return new Date(b[1]) - new Date(a[1]);
        });
        // 重新编号
        recordData.forEach((r, i) => { r[0] = i + 1; });

        // 写入 data.json（不限制条数，全量保存）
        const dataFile = path.join(__dirname, '..', 'data.json');
        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(dataFile, 'utf-8')); } catch {}
        const newData = { ...oldData, record: recordData, _record_updated: new Date().toISOString() };
        fs.writeFileSync(dataFile, JSON.stringify(newData, null, 2));
        console.log(`✅ 保养记录已同步到 data.json（${recordData.length} 条，按月份倒序）`);
    } catch(e) {
        console.warn('⚠️  保养记录同步失败:', e.message);
    }
}

// ============================================================
// 推送月度测试计划到飞书群
// ============================================================
async function sendMonthlyTestPlan() {
    const now   = new Date();
    const month = now.getMonth() + 1;
    const year  = now.getFullYear();
    const tasks = getMonthlyTasks(month);
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过测试计划推送'); return; }

    // 通过手机号动态查询孙伟和牛超的 open_id
    const sunweiId  = await getOpenId('18822077121', appToken) || '';
    const niuchaoId = await getOpenId('18515622585', appToken) || '';

    let listContent = '';
    tasks.forEach((t, i) => {
        listContent += `${i + 1}. ${t.name}（${t.cycle}）\n`;
    });

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `🧪 ${year}年${month}月 消防测试计划` },
            template: 'blue',
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**执行月份：** ${year}年${month}月\n**本月任务数：** ${tasks.length} 项\n**执行人：** <at id="${sunweiId}"></at> 孙伟 · <at id="${niuchaoId}"></at> 牛超`,
                },
            },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: `**本月需执行测试项目：**\n${listContent}` } },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '⚠️ 请按计划完成测试并录入测试记录，季度/半年项目已自动纳入本月' }] },
        ],
    };

    console.log(`📅 推送 ${year}年${month}月 测试计划（共 ${tasks.length} 项）...`);
    for (const chatId of CONFIG.chatIds) {
        await sendGroupMsg(chatId, card, appToken);
    }
}

// ============================================================
// 同步培训记录（每天执行）
// ============================================================
async function syncTrainingRecords() {
    console.log('📥 开始同步飞书培训记录...');
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过培训记录同步'); return; }

    const BASE_TOKEN = 'EZsjbgvvLayY7SsAJktcueMIn3f';
    const TABLE_ID   = 'tbltwZRL9iwZjk6o';
    const PAGE_SIZE  = 100;

    let allRecords = [];
    let pageToken  = '';

    try {
        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records?page_size=${PAGE_SIZE}${pageToken ? '&page_token=' + pageToken : ''}`;
            const res = await request(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${appToken}` },
            });
            const json = JSON.parse(res);
            if (json.code !== 0) { console.warn('⚠️  拉取培训记录失败:', json.msg); break; }
            allRecords = allRecords.concat(json.data?.items || []);
            pageToken  = json.data?.has_more ? json.data.page_token : '';
        } while (pageToken);

        console.log(`📊 共拉取 ${allRecords.length} 条培训记录`);

        // 转换为网页 trainingData 格式：
        // [月份, 人员考核类别, 姓名1, 理论1, 实操1, 姓名2, 理论2, 实操2, 姓名3, 理论3, 实操3, 合格率]
        // 按 年月 + 人员考核 分组，每组最多3人
        const groups = {};
        allRecords.forEach(item => {
            const f     = item.fields || {};
            const yearMonth = f['年月'] || '';
            const category  = Array.isArray(f['人员考核']) ? f['人员考核'][0] : (f['人员考核'] || '');
            const name      = Array.isArray(f['人员姓名']) ? (f['人员姓名'][0]?.name || '') : '';
            const theory    = f['培训考试成绩'] || '';
            const practical = f['实操成绩'] || '';
            const qualified = Array.isArray(f['人员考核']) ? f['人员考核'][0] === '合格' : false;
            const key = `${yearMonth}__${category}`;
            if (!groups[key]) groups[key] = { yearMonth, category, members: [], qualifiedCount: 0 };
            groups[key].members.push({ name, theory, practical, qualified });
            if (qualified) groups[key].qualifiedCount++;
        });

        const trainingData = Object.values(groups)
            .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth))
            .map(g => {
                const m = g.members.slice(0, 3);
                while (m.length < 3) m.push({ name: '—', theory: '', practical: '' });
                const total     = g.members.length;
                const qualified = g.members.filter(p => p.qualified).length;
                const rate      = total > 0 ? Math.round(qualified / total * 100) + '%' : '—';
                // 月份格式转换：2026-01 → 1月份
                const monthLabel = g.yearMonth ? (parseInt(g.yearMonth.split('-')[1]) + '月份') : '—';
                return [
                    monthLabel, g.category,
                    m[0].name, m[0].theory, m[0].practical,
                    m[1].name, m[1].theory, m[1].practical,
                    m[2].name, m[2].theory, m[2].practical,
                    rate
                ];
            });

        const dataFile = path.join(__dirname, '..', 'data.json');
        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(dataFile, 'utf-8')); } catch {}
        const newData = { ...oldData, training: trainingData, _training_updated: new Date().toISOString() };
        fs.writeFileSync(dataFile, JSON.stringify(newData, null, 2));
        console.log(`✅ 培训记录已同步到 data.json（${trainingData.length} 组）`);
    } catch(e) {
        console.warn('⚠️  培训记录同步失败:', e.message);
    }
}

// ============================================================
// 同步消防隐患汇总表→故障巡查（每天执行）
// ============================================================
async function syncFaultRecords() {
    console.log('📥 开始同步飞书故障巡查记录...');
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过故障巡查同步'); return; }

    const BASE_TOKEN = 'EZsjbgvvLayY7SsAJktcueMIn3f';
    const TABLE_ID   = 'tblO6Cm2RyLsy409';
    const PAGE_SIZE  = 500; // 飞书 API 最大支持 500

    let allRecords = [];
    let pageToken  = '';
    let page       = 0;

    try {
        do {
            page++;
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records?page_size=${PAGE_SIZE}${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
            const res = await request(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${appToken}` },
            });
            const json = JSON.parse(res);
            if (json.code !== 0) { console.warn('⚠️  拉取故障巡查失败:', json.msg); break; }
            const items = json.data?.items || [];
            allRecords = allRecords.concat(items);
            console.log(`  第${page}页：${items.length} 条，累计 ${allRecords.length} 条`);
            pageToken = json.data?.has_more ? (json.data.page_token || '') : '';
        } while (pageToken);

        console.log(`📊 共拉取 ${allRecords.length} 条故障巡查记录`);

        // 转换为网页 faultData 格式：
        // [序号, 检查主题, 时间, 隐患类型, 位置, 设备名称, 状态, 原因, 描述, 责任人, 整改措施, 整改情况]
        const faultData = allRecords
            .sort((a, b) => {
                const ta = a.fields?.['时间'] || 0;
                const tb = b.fields?.['时间'] || 0;
                return tb - ta; // 最新的排最前
            })
            .map((item, idx) => {
                const f = item.fields || {};
                const time       = f['时间'] ? new Date(f['时间']).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
                const category   = Array.isArray(f['项目内容'])   ? f['项目内容'][0]   : (f['项目内容']   || '—');
                const hazardType = Array.isArray(f['隐患类型'])   ? f['隐患类型'][0]   : (f['隐患类型']   || '—');
                const location   = Array.isArray(f['隐患位置'])   ? f['隐患位置'][0]   : (f['隐患位置']   || '—');
                const dept       = Array.isArray(f['责任部门'])   ? f['责任部门'][0]   : (f['责任部门']   || '—');
                const person     = Array.isArray(f['责任人'])     ? (f['责任人'][0]?.name || '—') : '—';
                const desc       = f['隐患描述']   || '—';
                const measure    = f['整改措施']   || '—';
                const status     = Array.isArray(f['整改情况'])   ? f['整改情况'][0]   : (f['整改情况']   || '整改中');
                return [idx + 1, category, time, hazardType, location, desc, status, person, desc, person, measure, status === '整改完成' ? '已整改' : '整改中'];
            });

        const dataFile = path.join(__dirname, '..', 'data.json');
        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(dataFile, 'utf-8')); } catch {}
        const newData = { ...oldData, fault: faultData, _fault_updated: new Date().toISOString() };
        fs.writeFileSync(dataFile, JSON.stringify(newData, null, 2));
        console.log(`✅ 故障巡查已同步到 data.json（${faultData.length} 条）`);
    } catch(e) {
        console.warn('⚠️  故障巡查同步失败:', e.message);
    }
}

// ============================================================
// 同步保养计划（每天执行）
// ============================================================
async function syncMaintainPlan() {
    console.log('📥 开始同步飞书保养计划...');
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过保养计划同步'); return; }

    const BASE_TOKEN = 'EZsjbgvvLayY7SsAJktcueMIn3f';
    const TABLE_ID   = 'tblTzKaHm8owsQH1';
    const PAGE_SIZE  = 100;

    let allRecords = [];
    let pageToken  = '';

    try {
        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records?page_size=${PAGE_SIZE}${pageToken ? '&page_token=' + pageToken : ''}`;
            const res = await request(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${appToken}` },
            });
            const json = JSON.parse(res);
            if (json.code !== 0) { console.warn('⚠️  拉取保养计划失败:', json.msg); break; }
            allRecords = allRecords.concat(json.data?.items || []);
            pageToken  = json.data?.has_more ? json.data.page_token : '';
        } while (pageToken);

        console.log(`📊 共拉取 ${allRecords.length} 条保养计划`);

        // 转换为网页 maintainPlan 格式（对应网页保养计划表格）
        // 网页格式：[序号, 系统名称, 保养项目, 保养内容, 保养频次, 计划实施月份, 保养情况]
        const maintainPlan = allRecords
            .filter(item => {
                const f = item.fields || {};
                return f['保养项目'] || f['保养内容'];
            })
            .map((item, idx) => {
                const f = item.fields || {};
                const month    = Array.isArray(f['计划实施月份']) ? f['计划实施月份'][0] : (f['计划实施月份'] || '—');
                const project  = f['保养项目']  || '—';
                const content  = f['保养内容']  || '—';
                const freq     = f['保养频次']  || '—';
                const system   = f['系统名称']  || '—';
                const status   = Array.isArray(f['保养情况']) ? f['保养情况'][0] : (f['保养情况'] || '—');
                return [idx + 1, system, project, content, freq, month, status];
            })
            .sort((a, b) => {
                // 按月份排序
                const monthOrder = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
                return monthOrder.indexOf(a[5]) - monthOrder.indexOf(b[5]);
            });

        const dataFile = path.join(__dirname, '..', 'data.json');
        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(dataFile, 'utf-8')); } catch {}
        const newData = { ...oldData, maintainPlan, _maintain_plan_updated: new Date().toISOString() };
        fs.writeFileSync(dataFile, JSON.stringify(newData, null, 2));
        console.log(`✅ 保养计划已同步到 data.json（${maintainPlan.length} 条）`);
    } catch(e) {
        console.warn('⚠️  保养计划同步失败:', e.message);
    }
}


// ============================================================
// 同步设施巡查记录（17个区域表 → data.json 的 facilityInspections）
// 每月自动更新，网页只展示当月；OK=无问题，NG=有问题
// ============================================================
const FACILITY_TABLES = [
    { id: 'tblZxef96Z6WhIxb', name: '消控室' },
    { id: 'tblfDvwtiB6dSXsj', name: '办公楼' },
    { id: 'tbl5Vrc2dQ5kZS8M', name: '冲压' },
    { id: 'tblrn2OhB2SfzVfu', name: '焊装' },
    { id: 'tblRnEYZfhUc90dx', name: '总装' },
    { id: 'tblZOxZbioECuiM5', name: '餐厅' },
    { id: 'tblkpCsX8O26nSyC', name: '涂装' },
    { id: 'tblGoyImZXIkShIX', name: '消防水泵房' },
    { id: 'tblNksx9Z2ExoWWq', name: '综合站房' },
    { id: 'tbl0y5m32tnq34Y4', name: '污水站' },
    { id: 'tbllr8xeyeUeTBS2', name: '物流LOC' },
    { id: 'tblFGqWWKzGEaKAe', name: '1号仓库' },
    { id: 'tbliu3Izsm4EHZDk', name: '2号仓库' },
    { id: 'tblf3pnHWNxEWGZC', name: '售后备件库' },
    { id: 'tbl5GTm1Xbzs36zO', name: '交检' },
    { id: 'tblZeHL2SAU1PcUg', name: '4#厂房' },
    { id: 'tblBjlvfucGYLYsL', name: '厂区' },
];

// 系统检查字段的识别规则（排除照片/人员等非检查字段）
const FACILITY_SKIP_KEYS = ['照片','地理位置','提交人','人员','巡查人员','巡查区域','单选','文本','record_id','区域','姓名','提交时间','巡查日期'];

async function syncFacilityInspections() {
    console.log('📥 开始同步设施巡查记录...');
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过设施巡查同步'); return; }

    const BASE_TOKEN = 'NrR0bFXlMasyX7suJKmcwzdGn8M';
    const byArea = [];
    let totalOk = 0, totalNg = 0;

    try {
        for (const tbl of FACILITY_TABLES) {
            let items = [], pageToken = '';
            do {
                const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tbl.id}/records?page_size=200${pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''}`;
                const res = await request(url, { method: 'GET', headers: { 'Authorization': `Bearer ${appToken}` } });
                const json = JSON.parse(res);
                if (json.code !== 0) { console.warn(`⚠️  ${tbl.name} 拉取失败:`, json.msg); break; }
                items = items.concat(json.data?.items || []);
                pageToken = json.data?.has_more ? (json.data.page_token || '') : '';
            } while (pageToken);

            // 统计每个区域的 OK / NG / 日期明细 / NG 清单
            const areaStat = { area: tbl.name, records: [], ok: 0, ng: 0, ngItems: [], dates: [] };

            for (const it of items) {
                const f  = it.fields || {};
                const ts = f['巡查时间'] || f['提交时间'] || f['巡查日期'] || null;
                const dateStr = ts ? new Date(Number(ts)).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';

                const recStat = { date: dateStr, ok: 0, ng: 0, ngSystems: [], problems: [] };
                for (const [k, v] of Object.entries(f)) {
                    if (FACILITY_SKIP_KEYS.some(sk => k.includes(sk))) continue;
                    if (k.endsWith('照片')) continue;
                    const val = Array.isArray(v) ? (v[0] || '') : (typeof v === 'string' ? v : '');
                    if (val === 'OK') { recStat.ok++; areaStat.ok++; }
                    else if (val === 'NG') {
                        recStat.ng++; areaStat.ng++;
                        recStat.ngSystems.push(k);
                        areaStat.ngItems.push({ date: dateStr, system: k });
                    }
                }
                // 问题记录文本
                for (const k of Object.keys(f)) {
                    if (k.includes('问题记录') && f[k]) recStat.problems.push(String(f[k]));
                }
                if (dateStr) areaStat.dates.push(dateStr);
                areaStat.records.push(recStat);
            }

            areaStat.dates.sort();
            areaStat.lastDate = areaStat.dates[areaStat.dates.length - 1] || '';
            totalOk += areaStat.ok; totalNg += areaStat.ng;
            byArea.push(areaStat);
            console.log(`   ${tbl.name}: ${items.length} 条记录 | OK=${areaStat.ok} NG=${areaStat.ng} | 最近 ${areaStat.lastDate || '—'}`);
        }

        // 写入 data.json
        const dataFile = path.join(__dirname, '..', 'data.json');
        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(dataFile, 'utf-8')); } catch {}

        const newData = {
            ...oldData,
            facilityInspections: {
                updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
                month:     (() => {
                    const d = new Date();
                    const bj = new Date(d.getTime() + (d.getTimezoneOffset() * 60000) + (8 * 3600000));
                    return `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, '0')}`;
                })(),
                totalOk, totalNg,
                areas: byArea,
            },
        };
        fs.writeFileSync(dataFile, JSON.stringify(newData, null, 2));
        console.log(`✅ 设施巡查已同步（${byArea.length} 个区域，OK=${totalOk} NG=${totalNg}）`);
    } catch(e) {
        console.warn('⚠️  设施巡查同步失败:', e.message);
    }
}

// ============================================================
// 同步防火巡查记录（单表 tblIKaQ1BtB6rQoo → data.json 的 fireInspections）
// 按月度 + 类别统计：OK=无问题，NG=有问题；网页"防火巡查"页按月展示分类分析
// ============================================================
const FIRE_TABLE = 'tblIKaQ1BtB6rQoo';   // 防火巡查表
// 10 个巡查类别（按表内出现顺序；名称即飞书字段名）
const FIRE_CHECK_KEYS = [
    '防火分隔、安全疏散管理措施落实情况',
    '安全疏散设施管理情况',
    '消防水源',
    '消火栓系统',
    '自动喷水灭火系统',
    '火灾自动报警系统',
    '机械防烟排烟系统',
    '灭火器',
    '消防控制中心值班情况',
    '其他重点部位值班情况',
];

async function syncFireInspections() {
    console.log('📥 开始同步防火巡查记录...');
    const appToken = await getAppToken();
    if (!appToken) { console.warn('⚠️  获取 token 失败，跳过防火巡查同步'); return; }

    const BASE_TOKEN = 'NrR0bFXlMasyX7suJKmcwzdGn8M';

    try {
        // 拉全量记录（分页）
        let items = [], pageToken = '';
        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${FIRE_TABLE}/records?page_size=200${pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''}`;
            const res = await request(url, { method: 'GET', headers: { 'Authorization': `Bearer ${appToken}` } });
            const json = JSON.parse(res);
            if (json.code !== 0) { console.warn('⚠️  防火巡查拉取失败:', json.msg); return; }
            items = items.concat(json.data?.items || []);
            pageToken = json.data?.has_more ? (json.data.page_token || '') : '';
        } while (pageToken);

        // 月份工具（UTC+8）
        const toMonth = (ts) => {
            if (!ts) return '';
            const d  = new Date(Number(ts));
            const bj = new Date(d.getTime() + 8 * 3600 * 1000);
            return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}`;
        };
        const toDateStr = (ts) => {
            if (!ts) return '';
            const d  = new Date(Number(ts));
            const bj = new Date(d.getTime() + 8 * 3600 * 1000);
            return `${bj.getUTCFullYear()}/${bj.getUTCMonth() + 1}/${bj.getUTCDate()}`;
        };

        const nowMonth = (() => {
            const d = new Date();
            const bj = new Date(d.getTime() + (d.getTimezoneOffset() * 60000) + (8 * 3600000));
            return `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, '0')}`;
        })();

        // 结构：
        //   byCategory: 10 类各月 OK/NG 累计（跨月，前端按 currentMonth 过滤展示当月）
        //   records:    逐条记录（日期、提交人、各类 OK/NG、问题记录）
        //   months:     有数据的月份清单 [{month, records, ok, ng}]
        const byCategory = FIRE_CHECK_KEYS.map(k => ({ name: k, ok: 0, ng: 0, months: {} }));
        const monthAgg   = {};   // month -> { records, ok, ng }
        const records    = [];

        for (const it of items) {
            const f  = it.fields || {};
            const ts = f['巡查日期'] || f['提交时间'] || null;
            const month = toMonth(ts);
            const dateStr = toDateStr(ts);
            const submitter = f['提交人'] ? (f['提交人'].name || '') : '';
            const inspector = Array.isArray(f['巡查人员'])
                ? f['巡查人员'].map(p => p && p.name).filter(Boolean).join('/')
                : (f['巡查人员'] && f['巡查人员'].name) || '';
            const problems = [];
            ['1问题记录', '2问题记录'].forEach(k => { if (f[k]) problems.push(String(f[k])); });

            const recCat = {};   // 本条记录各类别结果
            let recOk = 0, recNg = 0;
            FIRE_CHECK_KEYS.forEach((k, idx) => {
                const val = f[k];
                recCat[k] = val || '';
                if (val === 'OK') { recOk++; byCategory[idx].ok++;
                    if (month) { const m = byCategory[idx].months[month] || (byCategory[idx].months[month] = { ok: 0, ng: 0 }); m.ok++; } }
                else if (val === 'NG') { recNg++; byCategory[idx].ng++;
                    if (month) { const m = byCategory[idx].months[month] || (byCategory[idx].months[month] = { ok: 0, ng: 0 }); m.ng++; } }
            });

            if (month) {
                const agg = monthAgg[month] || (monthAgg[month] = { records: 0, ok: 0, ng: 0 });
                agg.records++; agg.ok += recOk; agg.ng += recNg;
            }

            records.push({
                date: dateStr, month, submitter, inspector,
                ok: recOk, ng: recNg,
                categories: recCat,
                ngKeys: FIRE_CHECK_KEYS.filter(k => recCat[k] === 'NG'),
                problems,
                recordId: it.record_id,
            });
        }

        // 排序：记录按日期倒序；月份列表倒序
        records.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const months = Object.keys(monthAgg).sort().reverse().map(m => ({ month: m, ...monthAgg[m] }));

        const totalOk = byCategory.reduce((s, c) => s + c.ok, 0);
        const totalNg = byCategory.reduce((s, c) => s + c.ng, 0);

        // 写入 data.json
        const dataFile = path.join(__dirname, '..', 'data.json');
        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(dataFile, 'utf-8')); } catch {}

        const newData = {
            ...oldData,
            fireInspections: {
                updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
                currentMonth: nowMonth,
                totalRecords: records.length,
                totalOk, totalNg,
                byCategory, months, records,
            },
        };
        fs.writeFileSync(dataFile, JSON.stringify(newData, null, 2));
        console.log(`✅ 防火巡查已同步（${records.length} 条记录，${months.length} 个月份，OK=${totalOk} NG=${totalNg}）`);
    } catch(e) {
        console.warn('⚠️  防火巡查同步失败:', e.message);
    }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
    console.log(`\n🕐 ${new Date().toLocaleString('zh-CN')} 开始检查天泽智联...`);

    // 每月1日自动推送本月测试计划
    const today = new Date();
    if (today.getDate() === 1) {
        await sendMonthlyTestPlan();
    }

    const chromePaths = [
        CONFIG.chromePath,
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    let executablePath = null;
    for (const p of chromePaths) {
        if (fs.existsSync(p)) { executablePath = p; break; }
    }
    if (!executablePath) { console.error('❌ 找不到 Chrome/Edge'); process.exit(1); }
    console.log(`🌐 使用浏览器: ${executablePath}`);

    const browser = await puppeteer.launch({
        executablePath,
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });

        console.log(`🌐 访问: ${CONFIG.url}`);
        await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: CONFIG.screenshotFile });
        console.log('📸 截图已保存');

        await new Promise(r => setTimeout(r, 2000));
        const inputs = await page.$$('input');
        console.log(`🔍 找到 ${inputs.length} 个输入框`);

        if (inputs.length >= 2) {
            await inputs[0].click({ clickCount: 3 });
            await inputs[0].type(CONFIG.username, { delay: 50 });
            await inputs[1].click({ clickCount: 3 });
            await inputs[1].type(CONFIG.password, { delay: 50 });
            console.log('✅ 已填写账号密码');

            const btns = await page.$$('button');
            for (const btn of btns) {
                const text = await btn.evaluate(el => el.textContent);
                if (text.includes('登录') || text.includes('Login')) {
                    await btn.click();
                    console.log('✅ 已点击登录按钮');
                    break;
                }
            }
            await new Promise(r => setTimeout(r, 3000));
            await page.screenshot({ path: CONFIG.screenshotFile });
        }

        const alarms = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('*').forEach(el => {
                const text = el.textContent || '';
                if ((text.includes('火警') || text.includes('报警')) &&
                    el.children.length === 0 && text.trim().length < 100) {
                    const parent = el.closest('[class]');
                    const parentText = parent
                        ? parent.textContent.trim().replace(/\s+/g, ' ').substring(0, 150)
                        : text.trim();
                    if (parentText && !results.some(r => r.raw === parentText)) {
                        results.push({
                            time:     new Date().toLocaleString('zh-CN'),
                            location: text.trim(),
                            type:     text.includes('火警') ? '火警' : '报警',
                            status:   '待处理',
                            raw:      parentText,
                        });
                    }
                }
            });
            document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="popup"],[class*="alert"]')
                .forEach(modal => {
                    const text = modal.textContent.trim().replace(/\s+/g, ' ').substring(0, 200);
                    if (text.includes('火警') || text.includes('报警')) {
                        results.push({ time: new Date().toLocaleString('zh-CN'), location: '弹窗报警', type: '火警', status: '待处理', raw: text });
                    }
                });
            return results.slice(0, 20);
        });

        // ⚠️ 测试模式：模拟故障/预警弹窗（仅调试用，正式运行必须为 false，否则会向数据里塞假故障）
        const TEST_FAULT_MODE = false;  // 正式运行保持 false

        // 读取故障和预警弹窗
        const faultWarnings = TEST_FAULT_MODE ? [
            { type: '故障', device: '可燃气体探测器（测试）', recvTime: new Date().toLocaleString('zh-CN'), raw: '故障提醒（共1条） 可燃气体探测器（测试） 平台最新接收时间：' + new Date().toLocaleString('zh-CN') },
            { type: '预警', device: '感烟探测器（测试）',     recvTime: new Date().toLocaleString('zh-CN'), raw: '预警提醒（共1条） 感烟探测器（测试） 平台最新接收时间：' + new Date().toLocaleString('zh-CN') },
        ] : await page.evaluate(() => {
            const results = [];
            const now = new Date().toLocaleString('zh-CN');

            // 读取所有弹窗/提示框
            document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="popup"],[class*="alert"],[class*="notice"],[class*="tip"],[class*="remind"]')
                .forEach(el => {
                    const text = el.textContent.trim().replace(/\s+/g, ' ');
                    if (!text) return;

                    // 故障提醒弹窗
                    if (text.includes('故障提醒') || text.includes('故障')) {
                        const titleMatch = text.match(/故障提醒[（(]共(\d+)条[）)]/);
                        const count = titleMatch ? parseInt(titleMatch[1]) : 1;
                        // 提取设备名称和时间
                        const items = el.querySelectorAll ? el.querySelectorAll('*') : [];
                        let device = '', recvTime = '';
                        items.forEach(item => {
                            const t = item.textContent.trim();
                            if (t && item.children.length === 0) {
                                if (t.includes('平台最新接收时间')) {
                                    recvTime = t.replace('平台最新接收时间：', '').trim();
                                } else if (t.length < 30 && !t.includes('提醒') && !t.includes('查看')) {
                                    device = t;
                                }
                            }
                        });
                        if (device || recvTime) {
                            results.push({ type: '故障', device: device || '未知设备', recvTime: recvTime || now, raw: text.substring(0, 150) });
                        }
                    }

                    // 预警提醒弹窗
                    if (text.includes('预警提醒') || (text.includes('预警') && !text.includes('火警'))) {
                        const items = el.querySelectorAll ? el.querySelectorAll('*') : [];
                        let device = '', recvTime = '';
                        items.forEach(item => {
                            const t = item.textContent.trim();
                            if (t && item.children.length === 0) {
                                if (t.includes('平台最新接收时间')) {
                                    recvTime = t.replace('平台最新接收时间：', '').trim();
                                } else if (t.length < 30 && !t.includes('提醒') && !t.includes('查看')) {
                                    device = t;
                                }
                            }
                        });
                        if (device || recvTime) {
                            results.push({ type: '预警', device: device || '未知设备', recvTime: recvTime || now, raw: text.substring(0, 150) });
                        }
                    }
                });
            return results;
        });  // end page.evaluate（TEST_FAULT_MODE=false 时生效）

        console.log(`⚠️  检测到 ${faultWarnings.length} 条故障/预警`);

        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf-8')); } catch {}

        // 页面噪点过滤 + 去重（含近3天历史）+ 已确认状态继承
        // 修复两个历史问题：①菜单/图例文字被误抓成火警反复提醒；②抓取波动导致旧报警重复"新增"、已确认状态被冲掉
        const proc = processScrapedAlarms(oldData, alarms);
        const { newAlarms, mergedAlarms } = proc;
        console.log(`🧹 过滤页面噪点: 本轮 ${proc.filteredCount} 条, 历史遗留 ${proc.cleanedCount} 条`);
        console.log(`🆕 新增火警: ${newAlarms.length} 条 | 本轮抓取 ${mergedAlarms.length} 条`);

        newAlarms.forEach(a => {
            const loc = a.location || a.raw || '';
            const c = matchArea(loc) || FALLBACK_CONTACT;
            a.area = c.label; a.responsible = c.name; a.responsible_phone = c.phone;
        });

        // 处理故障/预警：与历史记录对比，找出新增的
        const oldFaultRaws = new Set((oldData.fault || []).map(f => f.raw));
        const newFaults = faultWarnings
            .filter(f => !oldFaultRaws.has(f.raw))
            .map(f => ({
                id:          `fault_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                type:        f.type,
                device:      f.device,
                recvTime:    f.recvTime,
                raw:         f.raw,
                status:      '整改中',
                closedBy:    '',
                closedTime:  '',
                createTime:  new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            }));

        console.log(`🆕 新增故障/预警: ${newFaults.length} 条`);

        const newData = {
            ...oldData,
            _updated:          new Date().toISOString(),
            _source:           'local_scrape',
            tianze_alarms:     mergedAlarms,
            tianze_last_check: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            tianze_new_count:  newAlarms.length,
            alarm_history:     [...newAlarms, ...(oldData.alarm_history || [])].slice(0, 500),
            fault:             [...newFaults, ...(oldData.fault || [])].slice(0, 500),
        };
        fs.writeFileSync(CONFIG.dataFile, JSON.stringify(newData, null, 2));
        console.log('✅ data.json 已更新');

        if (newAlarms.length > 0) {
            console.log('🔔 发现新火警，推送飞书通知...');
            await sendFeishu(newAlarms);
        }

        // 推送故障/预警到消防维保群
        if (newFaults.length > 0) {
            console.log('🔔 发现新故障/预警，推送飞书通知...');
            await sendFaultWarning(newFaults);
        }

        // 每次运行都同步飞书值班记录
        await syncDutyRecords();

        // 每月28日同步保养记录（全量）；若 data.json 中还没有保养记录则立即同步一次
        const existingRecord = (oldData && oldData.record && oldData.record.length > 0);
        if (today.getDate() === 28 || !existingRecord) {
            await syncMaintenanceRecords();
        }

        // 每天同步培训记录
        await syncTrainingRecords();

        // 每天同步故障巡查（消防隐患汇总表）
        await syncFaultRecords();

        // 每天同步保养计划
        await syncMaintainPlan();

        // 同步设施巡查记录（17个区域，OK/NG 分析）
        await syncFacilityInspections();

        // 同步防火巡查记录（按月+按类别统计）
        await syncFireInspections();

        // 每周一同步飞书测试记录数据
        if (today.getDay() === 1) {
            await syncTestRecords();
        }

        pushToGithub();

    } finally {
        await browser.close();
        console.log('🔒 浏览器已关闭');
    }
}

main().catch(err => {
    console.error('❌ 运行失败:', err.message);
    process.exit(1);
});
