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
let roster = [];                // 今の試合の参加者 { name, id }。名前からカードを引くのに使う

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
const chatLog = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');

// ----------------------------------------------------------
// 役職データの読み込み
// ----------------------------------------------------------

const HIDDEN_CARD = { name: '非公開', team: null, image: 'backcard.webp' };

function roleOf(name) {
    return ROLES[name] || HIDDEN_CARD;
}
function teamClass(name) {
    const t = roleOf(name).team;
    if (t === '人狼陣営') return 'border-red';
    if (t === '村人陣営') return 'border-blue';
    if (t === '単独陣営') return 'border-solo';
    return 'border-gray';
}
function bgClass(name) {
    const t = roleOf(name).team;
    if (t === '人狼陣営') return 'bg-werewolf';
    if (t === '村人陣営') return 'bg-villager';
    if (t === '単独陣営') return 'bg-solo';
    return 'bg-gray';
}

/** 一覧の行に付ける陣営クラス。陣営が3種類あるので二分岐にはできない */
function teamRowClass(team) {
    if (team === '人狼陣営') return 'team-wolf';
    if (team === '単独陣営') return 'team-solo';
    return 'team-village';
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
    renderAboutRoles();
    if (Object.keys(currentRoleConfig).length) renderRoleSettings();
    maybeAutoJoin();
}

