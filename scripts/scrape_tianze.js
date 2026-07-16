/**
 * 天泽智联火警数据抓取脚本
 * 使用 Puppeteer 无头浏览器登录系统，截取并提取报警信息
 * 写入 data.json，并通过飞书 Webhook 推送火警通知
 *
 * 环境变量（在 GitHub Secrets 中配置，不要写在代码里）：
 *   TIANZE_USERNAME    — 天泽智联账号
 *   TIANZE_PASSWORD    — 天泽智联密码
 *   TIANZE_URL         — 天泽智联系统网址
 *   FEISHU_WEBHOOK_URL — 飞书机器人 Webhook 地址
 */

const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================
// 配置（全部从环境变量读取，不要硬编码）
// ============================================================
const CONFIG = {
    username:    process.env.TIANZE_USERNAME,
    password:    process.env.TIANZE_PASSWORD,
    url:         process.env.TIANZE_URL || 'https://mty360.com',
    webhook:     process.env.FEISHU_WEBHOOK_URL,
    outputPath:  path.join(__dirname, '..', 'data.json'),
    screenshotPath: path.join(__dirname, '..', 'alarm_screenshot.png'),
};

// ============================================================
// 工具：发送飞书 Webhook 消息
// ============================================================
function sendFeishuAlert(alarms) {
    if (!CONFIG.webhook) {
        console.log('⚠️  未配置 FEISHU_WEBHOOK_URL，跳过飞书推送');
        return Promise.resolve();
    }

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    // 构建消息卡片
    const alarmList = alarms.slice(0, 10).map((a, i) =>
        `**${i + 1}.** 📍 ${a.location || '未知位置'}｜🔥 ${a.type || '火警'}｜⏰ ${a.time || '—'}｜状态: ${a.status || '未处理'}`
    ).join('\n');

    const body = JSON.stringify({
        msg_type: 'interactive',
        card: {
            config: { wide_screen_mode: true },
            header: {
                title: {
                    tag: 'plain_text',
                    content: `🚨 消防火警通知 · ${alarms.length} 条新报警`
                },
                template: 'red'
            },
            elements: [
                {
                    tag: 'div',
                    text: {
                        tag: 'lark_md',
                        content: `**检测时间：** ${now}\n**报警数量：** ${alarms.length} 条\n**数据来源：** 天泽智联系统`
                    }
                },
                { tag: 'hr' },
                {
                    tag: 'div',
                    text: {
                        tag: 'lark_md',
                        content: alarmList || '暂无具体报警信息'
                    }
                },
                { tag: 'hr' },
                {
                    tag: 'action',
                    actions: [{
                        tag: 'button',
                        text: { tag: 'plain_text', content: '查看消防管理平台' },
                        type: 'primary',
                        url: 'https://tiny-narwhal-93e6a2.netlify.app'
                    }]
                }
            ]
        }
    });

    return new Promise((resolve, reject) => {
        const urlObj = new URL(CONFIG.webhook);
        const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log('✅ 飞书推送成功:', data);
                resolve(data);
            });
        });
        req.on('error', err => {
            console.error('❌ 飞书推送失败:', err.message);
            reject(err);
        });
        req.write(body);
        req.end();
    });
}

