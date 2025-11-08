// server.js (VERSI PERBAIKAN V5 - LOGIKA JOIN LEBIH BAIK)

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const os = require('os');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
console.log("Server siap.");

// --- Variabel Game ---
let lobbies = {}; // { '1234': { players: { socketId: {...} }, tugPosition: 0, ... } }
const TUG_LIMIT = 50;
const QUESTION_DURATION = 10000;
const MAX_PLAYERS = 2;

let currentQuestion = {};
let questionTimeout;

// --- Fungsi Helper (Sama) ---
function generateQuestion() {
    const ops = ['+', '-', '*', '/']; const op = ops[Math.floor(Math.random() * ops.length)];
    let num1, num2, question, answer;
    if (op === '+') { num1 = Math.floor(Math.random()*20)+1; num2 = Math.floor(Math.random()*20)+1; question = `${num1} + ${num2}`; answer = num1 + num2; }
    else if (op === '-') { num1 = Math.floor(Math.random()*25)+5; num2 = Math.floor(Math.random()*num1)+1; question = `${num1} - ${num2}`; answer = num1 - num2; }
    else if (op === '*') { num1 = Math.floor(Math.random()*10)+2; num2 = Math.floor(Math.random()*10)+2; question = `${num1} × ${num2}`; answer = num1 * num2; }
    else { answer = Math.floor(Math.random()*10)+2; num2 = Math.floor(Math.random()*10)+2; num1 = answer * num2; question = `${num1} ÷ ${num2}`; }
    return { question, answer };
}

// --- Logika Game (Server) ---
function startGame(roomCode) {
    const lobby = lobbies[roomCode]; if (!lobby) return;
    lobby.gameStarted = true; lobby.tugPosition = 0;
    for (const id in lobby.players) { lobby.players[id].score = 0; }
    io.to(roomCode).emit('gameStarted');
    io.to(roomCode).emit('scoreUpdate', lobby.players);
    io.to(roomCode).emit('tugUpdate', lobby.tugPosition);
    sendNewQuestion(roomCode);
}

function sendNewQuestion(roomCode) {
    const lobby = lobbies[roomCode]; if (!lobby) return;
    if (lobby.questionTimeout) clearTimeout(lobby.questionTimeout);
    const q = generateQuestion();
    lobby.currentQuestion = { question: q.question, answer: q.answer, team: 'none' };
    io.to(roomCode).emit('newQuestion', lobby.currentQuestion.question);
    console.log(`[Lobby ${roomCode}] Soal: ${q.question} = ${q.answer}`);
    lobby.questionTimeout = setTimeout(() => {
        if (lobby.currentQuestion.team === 'none') {
            io.to(roomCode).emit('message', "Waktu habis! Soal berikutnya...");
            io.to(roomCode).emit('tugUpdate', lobby.tugPosition);
            sendNewQuestion(roomCode);
        }
    }, QUESTION_DURATION);
}

function checkWinCondition(roomCode) {
    const lobby = lobbies[roomCode]; if (!lobby) return false;
    let winnerTeam = null;
    if (lobby.tugPosition >= TUG_LIMIT) { winnerTeam = 'BIRU'; }
    else if (lobby.tugPosition <= -TUG_LIMIT) { winnerTeam = 'MERAH'; }
    if (winnerTeam) {
        let winnerName = "";
        for(const id in lobby.players) { if(lobby.players[id].team === winnerTeam.toLowerCase()) { winnerName = lobby.players[id].name; break; } }
        io.to(roomCode).emit('gameOver', `Tim ${winnerTeam} (${winnerName}) menang!`);
        resetLobby(roomCode); return true;
    }
    return false;
}

function resetLobby(roomCode) {
    const lobby = lobbies[roomCode]; if (!lobby) return;
    lobby.gameStarted = false; lobby.tugPosition = 0; lobby.currentQuestion = {};
    if (lobby.questionTimeout) clearTimeout(lobby.questionTimeout);
    console.log(`Game direset untuk lobby ${roomCode}`);
    io.to(roomCode).emit('gameReset');
}