/** 入口ページの役職紹介。roles.csv をそのまま使うので説明が二重管理にならない */
function renderAboutRoles() {
    const box = document.getElementById('about-roles');
    if (!box) return;
    box.innerHTML = '';

    ROLE_ORDER.forEach(name => {
        const role = ROLES[name];
        const row = document.createElement('div');
        row.className = 'about-role ' + teamRowClass(role.team);
        row.innerHTML = `
            <img src="images/${role.image}" alt="" onerror="this.style.visibility='hidden'">
            <div>
                <div class="rname"><span class="team-dot"></span>${role.name}
                    <span style="font-size:.72rem;color:var(--faint);font-weight:400">${role.team}</span>
                </div>
                <div class="rdesc">${role.description}</div>
            </div>
        `;
        box.appendChild(row);
    });
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
        copyLinkButton.textContent = '✓ コピーしました';
        setTimeout(() => { copyLinkButton.textContent = '招待リンクをコピー'; }, 1600);
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
            + (p.id === socket.id ? ' is-me' : '')
            + (p.disconnected ? ' is-offline' : '');
        chip.innerHTML = `${p.name}`
            + (p.isHost ? `<span class="tag">HOST</span>` : '')
            + (p.id === socket.id ? `<span class="tag">YOU</span>` : '')
            + (p.disconnected ? `<span class="tag">切断中</span>` : '');
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
        row.className = 'role-row ' + teamRowClass(role.team);
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
    roster = data.players || [];
    // 途中で復帰した場合は、暗殺状況と能力の使用済みをサーバーから受け取って復元する
    abilityUsed = !!data.abilityUsed;
    deadIds = new Set(data.deadIds || []);

    clearChat();
    appendChatSystem(`ゲーム開始。あなたは「${myRole}」です`);
    if (deadIds.size > 0) appendChatSystem('（途中から復帰しました）');

    const playerRolesDiv = document.getElementById('player-roles');
    playerRolesDiv.innerHTML = '';

    // 1. プレイヤーカード。他人の役職はサーバーから送られてこない（role が null）
    data.players.forEach(p => {
        const isMe = p.id === socket.id;
        const shownRole = p.role || '非公開';
        const role = roleOf(shownRole);

        const cardDiv = document.createElement('div');
        cardDiv.id = `player-card-${p.id || p.name}`;
        // 復帰すると通信IDが変わるため、クリック時はこの属性を読み直す。
        // 生成時のIDを閉じ込めてしまうと、復帰した人に投票できなくなる。
        cardDiv.dataset.playerId = p.id || p.name;
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

    // 復帰時に、既に暗殺されている人の見た目を戻す
    deadIds.forEach(id => {
        const card = document.getElementById(`player-card-${id}`);
        if (!card) return;
        card.classList.add('is-dead');
        restoreBulletHoles(card);
    });
    if (deadIds.has(socket.id)) setChatEnabled(false);

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

    // 6. 狂信者にだけ届く狼の情報。狼側はこちらを知らない
    showKnownWolves(data.knownWolves, data.youAreWolf);
});

/**
 * 人狼と狂信者だけに届く、狼の情報。
 * 人狼から見れば「仲間」、狂信者から見れば「誰を守るか」なので文言を分ける。
 * 名前の一覧には自分が含まれていない（サーバー側で除いている）。
 */
function showKnownWolves(wolves, iAmWolf) {
    if (!Array.isArray(wolves)) return;
    const list = wolves.map(w => w.name).join('、');

    if (iAmWolf) {
        if (wolves.length === 0) {
            showNotice('あなた以外に人狼はいません。', 'notice-wolf');
            appendChatSystem('（あなただけに表示）あなた以外に人狼はいません');
            return;
        }
        showNotice(`仲間の人狼は ${list} です。`, 'notice-wolf');
        appendChatSystem(`（あなただけに表示）仲間の人狼：${list}`);
        revealWolfCards(wolves, '仲間');
        return;
    }

    if (wolves.length === 0) return;
    showNotice(`人狼は ${list} です。あなたが狂信者であることは、人狼側には分かりません。`, 'notice-wolf');
    appendChatSystem(`（あなただけに表示）人狼：${list}`);
    revealWolfCards(wolves, '人狼');
}

/**
 * 狼のカードを表にする。伏せたままだと誰が仲間か盤面で分からず、
 * チャットの1行は流れて消えてしまう。
 * 白狼も本当の役職のまま出す——本人は村人だと思っているが、
 * 他の狼からは白狼だと分かるのが正しい。
 */
function revealWolfCards(wolves, label) {
    wolves.forEach(w => {
        revealRoleOnCard(w.id, w.role, label, 'rgba(248,113,113,.95)');
    });
}

// ----------------------------------------------------------
// 役職の能力（すべて議論中に1回だけ使う）
// ----------------------------------------------------------

function clearAbilityUI() {
    document.querySelectorAll('.ability-btn').forEach(b => b.remove());
    const centerUI = document.getElementById('ability-center-ui');
    if (centerUI) centerUI.remove();
}

function setupAbilityUI(players) {
    if (abilityUsed) return;     // 復帰時など、既に使い終わっている場合
    if (deadIds.has(socket.id)) return;

    const role = roleOf(myRole);
    if (!role.ability) return;   // 人狼・白狼・狂人・村人は能力なし

    const eventName = {
        fortune: 'fortuneAction',
        assassinate: 'assassinateAction',
        follow: 'followerAction',
        accuse: 'accuseAction',
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
            socket.emit(eventName, { targetType: 'player', targetId: card.dataset.playerId });
            clearAbilityUI();
        };
        card.appendChild(btn);
    });

    // 占う能力だけは中央の余りカードもまとめて見られる
    if (role.ability === 'fortune') {
        const centerArea = document.createElement('div');
        centerArea.id = 'ability-center-ui';
        centerArea.innerHTML = `<button>中央のカードをすべて見る</button>`;
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

// ----------------------------------------------------------
// ⭐ 公開チャット
// ----------------------------------------------------------

/** 発言を1行追加する。textContent を使うのでHTMLタグは実行されない */
function appendChat(name, text, isMe) {
    const row = document.createElement('div');
    row.className = 'chat-msg' + (isMe ? ' is-me' : '');

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = name;

    const body = document.createElement('span');
    body.textContent = text;

    row.append(who, body);
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
}

/** 進行状況をチャット欄にも残す（後から見返せるログになる） */
function appendChatSystem(text) {
    const row = document.createElement('div');
    row.className = 'chat-sys';
    row.textContent = text;
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
}

function clearChat() {
    chatLog.innerHTML = '';
    setChatEnabled(true);
}

function setChatEnabled(enabled) {
    chatInput.disabled = !enabled;
    chatSend.disabled = !enabled;
    chatInput.placeholder = enabled ? '発言する' : '暗殺されたため発言できません';
}

function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chatMessage', text);
    chatInput.value = '';
}

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
});