// ============================================================
// 工具：读取现有 data.json
// ============================================================
function readCurrentData() {
    try {
        const raw = fs.readFileSync(CONFIG.outputPath, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

// ============================================================
// 工具：判断是否有新火警（与上次对比）
// ============================================================
function findNewAlarms(currentAlarms, previousAlarms) {
    const prevIds = new Set((previousAlarms || []).map(a => a.id || a.time + a.location));
    return currentAlarms.filter(a => {
        const id = a.id || a.time + a.location;
        return !prevIds.has(id);
    });
}

// ============================================================
// 主流程：登录并抓取
// ============================================================
async function scrapeAlarms() {
    if (!CONFIG.username || !CONFIG.password) {
        console.error('❌ 缺少环境变量 TIANZE_USERNAME 或 TIANZE_PASSWORD');
        console.log('ℹ️  请在 GitHub Secrets 中配置账号密码');
        process.exit(1);
    }

    console.log('🚀 启动浏览器...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    );

    try {
        // ---- 1. 打开登录页 ----
        console.log(`🌐 访问: ${CONFIG.url}`);
        await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.screenshot({ path: CONFIG.screenshotPath });
        console.log('📸 已截图：login_page');

        // ---- 2. 填写账号密码并登录 ----
        // 注意：以下选择器需要根据天泽智联实际页面调整
        // 运行后查看截图 alarm_screenshot.png 来确认页面结构
        await page.waitForSelector('input[type="text"], input[name="username"], #username', { timeout: 10000 });

        // 尝试多种常见的用户名输入框选择器
        const usernameSelectors = [
            'input[name="username"]',
            'input[name="phone"]',
            'input[name="loginName"]',
            'input[type="text"]:first-of-type',
            '#username',
            '.username input',
        ];
        const passwordSelectors = [
            'input[name="password"]',
            'input[type="password"]',
            '#password',
            '.password input',
        ];
        const submitSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            '.login-btn',
            '.btn-login',
            'button:contains("登录")',
        ];

        let loggedIn = false;
        for (const sel of usernameSelectors) {
            try {
                await page.click(sel);
                await page.type(sel, CONFIG.username, { delay: 50 });
                loggedIn = true;
                console.log(`✅ 用户名框: ${sel}`);
                break;
            } catch { /* 继续尝试下一个 */ }
        }

        for (const sel of passwordSelectors) {
            try {
                await page.click(sel);
                await page.type(sel, CONFIG.password, { delay: 50 });
                console.log(`✅ 密码框: ${sel}`);
                break;
            } catch { /* 继续尝试下一个 */ }
        }

        // 点击登录按钮
        for (const sel of submitSelectors) {
            try {
                await page.click(sel);
                console.log(`✅ 登录按钮: ${sel}`);
                break;
            } catch { /* 继续尝试下一个 */ }
        }

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        await page.screenshot({ path: CONFIG.screenshotPath });
        console.log('📸 已截图：after_login');

        // ---- 3. 导航到报警列表页 ----
        const currentUrl = page.url();
        console.log('📍 当前URL:', currentUrl);

        // 尝试找到报警/火警入口
        const alarmNavSelectors = [
            'a[href*="alarm"]',
            'a[href*="alert"]',
            'a[href*="fire"]',
            '[class*="alarm"]',
            '[class*="alert"]',
            'li:contains("报警")',
            'li:contains("火警")',
            'span:contains("报警")',
            'a:contains("实时报警")',
            'a:contains("火警信息")',
        ];

        for (const sel of alarmNavSelectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    await el.click();
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
                    console.log(`✅ 找到报警入口: ${sel}`);
                    break;
                }
            } catch { /* 继续 */ }
        }

        await new Promise(r => setTimeout(r, 2000));
        await page.screenshot({ path: CONFIG.screenshotPath });
        console.log('📸 已截图：alarm_page');

        // ---- 4. 提取报警数据 ----
        const alarms = await page.evaluate(() => {
            const results = [];

            // 尝试从表格中提取数据
            const tables = document.querySelectorAll('table');
            tables.forEach(table => {
                const rows = table.querySelectorAll('tr');
                rows.forEach((row, idx) => {
                    if (idx === 0) return; // 跳过表头
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 3) {
                        // 检查是否包含报警相关内容
                        const text = row.textContent || '';
                        if (text.includes('火警') || text.includes('报警') || text.includes('故障')) {
                            results.push({
                                id:       cells[0]?.textContent?.trim() || '',
                                time:     cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim() || '',
                                location: cells[2]?.textContent?.trim() || cells[1]?.textContent?.trim() || '',
                                type:     cells[3]?.textContent?.trim() || '火警',
                                status:   cells[cells.length - 1]?.textContent?.trim() || '未处理',
                                raw:      text.trim().replace(/\s+/g, ' ').substring(0, 200),
                            });
                        }
                    }
                });
            });

            // 如果表格没数据，尝试列表项
            if (results.length === 0) {
                const items = document.querySelectorAll(
                    '[class*="alarm-item"], [class*="alert-item"], [class*="fire-item"], [class*="event-item"]'
                );
                items.forEach(item => {
                    const text = item.textContent?.trim() || '';
                    if (text) {
                        results.push({
                            id: Date.now() + Math.random(),
                            time: new Date().toLocaleString('zh-CN'),
                            location: text.substring(0, 50),
                            type: '火警',
                            status: '待确认',
                            raw: text.replace(/\s+/g, ' ').substring(0, 200),
                        });
                    }
                });
            }

            return results;
        });

        console.log(`📊 提取到报警数据: ${alarms.length} 条`);
        alarms.forEach((a, i) => console.log(`   ${i+1}. ${a.time} | ${a.location} | ${a.type}`));

        // ---- 5. 读取旧数据，判断是否有新火警 ----
        const existingData = readCurrentData();
        const previousAlarms = existingData.tianze_alarms || [];
        const newAlarms = findNewAlarms(alarms, previousAlarms);
        console.log(`🆕 新增火警: ${newAlarms.length} 条`);

        // ---- 6. 更新 data.json ----
        const updatedData = {
            ...existingData,
            _updated: new Date().toISOString(),
            tianze_alarms: alarms,
            tianze_last_check: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            tianze_new_count: newAlarms.length,
        };
        fs.writeFileSync(CONFIG.outputPath, JSON.stringify(updatedData, null, 2), 'utf-8');
        console.log('✅ data.json 已更新');

        // ---- 7. 有新火警则推送飞书 ----
        if (newAlarms.length > 0) {
            console.log('🔔 检测到新火警，推送飞书通知...');
            await sendFeishuAlert(newAlarms);
        } else {
            console.log('ℹ️  无新增火警，不推送飞书');
        }

        return { alarms, newAlarms };

    } finally {
        await browser.close();
        console.log('🔒 浏览器已关闭');
    }
}

// ============================================================
// 入口
// ============================================================
scrapeAlarms().then(({ alarms, newAlarms }) => {
    console.log(`\n✅ 抓取完成 | 总报警: ${alarms.length} | 新增: ${newAlarms.length}`);
}).catch(err => {
    console.error('❌ 抓取失败:', err.message);
    // 不让 Actions 失败，避免频繁报错邮件
    process.exit(0);
});
