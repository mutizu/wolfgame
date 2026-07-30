// client.js
//
// 役職の定義（陣営・能力・画像・説明）はサーバーの roles.csv が持っている。
// この画面は起動時に /roles.json を取得してから動きはじめる。

const socket = io();

let ROLES = {};                 // 役職名 -> { name, team, ability, abilityLabel, image, description }
let ROLE_ORDER = [];            // roles.csv に書かれている順
let rolesLoaded = false;

let isHost = false;
let currentRoomId = null;
let currentRoleConfig = {};
let lastPlayerCount = 0;
let lastCpuChecked = false;

let myRole = null;              // 自分の役職（付き人が能力を使うと変わる）
let abilityUsed = false;        // 能力は1ゲームに1回だけ
let deadIds = new Set();        // 暗殺された人。投票できない

// ---------- HTML要素 ----------
const entryScreen = document.getElementById('entry-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const nameInput = document.getElementById('name-input');
const roomCodeInput = document.getElementById('room-code-input');
const createRoomButton = document.getElementById('create-room-button');
const joinRoomButton = document.getElementById('join-room-button');
const roomCodeDisplay = document.getElementById('room-code-display');
const copyLinkButton = document.getElementById('copy-link-button');
const playerCountDisplay = document.getElementById('player-count');
const lobbyPlayerList = document.getElementById('lobby-player-list');
const roleSettingsDiv = document.getElementById('role-settings');
const totalRoleCount = document.getElementById('total-role-count');
const cpuToggle = document.getElementById('cpu-toggle');
const startButton = document.getElementById('start-button');
const discussionEndButton = document.querySelector('.discussion-end-button');

// ----------------------------------------------------------
// 役職データの読み込み
// ----------------------------------------------------------

const HIDDEN_CARD = { name: '非公開', team: null, image: 'backcard.svg' };

function roleOf(name) {
    return ROLES[name] || HIDDEN_CARD;
}
function teamClass(name) {
    const t = roleOf(name).team;
    if (t === '人狼陣営') return 'border-red';
    if (t === '村人陣営') return 'border-blue';
    return 'border-gray';
}
function bgClass(name) {
    const t = roleOf(name).team;
    if (t === '人狼陣営') return 'bg-werewolf';
    if (t === '村人陣営') return 'bg-villager';
    return 'bg-gray';
}

async function loadRoles() {
    createRoomButton.disabled = true;
    joinRoomButton.disabled = true;
    try {
        const list = await (await fetch('/roles.json')).json();
        ROLE_ORDER = list.map(r => r.name);
        ROLES = Object.fromEntries(list.map(r => [r.name, r]));
        rolesLoaded = true;
    } catch (e) {
        alert('役職データの読み込みに失敗しました。ページを再読み込みしてください。');
        return;
    }
    unlockEntryButtons();
    if (Object.keys(currentRoleConfig).length) renderRoleSettings();
    maybeAutoJoin();
}

// ----------------------------------------------------------
// 入室（部屋を作る / 合言葉で入る）
// ----------------------------------------------------------

// 招待リンク（?room=ABCD）で来た場合は合言葉を先に埋めておく
const urlRoomCode = new URLSearchParams(location.search).get('room');
if (urlRoomCode) roomCodeInput.value = urlRoomCode.toUpperCase();

// 名前は端末内に覚えておく。結果画面のリロードで入れ直す手間をなくすため
try {
    const savedName = sessionStorage.getItem('wolf-name');
    if (savedName) nameInput.value = savedName;
} catch (e) { /* プライベートモード等では使えないので無視 */ }

function readName() {
    const name = nameInput.value.trim();
    if (!name) {
        alert('名前を入力してください。');
        nameInput.focus();
        return null;
    }
    try { sessionStorage.setItem('wolf-name', name); } catch (e) { }
    return name;
}

function lockEntryButtons(label) {
    createRoomButton.disabled = true;
    joinRoomButton.disabled = true;
    joinRoomButton.textContent = label;
}

function unlockEntryButtons() {
    createRoomButton.disabled = false;
    joinRoomButton.disabled = false;
    joinRoomButton.textContent = 'この合言葉で入る';
}

createRoomButton.addEventListener('click', () => {
    const name = readName();
    if (!name) return;
    lockEntryButtons('作成中...');
    socket.emit('createRoom', name);
});

joinRoomButton.addEventListener('click', () => {
    const name = readName();
    if (!name) return;
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) {
        alert('合言葉を入力してください。');
        roomCodeInput.focus();
        return;
    }
    lockEntryButtons('入室中...');
    socket.emit('joinRoom', { playerName: name, roomId: code });
});

roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoomButton.click();
});

// 招待リンクで来て名前も覚えている場合は、自動で入室を試みる
function maybeAutoJoin() {
    if (currentRoomId || !rolesLoaded || !socket.connected) return;
    if (urlRoomCode && nameInput.value.trim()) joinRoomButton.click();
}

socket.on('connect', maybeAutoJoin);

socket.on('roomJoined', (data) => {
    currentRoomId = data.roomId;
    roomCodeDisplay.textContent = data.roomId;

    entryScreen.style.display = 'none';
    lobbyScreen.style.display = 'block';

    // URLに合言葉を残しておくと、リロードや結果画面からの復帰でそのまま戻れる
    const url = new URL(location.href);
    url.searchParams.set('room', data.roomId);
    history.replaceState(null, '', url);
});

copyLinkButton.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?room=${currentRoomId}`;
    navigator.clipboard.writeText(url).then(() => {
        copyLinkButton.textContent = '✅ コピーしました';
        setTimeout(() => { copyLinkButton.textContent = '🔗 招待リンクをコピー'; }, 1600);
    }).catch(() => {
        // クリップボードが使えない環境では、手で選べるように出す
        prompt('このリンクをコピーして共有してください', url);
    });
});

// ----------------------------------------------------------
// 待合室
// ----------------------------------------------------------

socket.on('lobbyUpdate', (data) => {
    if (data.roleConfig) currentRoleConfig = data.roleConfig;

    const me = data.players.find(p => p.id === socket.id);
    isHost = me ? me.isHost : false;

    // 参加者一覧
    lobbyPlayerList.innerHTML = '';
    data.players.forEach(p => {
        const chip = document.createElement('div');
        chip.className = 'chip'
            + (p.isHost ? ' is-host' : '')
            + (p.id === socket.id ? ' is-me' : '');
        chip.innerHTML = `${p.name}`
            + (p.isHost ? `<span class="tag">HOST</span>` : '')
            + (p.id === socket.id ? `<span class="tag">YOU</span>` : '');
        lobbyPlayerList.appendChild(chip);
    });

    lastPlayerCount = data.players.length;
    lastCpuChecked = cpuToggle.checked;
    const totalPlayers = lastPlayerCount + (lastCpuChecked ? 1 : 0);
    playerCountDisplay.textContent = totalPlayers;

    if (rolesLoaded) renderRoleSettings();

    // 開始ボタン
    if (isHost) {
        startButton.disabled = totalPlayers < 2;
        startButton.textContent = totalPlayers < 2
            ? `あと ${2 - totalPlayers} 人必要`
            : `ゲーム開始（${totalPlayers}人）`;
    } else {
        startButton.disabled = true;
        startButton.textContent = 'ホストの開始待ち';
    }
});

/** 役職構成のUI。roles.csv の順・説明をそのまま使う */
function renderRoleSettings() {
    roleSettingsDiv.innerHTML = '';
    let total = 0;

    ROLE_ORDER.forEach(name => {
        const role = ROLES[name];
        const count = currentRoleConfig[name] || 0;
        total += count;

        const row = document.createElement('div');
        row.className = 'role-row ' + (role.team === '人狼陣営' ? 'team-wolf' : 'team-village');
        row.innerHTML = `
            <img src="images/${role.image}" alt="" onerror="this.style.visibility='hidden'">
            <div class="meta">
                <div class="rname"><span class="team-dot"></span>${role.name}</div>
                <div class="rdesc">${role.description}</div>
            </div>
            <div class="stepper">
                ${isHost ? `
                    <button data-role="${name}" data-action="decrease">−</button>
                    <span class="num">${count}</span>
                    <button data-role="${name}" data-action="increase">＋</button>
                ` : `<span class="fixed">×${count}</span>`}
            </div>
        `;
        roleSettingsDiv.appendChild(row);
    });

    const totalPlayers = lastPlayerCount + (cpuToggle.checked ? 1 : 0);
    const needed = totalPlayers + 1;
    if (total < needed) {
        totalRoleCount.className = 'total-line warn';
        totalRoleCount.textContent =
            `カード ${total}枚 / プレイヤー ${totalPlayers}人 — あと ${needed - total}枚 必要です`;
    } else {
        totalRoleCount.className = 'total-line';
        totalRoleCount.textContent =
            `カード ${total}枚 / プレイヤー ${totalPlayers}人 → 中央に ${total - totalPlayers}枚 伏せます`;
    }

    if (isHost) {
        roleSettingsDiv.querySelectorAll('button[data-role]').forEach(btn => {
            btn.onclick = () => {
                const r = btn.dataset.role;
                const delta = btn.dataset.action === 'increase' ? 1 : -1;
                const next = { ...currentRoleConfig };
                next[r] = Math.min(Math.max((next[r] || 0) + delta, 0), 9);
                socket.emit('updateRoleConfig', next);
            };
        });
    }
}

cpuToggle.addEventListener('change', () => socket.emit('requestLobbyUpdate'));

startButton.onclick = () => socket.emit('startGame', { useCpu: cpuToggle.checked });

// ----------------------------------------------------------
// ゲーム開始
// ----------------------------------------------------------

socket.on('gameStarted', (data) => {
    lobbyScreen.style.display = 'none';
    gameScreen.style.display = 'block';

    // 前のゲームの表示が残っていたら片付ける
    const oldPanel = document.getElementById('result-panel');
    if (oldPanel) oldPanel.remove();
    clearAbilityUI();

    myRole = data.yourRole || null;
    abilityUsed = false;
    deadIds = new Set();

    const playerRolesDiv = document.getElementById('player-roles');
    playerRolesDiv.innerHTML = '';

    // 1. プレイヤーカード。他人の役職はサーバーから送られてこない（role が null）
    data.players.forEach(p => {
        const isMe = p.id === socket.id;
        const shownRole = p.role || '非公開';
        const role = roleOf(shownRole);

        const cardDiv = document.createElement('div');
        cardDiv.id = `player-card-${p.id || p.name}`;
        cardDiv.className = `player-card ${isMe ? teamClass(shownRole) : 'border-gray'}`;
        cardDiv.innerHTML = `
            <div class="player-name">${p.name}${isMe ? ' (YOU)' : (p.type === 'computer' ? ' (NPC)' : '')}</div>
            <div class="role-image-container ${isMe ? bgClass(shownRole) : 'bg-gray'}">
                <img src="images/${role.image}" class="role-icon" onerror="this.style.display='none'">
                ${isMe ? `<div class="my-role-badge">${shownRole}</div>` : ''}
            </div>
        `;
        playerRolesDiv.appendChild(cardDiv);
    });

    // 2. 中央の余りカード枚数（中身は占い師だけが見られる）
    document.getElementById('center-count').textContent = `${data.centerCount}枚`;

    // 3. 場に出ている役職の一覧
    const roleSummaryDiv = document.getElementById('role-cards-summary');
    let summaryHtml = '';
    let total = 0;
    ROLE_ORDER.forEach(name => {
        const n = data.roleConfig[name] || 0;
        total += n;
        if (n > 0) summaryHtml += `<div class="role-item"><span>${name}</span><span class="role-count">×${n}</span></div>`;
    });
    summaryHtml += `<div class="role-item" style="border-top:1px solid var(--border);margin-top:6px;padding-top:8px">`
        + `<span>合計</span><span class="role-count">${total}枚</span></div>`;
    roleSummaryDiv.innerHTML = summaryHtml;

    // 4. 自分の役職に応じた能力ボタン（夜フェーズが無いので議論中に使う）
    setupAbilityUI(data.players);

    // 5. 議論終了ボタン（ホストのみ）
    discussionEndButton.style.display = 'block';
    discussionEndButton.disabled = !isHost;
    discussionEndButton.textContent = isHost ? '投票開始' : '議論中...';
    document.querySelector('.phase-header h2').textContent = '議論中';
});

// ----------------------------------------------------------
// 役職の能力（すべて議論中に1回だけ使う）
// ----------------------------------------------------------

function clearAbilityUI() {
    document.querySelectorAll('.ability-btn').forEach(b => b.remove());
    const centerUI = document.getElementById('ability-center-ui');
    if (centerUI) centerUI.remove();
}

function setupAbilityUI(players) {
    const role = roleOf(myRole);
    if (!role.ability) return;   // 人狼・白狼・狂人・村人は能力なし

    const eventName = {
        fortune: 'fortuneAction',
        assassinate: 'assassinateAction',
        follow: 'followerAction',
    }[role.ability];
    if (!eventName) return;

    players.forEach(p => {
        const targetKey = p.id || p.name;
        if (targetKey === socket.id) return;   // 自分は対象にできない

        const card = document.getElementById(`player-card-${targetKey}`);
        if (!card) return;

        const btn = document.createElement('button');
        btn.className = `ability-btn ability-${role.ability}`;
        btn.textContent = role.abilityLabel || '使う';
        btn.onclick = () => {
            if (abilityUsed) return;
            abilityUsed = true;
            socket.emit(eventName, { targetType: 'player', targetId: targetKey });
            clearAbilityUI();
        };
        card.appendChild(btn);
    });

    // 占う能力だけは中央の余りカードもまとめて見られる
    if (role.ability === 'fortune') {
        const centerArea = document.createElement('div');
        centerArea.id = 'ability-center-ui';
        centerArea.innerHTML = `<button>🔮 中央のカードをすべて見る</button>`;
        centerArea.onclick = () => {
            if (abilityUsed) return;
            abilityUsed = true;
            socket.emit('fortuneAction', { targetType: 'center' });
            clearAbilityUI();
        };
        const playerRolesDiv = document.getElementById('player-roles');
        playerRolesDiv.parentNode.insertBefore(centerArea, playerRolesDiv);
    }
}

/** 画面上部に短いお知らせを出す */
function showNotice(text, variant = 'notice-dark') {
    const el = document.createElement('div');
    el.className = `notice ${variant}`;
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
}

/** カードに役職を表示する（占い結果・付き人の取得結果で使う） */
function revealRoleOnCard(targetKey, roleName, labelText, labelColor) {
    const card = document.getElementById(`player-card-${targetKey}`);
    if (!card) return;
    const imgCont = card.querySelector('.role-image-container');
    if (!imgCont) return;

    imgCont.className = `role-image-container ${bgClass(roleName)}`;
    imgCont.innerHTML = `
        <img src="images/${roleOf(roleName).image}" class="role-icon" onerror="this.style.display='none'">
        <div style="position:absolute;top:0;width:100%;background:${labelColor};color:#12161f;
                    font-size:.68rem;text-align:center;font-weight:800;padding:2px 0">${labelText}</div>
        <div class="my-role-badge">${roleName}</div>
    `;
    card.className = `player-card ${teamClass(roleName)}`;
}

// 占い結果（本人にだけ届く）
socket.on('fortuneResult', (res) => {
    if (res.targetId) {
        // 白狼はここで「白狼」と分かる
        revealRoleOnCard(res.targetId, res.role, '占い結果', 'rgba(167,139,250,.9)');
        return;
    }
    if (res.targetType === 'center') {
        const roles = res.role ? res.role.split(' / ') : [];
        let html = `<div style="color:var(--purple);font-weight:800;margin-bottom:8px;font-size:.82rem">🔮 中央のカード</div>`
            + `<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center">`;
        roles.forEach(name => {
            html += `<div style="width:56px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface-2)">`
                + `<img src="images/${roleOf(name).image}" style="width:100%;height:48px;object-fit:contain" onerror="this.style.display='none'">`
                + `<div style="font-size:.62rem;padding:2px;background:rgba(0,0,0,.6);text-align:center">${name}</div></div>`;
        });
        html += `</div>`;
        document.getElementById('center-count').innerHTML = html;
    }
});

