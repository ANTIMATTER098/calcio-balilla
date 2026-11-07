const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const W = 900, H = 600, GOAL_H = 160, BALL_R = 10, PLAYER_R = 18;
const EXTRA_TIME = 5 * 60;
const rooms = {};

function createRoom(roomId, config) {
  return {
    id: roomId,
    players: {},
    ball: { x: W/2, y: H/2, vx: 0, vy: 0 },
    score: { A: 0, B: 0 },
    trainingScore: 0,
    timeLeft: config.matchTime || 10 * 60,
    matchState: 'waiting',
    extraTimeLeft: 0,
    inExtraTime: false,
    lastTick: Date.now(),
    MAX_PER_TEAM: Math.min(2, Math.max(1, config.maxPerTeam || 2)),
    MATCH_TIME: Math.max(30, Math.min(60 * 60, config.matchTime || 10 * 60)),
    mode: config.mode || 'normal',
    goalPause: 0,
    botDifficulty: config.botDifficulty || 'medium' // facile, medium, hard
  };
}

function resetPositions(room) {
  const ids = Object.keys(room.players);
  const teamA = ids.filter(id => room.players[id].team === 'A');
  const teamB = ids.filter(id => room.players[id].team === 'B');

  teamA.forEach((id, i) => { room.players[id].x = W * 0.25; room.players[id].y = H * 0.5 + (i - (teamA.length - 1) / 2) * 120; room.players[id].vx = 0; room.players[id].vy = 0; });
  teamB.forEach((id, i) => { room.players[id].x = W * 0.75; room.players[id].y = H * 0.5 + (i - (teamB.length - 1) / 2) * 120; room.players[id].vx = 0; room.players[id].vy = 0; });

  room.ball.x = W / 2; room.ball.y = H / 2; room.ball.vx = 0; room.ball.vy = 0;
}

function checkGoal(room) {
  let scored = false;
  
  if (room.ball.x - BALL_R <= 0 && room.ball.y > H/2 - GOAL_H/2 && room.ball.y < H/2 + GOAL_H/2) {
    if (room.mode === 'training') room.trainingScore++;
    else room.score.B++;
    scored = true;
  }
  else if (room.ball.x + BALL_R >= W && room.ball.y > H/2 - GOAL_H/2 && room.ball.y < H/2 + GOAL_H/2) {
    if (room.mode === 'training') room.trainingScore++;
    else room.score.A++;
    scored = true;
  }

  if (scored) {
    resetPositions(room);
    if (room.mode !== 'training') io.to(room.id).emit('goal', { team: room.ball.x < W/2 ? 'B' : 'A', score: room.score });
    room.goalPause = 3; 
    return true;
  }
  return false;
}