socket.on('chatMessage', (m) => appendChat(m.name, m.text, m.id === socket.id));

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
        let html = `<div style="color:var(--purple);font-weight:800;margin-bottom:8px;font-size:.82rem">中央のカード</div>`
            + `<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center">`;
        roles.forEach(name => {
            html += `<div style="width:56px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface-2)">`
                + `<img src="images/${roleOf(name).image}" style="width:100%;height:56px;object-fit:cover;display:block" onerror="this.style.display='none'">`
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

    showNotice(`${res.targetName} は「${res.role}」でした。あなたも ${res.role} になりました。`, 'notice-teal');
    showKnownWolves(res.knownWolves, res.youAreWolf);
});

// 暗殺（全員に公開される）
// 告発の結果。役職名は伏せ、陣営だけが全員に公開される
socket.on('accuseResult', (data) => {
    const card = document.getElementById(`player-card-${data.targetId}`);
    if (card) {
        const imgCont = card.querySelector('.role-image-container');
        if (imgCont && !imgCont.querySelector('.accused-tag')) {
            const tag = document.createElement('div');
            tag.className = 'accused-tag ' + (data.team === '人狼陣営' ? 'is-wolf'
                : (data.team === '村人陣営' ? 'is-village' : 'is-solo'));
            tag.textContent = data.team;
            imgCont.appendChild(tag);
        }
    }
    appendChatSystem(`告発：${data.targetName} は ${data.team} です`);
    showNotice(`${data.targetName} は ${data.team} でした。`,
        data.team === '人狼陣営' ? 'notice-wolf' : 'notice-teal');
});

// ----------------------------------------------------------
// 暗殺の演出
// ----------------------------------------------------------

/**
 * ガラスのひびを1つ生成する。放射状のひびと、それをつなぐ同心状の破片で作る。
 * 毎回かたちが変わるので、3発並べても同じ判子に見えない。
 *
 * 線は「太い暗線の上に細い明線」を重ねる。単色だと、カード裏面のような
 * 暗い絵か白狼のような明るい絵か、どちらかで完全に沈むため。
 */
function glassCrackSVG() {
    const rnd = (a, b) => a + Math.random() * (b - a);
    const C = 50;                               // viewBox 100x100 の中心
    const n = Math.round(rnd(12, 17));          // 放射状のひびの本数
    const angles = [];
    const lens = [];
    for (let i = 0; i < n; i++) {
        angles.push((i / n) * Math.PI * 2 + rnd(-0.16, 0.16));
        lens.push(rnd(24, 47));
    }

    // 放射状のひび。まっすぐだと定規で引いたように見えるので、途中を折る
    const radial = angles.map((a, i) => {
        let d = `M${C} ${C}`;
        for (let s = 1; s <= 3; s++) {
            const t = lens[i] * s / 3;
            const aa = a + rnd(-0.07, 0.07);
            d += ` L${(C + Math.cos(aa) * t + rnd(-2, 2)).toFixed(1)} ${(C + Math.sin(aa) * t + rnd(-2, 2)).toFixed(1)}`;
        }
        return d;
    });

    // 同心状の破片。隣り合う放射ひびの間を弧でつなぐ。全部はつながない
    const rings = [];
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const reach = Math.min(lens[i], lens[j]);
        for (const frac of [0.34, 0.62, 0.86]) {
            if (Math.random() < 0.45) continue;
            const r = reach * frac * rnd(0.9, 1.1);
            const x1 = C + Math.cos(angles[i]) * r, y1 = C + Math.sin(angles[i]) * r;
            const x2 = C + Math.cos(angles[j]) * r, y2 = C + Math.sin(angles[j]) * r;
            const mr = r * rnd(0.82, 0.96);
            const ma = (angles[i] + angles[j]) / 2;
            const mx = C + Math.cos(ma) * mr, my = C + Math.sin(ma) * mr;
            rings.push(`M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`);
        }
    }

    const all = radial.concat(rings).join(' ');
    const hole = rnd(4.5, 6.5);
    return `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="${all}" stroke="rgba(0,0,0,.55)" stroke-width="3"/>
    <path d="${all}" stroke="rgba(255,255,255,.92)" stroke-width="1.1"/>
  </g>
  <circle cx="${C}" cy="${C}" r="${(hole + 1.6).toFixed(1)}" fill="rgba(0,0,0,.5)"/>
  <circle cx="${C}" cy="${C}" r="${hole.toFixed(1)}" fill="#08080a"/>
  <circle cx="${C}" cy="${C}" r="${hole.toFixed(1)}" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.3"/>
</svg>`;
}