// 付き人が誰かに付いた結果（本人にだけ届く）
socket.on('followerResult', (res) => {
    myRole = res.role;   // 陣営もこの役職に従う

    revealRoleOnCard(res.targetId, res.role, '付いた相手', 'rgba(45,212,191,.9)');

    // 自分のカードも新しい役職に差し替える
    const myCard = document.getElementById(`player-card-${socket.id}`);
    if (myCard) {
        const imgCont = myCard.querySelector('.role-image-container');
        if (imgCont) {
            imgCont.className = `role-image-container ${bgClass(res.role)}`;
            imgCont.innerHTML = `
                <img src="images/${roleOf(res.role).image}" class="role-icon" onerror="this.style.display='none'">
                <div class="my-role-badge">${res.role}</div>
            `;
        }
        myCard.className = `player-card ${teamClass(res.role)}`;
    }

    showNotice(`🎭 ${res.targetName} は「${res.role}」でした。あなたも ${res.role} になりました。`, 'notice-teal');
});

// 暗殺（全員に公開される）
socket.on('playerAssassinated', (data) => {
    deadIds.add(data.targetId);

    const card = document.getElementById(`player-card-${data.targetId}`);
    if (card) {
        card.classList.add('is-dead');
        card.querySelectorAll('.ability-btn, .vote-button').forEach(b => b.remove());
    }

    if (data.targetId === socket.id) {
        document.querySelectorAll('.vote-button').forEach(b => b.remove());
        showNotice('🗡 あなたは暗殺されました。以降は投票できません。', 'notice-wolf');
    } else {
        showNotice(`🗡 ${data.targetName} が暗殺されました`, 'notice-wolf');
    }
});

