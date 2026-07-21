/**
 * 月度保养任务推送脚本
 * 每月1日早上8点自动运行
 * 筛选当月保养任务 → 推送飞书群通知 + 私信孙伟/牛超
 *
 * 用法：
 *   node send_monthly_plan.js          ← 正常运行（按当前月份）
 *   node send_monthly_plan.js --test   ← 测试模式（模拟当月，不写记录）
 *   node send_monthly_plan.js --month=7 ← 指定月份测试
 */

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

// ============================================================
// ⚙️ 配置
// ============================================================
const CONFIG = {
    appId:     'cli_aadddd5e85f81bd1',
    appSecret: 'HcRDNeBimwNvg9N1DLQOVhsiOG5L3okI',
    // 应用机器人群 chat_id（无需每群建 Webhook）
    chatIds: [
        'oc_b362688580f805857fddc1a2d9df0ff9', // 消防维保群
        'oc_5cedb65c30a3cf0887b1870b4cd08e82', // 北京基地消防工作群
    ],
    siteUrl:  'https://beijing-fire.netlify.app',
    dataFile: path.join(__dirname, '..', 'data.json'),
    planFile: path.join(__dirname, 'plan_data.json'),
};

// ============================================================
// ⚙️ 固定接收人员（维保组）
// ============================================================
const MAINTAINERS = [
    { name: '孙伟', openId: 'ou_63124c2341b701f4a9fef354a6d80f70', role: '维保主管' },
    { name: '牛超', openId: 'ou_f31b4418835c8636e1a57deb8bf78cb7', role: '维保员'   },
];