function tickRoom(room) {
  const now = Date.now();
  const dt = Math.min((now - room.lastTick) / 1000, 0.05);
  room.lastTick = now;

  if (room.matchState === 'playing') {
    
    if (room.goalPause > 0) {
      room.goalPause -= dt;
      if (room.goalPause <= 0) room.goalPause = 0;
    } else {
      if (room.mode !== 'training') {
        if (room.inExtraTime) {
          room.extraTimeLeft -= dt;
          if (room.extraTimeLeft <= 0) { room.matchState = 'ended'; io.to(room.id).emit('matchEnd', { score: room.score, winner: room.score.A > room.score.B ? 'A' : (room.score.B > room.score.A ? 'B' : 'pareggio') }); }
        } else {
          room.timeLeft -= dt;
          if (room.timeLeft <= 0) {
            if (room.score.A === room.score.B) { room.inExtraTime = true; room.extraTimeLeft = EXTRA_TIME; io.to(room.id).emit('extraTime', { extraTimeLeft: room.extraTimeLeft }); }
            else { room.matchState = 'ended'; io.to(room.id).emit('matchEnd', { score: room.score, winner: room.score.A > room.score.B ? 'A' : 'B' }); }
          }
        }
      }
    }

    if (room.goalPause <= 0) {
      for (const id in room.players) {
        const p = room.players[id];
        if (p.isBot) {
          // IMPOSTAZIONI BOT IN BASE ALLA DIFFICOLTÀ
          let botSpeed = 150;
          let botHitForce = 1.5;
          
          if (room.botDifficulty === 'easy') {
            botSpeed = 100;
            botHitForce = 1.0;
          } else if (room.botDifficulty === 'hard') {
            botSpeed = 240;
            botHitForce = 2.5;
          }

          const dx = room.ball.x - p.x; const dy = room.ball.y - p.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 5) {
            p.vx = (dx / dist) * botSpeed; p.vy = (dy / dist) * botSpeed;
            p.x += p.vx * dt; p.y += p.vy * dt;
          } else { p.vx = 0; p.vy = 0; }
        }
      }

      const ids = Object.keys(room.players);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = room.players[ids[i]]; const b = room.players[ids[j]];
          const dx = b.x - a.x; const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy); const minDist = PLAYER_R * 2;
          if (dist < minDist && dist > 0) {
            const overlap = (minDist - dist) / 2; const nx = dx / dist; const ny = dy / dist;
            a.x -= nx * overlap; a.y -= ny * overlap; b.x += nx * overlap; b.y += ny * overlap;
          }
        }
      }

      for (const id in room.players) {
        const p = room.players[id];
        p.x = Math.max(PLAYER_R, Math.min(W - PLAYER_R, p.x));
        p.y = Math.max(PLAYER_R, Math.min(H - PLAYER_R, p.y));
        if (p.boostCooldown > 0) p.boostCooldown -= dt;
      }

      room.ball.x += room.ball.vx * dt; room.ball.y += room.ball.vy * dt;
      room.ball.vx *= 0.985; room.ball.vy *= 0.985;

      if (room.ball.x - BALL_R < 0) { if (!(room.ball.y > H/2 - GOAL_H/2 && room.ball.y < H/2 + GOAL_H/2)) { room.ball.x = BALL_R; room.ball.vx = -room.ball.vx * 0.8; } }
      if (room.ball.x + BALL_R > W) { if (!(room.ball.y > H/2 - GOAL_H/2 && room.ball.y < H/2 + GOAL_H/2)) { room.ball.x = W - BALL_R; room.ball.vx = -room.ball.vx * 0.8; } }
      if (room.ball.y - BALL_R < 0) { room.ball.y = BALL_R; room.ball.vy = -room.ball.vy * 0.8; }
      if (room.ball.y + BALL_R > H) { room.ball.y = H - BALL_R; room.ball.vy = -room.ball.vy * 0.8; }

      for (const id in room.players) {
        const p = room.players[id];
        const dx = room.ball.x - p.x; const dy = room.ball.y - p.y;
        const dist = Math.hypot(dx, dy); const minDist = PLAYER_R + BALL_R;
        if (dist < minDist && dist > 0) {
          const nx = dx / dist; const ny = dy / dist; const overlap = minDist - dist;
          room.ball.x += nx * overlap; room.ball.y += ny * overlap;
          
          let hitForce = 1.5;
          if (p.isBot) {
            if (room.botDifficulty === 'easy') hitForce = 1.0;
            if (room.botDifficulty === 'hard') hitForce = 2.5;
          }
          
          const pSpeed = Math.hypot(p.vx, p.vy);
          room.ball.vx += nx * (pSpeed * hitForce + 50); room.ball.vy += ny * (pSpeed * hitForce + 50);
        }
      }
      checkGoal(room);
    }
  }

  io.to(room.id).emit('state', {
    players: room.players, ball: room.ball, score: room.score, trainingScore: room.trainingScore,
    timeLeft: room.inExtraTime ? room.extraTimeLeft : room.timeLeft,
    inExtraTime: room.inExtraTime, matchState: room.matchState, mode: room.mode, goalPause: room.goalPause
  });
}

setInterval(() => { for (const roomId in rooms) tickRoom(rooms[roomId]); }, 1000 / 30);

