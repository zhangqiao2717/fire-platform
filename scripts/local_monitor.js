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
    appId:     'cli_aadddd5e85f81bd1',
    appSecret: 'HcRDNeBimwNvg9N1DLQOVhsiOG5L3okI',
    // 群推送 chat_id（应用机器人方式，无需每群建 Webhook）
    chatIds: [
        'oc_b362688580f805857fddc1a2d9df0ff9', // 消防维保群
        'oc_5cedb65c30a3cf0887b1870b4cd08e82', // 北京基地消防工作群
    ],
    // 旧 Webhook 保留备用（若 API 失败自动降级）
    webhooks: [
        'https://open.feishu.cn/open-apis/bot/v2/hook/486a84ae-3861-4652-b00d-cad5e2759cba',
        'https://open.feishu.cn/open-apis/bot/v2/hook/7c826fde-ab70-456d-ad8e-32cb6298f084',
    ],
    siteUrl:        'https://zhangqiao2717.github.io/fire-platform',
    dataFile:       path.join(__dirname, '..', 'data.json'),
    screenshotFile: path.join(__dirname, '..', 'screenshot.png'),
    chromePath:     'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};

// ============================================================
// ⚙️ 区域负责人配置（含飞书 open_id，用于 @ 和按钮权限）
// ============================================================
const AREA_CONTACTS = {
    '冲焊':     { name: '张蕴龙', phone: '15040026850', openId: 'ou_ecd6d6b9aa8d437691a3b4489e9e376b' },
    '涂装':     { name: '郭书强', phone: '18658424252', openId: 'ou_88ac30a887281c8b02e462cc4c481c2a' },
    '总装':     { name: '何迅达', phone: '13681070413', openId: 'ou_a9b6893a0f6e535aef03f67d89e63448' },
    '餐厅':     { name: '王治纲', phone: '13810395510', openId: 'ou_b801942e5304b3061efccc4a222d7d49' },
    '综合站房': { name: '于玥',   phone: '13889267822', openId: 'ou_c1895b641825bad7ad236860d7477582' },
    '办公楼':   { name: '王治纲', phone: '13810395510', openId: 'ou_b801942e5304b3061efccc4a222d7d49' },
    '4#厂房':   { name: '邓海南', phone: '15232971855', openId: 'ou_8ca8239ea7a33c7cc1cece73a453c71d' },
};

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
// 工具：推送飞书群通知（@负责人 + 按钮仅负责人可点）
// ============================================================
async function sendFeishu(alarms) {
    if (!CONFIG.webhooks?.length) {
        console.log('⚠️  未配置 Webhook，跳过推送');
        return;
    }
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    // 按区域分组匹配负责人
    const areaGroups = {};
    const unmatched  = [];
    alarms.forEach(a => {
        const loc = a.location || a.raw || '';
        let hit = false;
        for (const [area, contact] of Object.entries(AREA_CONTACTS)) {
            if (loc.includes(area)) {
                if (!areaGroups[area]) areaGroups[area] = { contact, alarms: [] };
                areaGroups[area].alarms.push(a);
                hit = true; break;
            }
        }
        if (!hit) unmatched.push(a);
    });

    // 直接使用配置里的 open_id（已预先查询好）
    const openIds = {};
    Object.values(areaGroups).forEach(g => {
        if (g.contact.openId) openIds[g.contact.phone] = g.contact.openId;
    });

    // 构建 @ 文本
    const atText = (contact) => {
        const oid = openIds[contact.phone];
        return oid ? `<at id="${oid}"></at>` : `@${contact.name}`;
    };

    // 构建报警列表内容
    let listContent = '';
    for (const [area, group] of Object.entries(areaGroups)) {
        listContent += `**【${area}】** 负责人：${atText(group.contact)} ${group.contact.name} 📞 ${group.contact.phone}\n`;
        group.alarms.forEach((a, i) => {
            listContent += `　${i+1}. 🔥 ${a.type || '火警'} | ⏰ ${a.time || now} | ${a.status || '待处理'}\n`;
        });
        listContent += '\n';
    }
    if (unmatched.length > 0) {
        listContent += `**【其他区域】** 负责人：@张乔\n`;
        unmatched.forEach((a, i) => {
            listContent += `　${i+1}. 📍 ${a.location || '未知'} | 🔥 ${a.type || '火警'}\n`;
        });
    }

    // 所有负责人 open_id 列表（用于按钮权限）
    const allOpenIds = Object.values(openIds);

    // 确认链接
    const allIds      = alarms.map(a => a.id).join(',');
    const confirmUrl1 = `${CONFIG.siteUrl}?confirm=safe&ids=${encodeURIComponent(allIds)}&area=all&time=${encodeURIComponent(now)}`;
    const confirmUrl2 = `${CONFIG.siteUrl}?confirm=emergency&ids=${encodeURIComponent(allIds)}&area=all&time=${encodeURIComponent(now)}`;

    // @ 汇总行
    const atSummary = Object.values(areaGroups).map(g => atText(g.contact)).join(' ');

    // 按钮（有 open_id 则限制只有负责人可点）
    const mkBtn = (label, type, url) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: label },
        type,
        url,
        ...(allOpenIds.length > 0 ? { confirm_users: allOpenIds } : {}),
    });

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `🚨 火警通知 · ${alarms.length} 条报警 · 请各区域负责人确认` },
            template: 'red',
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**检测时间：** ${now}\n**报警数量：** ${alarms.length} 条\n**通知负责人：** ${atSummary}`,
                },
            },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: listContent || '请查看平台详情' } },
            { tag: 'hr' },
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: allOpenIds.length > 0
                        ? `**${atSummary} 请现场核实后点击确认（仅负责人可操作）：**`
                        : '**各区域负责人请现场核实后点击确认：**',
                },
            },
            {
                tag: 'action',
                actions: [
                    mkBtn('✅ 1. 已现场确认，无火情',           'primary', confirmUrl1),
                    mkBtn('🚒 2. 现场发生火情，立即启动应急预案', 'danger',  confirmUrl2),
                ],
            },
            { tag: 'hr' },
            {
                tag: 'note',
                elements: [{
                    tag: 'plain_text',
                    content: allOpenIds.length > 0
                        ? '⚠️ 确认按钮仅限对应区域负责人操作，其他人无法点击'
                        : '⚠️ 请各区域负责人务必现场核实后点击对应按钮确认',
                }],
            },
        ],
    };

    // 获取 app token（用于应用机器人发群消息）
    const appToken = await getAppToken();

    // 优先用应用机器人 API 发群消息（支持真正 @，无需每群建 Webhook）
    if (appToken && CONFIG.chatIds?.length) {
        for (const chatId of CONFIG.chatIds) {
            await sendGroupMsg(chatId, card, appToken);
        }
    } else {
        // 降级到 Webhook 方式
        const groupBody = JSON.stringify({ msg_type: 'interactive', card });
        for (const webhook of CONFIG.webhooks) {
            try {
                await request(webhook, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(groupBody) },
                }, groupBody);
                console.log(`✅ Webhook 发送成功: ...${webhook.slice(-8)}`);
            } catch(e) {
                console.error(`❌ Webhook 失败 (...${webhook.slice(-8)}):`, e.message);
            }
        }
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
        execSync('git add data.json', { cwd: dir });
        execSync('git diff --staged --quiet || git commit -m "fire data update"', { cwd: dir, shell: true });
        execSync('git push --set-upstream origin main', { cwd: dir });
        console.log('✅ 已推送到 GitHub，网页将自动更新');
    } catch(e) {
        console.log('⚠️  GitHub 推送失败（可能无变化）:', e.message.split('\n')[0]);
    }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
    console.log(`\n🕐 ${new Date().toLocaleString('zh-CN')} 开始检查天泽智联...`);

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

        console.log(`📊 检测到 ${alarms.length} 条火警信息`);

        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf-8')); } catch {}
        const oldIds      = new Set((oldData.tianze_alarms || []).map(a => a.raw));
        const alarmHistory = oldData.alarm_history || [];

        const newAlarms = alarms
            .filter(a => !oldIds.has(a.raw))
            .map(a => ({
                ...a,
                id:             `alarm_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                confirm_status: 'pending',
                confirm_person: '',
                confirm_time:   '',
            }));

        newAlarms.forEach(a => {
            const loc = a.location || a.raw || '';
            for (const [area, contact] of Object.entries(AREA_CONTACTS)) {
                if (loc.includes(area)) {
                    a.area = area; a.responsible = contact.name; a.responsible_phone = contact.phone;
                    return;
                }
            }
            a.area = '其他区域'; a.responsible = '张乔'; a.responsible_phone = '19800312191';
        });

        console.log(`🆕 新增火警: ${newAlarms.length} 条`);

        const newData = {
            ...oldData,
            _updated:          new Date().toISOString(),
            _source:           'local_scrape',
            tianze_alarms:     alarms,
            tianze_last_check: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            tianze_new_count:  newAlarms.length,
            alarm_history:     [...newAlarms, ...alarmHistory].slice(0, 500),
        };
        fs.writeFileSync(CONFIG.dataFile, JSON.stringify(newData, null, 2));
        console.log('✅ data.json 已更新');

        if (newAlarms.length > 0) {
            console.log('🔔 发现新火警，推送飞书通知...');
            await sendFeishu(newAlarms);
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
