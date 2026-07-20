/**
 * 天泽智联火警本地监控脚本
 * 在你的电脑上运行，每30分钟自动检查一次
 * 发现新火警时：写入 data.json + 推送飞书通知 + 上传 GitHub
 *
 * 配置区：修改下方的配置后运行
 */

const puppeteer = require('puppeteer-core');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================
// ⚙️ 配置区 — 按实际情况修改
// ============================================================
const CONFIG = {
    // 天泽智联内网地址
    url:      'http://10.231.136.231:9832/bw-fck-bjdx-web/#/login',
    // 天泽智联账号
    username: '19800312191',
    // 天泽智联密码
    password: 'Li@666888',
    // 飞书机器人 Webhook（群通知）
    webhook:  'https://open.feishu.cn/open-apis/bot/v2/hook/486a84ae-3861-4652-b00d-cad5e2759cba',
    // 飞书应用 App Secret（用于发送私信，填入你的飞书 App Secret）
    appSecret: '',   // ← 填入飞书开放平台的 App Secret 后私信功能生效
    // 消防平台网址
    siteUrl:  'https://beijing-fire.netlify.app',
    // 文件路径
    dataFile:       path.join(__dirname, '..', 'data.json'),
    screenshotFile: path.join(__dirname, '..', 'screenshot.png'),
    // Chrome 路径
    chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};

// ============================================================
// 工具：发送 HTTP/HTTPS 请求
// ============================================================
function request(url, options, body) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const lib = isHttps ? https : http;
        const urlObj = new URL(url);
        const opts = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            ...options
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
// ⚙️ 区域负责人配置
// ============================================================
const AREA_CONTACTS = {
    '冲焊':   { name: '张蕴龙', phone: '15040026850' },
    '涂装':   { name: '郭书强', phone: '18658424252' },
    '总装':   { name: '何迅达', phone: '13681070413' },
    '餐厅':   { name: '王治纲', phone: '13810395510' },
    '综合站房': { name: '于玥',   phone: '13889267822' },
    '办公楼': { name: '王治纲', phone: '13810395510' },
    '4#厂房': { name: '邓海南', phone: '15232971855' },
};

// ============================================================
// 工具：通过手机号查询飞书 open_id（用于 @人）
// ============================================================
async function getOpenId(phone, appToken) {
    try {
        const res = await request(
            `https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${appToken}`,
                    'Content-Type': 'application/json',
                }
            },
            JSON.stringify({ mobiles: [phone] })
        );
        const data = JSON.parse(res);
        const list = data?.data?.user_list || [];
        const user = list.find(u => u.mobile === phone);
        return user?.user_id || null;
    } catch(e) {
        console.warn(`⚠️  查询 ${phone} 的 open_id 失败:`, e.message);
        return null;
    }
}

// ============================================================
// 工具：获取飞书 app_access_token（用于查询用户 open_id）
// ============================================================
async function getAppToken() {
    try {
        const res = await request(
            'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            JSON.stringify({ app_id: 'cli_aadddd5e85f81bd1', app_secret: CONFIG.appSecret })
        );
        const data = JSON.parse(res);
        return data?.app_access_token || null;
    } catch(e) {
        console.warn('⚠️  获取 app_access_token 失败:', e.message);
        return null;
    }
}

// ============================================================
// 工具：发送飞书私信给指定 open_id（含确认按钮）
// ============================================================
async function sendPrivateMsg(openId, appToken, alarm, contact) {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    // 确认链接：跳转到消防平台并带上参数，记录确认状态
    const confirmUrl1 = `${CONFIG.siteUrl}?confirm=safe&area=${encodeURIComponent(alarm.location)}&name=${encodeURIComponent(contact.name)}&time=${encodeURIComponent(now)}`;
    const confirmUrl2 = `${CONFIG.siteUrl}?confirm=emergency&area=${encodeURIComponent(alarm.location)}&name=${encodeURIComponent(contact.name)}&time=${encodeURIComponent(now)}`;

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `🚨 【${alarm.location}】火警确认` },
            template: 'red'
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**${contact.name} 您好，您负责的区域发生火警，请现场核实后确认处置情况！**\n\n📍 **区域：** ${alarm.location}\n🔥 **类型：** ${alarm.type || '火警'}\n⏰ **时间：** ${now}\n📊 **状态：** 待确认`
                }
            },
            { tag: 'hr' },
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: '**请现场核实后，点击下方按钮确认：**'
                }
            },
            {
                tag: 'action',
                actions: [
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '✅ 1. 已现场确认，无火情' },
                        type: 'primary',
                        url: confirmUrl1
                    },
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '🚒 2. 现场发生火情，立即启动应急预案' },
                        type: 'danger',
                        url: confirmUrl2
                    }
                ]
            },
            { tag: 'hr' },
            {
                tag: 'note',
                elements: [{
                    tag: 'plain_text',
                    content: '⚠️ 请务必现场核实后再确认，确认结果将同步至消防管理平台'
                }]
            }
        ]
    };

    try {
        await request(
            'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${appToken}`,
                    'Content-Type': 'application/json',
                }
            },
            JSON.stringify({
                receive_id: openId,
                msg_type: 'interactive',
                content: JSON.stringify(card)
            })
        );
        console.log(`✅ 已私信 ${contact.name}（${alarm.location}）含确认按钮`);
    } catch(e) {
        console.warn(`⚠️  私信 ${contact.name} 失败:`, e.message);
    }
}

