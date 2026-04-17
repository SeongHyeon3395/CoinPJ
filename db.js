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

module.exports = {
    saveTrade,
    saveAILog,
    getOpenPosition,
    createOpenPosition,
    updateOpenPosition,
    closePosition
};