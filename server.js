// server.js — ルーム対応版
//
// 以前は接続者全員が1つのゲームを共有していたため、同時に2グループが遊べなかった。
// このバージョンでは「合言葉（ルームコード）」ごとに独立したゲームを持つ。

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const {
    assignRoles,
    generateRolePool,
    determineWinner,
    ROLES,
    ROLE_ORDER,
    defaultRoleConfig,
    rolesForClient,
} = require('./coreLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// 口頭で伝えられるように、紛らわしい文字（I, O, 0, 1）を除いてある
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const MAX_PLAYERS = 12;

// 役職の定義と初期枚数は roles.csv が持っている
const DEFAULT_ROLE_CONFIG = defaultRoleConfig();

/** roomId -> room。1ルーム = 1ゲーム */
const rooms = new Map();

// ==========================================================
// ルーム管理
// ==========================================================

function generateRoomCode() {
    let len = CODE_LENGTH;
    for (let attempt = 1; ; attempt++) {
        // 総当たりで埋まることは現実にはないが、保険として桁を増やす
        if (attempt % 200 === 0) len++;
        let code = '';
        for (let i = 0; i < len; i++) {
            code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        }
        if (!rooms.has(code)) return code;
    }
}

function createRoom() {
    const room = {
        id: generateRoomCode(),
        players: {},                              // socketId -> { name, id, isHost }
        isGameStarted: false,
        roleConfig: { ...DEFAULT_ROLE_CONFIG },
        gameSetup: null,
        votes: {},
        deadIds: new Set(),        // 暗殺された人。発言・投票ができず、処刑先にも選べない
        usedAbilities: new Set(),  // 能力を使い終わった socketId（各能力は1回だけ）
        votingStarted: false,      // 投票フェーズに入ったか（能力は議論中しか使えない）
        createdAt: Date.now(),
    };
    rooms.set(room.id, room);
    console.log(`🏠 ルーム作成: ${room.id}（現在 ${rooms.size} 室）`);
    return room;
}

function getRoom(socket) {
    return rooms.get(socket.data.roomId);
}

function playerCount(room) {
    return Object.keys(room.players).length;
}

function lobbyPayload(room) {
    return {
        roomId: room.id,
        players: Object.values(room.players).map(p => ({
            name: p.name, id: p.id, isHost: p.isHost,
        })),
        isGameStarted: room.isGameStarted,
        roleConfig: room.roleConfig,
    };
}

function broadcastLobby(room) {
    io.to(room.id).emit('lobbyUpdate', lobbyPayload(room));
}

function totalRoleCount(roleConfig) {
    return Object.values(roleConfig).reduce((sum, n) => sum + n, 0);
}

/**
 * 本人に見せる役職名。
 * roles.csv の「偽装先」が設定されている役職（白狼など）は、自分のカードにその名前を表示する。
 * 占い師や最終公開では本当の役職が出る。
 */
function displayRoleFor(player) {
    return ROLES[player.role]?.disguiseAs || player.role;
}

/** その役職が指定の能力を持っているか */
function hasAbility(roleName, ability) {
    return ROLES[roleName]?.ability === ability;
}

/** 生きている人間プレイヤーの socketId */
function aliveHumanIds(room) {
    return Object.keys(room.players).filter(id => !room.deadIds.has(id));
}

/** 処刑先に選べる相手（暗殺された人は対象外。自分にも投票できない） */
function validTargetsFor(room, voterId) {
    if (!room.gameSetup) return [];
    return room.gameSetup.players.filter(p => {
        const key = p.id || p.name;
        return key !== voterId && !room.deadIds.has(key);
    });
}

/** その人が投票できる状態か（暗殺されておらず、選べる相手が1人以上いる） */
function canVote(room, voterId) {
    if (room.deadIds.has(voterId)) return false;
    return validTargetsFor(room, voterId).length > 0;
}

/** 入室処理。成功したら true */
function enterRoom(socket, room, playerName) {
    if (room.isGameStarted) {
        socket.emit('error_message', 'この部屋はゲーム中です。終わるまで待ってください。');
        return false;
    }
    if (playerCount(room) >= MAX_PLAYERS) {
        socket.emit('error_message', `この部屋は満室です（最大 ${MAX_PLAYERS} 人）。`);
        return false;
    }
    const isNameTaken = Object.values(room.players).some(p => p.name === playerName);
    if (isNameTaken) {
        socket.emit('error_message', 'その名前は既に使われています。別の名前で入ってください。');
        return false;
    }

    room.players[socket.id] = {
        name: playerName,
        id: socket.id,
        isHost: playerCount(room) === 0,   // 最初の人がホスト
    };

    socket.data.roomId = room.id;
    socket.data.name = playerName;
    socket.join(room.id);

    socket.emit('roomJoined', { roomId: room.id, yourId: socket.id });
    broadcastLobby(room);
    console.log(`➕ ${playerName} が ${room.id} に入室（${playerCount(room)}人）`);
    return true;
}

// ==========================================================
// ゲーム進行
// ==========================================================

function startNewGame(room, useCpu) {
    if (room.isGameStarted) return;

    const humanPlayers = Object.values(room.players).map(p => ({
        name: p.name, id: p.id, role: '未定', type: 'human',
    }));

    const comPlayers = useCpu
        ? [{ name: 'COM1', role: '未定', type: 'computer', id: 'COM1' }]
        : [];

    const currentPlayers = [...humanPlayers, ...comPlayers];
    room.votes = {};
    room.deadIds = new Set();
    room.usedAbilities = new Set();
    room.votingStarted = false;

    // ── 役職カードが足りないと役職なしのプレイヤーが出て進行不能になるので先に弾く
    const total = totalRoleCount(room.roleConfig);
    if (total < currentPlayers.length + 1) {
        io.to(room.id).emit('error_message',
            `役職カードが足りません。プレイヤー ${currentPlayers.length}人 に対してカードは ${total}枚 です。` +
            `中央に伏せる分を含めて ${currentPlayers.length + 1}枚以上 に増やしてください。`);
        return;
    }

    const gameSetup = assignRoles(currentPlayers, generateRolePool(room.roleConfig));

    // 処刑対象になる狼（人狼・白狼）が1枚も無い構成はゲームが成立しないため即終了。
    // 白狼も狼なので、人狼0・白狼1 は成立する。
    const werewolfCards = Object.entries(room.roleConfig)
        .filter(([role]) => ROLES[role]?.isWerewolf)
        .reduce((sum, [, n]) => sum + n, 0);

    if (werewolfCards === 0) {
        room.isGameStarted = false;
        io.to(room.id).emit('gameResults', {
            winner: 'なし',
            executedPlayer: 'なし',
            finalPlayers: gameSetup.players.map(p => ({
                name: p.name, role: p.role, isExecuted: false,
            })),
            voteCounts: {},
            message: '【人為的な平和村】人狼がいません。解散！',
        });
        return;
    }

    room.gameSetup = gameSetup;
    room.isGameStarted = true;

    emitGameStarted(room);
}

/**
 * 配役を各プレイヤーへ個別に送る。
 * 以前は全員に全員の役職を送って画面側で隠していただけだったため、
 * 開発者ツールを開けば全部見えてしまっていた。他人の役職は送らない。
 */
function emitGameStarted(room) {
    const roster = room.gameSetup.players;

    for (const me of roster) {
        if (me.type !== 'human') continue;

        io.to(me.id).emit('gameStarted', {
            players: roster.map(other => ({
                name: other.name,
                id: other.id,
                type: other.type,
                // 自分の分だけ役職を入れる。他人は null（画面では「非公開」表示）
                role: other.id === me.id ? displayRoleFor(me) : null,
            })),
            yourRole: displayRoleFor(me),
            centerCount: room.gameSetup.centerCards.length,
            roleConfig: room.roleConfig,
        });
    }
}

function processFinalResults(room) {
    const finalPlayers = room.gameSetup.players;
    const voteCounts = {};
    let maxVotes = 0;
    let mostVotedTargetId = null;

    for (const targetId of Object.values(room.votes)) {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        if (voteCounts[targetId] > maxVotes) {
            maxVotes = voteCounts[targetId];
            mostVotedTargetId = targetId;
        }
    }

    // 同数の場合は誰も処刑されない
    const tiedPlayers = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes);
    let executedPlayer = null;
    if (!(maxVotes === 0 || tiedPlayers.length > 1)) {
        executedPlayer = finalPlayers.find(
            p => p.id === mostVotedTargetId || p.name === mostVotedTargetId
        );
    }

    // 暗殺も処刑と同じ扱いにするため、暗殺された人を渡す
    const assassinatedPlayers = finalPlayers.filter(p => room.deadIds.has(p.id || p.name));
    const winner = determineWinner(finalPlayers, executedPlayer, assassinatedPlayers);

    console.log(`[勝敗] ${room.id}: ${winner.team} / ${winner.message}`);

    io.to(room.id).emit('gameResults', {
        executedPlayer: executedPlayer ? executedPlayer.name : 'なし',
        winner: winner.team,
        message: winner.message,
        finalPlayers: finalPlayers.map(p => ({
            name: p.name,
            id: p.id,
            role: p.role,   // 最終公開では白狼も白狼として出す
            isExecuted: executedPlayer ? p.name === executedPlayer.name : false,
            isAssassinated: room.deadIds.has(p.id || p.name),
        })),
        voteCounts,
    });

    room.isGameStarted = false;
    room.gameSetup = null;
    room.votes = {};
    room.deadIds = new Set();
    room.usedAbilities = new Set();
    room.votingStarted = false;

    // 結果画面から待合室に戻ったときに最新の状態が出るようにしておく
    broadcastLobby(room);
}

