#!/usr/bin/env node
/**
 * 同步北京基地消防管理平台的防火巡查数据。
 *
 * 从飞书多维表格读取防火巡查记录，并将汇总结果写入 data.json 的
 * fireInspections 字段，供网页“防火巡查”导航页展示。
 *
 * 需要环境变量：FEISHU_APP_ID、FEISHU_APP_SECRET
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = 'NrR0bFXlMasyX7suJKmcwzdGn8M';
const FIRE_TABLE_ID = 'tblIKaQ1BtB6rQoo';
const DATA_FILE = path.join(__dirname, '..', 'data.json');

const FIRE_CHECK_FIELDS = [
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

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let response = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { response += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(response);
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

async function getTenantAccessToken() {
    const result = await request({
        hostname: 'open.feishu.cn',
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }, { app_id: APP_ID, app_secret: APP_SECRET });

    if (result.code !== 0 || !result.tenant_access_token) {
        throw new Error(`获取飞书访问令牌失败：${result.msg || result.code}`);
    }
    return result.tenant_access_token;
}

async function getAllRecords(token) {
    const records = [];
    let pageToken = '';

    do {
        const query = new URLSearchParams({ page_size: '500' });
        if (pageToken) query.set('page_token', pageToken);
        const result = await request({
            hostname: 'open.feishu.cn',
            path: `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${FIRE_TABLE_ID}/records?${query}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });

        if (result.code !== 0) throw new Error(result.msg || '读取防火巡查表失败');
        records.push(...(result.data?.items || []));
        pageToken = result.data?.has_more ? (result.data.page_token || '') : '';
    } while (pageToken);

    return records;
}

function toDateParts(value) {
    if (!value) return { month: '', date: '' };
    const parsed = new Date(Number(value));
    if (Number.isNaN(parsed.getTime())) return { month: '', date: '' };

    const values = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(parsed);
    const get = type => values.find(valuePart => valuePart.type === type)?.value;
    const year = get('year');
    const month = get('month');
    const day = get('day');
    return { month: `${year}-${month}`, date: `${year}/${Number(month)}/${Number(day)}` };
}

function currentMonth() {
    return toDateParts(Date.now()).month;
}

function personNames(value) {
    if (Array.isArray(value)) return value.map(person => person?.name).filter(Boolean).join('/');
    return value?.name || '';
}

function asText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('、');
    if (value && typeof value === 'object') return value.text || value.name || '';
    return value === null || value === undefined ? '' : String(value);
}

function buildFireInspections(items) {
    const byCategory = FIRE_CHECK_FIELDS.map(name => ({ name, ok: 0, ng: 0, months: {} }));
    const monthAggregates = {};
    const records = [];

    for (const item of items) {
        const fields = item.fields || {};
        const { month, date } = toDateParts(fields['巡查日期'] || fields['提交时间']);
        const categories = {};
        const problems = ['1问题记录', '2问题记录']
            .map(field => asText(fields[field]))
            .filter(Boolean);
        let ok = 0;
        let ng = 0;

        FIRE_CHECK_FIELDS.forEach((field, index) => {
            const result = asText(fields[field]);
            categories[field] = result;
            if (result === 'OK' || result === 'NG') {
                const category = byCategory[index];
                const monthStatistics = category.months[month] || (category.months[month] = { ok: 0, ng: 0 });
                if (result === 'OK') {
                    ok++;
                    category.ok++;
                    if (month) monthStatistics.ok++;
                } else {
                    ng++;
                    category.ng++;
                    if (month) monthStatistics.ng++;
                }
            }
        });

        if (month) {
            const aggregate = monthAggregates[month] || (monthAggregates[month] = { records: 0, ok: 0, ng: 0 });
            aggregate.records++;
            aggregate.ok += ok;
            aggregate.ng += ng;
        }

        records.push({
            date,
            month,
            submitter: personNames(fields['提交人']),
            inspector: personNames(fields['巡查人员']),
            ok,
            ng,
            categories,
            ngKeys: FIRE_CHECK_FIELDS.filter(field => categories[field] === 'NG'),
            problems,
            recordId: item.record_id,
        });
    }

    records.sort((left, right) => String(right.date).localeCompare(String(left.date)));
    const months = Object.keys(monthAggregates)
        .sort()
        .reverse()
        .map(month => ({ month, ...monthAggregates[month] }));

    return {
        updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        currentMonth: currentMonth(),
        totalRecords: records.length,
        totalOk: byCategory.reduce((sum, category) => sum + category.ok, 0),
        totalNg: byCategory.reduce((sum, category) => sum + category.ng, 0),
        byCategory,
        months,
        records,
    };
}

async function main() {
    if (!APP_ID || !APP_SECRET) {
        throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET 环境变量');
    }

    const token = await getTenantAccessToken();
    const items = await getAllRecords(token);
    const fireInspections = buildFireInspections(items);

    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    data.fireInspections = fireInspections;
    data._updated = new Date().toISOString();
    data._fire_inspections_updated = data._updated;
    fs.writeFileSync(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

    const monthData = fireInspections.months.find(month => month.month === fireInspections.currentMonth);
    console.log(`✅ 防火巡查同步完成：${fireInspections.totalRecords} 条记录，当前月 ${fireInspections.currentMonth} ${monthData?.records || 0} 条，OK=${monthData?.ok || 0}，NG=${monthData?.ng || 0}`);
}

main().catch(error => {
    console.error(`❌ 防火巡查同步失败：${error.message}`);
    process.exit(1);
});