// 弾痕の位置と大きさ（カードの絵に対する割合）。
// 同じ大きさで並べると判子っぽくなるので、1発ずつ変えてある
const HOLE_SPOTS = [
    { x: 40, y: 33, size: 62 },
    { x: 63, y: 54, size: 46 },
    { x: 45, y: 71, size: 52 },
];

/** 弾痕を1つ置く。restored=true は復帰時の復元なのでアニメーションしない */
function addBulletHole(container, spot, restored) {
    const hole = document.createElement('div');
    hole.className = 'bullet-hole' + (restored ? ' is-restored' : '');
    hole.style.left = spot.x + '%';
    hole.style.top = spot.y + '%';
    hole.style.setProperty('--hole-size', spot.size + '%');
    hole.innerHTML = glassCrackSVG();
    container.appendChild(hole);
}

/** 暗殺された人のカードに弾痕を残す（演出なし。復帰時に使う） */
function restoreBulletHoles(card) {
    const cont = card?.querySelector('.role-image-container');
    if (!cont || cont.querySelector('.bullet-hole')) return;
    HOLE_SPOTS.forEach(spot => addBulletHole(cont, spot, true));
}

/** 両端が尖った帯の形。1本ずつ違う形にして、定規で引いたように見せない */
function slashClipPath() {
    const r = (a, b) => (a + Math.random() * (b - a)).toFixed(1);
    return `polygon(0% ${r(28, 52)}%, ${r(3, 9)}% 0%, ${r(86, 96)}% ${r(0, 14)}%, ` +
           `100% ${r(44, 68)}%, ${r(89, 97)}% 100%, ${r(4, 11)}% ${r(84, 98)}%)`;
}

/** 画面全体のカットインと、カードへの着弾 */
function playKillEffect(card, targetName) {
    const cut = document.createElement('div');
    cut.id = 'kill-cutin';

    const dim = document.createElement('div');
    dim.className = 'kill-dim';
    cut.appendChild(dim);

    // 赤い帯を左右から交互に。高さ・位置・濃さ・タイミングを散らす
    // 隙間を空けて帯に見せる。埋めてしまうとただの赤い画面になる。
    // 文字が乗る 50% 付近には太い帯を通して読みやすくする
    const bands = [
        { top: 18, h: 5,  color: '#8e0f22', delay: 90,  right: false },
        { top: 29, h: 10, color: '#b3122a', delay: 0,   right: true  },
        { top: 44, h: 15, color: '#dc3545', delay: 50,  right: false },
        { top: 65, h: 7,  color: '#ff5566', delay: 130, right: true  },
        { top: 77, h: 5,  color: '#a81428', delay: 30,  right: false },
    ];
    bands.forEach(b => {
        const el = document.createElement('div');
        el.className = 'kill-slash' + (b.right ? ' from-right' : '');
        el.style.top = b.top + '%';
        el.style.height = b.h + '%';
        el.style.background = b.color;
        el.style.animationDelay = b.delay + 'ms';
        el.style.clipPath = slashClipPath();
        cut.appendChild(el);
    });

    const text = document.createElement('div');
    text.className = 'kill-text';
    const word = document.createElement('div');
    word.className = 'kill-word';
    word.textContent = '暗殺';
    const who = document.createElement('div');
    who.className = 'kill-target';
    who.textContent = targetName;          // 名前は必ず textContent で入れる
    text.append(word, who);
    cut.appendChild(text);

    document.body.appendChild(cut);
    setTimeout(() => cut.remove(), 1800);

    const cont = card?.querySelector('.role-image-container');
    if (!cont || cont.querySelector('.bullet-hole')) return;

    HOLE_SPOTS.forEach((spot, i) => {
        setTimeout(() => {
            addBulletHole(cont, spot, false);
            card.classList.remove('is-hit');
            void card.offsetWidth;          // 連続で撃つため、アニメーションを掛け直す
            card.classList.add('is-hit');
        }, 300 + i * 150);
    });
}