/** 投票できる全員が投票し終わったら結果へ進む */
function checkVotesComplete(room) {
    if (!room.isGameStarted || !room.votingStarted) return;

    // 暗殺されている人と、選べる相手がいない人は締め切り判定から除く。
    // これを入れないと、暗殺で対象がいなくなった人を待ち続けて進行不能になる。
    const voters = Object.keys(room.players).filter(id => canVote(room, id));
    const voted = voters.filter(id => room.votes[id] !== undefined);

    console.log(`🗳 ${room.id}: ${voted.length} / ${voters.length}（投票できる人）`);

    if (voted.length >= voters.length) {
        processFinalResults(room);
    }
}

// ==========================================================
// Socket.io
// ==========================================================

io.on('connection', (socket) => {
    console.log('🔗 接続:', socket.id);

    // ── 部屋を作る
    socket.on('createRoom', (playerName) => {
        const name = String(playerName || '').trim().slice(0, 12);
        if (!name) return socket.emit('error_message', '名前を入力してください。');
        if (socket.data.roomId) return;

        enterRoom(socket, createRoom(), name);
    });

    // ── 合言葉で部屋に入る
    socket.on('joinRoom', (data) => {
        const name = String(data?.playerName || '').trim().slice(0, 12);
        const code = String(data?.roomId || '').trim().toUpperCase();
        if (!name) return socket.emit('error_message', '名前を入力してください。');
        if (socket.data.roomId) return;

        const room = rooms.get(code);
        if (!room) {
            return socket.emit('error_message',
                `合言葉「${code}」の部屋が見つかりません。入力を確認してください。`);
        }
        enterRoom(socket, room, name);
    });

    // ── 役職構成の更新（ホストのみ）
    socket.on('updateRoleConfig', (newConfig) => {
        const room = getRoom(socket);
        if (!room || !room.players[socket.id]?.isHost) return;
        if (!newConfig || typeof newConfig !== 'object') return;

        // 想定外のキーや値が混ざらないよう、既知の役職だけを取り込む
        const sanitized = {};
        for (const role of ROLE_ORDER) {
            const n = Number(newConfig[role]);
            sanitized[role] = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 0), 9) : 0;
        }
        room.roleConfig = sanitized;
        broadcastLobby(room);
    });

    // ── ロビー状態の再送要求（CPUトグル切り替え時など）
    socket.on('requestLobbyUpdate', () => {
        const room = getRoom(socket);
        if (room) socket.emit('lobbyUpdate', lobbyPayload(room));
    });

    // ── ゲーム開始（ホストのみ）
    socket.on('startGame', (data) => {
        const room = getRoom(socket);
        if (!room || !room.players[socket.id]?.isHost) return;
        startNewGame(room, Boolean(data?.useCpu));
    });

    // ── 占い師の行動
    socket.on('fortuneAction', (data) => {
        const room = getRoom(socket);
        if (!room || !room.isGameStarted || !room.gameSetup) return;
        if (room.votingStarted) return;                  // 能力は議論中だけ

        const me = room.gameSetup.players.find(p => p.id === socket.id);
        if (!me || !hasAbility(me.role, 'fortune')) return;

        if (data?.targetType === 'center') {
            socket.emit('fortuneResult', {
                targetType: 'center',
                role: room.gameSetup.centerCards.join(' / '),
            });
            return;
        }

        const target = room.gameSetup.players.find(p => (p.id || p.name) === data?.targetId);
        if (target) {
            // 占い師には本当の役職を返す（白狼は白狼と分かる）
            socket.emit('fortuneResult', { targetId: data.targetId, role: target.role });
        }
    });

    // ── 暗殺者の行動：議論中に1人を暗殺する。結果は全員に公開される
    socket.on('assassinateAction', (data) => {
        const room = getRoom(socket);
        if (!room || !room.isGameStarted || !room.gameSetup) return;
        if (room.votingStarted) return;                  // 能力は議論中だけ
        if (room.usedAbilities.has(socket.id)) return;   // 能力は1回だけ

        const me = room.gameSetup.players.find(p => p.id === socket.id);
        if (!me || !hasAbility(me.role, 'assassinate')) return;

        const target = room.gameSetup.players.find(p => (p.id || p.name) === data?.targetId);
        if (!target) return;

        const targetKey = target.id || target.name;
        if (targetKey === socket.id) return;             // 自分は殺せない
        if (room.deadIds.has(targetKey)) return;         // 既に死んでいる

        room.usedAbilities.add(socket.id);
        room.deadIds.add(targetKey);

        // 死んだ人の投票は無効にする
        delete room.votes[targetKey];

        console.log(`🗡 ${room.id}: ${me.name} が ${target.name} を暗殺`);

        io.to(room.id).emit('playerAssassinated', {
            targetId: targetKey,
            targetName: target.name,
        });

        // 生存者が減ったので、締め切り条件を満たしていないか再確認する
        checkVotesComplete(room);
    });

    // ── 付き人の行動：1人の役職を見て、自分もその役職になる（中央の余りカードは選べない）
    socket.on('followerAction', (data) => {
        const room = getRoom(socket);
        if (!room || !room.isGameStarted || !room.gameSetup) return;
        if (room.votingStarted) return;                  // 能力は議論中だけ
        if (room.usedAbilities.has(socket.id)) return;

        const me = room.gameSetup.players.find(p => p.id === socket.id);
        if (!me || !hasAbility(me.role, 'follow')) return;

        const target = room.gameSetup.players.find(p => (p.id || p.name) === data?.targetId);
        if (!target || (target.id || target.name) === socket.id) return;

        room.usedAbilities.add(socket.id);

        // 見えるのは本当の役職。そのまま自分の役職になるので陣営も変わる
        const acquired = target.role;
        me.role = acquired;

        console.log(`🎭 ${room.id}: ${me.name} が ${target.name} に付いて ${acquired} になった`);

        socket.emit('followerResult', {
            targetId: target.id || target.name,
            targetName: target.name,
            role: acquired,
        });
    });

    // ── 投票フェーズ開始（ホストのみ）
    socket.on('startVote', () => {
        const room = getRoom(socket);
        if (!room || !room.isGameStarted || !room.players[socket.id]?.isHost) return;

        const humanPlayers = Object.values(room.players).map(p => ({ name: p.name, id: p.id }));
        const comPlayers = room.gameSetup.players
            .filter(p => p.type === 'computer')
            .map(p => ({ name: p.name, id: p.name }));

        room.votingStarted = true;
        io.to(room.id).emit('startVoting', { players: [...humanPlayers, ...comPlayers] });

        // 暗殺で投票できる人が誰もいなくなっている場合、
        // 誰の投票も届かないため、ここで判定を起動しないと進行不能になる
        checkVotesComplete(room);
    });

    // ── 投票
    socket.on('submitVote', (data) => {
        const room = getRoom(socket);
        if (!room || !room.isGameStarted || room.votes[socket.id]) return;

        // 暗殺された人は投票できない
        if (room.deadIds.has(socket.id)) return;

        // 自分自身と、暗殺された人には投票できない（口封じ＝処刑対象からも外れる）
        if (data?.targetId === socket.id) return;
        if (room.deadIds.has(data?.targetId)) return;

        room.votes[socket.id] = data?.targetId;
        checkVotesComplete(room);
    });

    // ── 公開チャット。同じ部屋の全員に届く
    socket.on('chatMessage', (text) => {
        const room = getRoom(socket);
        if (!room) return;

        const player = room.players[socket.id];
        if (!player) return;

        // 暗殺された人は発言できない（口封じ）
        if (room.deadIds.has(socket.id)) return;

        const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!body) return;

        // 連打による荒らしを防ぐ簡易的な間隔制限
        const now = Date.now();
        if (now - (socket.data.lastChatAt || 0) < 400) return;
        socket.data.lastChatAt = now;

        io.to(room.id).emit('chatMessage', {
            id: socket.id,
            name: player.name,
            text: body,
        });
    });

    // ── 切断
    socket.on('disconnect', () => {
        const room = getRoom(socket);
        if (!room) return;

        const leaver = room.players[socket.id];
        if (!leaver) return;

        console.log(`🔌 切断: ${leaver.name}（${room.id}）`);
        delete room.players[socket.id];
        delete room.votes[socket.id];

        // プレイ中に抜けられると進行不能になるので、全員ロビーへ戻す
        if (room.isGameStarted) {
            room.isGameStarted = false;
            room.gameSetup = null;
            room.votes = {};
            room.deadIds = new Set();
            room.usedAbilities = new Set();
            room.votingStarted = false;
            io.to(room.id).emit('gameAborted', {
                message: `${leaver.name}さんが退出したため、ロビーに戻ります。`,
            });
        }

        // 誰もいなくなった部屋は破棄する
        if (playerCount(room) === 0) {
            rooms.delete(room.id);
            console.log(`🏚 ルーム破棄: ${room.id}（残り ${rooms.size} 室）`);
            return;
        }

        // ホストが抜けたら残っている人に引き継ぐ
        if (leaver.isHost) {
            const nextId = Object.keys(room.players)[0];
            room.players[nextId].isHost = true;
            console.log(`👑 ホスト引き継ぎ: ${room.players[nextId].name}`);
        }

        broadcastLobby(room);
    });
});

// 画面側も roles.csv の内容を使うので、JSON にして配る
app.get('/roles.json', (req, res) => res.json(rolesForClient()));

// 起動時のカレントディレクトリに依存しないよう、必ずこのファイル基準で解決する
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`サーバー起動: http://localhost:${PORT}`);
});
