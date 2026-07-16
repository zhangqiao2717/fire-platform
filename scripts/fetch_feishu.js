/**
 * 飞书数据抓取脚本
 * 每天由 GitHub Actions 自动运行
 * 将飞书电子表格数据写入 public/data.json
 *
 * 环境变量（在 GitHub Secrets 中配置）：
 *   FEISHU_APP_ID     — 飞书自建应用 App ID
 *   FEISHU_APP_SECRET — 飞书自建应用 App Secret
 *   FEISHU_SHEET_TOKEN — 电子表格 Token（URL 中提取）
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================
// 配置区 — 按实际情况修改
// ============================================================
const APP_ID     = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const SHEET_TOKEN = process.env.FEISHU_SHEET_TOKEN || 'UyWxsvbskhbRdkt0TYOcFV5HnUc';

// 飞书表格中各工作表的 sheet_id（运行一次后从日志中确认）
// 格式：{ 网页模块名: '飞书工作表ID' }
const SHEET_ID_MAP = {
  duty:       process.env.SHEET_ID_DUTY       || '',  // 值班记录
  fault:      process.env.SHEET_ID_FAULT      || '',  // 故障巡查
  record:     process.env.SHEET_ID_RECORD     || '',  // 保养记录
  testRecord: process.env.SHEET_ID_TESTRECORD || '',  // 测试记录
  training:   process.env.SHEET_ID_TRAINING   || '',  // 培训记录
  assessment: process.env.SHEET_ID_ASSESSMENT || '',  // 月度考核
};

// 输出文件路径
const OUTPUT_PATH = path.join(__dirname, '..', 'data.json');

// ============================================================
// 工具函数
// ============================================================

/** 发送 HTTPS 请求（返回 Promise） */
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON 解析失败: ' + data)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** 获取 tenant_access_token */
async function getToken() {
  const result = await request({
    hostname: 'open.feishu.cn',
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }, { app_id: APP_ID, app_secret: APP_SECRET });

  if (result.code !== 0) {
    throw new Error('获取 Token 失败: ' + JSON.stringify(result));
  }
  console.log('✅ Token 获取成功');
  return result.tenant_access_token;
}

/** 获取工作簿中所有工作表信息 */
async function getSheetList(token) {
  const result = await request({
    hostname: 'open.feishu.cn',
    path: `/open-apis/sheets/v3/spreadsheets/${SHEET_TOKEN}/sheets/query`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
  if (result.code !== 0) throw new Error('获取工作表列表失败: ' + JSON.stringify(result));
  const sheets = result.data.sheets;
  console.log('📋 工作表列表:');
  sheets.forEach(s => console.log(`   - ${s.title}（sheet_id: ${s.sheet_id}）`));
  return sheets;
}

/** 读取指定工作表的数据 */
async function readSheet(token, sheetId) {
  if (!sheetId) return [];
  const result = await request({
    hostname: 'open.feishu.cn',
    path: `/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${sheetId}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
  if (result.code !== 0) {
    console.warn(`⚠️  读取工作表 ${sheetId} 失败:`, result.msg);
    return [];
  }
  const rows = result.data.valueRange.values || [];
  // 去掉表头行（第一行），空行过滤
  return rows.slice(1).filter(row => row && row.some(cell => cell !== '' && cell !== null));
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  // 校验环境变量
  if (!APP_ID || !APP_SECRET) {
    console.error('❌ 缺少环境变量 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
    console.log('ℹ️  本地测试时请创建 .env 文件或手动设置环境变量');
    console.log('ℹ️  生产环境请在 GitHub Secrets 中配置');
    process.exit(1);
  }

  console.log('🚀 开始抓取飞书数据...');
  console.log(`📊 表格 Token: ${SHEET_TOKEN}`);

  const token = await getToken();

  // 先列出所有工作表（方便你确认 sheet_id）
  const sheetList = await getSheetList(token);

  // 自动按工作表名称匹配（如果 SHEET_ID_MAP 未手动填写）
  const nameToKey = {
    '值班记录': 'duty',
    '故障巡查': 'fault',
    '保养记录': 'record',
    '测试记录': 'testRecord',
    '培训记录': 'training',
    '月度考核': 'assessment',
  };

  // 用工作表标题自动填充 sheetId
  sheetList.forEach(s => {
    const key = nameToKey[s.title];
    if (key && !SHEET_ID_MAP[key]) {
      SHEET_ID_MAP[key] = s.sheet_id;
      console.log(`🔗 自动匹配: "${s.title}" → ${key} (${s.sheet_id})`);
    }
  });

  // 抓取各模块数据
  const result = {
    _updated: new Date().toISOString(),
    _source: 'feishu_auto',
    duty:       await readSheet(token, SHEET_ID_MAP.duty),
    fault:      await readSheet(token, SHEET_ID_MAP.fault),
    record:     await readSheet(token, SHEET_ID_MAP.record),
    testRecord: await readSheet(token, SHEET_ID_MAP.testRecord),
    training:   await readSheet(token, SHEET_ID_MAP.training),
    assessment: await readSheet(token, SHEET_ID_MAP.assessment),
  };

  // 打印抓取摘要
  console.log('\n📊 抓取结果摘要:');
  Object.entries(result).forEach(([k, v]) => {
    if (k.startsWith('_')) return;
    console.log(`   ${k}: ${Array.isArray(v) ? v.length + ' 条' : '—'}`);
  });

  // 写入 data.json
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\n✅ 数据已写入 ${OUTPUT_PATH}`);
  console.log(`⏰ 更新时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
}

main().catch(err => {
  console.error('❌ 脚本执行失败:', err.message);
  process.exit(1);
});