// ============================================================
// 工具：推送飞书通知（群通知 + 精准 @负责人 + 私信）
// ============================================================
async function sendFeishu(alarms) {
    if (!CONFIG.webhook || CONFIG.webhook === 'YOUR_FEISHU_WEBHOOK_URL') {
        console.log('⚠️  未配置飞书 Webhook，跳过推送');
        return;
    }
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    // 按区域分组，匹配负责人
    const areaGroups = {};
    const unmatchedAlarms = [];
    alarms.forEach(a => {
        const loc = a.location || a.raw || '';
        let matched = false;
        for (const [area, contact] of Object.entries(AREA_CONTACTS)) {
            if (loc.includes(area)) {
                if (!areaGroups[area]) areaGroups[area] = { contact, alarms: [] };
                areaGroups[area].alarms.push(a);
                matched = true;
                break;
            }
        }
        if (!matched) unmatchedAlarms.push(a);
    });

    // 构建群通知内容（含区域和负责人信息）
    let listContent = '';
    for (const [area, group] of Object.entries(areaGroups)) {
        listContent += `**【${area}】** 负责人：${group.contact.name} 📞 ${group.contact.phone}\n`;
        group.alarms.forEach((a, i) => {
            listContent += `　${i+1}. 🔥 ${a.type || '火警'} | ⏰ ${a.time || now} | ${a.status || '待处理'}\n`;
        });
        listContent += '\n';
    }
    if (unmatchedAlarms.length > 0) {
        listContent += `**【其他区域】** 负责人：张乔\n`;
        unmatchedAlarms.forEach((a, i) => {
            listContent += `　${i+1}. 📍 ${a.location || '未知'} | 🔥 ${a.type || '火警'}\n`;
        });
    }

    // 发送群通知
    const confirmUrl1 = `${CONFIG.siteUrl}?confirm=safe&area=all&name=all&time=${encodeURIComponent(now)}`;
    const confirmUrl2 = `${CONFIG.siteUrl}?confirm=emergency&area=all&name=all&time=${encodeURIComponent(now)}`;

    const groupBody = JSON.stringify({
        msg_type: 'interactive',
        card: {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: 'plain_text', content: `🚨 火警通知 · ${alarms.length} 条报警 · 请各区域负责人确认` },
                template: 'red'
            },
            elements: [
                {
                    tag: 'div',
                    text: {
                        tag: 'lark_md',
                        content: `**检测时间：** ${now}\n**报警数量：** ${alarms.length} 条\n**待确认负责人：** ${Object.values(areaGroups).map(g => g.contact.name).join('、') || '—'}`
                    }
                },
                { tag: 'hr' },
                { tag: 'div', text: { tag: 'lark_md', content: listContent || '请查看平台详情' } },
                { tag: 'hr' },
                {
                    tag: 'div',
                    text: { tag: 'lark_md', content: '**各区域负责人请现场核实后点击确认：**' }
                },
                {
                    tag: 'action',
                    actions: [
                        {
                            tag: 'button',
                            text: { tag: 'plain_text', content: '✅ 1. 已现场确认，无火情' },
                            type: 'primary',
                            url: confirmUrl1
                        },
                        {
                            tag: 'button',
                            text: { tag: 'plain_text', content: '🚒 2. 现场发生火情，立即启动应急预案' },
                            type: 'danger',
                            url: confirmUrl2
                        }
                    ]
                },
                { tag: 'hr' },
                {
                    tag: 'note',
                    elements: [{
                        tag: 'plain_text',
                        content: '⚠️ 各区域负责人同时已收到私信，请务必现场确认后点击对应按钮'
                    }]
                }
            ]
        }
    });

    try {
        await request(CONFIG.webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(groupBody) }
        }, groupBody);
        console.log('✅ 群通知发送成功');
    } catch(e) {
        console.error('❌ 群通知失败:', e.message);
    }

    // 发送私信给各区域负责人
    if (CONFIG.appSecret) {
        const appToken = await getAppToken();
        if (appToken) {
            for (const [area, group] of Object.entries(areaGroups)) {
                const openId = await getOpenId(group.contact.phone, appToken);
                if (openId) {
                    for (const alarm of group.alarms) {
                        await sendPrivateMsg(openId, appToken, { ...alarm, location: area }, group.contact);
                    }
                } else {
                    console.warn(`⚠️  未找到 ${group.contact.name} 的飞书账号，跳过私信`);
                }
            }
        }
    } else {
        console.log('ℹ️  未配置 appSecret，跳过私信功能（群通知已发送）');
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

    // 检查 Chrome 是否存在
    const chromePaths = [
        CONFIG.chromePath,
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    let executablePath = null;
    for (const p of chromePaths) {
        if (fs.existsSync(p)) { executablePath = p; break; }
    }
    if (!executablePath) {
        console.error('❌ 找不到 Chrome/Edge，请安装 Chrome 浏览器');
        process.exit(1);
    }
    console.log(`🌐 使用浏览器: ${executablePath}`);

    const browser = await puppeteer.launch({
        executablePath,
        headless: false, // 设为 true 可隐藏浏览器窗口
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });

        // 1. 打开登录页
        console.log(`🌐 访问: ${CONFIG.url}`);
        await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: CONFIG.screenshotFile });
        console.log('📸 截图已保存: screenshot.png');

        // 2. 登录
        await new Promise(r => setTimeout(r, 2000));
        const inputs = await page.$$('input');
        console.log(`🔍 找到 ${inputs.length} 个输入框`);

        if (inputs.length >= 2) {
            await inputs[0].click({ clickCount: 3 });
            await inputs[0].type(CONFIG.username, { delay: 50 });
            await inputs[1].click({ clickCount: 3 });
            await inputs[1].type(CONFIG.password, { delay: 50 });
            console.log('✅ 已填写账号密码');

            // 点击登录按钮
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

        // 3. 提取页面上的火警信息
        const alarms = await page.evaluate(() => {
            const results = [];
            // 查找所有包含"火警"文字的元素
            const allElements = document.querySelectorAll('*');
            allElements.forEach(el => {
                const text = el.textContent || '';
                if ((text.includes('火警') || text.includes('报警')) &&
                    el.children.length === 0 && text.trim().length < 100) {
                    const parent = el.closest('[class]');
                    const parentText = parent ? parent.textContent.trim().replace(/\s+/g, ' ').substring(0, 150) : text.trim();
                    if (parentText && !results.some(r => r.raw === parentText)) {
                        results.push({
                            time: new Date().toLocaleString('zh-CN'),
                            location: text.trim(),
                            type: text.includes('火警') ? '火警' : '报警',
                            status: '待处理',
                            raw: parentText
                        });
                    }
                }
            });
            // 也查找弹窗
            const modals = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="popup"], [class*="alert"]');
            modals.forEach(modal => {
                const text = modal.textContent.trim().replace(/\s+/g, ' ').substring(0, 200);
                if (text.includes('火警') || text.includes('报警')) {
                    results.push({
                        time: new Date().toLocaleString('zh-CN'),
                        location: '弹窗报警',
                        type: '火警',
                        status: '待处理',
                        raw: text
                    });
                }
            });
            return results.slice(0, 20);
        });

        console.log(`📊 检测到 ${alarms.length} 条火警信息`);

        // 4. 读取旧数据对比
        let oldData = {};
        try { oldData = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf-8')); } catch {}
        const oldAlarms = oldData.tianze_alarms || [];
        const oldIds = new Set(oldAlarms.map(a => a.raw));
        const newAlarms = alarms.filter(a => !oldIds.has(a.raw));
        console.log(`🆕 新增火警: ${newAlarms.length} 条`);

        // 5. 写入 data.json
        const newData = {
            ...oldData,
            _updated: new Date().toISOString(),
            _source: 'local_scrape',
            tianze_alarms: alarms,
            tianze_last_check: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            tianze_new_count: newAlarms.length,
        };
        fs.writeFileSync(CONFIG.dataFile, JSON.stringify(newData, null, 2));
        console.log('✅ data.json 已更新');

        // 6. 有新火警则推送飞书并上传 GitHub
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