// ============================================================
// 工具：HTTP/HTTPS 请求
// ============================================================
function request(url, options, body) {
    return new Promise((resolve, reject) => {
        const isHttps = url.startsWith('https');
        const lib = isHttps ? require('https') : require('http');
        const u = new URL(url);
        const req = lib.request({
            hostname: u.hostname,
            port:     u.port || (isHttps ? 443 : 80),
            path:     u.pathname + u.search,
            method:   options.method || 'GET',
            headers:  options.headers || {},
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ============================================================
// 工具：获取 app_access_token
// ============================================================
async function getAppToken() {
    const res = await request(
        'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ app_id: CONFIG.appId, app_secret: CONFIG.appSecret })
    );
    const token = JSON.parse(res)?.app_access_token;
    if (!token) throw new Error('获取 app_access_token 失败');
    return token;
}

// ============================================================
// 工具：发送飞书私信
// ============================================================
async function sendDM(openId, card, appToken) {
    const body = JSON.stringify({
        receive_id: openId,
        msg_type:   'interactive',
        content:    JSON.stringify(card),
    });
    const res = await request(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
        { method: 'POST', headers: { 'Authorization': `Bearer ${appToken}`, 'Content-Type': 'application/json' } },
        body
    );
    const result = JSON.parse(res);
    if (result.code !== 0) console.warn('⚠️  私信发送失败:', result.msg);
    return result.code === 0;
}

// ============================================================
// 工具：发送飞书群 Webhook
// ============================================================
async function sendWebhook(webhook, card) {
    const body = JSON.stringify({ msg_type: 'interactive', card });
    const res = await request(webhook, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, body);
    const result = JSON.parse(res);
    return result.code === 0;
}

// ============================================================
// 工具：推送到 GitHub
// ============================================================
function pushToGithub() {
    try {
        const dir = path.join(__dirname, '..');
        execSync('git add data.json', { cwd: dir });
        execSync('git diff --staged --quiet || git commit -m "monthly plan dispatched"', { cwd: dir, shell: true });
        execSync('git push --set-upstream origin main', { cwd: dir });
        console.log('✅ 已推送到 GitHub');
    } catch(e) {
        console.log('⚠️  GitHub 推送:', e.message.split('\n')[0]);
    }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
    const args     = process.argv.slice(2);
    const isTest   = args.includes('--test');
    const monthArg = args.find(a => a.startsWith('--month='));
    const now      = new Date();
    const month    = monthArg ? parseInt(monthArg.split('=')[1]) : now.getMonth() + 1;
    const year     = now.getFullYear();
    const monthStr = `${year}年${month}月`;
    const nowStr   = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    console.log(`\n🔧 ${nowStr} 开始推送 ${monthStr} 保养任务${isTest ? ' [测试模式]' : ''}...`);

    // 1. 读取保养计划数据
    const planData = JSON.parse(fs.readFileSync(CONFIG.planFile, 'utf-8'));

    // 2. 筛选本月需要执行的保养项
    const thisMonthTasks = planData.filter(item => item.months.includes(month));
    console.log(`📋 本月保养任务: ${thisMonthTasks.length} 项`);
    thisMonthTasks.forEach((t, i) => console.log(`   ${i+1}. [${t.cycle}] ${t.system} · ${t.content}`));

    if (thisMonthTasks.length === 0) {
        console.log('ℹ️  本月无保养任务，跳过推送');
        return;
    }

    // 3. 获取 app token
    const appToken = await getAppToken();
    console.log('✅ app_access_token 获取成功');

    // 4. 构建任务清单文本
    const taskList = thisMonthTasks.map((t, i) =>
        `${i+1}. **${t.system}** · ${t.content}（${t.cycle}）`
    ).join('\n');

    // 5. @ 文本
    const atText = MAINTAINERS.map(m => `<at id="${m.openId}"></at>`).join(' ');
    const nameText = MAINTAINERS.map(m => m.name).join('、');

    // 确认按钮链接
    const confirmUrl = `${CONFIG.siteUrl}?page=maintain-plan`;

    // 6. 群通知卡片
    const groupCard = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `🔧 【${monthStr}】消防维保保养任务下发` },
            template: 'blue',
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**下发时间：** ${nowStr}\n**任务数量：** ${thisMonthTasks.length} 项\n**执行人员：** ${atText} ${nameText}`,
                },
            },
            { tag: 'hr' },
            {
                tag: 'div',
                text: { tag: 'lark_md', content: `**本月保养任务清单：**\n${taskList}` },
            },
            { tag: 'hr' },
            {
                tag: 'action',
                actions: [
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '✅ 已收到，开始执行' },
                        type: 'primary',
                        url:  confirmUrl,
                        confirm_users: MAINTAINERS.map(m => m.openId),
                    },
                    {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '📋 查看保养计划' },
                        type: 'default',
                        url:  confirmUrl,
                    },
                ],
            },
            { tag: 'hr' },
            {
                tag: 'note',
                elements: [{ tag: 'plain_text', content: '⚠️ 「已收到」按钮仅 孙伟/牛超 可操作，请按计划完成各项保养任务并记录' }],
            },
        ],
    };

    // 7. 个人私信卡片
    const buildDMCard = (person) => ({
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `🔧 【${monthStr}保养任务】${person.name}，您好！` },
            template: 'blue',
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**${person.name}（${person.role}）您好！**\n\n本月消防维保保养任务已下发，共 **${thisMonthTasks.length} 项**，请按计划执行。\n\n**下发时间：** ${nowStr}`,
                },
            },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: `**本月任务清单：**\n${taskList}` } },
            { tag: 'hr' },
            {
                tag: 'action',
                actions: [{
                    tag:  'button',
                    text: { tag: 'plain_text', content: '📋 查看保养计划详情' },
                    type: 'primary',
                    url:  confirmUrl,
                }],
            },
        ],
    });

    if (!isTest) {
        // 8. 向群发送通知（应用机器人 API，无需每群建 Webhook）
        for (const chatId of CONFIG.chatIds) {
            const body = JSON.stringify({
                receive_id: chatId,
                msg_type:   'interactive',
                content:    JSON.stringify(groupCard),
            });
            const res = await request(
                'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
                { method: 'POST', headers: { 'Authorization': `Bearer ${appToken}`, 'Content-Type': 'application/json' } },
                body
            );
            const result = JSON.parse(res);
            console.log(result.code === 0
                ? `✅ 群通知发送成功: ...${chatId.slice(-8)}`
                : `❌ 群通知失败 (...${chatId.slice(-8)}): ${result.msg}`);
        }

        // 9. 向孙伟、牛超各发私信
        for (const person of MAINTAINERS) {
            const ok = await sendDM(person.openId, buildDMCard(person), appToken);
            console.log(ok ? `✅ 私信 ${person.name} 成功` : `❌ 私信 ${person.name} 失败`);
        }

        // 10. 写入下发记录到 data.json
        let dataJson = {};
        try { dataJson = JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf-8')); } catch {}
        const log = dataJson.plan_dispatch_log || [];
        log.unshift({
            id:         `plan_${Date.now()}`,
            month:      monthStr,
            task_count: thisMonthTasks.length,
            receivers:  nameText,
            dispatch_time: nowStr,
            tasks:      thisMonthTasks.map(t => `${t.system}·${t.content}`),
        });
        dataJson.plan_dispatch_log = log.slice(0, 24); // 最多保留24条（2年）
        fs.writeFileSync(CONFIG.dataFile, JSON.stringify(dataJson, null, 2));
        console.log('✅ 下发记录已写入 data.json');

        // 11. 推送到 GitHub
        pushToGithub();

    } else {
        console.log('\n[测试模式] 不发送实际消息，仅预览：');
        console.log('群通知卡片标题:', groupCard.header.title.content);
        console.log('私信人员:', MAINTAINERS.map(m => m.name).join('、'));
        console.log('任务列表:\n' + taskList);
    }

    console.log(`\n✅ ${monthStr} 保养任务下发完成！`);
}

main().catch(err => {
    console.error('❌ 运行失败:', err.message);
    process.exit(1);
});
