// coreLogic.js
// ==========================================================
// 1. 役職の定義は roles.csv から読み込む
// ==========================================================
//
// 役職を追加・調整したいときは roles.csv を編集してサーバーを再起動するだけでよい。
// 能力欄が空なら「能力なし」、値が入っていればサーバー側の対応する処理が動く。
// 対応している能力: fortune（占う）/ assassinate（暗殺する）/ follow（付いて同じ役職になる）
//
// 狼判定が TRUE の役職が処刑されたときだけ村人陣営の勝ちになる。
// このゲームは夜フェーズが無い独自ルールなので、能力はすべて議論中に1回だけ使う。

const fs = require('fs');
const path = require('path');

/** カンマ区切りを1行分パースする。ダブルクォートで囲めば中にカンマを書ける */
function parseCsvLine(line) {
    const cells = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cell += '"'; i++; }   // "" はエスケープされた "
                else inQuotes = false;
            } else cell += ch;
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            cells.push(cell);
            cell = '';
        } else {
            cell += ch;
        }
    }
    cells.push(cell);
    return cells.map(c => c.trim());
}

function loadRoles() {
    const csv = fs.readFileSync(path.join(__dirname, 'roles.csv'), 'utf8');
    const lines = csv.split(/\r?\n/).filter(l => l.trim() !== '');
    const header = parseCsvLine(lines[0]);
    const col = (name) => header.indexOf(name);

    const required = ['役職', '陣営', '狼判定', '能力', '能力ラベル', '偽装先', '初期枚数', '画像', '説明'];
    for (const name of required) {
        if (col(name) === -1) {
            throw new Error(`roles.csv に「${name}」列がありません。ヘッダー行を確認してください。`);
        }
    }

    const roles = {};
    const order = [];

    for (const line of lines.slice(1)) {
        const cells = parseCsvLine(line);
        const name = cells[col('役職')];
        if (!name) continue;

        const team = cells[col('陣営')];
        if (team !== '人狼陣営' && team !== '村人陣営') {
            throw new Error(`roles.csv:「${name}」の陣営が不正です（${team}）。人狼陣営 か 村人陣営 を指定してください。`);
        }

        const count = Number(cells[col('初期枚数')]);

        roles[name] = {
            name,
            team,
            isWerewolf: cells[col('狼判定')].toUpperCase() === 'TRUE',
            ability: cells[col('能力')] || null,
            abilityLabel: cells[col('能力ラベル')] || null,
            // 白狼のように、本人のカードには別の役職名を見せたい場合に使う
            disguiseAs: cells[col('偽装先')] || null,
            defaultCount: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
            image: cells[col('画像')] || 'backcard.png',
            description: cells[col('説明')] || '',
        };
        order.push(name);
    }

    if (order.length === 0) throw new Error('roles.csv に役職が1つもありません。');

    // 偽装先が実在する役職か確認しておく（タイプミスの早期検出）
    for (const r of Object.values(roles)) {
        if (r.disguiseAs && !roles[r.disguiseAs]) {
            throw new Error(`roles.csv:「${r.name}」の偽装先「${r.disguiseAs}」が役職一覧にありません。`);
        }
    }

    return { roles, order };
}

const { roles: ROLES, order: ROLE_ORDER } = loadRoles();

// 既存コードとの互換のため、これまでの ROLE_META と同じ形も用意しておく
const ROLE_META = Object.fromEntries(
    Object.entries(ROLES).map(([name, r]) => [name, { team: r.team, isWerewolf: r.isWerewolf }])
);

/** CSV の初期枚数から、部屋の初期構成を作る */
function defaultRoleConfig() {
    const config = {};
    for (const name of ROLE_ORDER) config[name] = ROLES[name].defaultCount;
    return config;
}

/** 画面側に渡す役職データ（サーバー内部だけの情報は含めない） */
function rolesForClient() {
    return ROLE_ORDER.map(name => {
        const r = ROLES[name];
        return {
            name: r.name,
            team: r.team,
            ability: r.ability,
            abilityLabel: r.abilityLabel,
            image: r.image,
            description: r.description,
        };
    });
}