// ----------------------------------------------------------
// 投票
// ----------------------------------------------------------

socket.on('startVoting', (data) => {
    discussionEndButton.disabled = true;
    discussionEndButton.textContent = '投票受付中...';
    document.querySelector('.phase-header h2').textContent = '投票中';
    document.querySelectorAll('.phase-indicator').forEach(d => d.classList.add('active'));

    // 能力を使い残していても投票フェーズに入ったら締め切る
    clearAbilityUI();

    if (deadIds.has(socket.id)) {
        showNotice('あなたは暗殺されているため投票できません。', 'notice-wolf');
        return;
    }

    data.players.forEach(p => {
        const targetId = p.id || p.name;
        const cardDiv = document.getElementById(`player-card-${targetId}`);
        if (!cardDiv || cardDiv.querySelector('.vote-button')) return;

        const isMe = targetId === socket.id;
        const isDead = deadIds.has(targetId);

        const btn = document.createElement('button');
        btn.className = 'vote-button' + (isMe ? ' is-self' : (isDead ? ' is-dead-target' : ''));
        // 暗殺された人も処刑先には選べる（狼を暗殺されて村が勝てなくなるのを防ぐため）
        btn.textContent = isMe ? '自分' : (isDead ? '投票（暗殺済）' : '投票する');

        if (isMe) {
            btn.disabled = true;
        } else {
            btn.onclick = () => {
                socket.emit('submitVote', { targetId });
                document.querySelectorAll('.vote-button').forEach(b => b.remove());
                const mark = document.createElement('div');
                mark.className = 'voted-mark';
                mark.textContent = '✓ 投票済み';
                cardDiv.appendChild(mark);
            };
        }
        cardDiv.appendChild(btn);
    });
});

