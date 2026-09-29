/**
 * 消防保养任务推送与 25 日执行汇总
 *
 * 用法：
 *   node scripts/send_monthly_plan.js --mode=dispatch
 *   node scripts/send_monthly_plan.js --mode=reminder
 *   node scripts/send_monthly_plan.js --month=8 --mode=dispatch
 *   node scripts/send_monthly_plan.js --test
 *
 * 环境变量：
 *   FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_MAINTENANCE_CHAT_ID、FIRE_PLATFORM_URL
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG = {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    chatId: process.env.FEISHU_MAINTENANCE_CHAT_ID || 'oc_5cedb65c30a3cf0887b1870b4cd08e82',
    siteUrl: (process.env.FIRE_PLATFORM_URL || 'http://10.231.43.248:8080').replace(/\/$/, ''),
    dataFile: path.join(__dirname, '..', 'data.json'),
    baseToken: 'EZsjbgvvLayY7SsAJktcueMIn3f',
    maintenanceTableId: 'tblTzKaHm8owsQH1',
};

const MAINTAINERS = [
    { name: '孙伟', openId: 'ou_63124c2341b701f4a9fef354a6d80f70' },
    { name: '牛超', openId: 'ou_f31b4418835c8636e1a57deb8bf78cb7' },
];

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(json.msg || `HTTP ${res.statusCode}`));
                        return;
                    }
                    resolve(json);
                } catch {
                    reject(new Error('飞书接口返回了无法解析的数据'));
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function getTenantToken() {
    const result = await request({
        hostname: 'open.feishu.cn',
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }, { app_id: CONFIG.appId, app_secret: CONFIG.appSecret });
    if (result.code !== 0 || !result.tenant_access_token) {
        throw new Error(`获取飞书访问令牌失败：${result.msg || result.code}`);
    }
    return result.tenant_access_token;
}

async function getAllRecords(token) {
    const records = [];
    let pageToken = '';
    do {
        const query = new URLSearchParams({ page_size: '500', text_field_option: 'html' });
        if (pageToken) query.set('page_token', pageToken);
        const result = await request({
            hostname: 'open.feishu.cn',
            path: `/open-apis/bitable/v1/apps/${CONFIG.baseToken}/tables/${CONFIG.maintenanceTableId}/records?${query}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        if (result.code !== 0) throw new Error(`读取消防保养计划失败：${result.msg || result.code}`);
        records.push(...(result.data?.items || []));
        pageToken = result.data?.has_more ? (result.data.page_token || '') : '';
    } while (pageToken);
    return records;
}

function plainText(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value)
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();
        return text && !text.startsWith('opt') ? text : fallback;
    }
    if (Array.isArray(value)) {
        const values = value.map(item => plainText(item, '')).filter(Boolean);
        return values.length ? values.join('、') : fallback;
    }
    if (typeof value === 'object') return plainText(value.text ?? value.value ?? value.name ?? '', fallback);
    return fallback;
}

function taskFromRecord(record) {
    const fields = record.fields || {};
    return {
        id: record.record_id,
        month: plainText(fields['计划实施月份'], ''),
        project: plainText(fields['保养项目']),
        content: plainText(fields['保养内容']),
        frequency: plainText(fields['保养频次']),
        system: plainText(fields['系统名称']),
    };
}

function matchesMonth(value, month) {
    return String(value || '').split(/[、,，\s]+/).some(item => parseInt(item, 10) === month);
}

function readData() {
    try { return JSON.parse(fs.readFileSync(CONFIG.dataFile, 'utf8')); } catch { return {}; }
}

function writeData(data) {
    fs.writeFileSync(CONFIG.dataFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function sendGroupCard(token, card) {
    const result = await request({
        hostname: 'open.feishu.cn',
        path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    }, {
        receive_id: CONFIG.chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
    });
    if (result.code !== 0) throw new Error(`发送北京基地消防工作群消息失败：${result.msg || result.code}`);
    return result.data?.message_id || '';
}

function atMaintainers() {
    return MAINTAINERS.map(person => `<at id="${person.openId}"></at>`).join(' ');
}

function taskSummary(tasks) {
    return tasks.map((task, index) => `${index + 1}. **${task.system}** · ${task.project}\n　${task.content}（${task.frequency}）`).join('\n');
}

function dispatchCard({ year, month, tasks, dispatchId, now }) {
    const url = `${CONFIG.siteUrl}/?action=maintenance-report&dispatchId=${encodeURIComponent(dispatchId)}`;
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: `🛠️ 【${year}年${month}月】消防保养任务下发` }, template: 'blue' },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content: `${atMaintainers()}\n**孙伟、牛超：本月消防保养任务已下发，请接收并按计划完成。**` } },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: `**下发时间：** ${now}\n**任务数量：** ${tasks.length} 项` } },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: `**本月任务清单：**\n${taskSummary(tasks)}` } },
            { tag: 'hr' },
            { tag: 'action', actions: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '✅ 接收并填报任务' },
                type: 'primary',
                url,
                confirm_users: MAINTAINERS.map(person => person.openId),
            }] },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '点击后请逐项填写执行数量、执行人并上传现场保养照片。' }] },
        ],
    };
}

function reminderCard({ year, month, dispatch, reports, now }) {
    const completed = new Set(reports.map(report => report.task_id));
    const finishedTasks = dispatch.tasks.filter(task => completed.has(task.id));
    const unfinishedTasks = dispatch.tasks.filter(task => !completed.has(task.id));
    const rate = dispatch.tasks.length ? Math.round(finishedTasks.length / dispatch.tasks.length * 100) : 0;
    const allDone = unfinishedTasks.length === 0;
    const content = allDone
        ? `**${atMaintainers()} ${year}年${month}月消防保养任务已全部完成。**\n\n完成任务：${finishedTasks.length}/${dispatch.tasks.length} 项\n完成率：${rate}%\n回报人员：${[...new Set(reports.map(report => report.reporter).filter(Boolean))].join('、') || '—'}\n\n请继续保持保养记录和现场照片完整。`
        : `**${atMaintainers()} ${year}年${month}月消防保养尚有 ${unfinishedTasks.length} 项未完成，请尽快完成并提交数量、执行人和现场照片。**\n\n已完成：${finishedTasks.length}/${dispatch.tasks.length} 项（${rate}%）\n\n**未完成任务：**\n${taskSummary(unfinishedTasks)}`;
    const url = `${CONFIG.siteUrl}/?action=maintenance-report&dispatchId=${encodeURIComponent(dispatch.id)}`;
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: allDone ? `✅ 【${year}年${month}月】消防保养完成结果` : `⚠️ 【${year}年${month}月】消防保养未完成提醒` }, template: allDone ? 'green' : 'orange' },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content } },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content: `**汇总时间：** ${now}` } },
            { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: allDone ? '查看完成回报' : '继续完成并填报' }, type: 'primary', url, confirm_users: MAINTAINERS.map(person => person.openId) }] },
        ],
    };
}

async function dispatch({ year, month, test }) {
    const token = await getTenantToken();
    const tasks = (await getAllRecords(token)).map(taskFromRecord).filter(task => matchesMonth(task.month, month));
    if (!tasks.length) {
        console.log(`ℹ️ ${year}年${month}月没有消防保养任务`);
        return;
    }

    const data = readData();
    const dispatches = data.maintenance_dispatches || [];
    const existing = dispatches.find(item => item.year === year && item.month === month);
    if (existing) {
        console.log(`ℹ️ ${year}年${month}月任务已在 ${existing.dispatch_time} 下发，跳过重复下发`);
        return;
    }

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const dispatchId = `maintenance_${year}_${String(month).padStart(2, '0')}`;
    const card = dispatchCard({ year, month, tasks, dispatchId, now });
    if (!test) await sendGroupCard(token, card);

    dispatches.unshift({
        id: dispatchId,
        year,
        month,
        month_label: `${year}年${month}月`,
        tasks,
        task_count: tasks.length,
        dispatch_time: now,
        receivers: MAINTAINERS.map(person => person.name),
        accepted_by: [],
        accepted_at: '',
    });
    data.maintenance_dispatches = dispatches.slice(0, 24);
    writeData(data);
    console.log(`✅ ${year}年${month}月消防保养任务已${test ? '模拟' : ''}下发：${tasks.length} 项`);
}

async function remind({ year, month, test }) {
    const data = readData();
    const dispatch = (data.maintenance_dispatches || []).find(item => item.year === year && item.month === month);
    if (!dispatch) {
        console.log(`ℹ️ 未找到 ${year}年${month}月下发任务，跳过 25 日汇总`);
        return;
    }
    if ((data.maintenance_reminders || []).some(item => item.year === year && item.month === month)) {
        console.log(`ℹ️ ${year}年${month}月 25 日汇总已发送，跳过重复推送`);
        return;
    }

    const reports = (data.maintenance_reports || []).filter(report => report.dispatch_id === dispatch.id);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const token = await getTenantToken();
    const card = reminderCard({ year, month, dispatch, reports, now });
    if (!test) await sendGroupCard(token, card);

    const doneIds = new Set(reports.map(report => report.task_id));
    data.maintenance_reminders = [{
        id: `maintenance_reminder_${year}_${String(month).padStart(2, '0')}`,
        year,
        month,
        sent_at: now,
        completed_count: dispatch.tasks.filter(task => doneIds.has(task.id)).length,
        total_count: dispatch.tasks.length,
    }, ...(data.maintenance_reminders || [])].slice(0, 24);
    writeData(data);
    console.log(`✅ ${year}年${month}月 25 日消防保养汇总已${test ? '模拟' : ''}发送`);
}

async function main() {
    const args = process.argv.slice(2);
    const mode = (args.find(arg => arg.startsWith('--mode=')) || '--mode=dispatch').split('=')[1];
    const test = args.includes('--test');
    const now = new Date();
    const month = parseInt((args.find(arg => arg.startsWith('--month=')) || `--month=${now.getMonth() + 1}`).split('=')[1], 10);
    const year = parseInt((args.find(arg => arg.startsWith('--year=')) || `--year=${now.getFullYear()}`).split('=')[1], 10);
    if (!CONFIG.appId || !CONFIG.appSecret) throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('月份必须是 1-12');
    if (!['dispatch', 'reminder'].includes(mode)) throw new Error('mode 仅支持 dispatch 或 reminder');

    if (mode === 'dispatch') await dispatch({ year, month, test });
    else await remind({ year, month, test });
}

main().catch(error => {
    console.error(`❌ 消防保养任务处理失败：${error.message}`);
    process.exit(1);
});