// ==========================================================
// 2. 役職プール（カードの束）を生成する
// ==========================================================

function generateRolePool(config) {
    const pool = [];
    for (const roleName of Object.keys(config)) {
        if (!ROLES[roleName]) continue;   // roles.csv に無い名前は無視する
        for (let i = 0; i < config[roleName]; i++) {
            pool.push(roleName);
        }
    }
    return pool;
}


// ==========================================================
// 3. 役職のシャッフルと割り当て
// ==========================================================
// coreLogic.js の assignRoles 関数を修正 (崩壊防止ロジック部分を変更)

// coreLogic.js の assignRoles 関数を最終修正

function assignRoles(players, pool) {
    let shuffledPool = [];

    // ==========================================================
    // ⭐【最終保証ループ】人狼タグを持つ役職がプレイヤー駒に割り当てられるまでシャッフルを繰り返す
    // ==========================================================

    let humanOrComHasWerewolfTag = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 1000;

    // プレイヤー駒（A, B, C, COM）の人数は players.length で取得 (今回は4)
    const assignedPlayerCount = players.length;

    // 「人狼がいるか？」を事前にチェック
    const hasAnyWerewolf = pool.some(role => ROLE_META[role]?.isWerewolf);

    do {
        // ① シャッフル実行
        shuffledPool = [...pool];
        for (let i = shuffledPool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledPool[i], shuffledPool[j]] = [shuffledPool[j], shuffledPool[i]];
        }

        const assignedRolesToPlayers = shuffledPool.slice(0, assignedPlayerCount);

        if (hasAnyWerewolf) {
            const hasWerewolfInPlayers = assignedRolesToPlayers.some(role => ROLE_META[role]?.isWerewolf);
            if (hasWerewolfInPlayers) break; // 人狼がいればOK
        } else {
            break; // 人狼が最初からいなければ1回で終了
        }
        attempts++;
    } while (attempts < MAX_ATTEMPTS);

    // 以降、players に role を割り当てる処理（ここは既存のまま）
    const finalPlayers = players.map((p, index) => ({
        ...p,
        role: shuffledPool[index]
    }));

    return {
        players: finalPlayers,
        centerCards: shuffledPool.slice(assignedPlayerCount)
    };
}


// ==========================================================
// 4. 勝利判定ロジック
// ==========================================================

/**
 * 勝敗を決める。
 * 処刑と暗殺は同じ扱いで、どちらであっても「狼が退場したか」だけを見る。
 * 狼（人狼・白狼）が1人でも退場していれば村人陣営の勝ち。
 *
 * @param {Array}  players            全プレイヤー（最終的な役職が入っている）
 * @param {Object} executedPlayer     投票で処刑された人。いなければ null
 * @param {Array}  assassinatedPlayers 暗殺された人の配列
 */
function determineWinner(players, executedPlayer, assassinatedPlayers = []) {
    const isWolf = (p) => !!(p && ROLE_META[p.role]?.isWerewolf);

    const deadWolfByAssassin = assassinatedPlayers.find(isWolf);
    if (deadWolfByAssassin) {
        return {
            team: '村人チーム',
            message: `暗殺された${deadWolfByAssassin.name}は${deadWolfByAssassin.role}でした。村人チームの勝利です！`,
        };
    }

    if (isWolf(executedPlayer)) {
        return {
            team: '村人チーム',
            message: `処刑された${executedPlayer.name}は${executedPlayer.role}でした。村人チームの勝利です！`,
        };
    }

    if (!executedPlayer && assassinatedPlayers.length === 0) {
        return { team: '人狼チーム', message: '誰も退場しませんでした。' };
    }

    return { team: '人狼チーム', message: '狼を1人も退場させられませんでした。' };
}

// ==========================================================
// 5. サーバーで利用できるようにエクスポート
// ==========================================================

module.exports = {
    generateRolePool,
    assignRoles,
    determineWinner,
    ROLE_META,
    ROLES,
    ROLE_ORDER,
    defaultRoleConfig,
    rolesForClient,
};

