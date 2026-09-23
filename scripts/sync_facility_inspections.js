#!/usr/bin/env node
/**
 * 同步北京基地消防管理平台的设施巡查数据。
 *
 * 读取飞书多维表格并仅将汇总结果写入 data.json 中的
 * facilityInspections 字段，供“设施巡查”页面加载展示。
 *
 * 需要环境变量：FEISHU_APP_ID、FEISHU_APP_SECRET
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = 'NrR0bFXlMasyX7suJKmcwzdGn8M';
const DATA_FILE = path.join(__dirname, '..', 'data.json');

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

const SKIP_FIELD_NAMES = [
    '照片', '地理位置', '提交人', '人员', '巡查区域',
    '文本', 'record_id', '区域', '姓名', '提交时间', '巡查日期',
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

async function getAllRecords(token, tableId) {
    const records = [];
    let pageToken = '';

    do {
        const query = new URLSearchParams({ page_size: '500' });
        if (pageToken) query.set('page_token', pageToken);
        const result = await request({
            hostname: 'open.feishu.cn',
            path: `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records?${query}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });

        if (result.code !== 0) {
            throw new Error(result.msg || `读取表 ${tableId} 失败`);
        }

        records.push(...(result.data?.items || []));
        pageToken = result.data?.has_more ? (result.data.page_token || '') : '';
    } while (pageToken);

    return records;
}

function valueText(value) {
    if (Array.isArray(value)) return value[0] ?? '';
    return typeof value === 'string' ? value : '';
}

function formatDate(value) {
    if (!value) return '';
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function buildAreaStatistics(name, records) {
    const area = { area: name, records: [], ok: 0, ng: 0, ngItems: [], dates: [] };

    for (const item of records) {
        const fields = item.fields || {};
        const date = formatDate(fields['巡查时间'] || fields['提交时间'] || fields['巡查日期']);
        const statistic = { date, ok: 0, ng: 0, ngSystems: [], problems: [] };

        for (const [field, rawValue] of Object.entries(fields)) {
            if (SKIP_FIELD_NAMES.some(skip => field.includes(skip)) || field.endsWith('照片')) continue;
            const value = valueText(rawValue);
            if (value === 'OK') {
                statistic.ok++;
                area.ok++;
            } else if (value === 'NG') {
                statistic.ng++;
                area.ng++;
                statistic.ngSystems.push(field);
                area.ngItems.push({ date, system: field });
            }
        }

        for (const [field, value] of Object.entries(fields)) {
            if (field.includes('问题记录') && value) statistic.problems.push(String(value));
        }

        if (date) area.dates.push(date);
        area.records.push(statistic);
    }

    area.dates.sort((a, b) => new Date(a) - new Date(b));
    area.lastDate = area.dates.at(-1) || '';
    delete area.dates;
    return area;
}

function currentMonth() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    }).formatToParts(new Date());
    const value = type => parts.find(part => part.type === type)?.value;
    return `${value('year')}-${value('month')}`;
}

async function main() {
    if (!APP_ID || !APP_SECRET) {
        throw new Error('缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET 环境变量');
    }

    const token = await getTenantAccessToken();
    const areas = [];

    for (const table of FACILITY_TABLES) {
        try {
            const records = await getAllRecords(token, table.id);
            const area = buildAreaStatistics(table.name, records);
            areas.push(area);
            console.log(`✅ ${table.name}：${area.records.length} 条记录，OK=${area.ok}，NG=${area.ng}`);
        } catch (error) {
            console.warn(`⚠️ ${table.name} 同步失败：${error.message}`);
        }
    }

    if (!areas.length) throw new Error('所有设施巡查表均未能读取，未写入 data.json');

    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const totalOk = areas.reduce((sum, area) => sum + area.ok, 0);
    const totalNg = areas.reduce((sum, area) => sum + area.ng, 0);
    const updatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    data.facilityInspections = { updatedAt, month: currentMonth(), totalOk, totalNg, areas };
    data._updated = new Date().toISOString();
    data._facility_inspections_updated = data._updated;

    fs.writeFileSync(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log(`\n✅ 设施巡查同步完成：${areas.length} 个区域，OK=${totalOk}，NG=${totalNg}`);
}

main().catch(error => {
    console.error(`❌ 设施巡查同步失败：${error.message}`);
    process.exit(1);
});
