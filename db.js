// db.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error('❌ Supabase 환경변수 누락: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY를 확인하세요.');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

async function saveTrade(tradeData) {
    const payload = {
        is_simulated: false,
        ...tradeData
    };

    const { data, error } = await supabase.from('quant_trades').insert([payload]);
    if (error) console.error("❌ DB 저장 에러(trades):", error);
    return data;
}

async function saveAILog(logData) {
    const payload = {
        is_simulated: false,
        ...logData
    };

    const { data, error } = await supabase.from('quant_ai_logs').insert([payload]);
    if (error) console.error("❌ DB 저장 에러(ai_logs):", error);
    return data;
}

async function getOpenPosition(market = 'KRW-BTC', isSimulated = false) {
    const { data, error } = await supabase
        .from('quant_positions')
        .select('*')
        .eq('market', market)
        .eq('status', 'OPEN')
        .eq('is_simulated', isSimulated)
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error('❌ DB 조회 에러(open_position):', error);
        return null;
    }
    return data;
}

async function createOpenPosition(positionData) {
    const payload = {
        is_simulated: false,
        status: 'OPEN',
        ...positionData
    };

    const { data, error } = await supabase
        .from('quant_positions')
        .insert([payload])
        .select('*')
        .single();

    if (error) {
        console.error('❌ DB 저장 에러(open_position):', error);
        return null;
    }
    return data;
}

async function updateOpenPosition(positionId, patch) {
    const { data, error } = await supabase
        .from('quant_positions')
        .update(patch)
        .eq('id', positionId)
        .eq('status', 'OPEN')
        .select('*')
        .maybeSingle();

    if (error) {
        console.error('❌ DB 업데이트 에러(open_position):', error);
        return null;
    }
    return data;
}

async function closePosition(positionId, exitPrice, exitReason) {
    const { data, error } = await supabase
        .from('quant_positions')
        .update({
            status: 'CLOSED',
            exit_price: exitPrice,
            exit_reason: exitReason,
            closed_at: new Date().toISOString()
        })
        .eq('id', positionId)
        .eq('status', 'OPEN')
        .select('*')
        .maybeSingle();

    if (error) {
        console.error('❌ DB 종료 에러(close_position):', error);
        return null;
    }
    return data;
}

async function getTradeCashflowSummary(isSimulated = false) {
    const { data, error } = await supabase
        .from('quant_trades')
        .select('side,amount,is_simulated')
        .eq('is_simulated', isSimulated);

    if (error) {
        console.error('❌ DB 조회 에러(trade_summary):', error);
        return {
            totalBuy: 0,
            totalSell: 0,
            totalInvested: 0,
            totalEarned: 0,
            totalLost: 0,
            netCashflow: 0
        };
    }

    let totalBuy = 0;
    let totalSell = 0;
    for (const row of data || []) {
        const amount = Number(row.amount || 0);
        if (row.side === 'buy') totalBuy += amount;
        if (row.side === 'sell') totalSell += amount;
    }

    const netCashflow = totalSell - totalBuy;
    return {
        totalBuy,
        totalSell,
        totalInvested: totalBuy,
        totalEarned: netCashflow > 0 ? netCashflow : 0,
        totalLost: netCashflow < 0 ? Math.abs(netCashflow) : 0,
        netCashflow
    };
}

async function getOpenPositionsTotal(isSimulated = false) {
    const { data, error } = await supabase
        .from('quant_positions')
        .select('invested_krw')
        .eq('status', 'OPEN')
        .eq('is_simulated', isSimulated);

    if (error) {
        console.error('❌ DB 조회 에러(open_positions_total):', error);
        return 0;
    }

    return (data || []).reduce((sum, row) => sum + Number(row.invested_krw || 0), 0);
}

async function upsertSyncReport(reportData) {
    const today = new Date().toISOString().slice(0, 10);
    const payload = {
        report_date: reportData.report_date || today,
        is_simulated: reportData.is_simulated ?? false,
        checked_markets: reportData.checked_markets ?? 0,
        mismatches: reportData.mismatches ?? 0,
        recovered_count: reportData.recovered_count ?? 0,
        closed_count: reportData.closed_count ?? 0,
        qty_adjusted_count: reportData.qty_adjusted_count ?? 0,
        details: reportData.details || null
    };

    const { data, error } = await supabase
        .from('quant_sync_reports')
        .upsert(payload, { onConflict: 'report_date,is_simulated' })
        .select('*')
        .maybeSingle();

    if (error) {
        console.error('❌ DB 저장 에러(sync_reports):', error);
        return null;
    }
    return data;
}

module.exports = {
    saveTrade,
    saveAILog,
    getOpenPosition,
    createOpenPosition,
    updateOpenPosition,
    closePosition,
    getTradeCashflowSummary,
    getOpenPositionsTotal,
    upsertSyncReport
};