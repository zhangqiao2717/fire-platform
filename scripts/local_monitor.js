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
    // 飞书机器人 Webhook
    webhook:  'https://open.feishu.cn/open-apis/bot/v2/hook/486a84ae-3861-4652-b00d-cad5e2759cba',
    // 消防平台网址
    siteUrl:  'https://beijing-fire.netlify.app',
    // 文件路径
    dataFile:       path.join(__dirname, '..', 'data.json'),
    screenshotFile: path.join(__dirname, '..', 'screenshot.png'),
    // Chrome 路径（Windows 默认路径，如不同请修改）
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
// 工具：推送飞书通知
// ============================================================
async function sendFeishu(alarms) {
    if (!CONFIG.webhook || CONFIG.webhook === 'YOUR_FEISHU_WEBHOOK_URL') {
        console.log('⚠️  未配置飞书 Webhook，跳过推送');
        return;
    }
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const list = alarms.slice(0, 10).map((a, i) =>
        `**${i+1}.** 📍 ${a.location || '未知位置'} | 🔥 ${a.type || '火警'} | ⏰ ${a.time || '—'}`
    ).join('\n');

    const body = JSON.stringify({
        msg_type: 'interactive',
        card: {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: 'plain_text', content: `🚨 火警通知 · ${alarms.length} 条新报警` },
                template: 'red'
            },
            elements: [
                { tag: 'div', text: { tag: 'lark_md', content: `**检测时间：** ${now}\n**报警数量：** ${alarms.length} 条` } },
                { tag: 'hr' },
                { tag: 'div', text: { tag: 'lark_md', content: list || '请查看平台详情' } },
                { tag: 'hr' },
                { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看消防管理平台' }, type: 'primary', url: CONFIG.siteUrl }] }
            ]
        }
    });

    try {
        await request(CONFIG.webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, body);
        console.log('✅ 飞书通知发送成功');
    } catch(e) {
        console.error('❌ 飞书通知失败:', e.message);
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
        execSync('git push', { cwd: dir });
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