socket.on('playerAssassinated', (data) => {
    deadIds.add(data.targetId);

    const card = document.getElementById(`player-card-${data.targetId}`);
    if (card) {
        card.querySelectorAll('.ability-btn, .vote-button').forEach(b => b.remove());
        playKillEffect(card, data.targetName);
        // 灰色に沈むのは演出が終わってから
        setTimeout(() => card.classList.add('is-dead'), 760);
    } else {
        playKillEffect(null, data.targetName);
    }

    // 暗殺された人は処刑先にも選べなくなるので、投票ボタンを消す
    document.querySelectorAll('.vote-button').forEach(b => {
        if (b.closest('.player-card') === card) b.remove();
    });

    appendChatSystem(`${data.targetName} が暗殺されました（発言・投票不可）`);

    if (data.targetId === socket.id) {
        document.querySelectorAll('.vote-button').forEach(b => b.remove());
        setChatEnabled(false);   // 口封じ：本人は以降しゃべれない
        showNotice('あなたは暗殺されました。以降は発言も投票もできません。', 'notice-wolf');
    } else {
        showNotice(`${data.targetName} が暗殺されました`, 'notice-wolf');
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

    appendChatSystem('投票フェーズに入りました');

    if (deadIds.has(socket.id)) {
        showNotice('あなたは暗殺されているため投票できません。', 'notice-wolf');
        return;
    }

    let targetCount = 0;

    data.players.forEach(p => {
        const targetId = p.id || p.name;

        // 暗殺された人は処刑先に選べない（口封じ＝投票の対象からも外れる）
        if (deadIds.has(targetId)) return;

        const cardDiv = document.getElementById(`player-card-${targetId}`);
        if (!cardDiv || cardDiv.querySelector('.vote-button')) return;

        const isMe = targetId === socket.id;
        if (!isMe) targetCount++;

        const btn = document.createElement('button');
        btn.className = 'vote-button' + (isMe ? ' is-self' : '');
        btn.textContent = isMe ? '自分' : '投票する';

        if (isMe) {
            btn.disabled = true;
        } else {
            btn.onclick = () => {
                socket.emit('submitVote', { targetId: cardDiv.dataset.playerId });
                document.querySelectorAll('.vote-button').forEach(b => b.remove());
                const mark = document.createElement('div');
                mark.className = 'voted-mark';
                mark.textContent = '✓ 投票済み';
                cardDiv.appendChild(mark);
            };
        }
        cardDiv.appendChild(btn);
    });

    // 生き残りが自分だけになった場合。サーバー側も締め切り判定から除外している
    if (targetCount === 0) {
        showNotice('投票できる相手がいません。結果をお待ちください。', 'notice-wolf');
    }
});

// ----------------------------------------------------------
// 結果
// ----------------------------------------------------------

socket.on('gameResults', (data) => {
    const isWolfWin = data.winner === '人狼チーム';
    const isVillageWin = data.winner === '村人チーム';
    const isSoloWin = !isWolfWin && !isVillageWin && data.winner && data.winner !== 'なし';
    const color = isWolfWin ? 'var(--wolf)'
        : (isVillageWin ? 'var(--village)' : (isSoloWin ? 'var(--solo)' : 'var(--dim)'));

    const assassinatedNames = data.finalPlayers.filter(p => p.isAssassinated).map(p => p.name);

    // 誰が誰に入れたか。処刑された人への票は色を変えて分かりやすくする
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const voteRows = (data.voteDetails || []).map(v => {
        const hit = v.target === data.executedPlayer;
        return `<div class="vote-row${hit ? ' is-hit' : ''}">`
            + `<span>${escapeHtml(v.voter)}</span><span class="arrow">→</span>`
            + `<span>${escapeHtml(v.target)}`
            + (v.weight > 1 ? `<span class="vote-weight">${v.weight}票</span>` : '')
            + `</span></div>`;
    }).join('');

    // 投票ボタンが残っていると結果画面に紛れるので片付ける
    document.querySelectorAll('.vote-button').forEach(b => b.remove());

    // 全員の正体を公開（白狼も白狼として出る）
    data.finalPlayers.forEach(p => {
        const cardDiv = document.getElementById(`player-card-${p.id || p.name}`);
        if (!cardDiv) return;

        const imgCont = cardDiv.querySelector('.role-image-container');
        if (imgCont) {
            let fate = '';
            if (p.isExecuted) {
                fate = `<div style="position:absolute;top:0;width:100%;background:rgba(255,85,102,.92);
                        color:#fff;font-size:.66rem;text-align:center;font-weight:800;padding:2px 0">処刑</div>`;
            } else if (p.isAssassinated) {
                fate = `<div style="position:absolute;top:0;width:100%;background:rgba(102,115,138,.92);
                        color:#fff;font-size:.66rem;text-align:center;font-weight:800;padding:2px 0">暗殺</div>`;
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
            <div class="executed">
                処刑：<b>${data.executedPlayer || 'なし'}</b>
                ${assassinatedNames.length ? `<br>暗殺：<b>${assassinatedNames.join('、')}</b>` : ''}
            </div>
            ${voteRows ? `<div class="vote-log"><div class="vote-log-head">投票</div>${voteRows}</div>` : ''}
            <div class="result-actions">
                ${isHost
                    ? `<button class="btn" id="result-again">同じ構成でもう一度</button>`
                    : `<div class="result-waiting">ホストがもう一度始めるのを待っています</div>`}
                <button class="btn btn-sub" id="result-lobby">待合室に戻る（構成を変える）</button>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    // リロードせずにその場で次の試合へ。全員が同時に再読込すると部屋が消えるため
    const againBtn = document.getElementById('result-again');
    if (againBtn) {
        againBtn.onclick = () => {
            againBtn.disabled = true;
            againBtn.textContent = '開始しています...';
            socket.emit('startGame', { useCpu: cpuToggle.checked });
        };
    }
    document.getElementById('result-lobby').onclick = returnToLobby;

    document.querySelector('.phase-header h2').textContent = '結果';
    // 「投票受付中...」が結果画面に残ると、まだ集計中に見えてしまう
    discussionEndButton.style.display = 'none';
    appendChatSystem(
        `${data.winner && data.winner !== 'なし' ? data.winner + 'の勝利' : 'ゲーム不成立'}`
        + `（処刑：${data.executedPlayer || 'なし'}）`
    );
    setChatEnabled(true);   // 結果後は暗殺された人も感想を言える
});

// ----------------------------------------------------------
// 進行不能・エラー
// ----------------------------------------------------------

/** 結果画面や中断から待合室へ戻る。再読込しないので部屋から抜けない */
function returnToLobby() {
    const panel = document.getElementById('result-panel');
    if (panel) panel.remove();

    gameScreen.style.display = 'none';
    lobbyScreen.style.display = 'block';
    socket.emit('requestLobbyUpdate');   // 最新の人数・構成をもらう
}

// 誰かの回線が切れた。すぐには中断せず、戻ってくるのを待つ
socket.on('playerDisconnected', (d) => {
    showNotice(`${d.name} の接続が切れました。${d.seconds}秒待ちます`, 'notice-wolf');
    appendChatSystem(`${d.name} の接続が切れました（${d.seconds}秒以内に戻れば続行）`);
});

socket.on('playerReconnected', (d) => {
    // 復帰すると通信IDが変わるので、他の人の画面が持っているIDを差し替える
    if (d.oldId && d.newId && d.oldId !== d.newId) {
        const card = document.getElementById(`player-card-${d.oldId}`);
        if (card) {
            card.id = `player-card-${d.newId}`;
            card.dataset.playerId = d.newId;
        }
        if (deadIds.delete(d.oldId)) deadIds.add(d.newId);
    }
    showNotice(`${d.name} が戻ってきました`);
    appendChatSystem(`${d.name} が戻ってきました`);
});

// 猶予時間内に戻らなかった場合。再読込せずに待合室へ戻す
socket.on('gameAborted', (d) => {
    showNotice(d.message, 'notice-wolf');
    returnToLobby();
});

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