// ----------------------------------------------------------
// 結果
// ----------------------------------------------------------

socket.on('gameResults', (data) => {
    const isWolfWin = data.winner?.includes('人狼');
    const isVillageWin = data.winner?.includes('村人');
    const color = isWolfWin ? 'var(--wolf)' : (isVillageWin ? 'var(--village)' : 'var(--dim)');

    // 全員の正体を公開（白狼も白狼として出る）
    data.finalPlayers.forEach(p => {
        const cardDiv = document.getElementById(`player-card-${p.id || p.name}`);
        if (!cardDiv) return;

        const imgCont = cardDiv.querySelector('.role-image-container');
        if (imgCont) {
            let fate = '';
            if (p.isExecuted) {
                fate = `<div style="position:absolute;top:0;width:100%;background:rgba(255,85,102,.92);
                        color:#fff;font-size:.66rem;text-align:center;font-weight:800;padding:2px 0">⚖️ 処刑</div>`;
            } else if (p.isAssassinated) {
                fate = `<div style="position:absolute;top:0;width:100%;background:rgba(102,115,138,.92);
                        color:#fff;font-size:.66rem;text-align:center;font-weight:800;padding:2px 0">🗡 暗殺</div>`;
            }
            imgCont.className = `role-image-container ${bgClass(p.role)}`;
            imgCont.innerHTML = `
                <img src="images/${roleOf(p.role).image}" class="role-icon" onerror="this.style.display='none'">
                ${fate}
                <div class="my-role-badge">${p.role}</div>
            `;
        }
        cardDiv.className = `player-card ${teamClass(p.role)}`
            + (p.isAssassinated && !p.isExecuted ? ' is-dead' : '');
    });

    const panel = document.createElement('div');
    panel.id = 'result-panel';
    panel.innerHTML = `
        <div class="result-box" style="border-color:${color}">
            <div class="banner">RESULT</div>
            <h2 style="color:${color}">${data.winner && data.winner !== 'なし' ? data.winner + 'の勝利！' : 'ゲーム不成立'}</h2>
            ${data.message ? `<div class="msg">${data.message}</div>` : ''}
            <div class="executed">処刑された人：<b>${data.executedPlayer || 'なし'}</b></div>
            <button class="btn btn-ghost" onclick="location.reload()">待合室に戻る</button>
        </div>
    `;
    document.body.appendChild(panel);

    document.querySelector('.phase-header h2').textContent = '結果';
});

// ----------------------------------------------------------
// 進行不能・エラー
// ----------------------------------------------------------

// プレイ中に誰か落ちた場合。URLに合言葉が残っているので再読込で同じ部屋に戻る
socket.on('gameAborted', (d) => { alert(d.message); location.reload(); });

socket.on('error_message', (m) => {
    alert(m);
    // 入室済みなら部屋から蹴り出さずロビーに留まる。
    // 入室前のエラー（合言葉違い・名前重複）は入力し直せるようボタンを戻す
    if (!currentRoomId) unlockEntryButtons();
});

// 議論終了（投票開始）ボタン
discussionEndButton.onclick = () => {
    if (!isHost) return;
    discussionEndButton.disabled = true;
    discussionEndButton.textContent = '切り替え中...';
    socket.emit('startVote');
};

loadRoles();
