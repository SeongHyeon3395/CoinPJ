const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUTO_CONFIRM = process.argv.includes('--yes');

function resetDataDirectory() {
    if (!fs.existsSync(DATA_DIR)) {
        console.log('[reset] data directory does not exist. nothing to reset.');
        return;
    }

    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log('[reset] removed data directory.');
}

function askConfirmation() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question('Reset local JSON DB (data folder)? This cannot be undone. (yes/no): ', (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'yes');
        });
    });
}

(async () => {
    if (AUTO_CONFIRM) {
        resetDataDirectory();
        return;
    }

    const ok = await askConfirmation();
    if (!ok) {
        console.log('[reset] canceled.');
        return;
    }

    resetDataDirectory();
})();
