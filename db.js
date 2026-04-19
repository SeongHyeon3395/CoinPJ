// db.js
const fs = require('fs');
const path = require('path');

// 1. 저장 경로 설정 (프로젝트 폴더 내 /data)
const DATA_DIR = path.join(__dirname, 'data');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const HISTORY_FILE = path.join(DATA_DIR, 'trades_history.json');

// 호환성/운영 로그 파일
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const AI_LOGS_FILE = path.join(DATA_DIR, 'ai_logs.json');
const SYNC_REPORTS_FILE = path.join(DATA_DIR, 'sync_reports.json');

// 2. 초기화: data 폴더가 없으면 스스로 만듭니다.
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log("📁 데이터 저장용 'data' 폴더를 생성했습니다.");
}

// 3. 파일 읽기 도우미 함수
function readJSON(filePath) {
    try {
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return [];
    }
}

// 4. 파일 쓰기 도우미 함수
function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * [함수 1] 현재 보유 중인 포지션 확인
 */
async function getOpenPosition(market) {
    const positions = readJSON(POSITIONS_FILE);
    return positions.find((p) => p.market === market && p.status === 'OPEN') || null;
}

async function listOpenPositions() {
    const positions = readJSON(POSITIONS_FILE);
    return positions.filter((p) => p.status === 'OPEN');
}

/**
 * [함수 2] 매수 직후 포지션 데이터 생성
 */
async function createOpenPosition(data) {
    const positions = readJSON(POSITIONS_FILE);
    const newPosition = {
        id: `pos_${Date.now()}`,
        ...data,
        status: 'OPEN',
        created_at: new Date().toISOString()
    };
    positions.push(newPosition);
    writeJSON(POSITIONS_FILE, positions);
    console.log(`💾 [DB] 신규 매수 기록 완료 (${data.market})`);
    return newPosition;
}

/**
 * [함수 3] 트레일링 스탑, 수익률 등 실시간 갱신
 */
async function updatePosition(id, updateData) {
    const positions = readJSON(POSITIONS_FILE);
    const index = positions.findIndex((p) => p.id === id);
    if (index !== -1) {
        positions[index] = {
            ...positions[index],
            ...updateData,
            updated_at: new Date().toISOString()
        };
        writeJSON(POSITIONS_FILE, positions);
        return positions[index];
    }
    return null;
}

/**
 * [함수 4] 매도 완료 후 포지션 종료 및 히스토리 저장
 */
async function closePosition(id, exitPrice, exitReason) {
    const positions = readJSON(POSITIONS_FILE);
    const index = positions.findIndex((p) => p.id === id);

    if (index !== -1) {
        const closedPosition = {
            ...positions[index],
            exit_price: exitPrice,
            exit_reason: exitReason,
            status: 'CLOSED',
            closed_at: new Date().toISOString()
        };

        // 현재 목록에서 업데이트
        positions[index] = closedPosition;
        writeJSON(POSITIONS_FILE, positions);

        // 과거 거래 기록 파일에 따로 한 번 더 저장
        const history = readJSON(HISTORY_FILE);
        history.push(closedPosition);
        writeJSON(HISTORY_FILE, history);

        console.log(`🏁 [DB] 포지션 종료 및 기록 완료 (${exitReason})`);
        return closedPosition;
    }

    return null;
}

// --- 기존 main.js와의 API 호환 함수들 ---
async function updateOpenPosition(positionId, patch) {
    return updatePosition(positionId, patch);
}

async function saveTrade(tradeData) {
    const trades = readJSON(TRADES_FILE);
    const row = {
        id: `trade_${Date.now()}`,
        ...tradeData,
        is_simulated: tradeData?.is_simulated ?? false,
        created_at: new Date().toISOString()
    };
    trades.push(row);
    writeJSON(TRADES_FILE, trades);
    return row;
}

async function saveAILog(logData) {
    const logs = readJSON(AI_LOGS_FILE);
    const row = {
        id: `ai_${Date.now()}`,
        ...logData,
        is_simulated: logData?.is_simulated ?? false,
        created_at: new Date().toISOString()
    };
    logs.push(row);
    writeJSON(AI_LOGS_FILE, logs);
    return row;
}

async function upsertSyncReport(reportData) {
    const reports = readJSON(SYNC_REPORTS_FILE);
    const reportDate = reportData?.report_date || new Date().toISOString().slice(0, 10);
    const isSimulated = reportData?.is_simulated ?? false;

    const index = reports.findIndex(
        (r) => r.report_date === reportDate && (r.is_simulated ?? false) === isSimulated
    );

    const payload = {
        ...reportData,
        report_date: reportDate,
        is_simulated: isSimulated,
        updated_at: new Date().toISOString()
    };

    if (index === -1) {
        reports.push({ id: `sync_${Date.now()}`, ...payload, created_at: new Date().toISOString() });
    } else {
        reports[index] = { ...reports[index], ...payload };
    }

    writeJSON(SYNC_REPORTS_FILE, reports);
    return index === -1 ? reports[reports.length - 1] : reports[index];
}

module.exports = {
    getOpenPosition,
    listOpenPositions,
    createOpenPosition,
    updatePosition,
    updateOpenPosition,
    closePosition,
    saveTrade,
    saveAILog,
    upsertSyncReport
};