// --- Logika Koneksi (Socket.IO) ---
io.on('connection', (socket) => {
    console.log('User terhubung:', socket.id);
    socket.emit('requestName'); // Minta nama pas baru konek
    let currentLobbyCode = null; // Lobby tempat player ini

    // 1. Saat Pemain Bikin Lobby
    socket.on('createLobby', (playerName) => {
        let code;
        do { code = Math.floor(1000 + Math.random() * 9000).toString(); } while (lobbies[code]);
        currentLobbyCode = code;
        socket.join(code);
        lobbies[code] = {
            players: { [socket.id]: { name: playerName, score: 0, team: 'red' } },
            tugPosition: 0, gameStarted: false, currentQuestion: {}, questionTimeout: null
        };
        console.log(`Lobby ${code} dibuat oleh ${playerName}`);
        socket.emit('lobbyCreated', code, lobbies[code].players); // Kirim kode lobby ke P1
    });

    // 2. Saat Pemain Gabung Lobby
    socket.on('joinLobby', (data) => {
        const { name, code } = data;
        const lobby = lobbies[code];
        if (!lobby) { socket.emit('error', 'Lobby tidak ditemukan.'); return; }
        if (Object.keys(lobby.players).length >= 2) { socket.emit('error', 'Lobby sudah penuh.'); return; }
        if (lobby.gameStarted) { socket.emit('error', 'Game sudah dimulai.'); return; }

        currentLobbyCode = code;
        socket.join(code);
        lobby.players[socket.id] = { name: name, score: 0, team: 'blue' };
        console.log(`${name} bergabung ke lobby ${code}`);

        // --- <<< PERBAIKAN LOGIKA SERVER >>> ---
        // 1. Kasih tahu P2 (joiner) info dia & sinyal sukses join
        socket.emit('playerInfo', lobby.players[socket.id]);
        socket.emit('joinSuccess', code); // Sinyal baru untuk P2 pindah layar
        
        // 2. Kasih tahu SEMUA (termasuk P1) update daftar pemain
        io.to(code).emit('lobbyUpdate', lobby.players); 
        // --- <<< ------------------------- >>> ---

        // Cek jika pemain lengkap
        if (Object.keys(lobby.players).length === 2) {
            io.to(code).emit('message', "Pemain lengkap! Game mulai dalam 3 detik...");
            setTimeout(() => startGame(code), 3000);
        }
    });

    // 3. Saat Pemain Jawab
    socket.on('submitAnswer', (answer) => {
        if (!currentLobbyCode || !lobbies[currentLobbyCode] || !lobbies[currentLobbyCode].gameStarted) {
            socket.emit('message', "Game belum dimulai."); return;
        }
        const lobby = lobbies[currentLobbyCode];
        const player = lobby.players[socket.id];
        if (!player) return;
        if (lobby.currentQuestion.team !== 'none') {
            socket.emit('message', `Terlambat! Tim lawan sudah menjawab.`); return;
        }
        if (parseInt(answer) === lobby.currentQuestion.answer) {
            lobby.currentQuestion.team = player.team;
            player.score++;
            io.to(currentLobbyCode).emit('message', `${player.name} (Tim ${player.team}) BENAR!`);
            if (player.team === 'red') { lobby.tugPosition -= 10; } else { lobby.tugPosition += 10; }
            io.to(currentLobbyCode).emit('tugUpdate', lobby.tugPosition);
            io.to(currentLobbyCode).emit('scoreUpdate', lobby.players); 
            if (!checkWinCondition(currentLobbyCode)) {
                sendNewQuestion(currentLobbyCode);
            }
        } else {
            socket.emit('message', `Jawaban salah, ${player.name}!`);
        }
    });

    // 4. Saat Pemain Disconnect
    socket.on('disconnect', () => {
        console.log('User terputus:', socket.id);
        if (currentLobbyCode && lobbies[currentLobbyCode]) {
            const lobby = lobbies[currentLobbyCode];
            const player = lobby.players[socket.id];
            if (player) {
                delete lobby.players[socket.id];
                io.to(currentLobbyCode).emit('message', `${player.name} meninggalkan game.`);
                if (lobby.gameStarted) {
                    io.to(currentLobbyCode).emit('message', "Pemain keluar, game direset.");
                    resetLobby(currentLobbyCode);
                }
                io.to(currentLobbyCode).emit('lobbyUpdate', lobby.players); // Update skor/nama
            }
            if (Object.keys(lobby.players).length === 0) {
                console.log(`Lobby ${currentLobbyCode} kosong dan dihapus.`);
                if (lobby.questionTimeout) clearTimeout(lobby.questionTimeout);
                delete lobbies[currentLobbyCode];
            }
        }
    });
});

// Mulai server
server.listen(PORT, () => {
    console.log("=".repeat(50));
    console.log("!!! SERVER TARIK TAMBANG (v5 - LOBBY FIX) SIAP !!!");
    console.log(`Server berjalan di http://0.0.0.0:${PORT}`);
    console.log("Buka browser dan masukkan alamat IP PC ini:");
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    console.log(`-> http://${iface.address}:${PORT}`);
                }
            }
        }
    } catch (e) { console.log("-> (Cek 'ipconfig' manual)"); }
    console.log("=".repeat(50));
});