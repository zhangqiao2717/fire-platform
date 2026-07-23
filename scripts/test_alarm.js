/**
 * 测试脚本：模拟火警推送 - 同时发送到多个群（含 @ 负责人）
 */
const https = require('https');

const WEBHOOKS = [
    'https://open.feishu.cn/open-apis/bot/v2/hook/486a84ae-3861-4652-b00d-cad5e2759cba',
    'https://open.feishu.cn/open-apis/bot/v2/hook/7c826fde-ab70-456d-ad8e-32cb6298f084',
];
const SITE_URL = 'https://zhangqiao2717.github.io/fire-platform';

const now          = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const area         = '总装车间';
const responsible  = '刘海兰';
// 如果你有刘海兰的飞书 open_id 可以填在这里，否则留空用纯文本 @
const openId       = 'ou_37aff01e4dda13eda95d4624ce20a951'; // 刘海兰

const confirmUrl1 = `${SITE_URL}?confirm=safe&area=${encodeURIComponent(area)}&name=${encodeURIComponent(responsible)}&time=${encodeURIComponent(now)}`;
const confirmUrl2 = `${SITE_URL}?confirm=emergency&area=${encodeURIComponent(area)}&name=${encodeURIComponent(responsible)}&time=${encodeURIComponent(now)}`;

const atText      = openId ? `<at id="${openId}"></at>` : `@${responsible}`;
const listContent = `**【${area}】** 负责人：${atText} ${responsible}\n　1. 🔥 火警 | ⏰ ${now} | 待处理\n`;

const mkBtn = (label, type, url) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type, url,
    ...(openId ? { confirm_users: [openId] } : {}),
});

const body = JSON.stringify({
    msg_type: 'interactive',
    card: {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '🚨 【测试】火警通知 · 1 条报警 · 请负责人确认' },
            template: 'red',
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**检测时间：** ${now}\n**报警数量：** 1 条\n**通知负责人：** ${atText}\n\n> ⚠️ 此为测试消息，非真实火警`,
                },
            },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: listContent } },
            { tag: 'hr' },
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: openId
                        ? `**${atText} 请现场核实后点击确认（仅负责人可操作）：**`
                        : `**${responsible} 请现场核实后点击确认：**`,
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
                    content: openId
                        ? '⚠️ 确认按钮仅限对应区域负责人操作，其他人无法点击'
                        : '⚠️ 请务必现场核实后点击对应按钮确认',
                }],
            },
        ],
    },
});

function sendToWebhook(webhook) {
    return new Promise(resolve => {
        const urlObj = new URL(webhook);
        const req = https.request({
            hostname: urlObj.hostname,
            path:     urlObj.pathname + urlObj.search,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.code === 0) console.log(`✅ 发送成功: ...${webhook.slice(-8)}`);
                    else console.error(`❌ 发送失败 (...${webhook.slice(-8)}):`, data);
                } catch(e) { console.error('解析失败:', data); }
                resolve();
            });
        });
        req.on('error', e => { console.error('❌ 请求失败:', e.message); resolve(); });
        req.write(body);
        req.end();
    });
}

(async () => {
    console.log(`🚀 向 ${WEBHOOKS.length} 个群发送测试火警通知...`);
    for (const w of WEBHOOKS) await sendToWebhook(w);
    console.log('✅ 全部发送完成，请查看飞书群。');
})();

const https = require('https');

const WEBHOOKS = [
    'https://open.feishu.cn/open-apis/bot/v2/hook/486a84ae-3861-4652-b00d-cad5e2759cba', // 原群
    'https://open.feishu.cn/open-apis/bot/v2/hook/7c826fde-ab70-456d-ad8e-32cb6298f084', // 安全管理室群
];
const SITE_URL = 'https://zhangqiao2717.github.io/fire-platform';

const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const area = '总装车间';
const responsible = '刘海兰';

const confirmUrl1 = `${SITE_URL}?confirm=safe&area=${encodeURIComponent(area)}&name=${encodeURIComponent(responsible)}&time=${encodeURIComponent(now)}`;
const confirmUrl2 = `${SITE_URL}?confirm=emergency&area=${encodeURIComponent(area)}&name=${encodeURIComponent(responsible)}&time=${encodeURIComponent(now)}`;
const listContent = `**【${area}】** 负责人：${responsible}\n　1. 🔥 火警 | ⏰ ${now} | 待处理\n`;

const body = JSON.stringify({
    msg_type: 'interactive',
    card: {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '🚨 【测试】火警通知 · 1 条报警 · 请负责人确认' },
            template: 'red'
        },
        elements: [
            {
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**检测时间：** ${now}\n**报警数量：** 1 条\n**待确认负责人：** ${responsible}\n\n> ⚠️ 此为测试消息，非真实火警`
                }
            },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: listContent } },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: `**${responsible} 请现场核实后点击确认：**` } },
            {
                tag: 'action',
                actions: [
                    { tag: 'button', text: { tag: 'plain_text', content: '✅ 1. 已现场确认，无火情' }, type: 'primary', url: confirmUrl1 },
                    { tag: 'button', text: { tag: 'plain_text', content: '🚒 2. 现场发生火情，立即启动应急预案' }, type: 'danger', url: confirmUrl2 }
                ]
            },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '⚠️ 请务必现场核实后点击对应按钮确认' }] }
        ]
    }
});

function sendToWebhook(webhook) {
    return new Promise((resolve) => {
        const urlObj = new URL(webhook);
        const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.code === 0) {
                        console.log(`✅ 发送成功: ...${webhook.slice(-8)}`);
                    } else {
                        console.error(`❌ 发送失败 (...${webhook.slice(-8)}):`, data);
                    }
                } catch(e) {
                    console.error('解析响应失败:', data);
                }
                resolve();
            });
        });
        req.on('error', e => { console.error('❌ 请求失败:', e.message); resolve(); });
        req.write(body);
        req.end();
    });
}

(async () => {
    console.log(`🚀 向 ${WEBHOOKS.length} 个群发送测试火警通知...`);
    for (const webhook of WEBHOOKS) {
        await sendToWebhook(webhook);
    }
    console.log('✅ 全部发送完成，请查看飞书群。');
})();