io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('createRoom', (config) => {
    let code = '';
    do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (rooms[code]);
    const room = createRoom(code, config);
    rooms[code] = room;

    if (config.mode === 'training') {
      room.matchState = 'playing';
      room.timeLeft = 999999;
    } else if (config.mode === 'bots') {
      const botId = 'BOT_' + Math.random().toString(36).substring(2, 6);
      room.players[botId] = { x: W*0.75, y: H/2, vx: 0, vy: 0, team: 'B', boost: 1.0, boostCooldown: 0, isBot: true, customColor: null, playerName: 'Bot' };
    }
    socket.emit('roomCreated', { roomId: code });
  });

  socket.on('joinGame', (data) => {
    const { roomId, customColor, preferredTeam, playerName } = data;
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', 'Stanza non trovata.');
    if (room.matchState !== 'waiting' && room.mode !== 'training') return socket.emit('errorMsg', 'La partita è già iniziata.');

    const teamACount = Object.values(room.players).filter(p => p.team === 'A').length;
    const teamBCount = Object.values(room.players).filter(p => p.team === 'B').length;

    let team = null;
    if (room.MAX_PER_TEAM > 1) {
      if (preferredTeam === 'A' && teamACount < room.MAX_PER_TEAM) team = 'A';
      else if (preferredTeam === 'B' && teamBCount < room.MAX_PER_TEAM) team = 'B';
    }
    if (!team) {
      if (teamACount <= teamBCount && teamACount < room.MAX_PER_TEAM) team = 'A';
      else if (teamBCount < room.MAX_PER_TEAM) team = 'B';
    }

    if (!team) return socket.emit('full');

    currentRoomId = roomId;
    socket.join(roomId);
    
    const finalName = (playerName && playerName.trim() !== '') ? playerName.substring(0, 7) : 'Giocatore';
    room.players[socket.id] = { x: W/2, y: H/2, vx: 0, vy: 0, team, boost: 1.0, boostCooldown: 0, isBot: false, customColor: customColor || null, playerName: finalName };

    socket.emit('assigned', { team, playerId: socket.id, roomId });

    const teamAReady = Object.values(room.players).some(p => p.team === 'A');
    const teamBReady = Object.values(room.players).some(p => p.team === 'B');
    
    if (teamAReady && teamBReady && room.matchState === 'waiting') {
      room.matchState = 'playing';
      room.timeLeft = room.MATCH_TIME;
      room.inExtraTime = false; room.extraTimeLeft = 0; room.score = { A: 0, B: 0 };
      resetPositions(room);
      room.lastTick = Date.now();
      room.goalPause = 0;
      io.to(roomId).emit('matchStart', { matchTime: room.MATCH_TIME });
    }
  });

  socket.on('move', (data) => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const room = rooms[currentRoomId]; 
    if (room.goalPause > 0) return;
    const p = room.players[socket.id];
    if (!p || p.isBot) return;
    const speed = 220 * (p.boost || 1);
    p.vx = (data.dx || 0) * speed; p.vy = (data.dy || 0) * speed;
    p.x += p.vx * (1/30); p.y += p.vy * (1/30);
    p.x = Math.max(PLAYER_R, Math.min(W - PLAYER_R, p.x)); p.y = Math.max(PLAYER_R, Math.min(H - PLAYER_R, p.y));
  });

  socket.on('boost', () => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const room = rooms[currentRoomId]; 
    if (room.goalPause > 0) return;
    const p = room.players[socket.id];
    if (!p || p.isBot) return;
    if (p.boostCooldown <= 0) {
      p.boost = 2.0; p.boostCooldown = 2.0;
      setTimeout(() => { if (room.players[socket.id]) room.players[socket.id].boost = 1.0; }, 500);
    }
  });

  socket.on('leaveRoom', () => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const room = rooms[currentRoomId];
    delete room.players[socket.id];
    socket.leave(currentRoomId);
    if (Object.keys(room.players).filter(id => !room.players[id].isBot).length === 0) { delete rooms[currentRoomId]; }
    socket.emit('leftRoom');
    currentRoomId = null;
  });

  socket.on('disconnect', () => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const room = rooms[currentRoomId];
    delete room.players[socket.id];
    if (Object.keys(room.players).filter(id => !room.players[id].isBot).length === 0) { delete rooms[currentRoomId]; }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server su porta ${PORT}`));
